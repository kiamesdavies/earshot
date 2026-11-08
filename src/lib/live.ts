// The live session controller: owns the capture sidecar, the copilot loop and
// everything written to the session folder while a call is running.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { Copilot } from "../core/copilot";
import { generateTitle, sessionMarkdown, summarize } from "../core/notes";
import { describeRole, ModelClient, type Role } from "../core/providers";
import { Retriever, tokenize } from "../core/retrieval";
import type { ChatMessage, Moment, Segment, SessionMeta, Suggestion } from "../core/types";
import { askSession } from "./assistant";
import { captureStart, captureStop, fsAppend, fsWrite, logEvent, readJson, recordingDelete, transport, type SttConfig } from "./backend";
import { buildVocabulary } from "./vocabulary";
import { pullTopicsForSession, runPostHooks } from "./integrations";
import { loadTopicDocs, newSessionId, slugify } from "./library";
import { getSettings } from "./settings";
import { foldSession, loadTopicSettings, summaryFormat } from "./topicBrain";

export type Phase = "idle" | "starting" | "live" | "stopping" | "summarizing" | "done" | "error";

export interface LiveState {
  phase: Phase;
  dir: string;
  meta: SessionMeta | null;
  segments: Segment[];
  suggestions: Suggestion[];
  moments: Moment[];
  chat: ChatMessage[];
  myNotes: string;
  status: string;
  warnings: string[];
  error?: string;
  startedAtMs: number;
  notes: string;
  docCount: number;
  thinking: boolean;
  chatBusy: boolean;
  echoDropped: number;
  /** Bumped when post-session hooks finish, so the hooks panel reloads. */
  hooksVersion: number;
}

const INITIAL: LiveState = {
  phase: "idle",
  dir: "",
  meta: null,
  segments: [],
  suggestions: [],
  moments: [],
  chat: [],
  myNotes: "",
  status: "",
  warnings: [],
  startedAtMs: 0,
  notes: "",
  docCount: 0,
  thinking: false,
  chatBusy: false,
  echoDropped: 0,
  hooksVersion: 0,
};

let state: LiveState = INITIAL;
const listeners = new Set<() => void>();
const set = (patch: Partial<LiveState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

/** Subscribe to one slice. The selector must return a primitive or an existing reference. */
export function useLiveSelector<T>(select: (s: LiveState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

// Audio levels arrive ~4x a second. They live in their own store so only the
// meters re-render, not the transcript, nudges and session list.
let levels = { me: 0, them: 0 };
const levelListeners = new Set<() => void>();
export function useLevels() {
  return useSyncExternalStore(
    (l) => {
      levelListeners.add(l);
      return () => levelListeners.delete(l);
    },
    () => levels,
  );
}

/** Non-React access for the mini-window bridge. */
export const useLiveStore = {
  get: () => state,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

export function useLive(): LiveState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

let copilot: Copilot | null = null;
let client: ModelClient | null = null;
let unlisten: UnlistenFn | null = null;
let ticker: number | null = null;
let stopped: (() => void) | null = null;
let titleRequested = false;
let lastSpeechAt = 0;
let callEndedAt: number | null = null;
let notesTimer: number | null = null;

const now = () => (state.startedAtMs ? (Date.now() - state.startedAtMs) / 1000 : 0);
const warn = (message: string) => {
  logEvent("warn", "session", message);
  set({ warnings: [...state.warnings.slice(-4), message] });
};
const ROLES: Role[] = ["gate", "suggest", "chat", "summarize"];

export interface StartOptions {
  title: string;
  goal: string;
  topics: string[];
  app?: string;
}

async function writeMeta(meta: SessionMeta) {
  set({ meta });
  await fsWrite(`${state.dir}/session.json`, JSON.stringify(meta, null, 2));
}

export async function startSession(options: StartOptions): Promise<void> {
  if (state.phase === "starting" || state.phase === "live" || state.phase === "stopping") return;
  const settings = getSettings();
  const id = newSessionId();
  const dir = `sessions/${id}`;
  const meta: SessionMeta = {
    id,
    title: options.title || (options.app ? `${options.app} call` : "Untitled call"),
    autoTitle: !options.title,
    startedAt: new Date().toISOString(),
    topics: options.topics,
    goal: options.goal,
    app: options.app,
    locale: settings.locale,
    models: Object.fromEntries(ROLES.map((r) => [r, describeRole(settings.models, r)])),
  };
  state = { ...INITIAL, phase: "starting", dir, meta, status: "Starting audio…" };
  listeners.forEach((l) => l());
  titleRequested = false;
  lastSpeechAt = 0;
  callEndedAt = null;

  try {
    await fsWrite(`${dir}/session.json`, JSON.stringify(meta, null, 2));
    // Linked topics (Spacesheep, Notion, …) refresh their local copy first, so the copilot sees the latest.
    set({ status: "Refreshing linked topics…" });
    await pullTopicsForSession(options.topics, warn);
    const docs = await loadTopicDocs(options.topics);
    client = new ModelClient(settings.models, transport);
    copilot = new Copilot({
      complete: (role, req) => client!.complete(role, req),
      retriever: new Retriever(docs),
      goal: options.goal,
      userName: settings.userName || undefined,
      config: settings.copilot,
    });
    set({ docCount: docs.length });
    unlisten = await listen<Record<string, unknown>>("audio", (e) => onAudio(e.payload));
    await captureStart(dir, settings.locale, settings.captureSystem, settings.echoCancellation, sttConfig(options.topics, docs));
  } catch (error) {
    logEvent("error", "session", `start failed: ${String(error)}`);
    await teardown();
    set({ phase: "error", error: String(error) });
  }
}

export function sttConfig(topics: string[], docs: { path: string; content: string }[]): SttConfig {
  const { stt, userName, locale } = getSettings();
  return {
    engine: stt.engine,
    modelPath: stt.modelPath,
    prompt: stt.engine === "whisper" ? buildVocabulary(stt.vocabulary, userName, topics, docs) : "",
    language: locale.split(/[-_]/)[0] || "en",
  };
}

/**
 * On speakers, the mic also hears the other side. If a "me" line closely
 * matches a "them" line from the same moment, it's echo — drop it.
 */
function isEcho(segment: Segment): boolean {
  if (segment.speaker !== "me") return false;
  const mine = new Set(tokenize(segment.text));
  if (mine.size < 3) return false;
  return state.segments.some((s) => {
    if (s.speaker !== "them" || s.end < segment.start - 3 || s.start > segment.end + 3) return false;
    const theirs = new Set(tokenize(s.text));
    let shared = 0;
    for (const t of mine) if (theirs.has(t)) shared++;
    return shared / mine.size >= 0.6;
  });
}

/** Replace or insert a segment, keeping start order without re-sorting the whole call. */
function upsert(list: Segment[], segment: Segment): Segment[] {
  const next = list.slice();
  const i = next.findIndex((s) => s.id === segment.id);
  if (i >= 0) {
    next[i] = segment;
    return next;
  }
  let at = next.length;
  while (at > 0 && next[at - 1].start > segment.start) at--; // usually 0 steps: new speech is last
  next.splice(at, 0, segment);
  return next;
}

function onAudio(msg: Record<string, unknown>) {
  switch (msg.type) {
    case "started":
      set({ phase: "live", startedAtMs: Date.parse(String(msg.startedAt)) || Date.now(), status: "Listening" });
      ticker = window.setInterval(tick, 250);
      break;
    case "preview": {
      // Apple's live words while a local model handles the final text.
      const { type: _type, ...clean } = msg;
      const preview = { ...(clean as unknown as Segment), id: `p-${clean.id}`, final: false };
      if (preview.text) {
        set({ segments: upsert(state.segments.filter((s) => s.id !== preview.id), preview) });
        copilot?.addSegment(preview, now());
      }
      break;
    }
    case "segment": {
      const { type: _type, ...clean } = msg;
      const segment = clean as unknown as Segment;
      if (segment.final && (clean as { engine?: string }).engine) {
        // A local-model final replaces the previews it covers.
        const covered = (s: Segment) => s.id.startsWith("p-") && s.speaker === segment.speaker && s.start <= segment.end + 0.3;
        set({ segments: state.segments.filter((s) => !covered(s)) });
      }
      if (segment.final && isEcho(segment)) {
        set({ segments: state.segments.filter((s) => s.id !== segment.id), echoDropped: state.echoDropped + 1 });
        break;
      }
      set({ segments: upsert(state.segments, segment) });
      copilot?.addSegment(segment, now());
      if (segment.final) lastSpeechAt = now();
      if (segment.final) fsAppend(`${state.dir}/transcript.jsonl`, JSON.stringify(segment) + "\n").catch((e) => warn(String(e)));
      break;
    }
    case "level":
      levels = { me: Number(msg.me) || 0, them: Number(msg.them) || 0 };
      levelListeners.forEach((l) => l());
      break;
    case "status":
      set({ status: String(msg.message) });
      break;
    case "permissions":
      if (msg.systemAudio !== "granted" && getSettings().captureSystem) warn("System audio permission isn't granted — the other side won't be transcribed. See Settings → Permissions.");
      break;
    case "error":
      if (msg.fatal) {
        logEvent("error", "session", String(msg.message));
        set({ phase: "error", error: String(msg.message) });
      }
      else warn(String(msg.message));
      break;
    case "log":
      console.debug("[audio]", msg.message);
      break;
    case "stopped":
    case "exited":
      stopped?.();
      if (state.phase === "starting" || state.phase === "live") {
        set({ phase: "error", error: state.error ?? "Audio capture stopped unexpectedly" });
        teardown();
      }
      break;
  }
}

/** The meeting app released the mic; with no speech after that, the session stops itself. */
export function noteCallEnded() {
  if (state.phase === "live") callEndedAt = now();
}
export function noteCallStarted() {
  callEndedAt = null;
}

function autoStopReason(t: number): string | null {
  const { afterCallEndMin, idleMin, maxHours } = getSettings().autoStop;
  const quietSince = Math.max(lastSpeechAt, callEndedAt ?? 0);
  if (callEndedAt !== null && afterCallEndMin > 0 && t - quietSince > afterCallEndMin * 60) return "the call ended";
  if (idleMin > 0 && t - lastSpeechAt > idleMin * 60) return `no one spoke for ${idleMin} minutes`;
  if (maxHours > 0 && t > maxHours * 3600) return `it reached the ${maxHours}-hour limit`;
  return null;
}

function tick() {
  if (!copilot || state.phase !== "live") return;
  const t = now();
  const reason = autoStopReason(t);
  if (reason) {
    logEvent("info", "session", `auto-stop: ${reason}`);
    warn(`Stopped automatically because ${reason}.`);
    stopSession();
    return;
  }
  maybeAutoTitle(t);
  const trigger = copilot.check(t);
  if (!trigger) return;
  set({ thinking: true });
  copilot
    .evaluate(trigger, now)
    .then((suggestion) => {
      if (!suggestion) return;
      set({ suggestions: [...state.suggestions, suggestion] });
      return fsAppend(`${state.dir}/suggestions.jsonl`, JSON.stringify(suggestion) + "\n");
    })
    .catch((error) => warn(`Copilot: ${String(error).slice(0, 240)}`))
    .finally(() => set({ thinking: false }));
}

function maybeAutoTitle(t: number) {
  const meta = state.meta;
  if (!meta?.autoTitle || titleRequested || !client) return;
  if (t < 75 || state.segments.filter((s) => s.final).length < 6) return;
  titleRequested = true;
  generateTitle((r, q) => client!.complete(r, q), state.segments, state.myNotes, meta.goal)
    .then((title) => {
      if (title && state.meta?.autoTitle) return writeMeta({ ...state.meta, title, autoTitle: false });
    })
    .catch((e) => warn(`Auto-title: ${String(e).slice(0, 160)}`));
}

/** The bookmark button: "I wanted a nudge here." This is the replay harness's ground truth. */
export function markMoment(note?: string) {
  if (state.phase !== "live") return;
  const moments = [...state.moments, { t: now(), ...(note ? { note } : {}) }];
  set({ moments });
  fsWrite(`${state.dir}/moments.json`, JSON.stringify(moments, null, 1)).catch((e) => warn(String(e)));
}

export function annotateMoment(index: number, note: string) {
  const moments = state.moments.map((m, i) => (i === index ? { ...m, note } : m));
  set({ moments });
  fsWrite(`${state.dir}/moments.json`, JSON.stringify(moments, null, 1)).catch((e) => warn(String(e)));
}

export function dismissSuggestion(id: string) {
  set({ suggestions: state.suggestions.map((s) => (s.id === id ? { ...s, dismissed: true } : s)) });
}

/** Your own notes for the call — saved as you type, fed into chat, summary and the topic file. */
export function setMyNotes(text: string) {
  set({ myNotes: text });
  if (notesTimer) window.clearTimeout(notesTimer);
  const dir = state.dir;
  notesTimer = window.setTimeout(() => fsWrite(`${dir}/my-notes.md`, text).catch((e) => warn(String(e))), 400);
}

export async function renameLive(title: string) {
  if (state.meta && title.trim()) await writeMeta({ ...state.meta, title: title.trim(), autoTitle: false });
}

export async function setLiveTopics(topics: string[]) {
  if (!state.meta) return;
  await writeMeta({ ...state.meta, topics });
  const docs = await loadTopicDocs(topics);
  copilot?.setRetriever(new Retriever(docs));
  set({ docCount: docs.length });
}

export async function askLive(question: string) {
  if (!state.meta) return;
  const history = state.chat;
  set({ chat: [...history, { role: "user", content: question, at: now() }], chatBusy: true });
  try {
    const answer = await askSession(
      { meta: state.meta, segments: state.segments, myNotes: state.myNotes, chat: history, question, live: state.phase === "live" },
      {
        appendNotes: async (md) => setMyNotes(`${state.myNotes.trim()}\n\n${md.trim()}`.trim()),
        rename: renameLive,
        attachTopic: async (topic) => setLiveTopics([...new Set([...(state.meta?.topics ?? []), topic])]),
      },
    );
    set({ chat: [...state.chat, { ...answer, at: now() }] });
  } catch (error) {
    set({ chat: [...state.chat, { role: "assistant", content: `⚠️ ${String(error)}`, at: now() }] });
  } finally {
    set({ chatBusy: false });
    fsWrite(`${state.dir}/chat.json`, JSON.stringify(state.chat, null, 1)).catch(() => {});
  }
}

async function teardown() {
  if (ticker) window.clearInterval(ticker);
  ticker = null;
  unlisten?.();
  unlisten = null;
}

export async function stopSession(): Promise<void> {
  if (state.phase !== "live" && state.phase !== "starting") return;
  set({ phase: "stopping", status: "Finishing transcript…" });
  const done = new Promise<void>((resolve) => {
    stopped = resolve;
    window.setTimeout(resolve, 25_000);
  });
  await captureStop();
  await done;
  stopped = null;
  await teardown();
  if (notesTimer) {
    window.clearTimeout(notesTimer);
    await fsWrite(`${state.dir}/my-notes.md`, state.myNotes).catch(() => {});
  }

  let meta: SessionMeta = { ...state.meta!, endedAt: new Date().toISOString(), durationSec: Math.round(now()) };
  const hasContent = state.segments.some((s) => s.final) || state.myNotes.trim();
  if (meta.autoTitle && hasContent && client) {
    try {
      const title = await generateTitle((r, q) => client!.complete(r, q), state.segments, state.myNotes, meta.goal);
      if (title) meta = { ...meta, title, autoTitle: false };
    } catch (e) {
      warn(`Auto-title: ${String(e).slice(0, 160)}`);
    }
  }
  await writeMeta(meta);
  if (getSettings().keepAudioDays === 0) recordingDelete(meta.id).catch(() => {});
  let summary = "";
  if (getSettings().autoSummarize && hasContent) {
    summary = await generateNotes(state.dir, meta, state.segments, state.suggestions, state.myNotes).catch(() => "");
  } else {
    set({ phase: "done", status: "Saved" });
  }
  // Post-session hooks (e.g. a skill that writes the meeting record) draft only; publishing waits for approval.
  if (hasContent && meta.topics.length) {
    const dir = state.dir;
    set({ status: "Drafting linked records…" });
    runPostHooks(dir, meta, state.segments, state.myNotes, summary)
      .then((results) => {
        if (state.dir !== dir) return;
        const drafts = results.filter((r) => r.state === "draft").length;
        const failed = results.filter((r) => r.state === "failed");
        if (results.length) set({ status: drafts ? `${drafts} record${drafts === 1 ? "" : "s"} ready to review` : state.status, hooksVersion: state.hooksVersion + 1 });
        failed.forEach((f) => warn(`Post-session hook for ${f.topic} failed: ${f.error}`));
      })
      .catch((e) => warn(`Post-session hooks: ${String(e)}`));
  }
}

/** Summarize a session and write notes into the session folder and each linked topic. */
export async function generateNotes(dir: string, meta: SessionMeta, segments: Segment[], suggestions: Suggestion[], myNotes: string): Promise<string> {
  const isLive = dir === state.dir && state.phase !== "idle";
  if (isLive) set({ phase: "summarizing", status: "Writing notes…" });
  try {
    const settings = getSettings();
    const modelClient = new ModelClient(settings.models, transport);
    const topicDocs = await loadTopicDocs(meta.topics);
    const complete = (r: Role, q: Parameters<ModelClient["complete"]>[1]) => modelClient.complete(r, q);
    // Each topic may bring its own summary format (a skill); topics sharing a format share one summary.
    const formats = await Promise.all(
      meta.topics.map(async (t) =>
        summaryFormat(await loadTopicSettings(t)).catch((e) => {
          warn(`Summary format for ${t}: ${String(e).slice(0, 160)}. Using the default.`);
          return "";
        }),
      ),
    );
    const byFormat = new Map<string, Promise<string>>();
    const notesFor = (format: string) => {
      if (!byFormat.has(format)) byFormat.set(format, summarize(complete, meta, segments, suggestions, topicDocs, myNotes, format || undefined));
      return byFormat.get(format)!;
    };
    const notes = await notesFor(formats[0] ?? "");
    const notesByTopic: Record<string, string> = {};
    for (const [i, t] of meta.topics.entries()) notesByTopic[t] = await notesFor(formats[i]);
    await fsWrite(`${dir}/notes.md`, notes);
    await saveToTopics(meta, notes, myNotes, segments, notesByTopic);
    // Fold the call into each topic's memory.md in the background (the topic "learns").
    const moments = await readJson<Moment[]>(`${dir}/moments.json`, []);
    for (const t of meta.topics) {
      foldSession(t, meta, notesByTopic[t], myNotes, moments, `topics/${t}/sessions/${sessionFileName(meta)}`).catch((e) => warn(`Memory for ${t}: ${String(e).slice(0, 200)}`));
    }
    if (isLive) set({ phase: "done", notes, status: "Notes saved" });
    return notes;
  } catch (error) {
    logEvent("error", "notes", String(error));
    if (isLive) set({ phase: "done", status: "Notes failed", warnings: [...state.warnings, `Notes failed: ${String(error)}`] });
    throw error;
  }
}

export const sessionFileName = (meta: SessionMeta) => `${meta.id.slice(0, 10)}-${slugify(meta.title)}-${meta.id.slice(11)}.md`;

/** One markdown file per session in each linked topic, keyed by session id so re-saves overwrite. */
export async function saveToTopics(meta: SessionMeta, notes: string, myNotes: string, segments: Segment[], notesByTopic: Record<string, string> = {}) {
  for (const topic of meta.topics) await fsWrite(`topics/${topic}/sessions/${sessionFileName(meta)}`, sessionMarkdown(meta, notesByTopic[topic] ?? notes, myNotes, segments));
}

export function resetLive() {
  if (state.phase === "done" || state.phase === "error") {
    state = INITIAL;
    listeners.forEach((l) => l());
  }
}
