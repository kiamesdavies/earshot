// How a topic learns: its summary format (a skill or written instructions) and
// its memory.md, folded forward after every call. See src/core/memory.ts.

import { foldIntoMemory, isMemoryDoc, isSessionDoc, memoryPath, topicSettingsPath, type TopicSettings } from "../core/memory";
import { ModelClient } from "../core/providers";
import type { Moment, SessionMeta } from "../core/types";
import { fsExists, fsList, fsRead, fsWrite, logEvent, readJson, transport } from "./backend";
import { skillLoad } from "./integrations";
import { loadTopicDocs } from "./library";
import { getSettings } from "./settings";

export type { TopicSettings };

export const loadTopicSettings = (slug: string) => readJson<TopicSettings>(topicSettingsPath(slug), {});
export const saveTopicSettings = (slug: string, settings: TopicSettings) => fsWrite(topicSettingsPath(slug), JSON.stringify(settings, null, 2));

/** The summary format a topic asks for: its skill's instructions, its written format, or "" for the default. */
export async function summaryFormat(settings: TopicSettings): Promise<string> {
  if (settings.summarySkill?.trim()) return skillLoad(settings.summarySkill.trim());
  return settings.summaryFormat?.trim() ?? "";
}

/** Which calls are already folded into memory.md, so re-generating notes never folds a call twice. */
const ledgerPath = (slug: string) => `topics/${slug}/.memory.json`;
interface Ledger {
  folded: string[];
  updatedAt?: string;
}

export interface MemoryInfo {
  exists: boolean;
  folded: number;
  sessions: number;
  updatedAt?: string;
}

export async function memoryInfo(slug: string): Promise<MemoryInfo> {
  const [exists, ledger, files] = await Promise.all([
    fsExists(memoryPath(slug)).catch(() => false),
    readJson<Ledger>(ledgerPath(slug), { folded: [] }),
    sessionFiles(slug),
  ]);
  return { exists, folded: ledger.folded.length, sessions: files.length, updatedAt: ledger.updatedAt };
}

function client() {
  const models = new ModelClient(getSettings().models, transport);
  return (role: Parameters<ModelClient["complete"]>[0], req: Parameters<ModelClient["complete"]>[1]) => models.complete(role, req);
}

async function prepText(slug: string): Promise<string> {
  const docs = await loadTopicDocs([slug]);
  return docs
    .filter((d) => !isMemoryDoc(d.path) && !isSessionDoc(d.path))
    .map((d) => `<doc path="${d.path}">\n${d.content.trim()}\n</doc>`)
    .join("\n");
}

/** Fold one finished call into a topic's memory.md (skips calls already folded in). */
export async function foldSession(slug: string, meta: SessionMeta, notes: string, myNotes: string, moments: Moment[], file?: string): Promise<boolean> {
  const settings = await loadTopicSettings(slug);
  if (settings.memory === false || !notes.trim()) return false;
  const ledger = await readJson<Ledger>(ledgerPath(slug), { folded: [] });
  if (ledger.folded.includes(meta.id)) return false;
  const started = performance.now();
  const memory = await fsRead(memoryPath(slug)).catch(() => "");
  const next = await foldIntoMemory(client(), slug, memory, { title: meta.title, date: meta.startedAt.slice(0, 10), notes, myNotes, moments, file }, await prepText(slug));
  await fsWrite(memoryPath(slug), next);
  await fsWrite(ledgerPath(slug), JSON.stringify({ folded: [...ledger.folded, meta.id], updatedAt: new Date().toISOString() }, null, 1));
  logEvent("info", "memory", `folded ${meta.id} into ${slug}/memory.md (${next.length} chars) in ${Math.round(performance.now() - started)} ms`);
  return true;
}

interface SessionFile {
  path: string;
  id: string;
}

/** Session notes saved in a topic, oldest first. Names are <yyyy-mm-dd>-<title>-<hhmmss>.md. */
async function sessionFiles(slug: string): Promise<SessionFile[]> {
  const entries = await fsList(`topics/${slug}/sessions`).catch(() => []);
  return entries
    .filter((e) => !e.isDir && e.name.endsWith(".md"))
    .map((e) => ({ path: e.path, id: `${e.name.slice(0, 10)}-${e.name.slice(-9, -3)}` }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** A saved session note without its transcript. */
function notesOnly(markdown: string): { title: string; notes: string; myNotes: string } {
  const body = markdown.replace(/^---[\s\S]*?---\s*/, "");
  const title = /^# (.+)$/m.exec(body)?.[1] ?? "Call";
  const withoutTranscript = body.split("<details>")[0];
  const [notes, myNotes = ""] = withoutTranscript.replace(/^# .+\n/m, "").split(/\n## My notes\n/);
  return { title, notes: notes.trim(), myNotes: myNotes.trim() };
}

/** Rebuild memory.md from every saved call, oldest first. One model call per call. */
export async function rebuildMemory(slug: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  const files = await sessionFiles(slug);
  const prep = await prepText(slug);
  const complete = client();
  let memory = "";
  const folded: string[] = [];
  for (const [i, f] of files.entries()) {
    onProgress?.(i, files.length);
    const { title, notes, myNotes } = notesOnly(await fsRead(f.path));
    if (!notes) continue;
    memory = await foldIntoMemory(complete, slug, memory, { title, date: f.id.slice(0, 10), notes, myNotes, file: f.path }, prep);
    folded.push(f.id);
  }
  onProgress?.(files.length, files.length);
  if (memory) {
    await fsWrite(memoryPath(slug), memory);
    await fsWrite(ledgerPath(slug), JSON.stringify({ folded, updatedAt: new Date().toISOString() }, null, 1));
  }
  logEvent("info", "memory", `rebuilt ${slug}/memory.md from ${folded.length} calls`);
  return folded.length;
}
