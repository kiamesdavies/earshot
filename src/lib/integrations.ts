// Connector-backed topics, end to end:
//   beginning — pull the linked source into topics/<slug>/linked/ (read-only mirror),
//               so nudges, chat and summaries read it like any other topic file;
//   ending    — run the topic's post-session hook (a skill) to draft the record,
//               then write it back through the connector only after approval.

import { invoke } from "@tauri-apps/api/core";
import { runAgent, type Tool } from "../core/agent";
import { formatTranscript } from "../core/copilot";
import {
  BUILTIN_CONNECTORS,
  ConnectorClient,
  fill,
  markerCandidates,
  NeedsAgent,
  normaliseMarker,
  openLink,
  type ConnectorDef,
  type McpTool,
  type PostHook,
  type SourceRef,
  type TopicBinding,
} from "../core/connectors";
import { ModelClient } from "../core/providers";
import type { Segment, SessionMeta } from "../core/types";
import { fsExists, fsRead, fsWrite, logEvent, readJson, transport } from "./backend";
import { listSessions, loadSession, loadTranscript, slugify } from "./library";
import { getSettings, updateSettings } from "./settings";

// ---- MCP bridge ----

export const mcpConnect = (id: string, url: string) => invoke<void>("mcp_connect", { id, url });
export const mcpDisconnect = (id: string) => invoke<void>("mcp_disconnect", { id });
export const mcpStatus = (id: string) => invoke<boolean>("mcp_status", { id });
export const mcpTools = (id: string, url: string) => invoke<McpTool[]>("mcp_tools", { id, url });
const mcpCall = (id: string, url: string, tool: string, args: Record<string, unknown>) => invoke<unknown>("mcp_call", { id, url, tool, args });
export const skillLoad = (path: string) => invoke<string>("skill_load", { path });

export function connectors(): ConnectorDef[] {
  return [...BUILTIN_CONNECTORS, ...(getSettings().customConnectors ?? [])];
}

export function connectorDef(id: string): ConnectorDef | undefined {
  return connectors().find((c) => c.id === id);
}

export async function addCustomConnector(name: string, url: string): Promise<ConnectorDef> {
  const def: ConnectorDef = {
    id: `${slugify(name)}-${Date.now().toString(36)}`,
    name,
    url,
    description: "Custom MCP server. Reads and writes go through an agent using its tools.",
    source: [{ key: "ref", label: "Document", placeholder: "URL, ID or path the server understands" }],
  };
  await updateSettings({ customConnectors: [...(getSettings().customConnectors ?? []), def] });
  return def;
}

export async function removeCustomConnector(id: string) {
  await mcpDisconnect(id).catch(() => {});
  await updateSettings({ customConnectors: (getSettings().customConnectors ?? []).filter((c) => c.id !== id) });
}

const clients = new Map<string, ConnectorClient>();
export function client(id: string): ConnectorClient {
  const def = connectorDef(id);
  if (!def) throw new Error(`Unknown connector "${id}"`);
  let c = clients.get(id);
  if (!c || c.def !== def) {
    c = new ConnectorClient(def, { call: (tool, args) => mcpCall(def.id, def.url, tool, args), tools: () => mcpTools(def.id, def.url) });
    clients.set(id, c);
  }
  return c;
}

const models = () => new ModelClient(getSettings().models, transport);

// ---- topic bindings ----

export const bindingPath = (slug: string) => `topics/${slug}/topic.json`;
export const loadBinding = (slug: string) => readJson<TopicBinding | null>(bindingPath(slug), null);
export const saveBinding = (slug: string, binding: TopicBinding) => fsWrite(bindingPath(slug), JSON.stringify(binding, null, 2));

export function mirrorPath(slug: string, binding: TopicBinding): string {
  const label = Object.values(binding.source).filter(Boolean).pop() ?? binding.connector;
  const name = slugify(label.split("/").pop()!.replace(/\.md$/i, "")) || "source";
  return `topics/${slug}/linked/${binding.connector}-${name}.md`;
}

function describeSource(binding: TopicBinding): string {
  return Object.entries(binding.source)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

/** Agent fallback for a connector without a read mapping. */
async function readWithAgent(c: ConnectorClient, source: SourceRef): Promise<string> {
  const { answer } = await runAgent(models(), "chat", {
    system: `You fetch one document from ${c.def.name} using the tools provided. Return its full content as markdown, verbatim and complete, between <document> and </document>. No commentary.`,
    history: [],
    question: `Fetch: ${Object.entries(source).map(([k, v]) => `${k}: ${v}`).join("; ")}`,
    tools: await c.agentTools(false),
  });
  const m = /<document>([\s\S]*?)<\/document>/.exec(answer);
  if (!m) throw new Error(`${c.def.name}: the agent couldn't fetch the document`);
  return m[1].trim();
}

/** Beginning: refresh the topic's mirror of its linked source. */
export async function pullTopic(slug: string): Promise<{ path: string; chars: number } | null> {
  const binding = await loadBinding(slug);
  if (!binding) return null;
  const c = client(binding.connector);
  const started = performance.now();
  let markdown: string;
  try {
    markdown = await c.read(binding.source);
  } catch (error) {
    if (!(error instanceof NeedsAgent)) throw error;
    markdown = await readWithAgent(c, binding.source);
  }
  const path = mirrorPath(slug, binding);
  const header = `<!-- Linked from ${c.def.name} (${describeSource(binding)}). Read-only copy, refreshed ${new Date().toISOString()}. Edit it in ${c.def.name}. -->\n\n`;
  await fsWrite(path, header + markdown);
  await saveBinding(slug, { ...binding, lastPulledAt: new Date().toISOString() });
  logEvent("info", "integrations", `pulled ${slug} from ${c.def.name}: ${markdown.length} chars in ${Math.round(performance.now() - started)} ms`);
  return { path, chars: markdown.length };
}

/** Before a session: refresh every linked topic set to pull on start. Failures don't block the session. */
export async function pullTopicsForSession(slugs: string[], warn: (m: string) => void): Promise<void> {
  await Promise.all(
    slugs.map(async (slug) => {
      const binding = await loadBinding(slug);
      if (!binding || binding.pull !== "on-session-start") return;
      try {
        await Promise.race([pullTopic(slug), new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 20s")), 20_000))]);
      } catch (error) {
        warn(`Couldn't refresh ${slug} from ${connectorDef(binding.connector)?.name ?? binding.connector}: ${String(error).replace(/^Error: /, "")}. Using the last copy.`);
      }
    }),
  );
}

// ---- ending: post-session hooks ----

export interface HookStatus {
  topic: string;
  connector: string;
  skill: string;
  state: "running" | "draft" | "published" | "failed" | "discarded";
  error?: string;
  createdAt: string;
  publishedAt?: string;
  result?: string;
  /** Where the published record can be opened, e.g. the new meeting's page. */
  link?: string;
}

export const hookDraftPath = (dir: string, slug: string) => `${dir}/hooks/${slug}.md`;
export const hookStatusPath = (dir: string, slug: string) => `${dir}/hooks/${slug}.json`;
export const loadHookStatus = (dir: string, slug: string) => readJson<HookStatus | null>(hookStatusPath(dir, slug), null);
const saveHookStatus = (dir: string, status: HookStatus) => fsWrite(hookStatusPath(dir, status.topic), JSON.stringify(status, null, 2));

export async function hooksForSession(dir: string, topics: string[]): Promise<{ slug: string; binding: TopicBinding; status: HookStatus | null; draft: string }[]> {
  const out = [];
  for (const slug of topics) {
    const binding = await loadBinding(slug);
    if (!binding?.postHook) continue;
    const status = await loadHookStatus(dir, slug);
    const draft = (await fsExists(hookDraftPath(dir, slug))) ? await fsRead(hookDraftPath(dir, slug)) : "";
    out.push({ slug, binding, status, draft });
  }
  return out;
}

const HOOK_RULES = `
You are running inside Earshot as a post-session hook. A call just ended; its transcript, the user's own notes and Earshot's summary are below.
Follow the skill above to produce this session's record. Use the tools only to read what the skill says to read (for example last week's record).
Do NOT publish, write, or ask for approval yourself: Earshot shows your draft to the user and writes it back only after they approve.
Return the complete record exactly as it should be written, between <draft> and </draft>. After </draft>, one line saying what it is.`;

/** Ending: draft the record with the topic's skill. Never writes to the connector. */
export async function runPostHook(dir: string, meta: SessionMeta, slug: string, segments: Segment[], myNotes: string, summary: string): Promise<HookStatus> {
  const binding = await loadBinding(slug);
  if (!binding?.postHook) throw new Error(`${slug} has no post-session hook`);
  const hook = binding.postHook;
  const c = client(binding.connector);
  const status: HookStatus = { topic: slug, connector: binding.connector, skill: hook.skill, state: "running", createdAt: new Date().toISOString() };
  await saveHookStatus(dir, status);
  try {
    const skill = await skillLoad(hook.skill);
    const mirror = (await fsExists(mirrorPath(slug, binding))) ? await fsRead(mirrorPath(slug, binding)) : "";
    const tools: Tool[] = await c.agentTools(false);
    const { answer } = await runAgent(models(), "summarize", {
      system: `${skill}\n\n---\n${HOOK_RULES}`,
      history: [],
      question: [
        `<session title="${meta.title}" date="${localDate(meta.startedAt)}" weekday="${new Date(meta.startedAt).toLocaleDateString("en-GB", { weekday: "long" })}" duration_min="${Math.round((meta.durationSec ?? 0) / 60)}">`,
        `<transcript>\n${formatTranscript(segments.filter((s) => s.final)) || "(no transcript)"}\n</transcript>`,
        `<my_notes>\n${myNotes.trim() || "(none)"}\n</my_notes>`,
        `<earshot_summary>\n${summary.trim() || "(none)"}\n</earshot_summary>`,
        `</session>`,
        mirror ? `<linked_source connector="${c.def.name}" ${describeSource(binding)}>\n${mirror.slice(0, 60_000)}\n</linked_source>` : "",
        `Draft the record now.`,
      ].join("\n"),
      tools,
      maxSteps: 10,
    });
    const m = /<draft>([\s\S]*?)<\/draft>/.exec(answer);
    if (!m) throw new Error(`The skill didn't return a draft. It said: ${answer.slice(0, 300)}`);
    await fsWrite(hookDraftPath(dir, slug), m[1].trim() + "\n");
    const done: HookStatus = { ...status, state: "draft" };
    await saveHookStatus(dir, done);
    logEvent("info", "integrations", `post-hook ${slug}: draft ready (${m[1].length} chars)`);
    return done;
  } catch (error) {
    const failed: HookStatus = { ...status, state: "failed", error: String(error).replace(/^Error: /, "") };
    await saveHookStatus(dir, failed);
    logEvent("error", "integrations", `post-hook ${slug} failed: ${failed.error}`);
    return failed;
  }
}

export async function runPostHooks(dir: string, meta: SessionMeta, segments: Segment[], myNotes: string, summary: string): Promise<HookStatus[]> {
  const results: HookStatus[] = [];
  for (const slug of meta.topics) {
    const binding = await loadBinding(slug);
    if (binding?.postHook) results.push(await runPostHook(dir, meta, slug, segments, myNotes, summary));
  }
  return results;
}

/** The meeting's date on the user's own calendar (UTC would move evening calls to the next day). */
export function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hookVars(hook: PostHook, meta: SessionMeta): Record<string, string> {
  const date = localDate(meta.startedAt);
  const pretty = new Date(meta.startedAt).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const label = (hook.label || "{title}").replace("{date}", pretty).replace("{isoDate}", date).replace("{title}", meta.title);
  return { marker: normaliseMarker(hook.marker ?? ""), label, date, isoDate: date };
}

/** After the user approves: write the (possibly edited) draft back through the connector, then refresh the mirror. */
export async function publishHook(dir: string, meta: SessionMeta, slug: string, draft: string): Promise<HookStatus> {
  const binding = await loadBinding(slug);
  if (!binding?.postHook) throw new Error(`${slug} has no post-session hook`);
  const hook = binding.postHook;
  const c = client(binding.connector);
  const status = (await loadHookStatus(dir, slug)) ?? { topic: slug, connector: binding.connector, skill: hook.skill, state: "draft", createdAt: new Date().toISOString() };
  await fsWrite(hookDraftPath(dir, slug), draft);
  const vars = hookVars(hook, meta);
  if (hook.write === "insert-after-marker" && !vars.marker) throw new Error("This hook writes after a marker, but no marker is set (Topics → Linked source).");
  if (hook.write === "insert-after-marker" && c.def.read) {
    // Check against the source as it is now, so a wrong marker fails here with a clear reason.
    const current = await c.read(binding.source);
    const count = current.split(vars.marker).length - 1;
    if (count !== 1) {
      const found = markerCandidates(current);
      throw new Error(
        count === 0
          ? `The marker "${vars.marker}" isn't in ${describeSource(binding)}, so nothing was written.${found.length ? ` Lines that could be the marker: ${found.join("  ")}` : ""} Fix it in Topics → Linked source → edit, then Publish again.`
          : `The marker "${vars.marker}" appears ${count} times in ${describeSource(binding)}; it must appear exactly once. Nothing was written.`,
      );
    }
  }
  let result: string;
  try {
    result = await c.write(binding.source, draft.trim(), hook.write, vars);
  } catch (error) {
    if (!(error instanceof NeedsAgent)) throw error;
    // No write mapping: an agent does it, with write tools, only now that the user approved.
    const { answer } = await runAgent(models(), "chat", {
      system: `Write content into a ${c.def.name} document using the tools. ${hook.write === "insert-after-marker" ? `Insert it on a new paragraph directly after the line "${vars.marker}", leaving everything else unchanged.` : "Append it at the end of the document, leaving everything else unchanged."} Then reply DONE, or FAILED: <reason>.`,
      history: [],
      question: `Document: ${describeSource(binding)}\nVersion label: ${vars.label}\n<content>\n${draft.trim()}\n</content>`,
      tools: await c.agentTools(true),
    });
    if (!/DONE/.test(answer)) throw new Error(answer.slice(0, 300));
    result = answer;
  }
  const anchor = hook.publishedLink ? (fill(hook.publishedLink, vars) as string) : binding.link;
  const link = openLink(c.def, binding.source, anchor ?? "") ?? undefined;
  const published: HookStatus = { ...status, state: "published", publishedAt: new Date().toISOString(), result: result.slice(0, 500), error: undefined, link };
  await saveHookStatus(dir, published);
  logEvent("info", "integrations", `published ${slug} to ${c.def.name}`);
  pullTopic(slug).catch(() => {});
  return published;
}

export async function discardHook(dir: string, slug: string) {
  const status = await loadHookStatus(dir, slug);
  if (status) await saveHookStatus(dir, { ...status, state: "discarded" });
}

// ---- choosing a source ----

export function sourceOptions(connector: string, field: string, source: SourceRef): Promise<string[] | null> {
  return client(connector).options(field, source);
}

// ---- testing a linked topic end to end, without publishing ----

export interface TestStep {
  phase: "connection" | "before" | "after";
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Checks everything a session will rely on, in order: the connection, the
 * pre-session pull, and the post-session pieces (skill, marker, write shape).
 * Nothing is written to the connector; the write is only validated.
 */
export async function testTopicLink(slug: string): Promise<TestStep[]> {
  const steps: TestStep[] = [];
  const step = (phase: TestStep["phase"], name: string, ok: boolean, detail: string) => steps.push({ phase, name, ok, detail });
  const binding = await loadBinding(slug);
  if (!binding) return [{ phase: "connection", name: "Linked", ok: false, detail: "This topic isn't linked to a connector." }];
  const def = connectorDef(binding.connector);
  if (!def) return [{ phase: "connection", name: "Connector", ok: false, detail: `Unknown connector "${binding.connector}".` }];
  const c = client(def.id);
  const err = (e: unknown) => String(e).replace(/^Error: /, "");

  // Connection
  if (!(await mcpStatus(def.id).catch(() => false))) {
    step("connection", `Signed in to ${def.name}`, false, "Not connected. Connect it in Settings → Integrations.");
    return steps;
  }
  try {
    const tools = await c.tools();
    step("connection", `Signed in to ${def.name}`, true, `${tools.length} tools available`);
  } catch (e) {
    step("connection", `Signed in to ${def.name}`, false, err(e));
    return steps;
  }

  // Before the session: the same pull a session does.
  let content = "";
  try {
    const pulled = await pullTopic(slug);
    content = pulled ? await fsRead(pulled.path) : "";
    step("before", "Pull the linked source", true, `${pulled?.chars.toLocaleString() ?? 0} characters saved to ${pulled?.path}`);
  } catch (e) {
    step("before", "Pull the linked source", false, err(e));
  }

  const hook = binding.postHook;
  if (!hook) {
    step("after", "Post-session hook", true, "None set: sessions only save Earshot's own notes to this topic.");
    return steps;
  }

  // After the session
  try {
    const skill = await skillLoad(hook.skill);
    const name = /^name:\s*(.+)$/m.exec(skill)?.[1] ?? hook.skill.split("/").filter(Boolean).pop();
    step("after", "Load the skill", true, `${name} (${skill.length.toLocaleString()} characters)`);
  } catch (e) {
    step("after", "Load the skill", false, err(e));
  }

  if (hook.write === "insert-after-marker") {
    const marker = normaliseMarker(hook.marker ?? "");
    const count = marker ? content.split(marker).length - 1 : 0;
    step(
      "after",
      "Find the marker line",
      !!marker && count === 1,
      !marker ? "No marker set." : count === 1 ? `Found once: ${marker}` : count === 0 ? `"${marker}" isn't in the pulled file, so publishing would fail.${markerCandidates(content).length ? ` Did you mean ${markerCandidates(content).join(" or ")}?` : ""}` : `"${marker}" appears ${count} times; it must appear exactly once.`,
    );
  }

  try {
    const meta = { title: "Test", startedAt: new Date().toISOString(), topics: [slug] } as unknown as SessionMeta;
    const vars = hookVars(hook, meta);
    const { tool } = await c.validateWrite(binding.source, hook.write, vars);
    const anchor = hook.publishedLink ? (fill(hook.publishedLink, vars) as string) : binding.link;
    step("after", "Check the write (not sent)", true, `${tool} accepts it. Label: "${vars.label}". After publishing, Open goes to ${openLink(def, binding.source, anchor ?? "") ?? "the source"}.`);
  } catch (e) {
    if (e instanceof NeedsAgent) step("after", "Check the write (not sent)", true, `${def.name} has no write mapping, so an agent will write it after you approve.`);
    else step("after", "Check the write (not sent)", false, err(e));
  }
  return steps;
}

/**
 * Optional last check: draft a record from this topic's most recent session
 * (as the hook would after a call). Uses the model; never publishes.
 */
export async function sampleDraft(slug: string): Promise<{ draft: string; from: string }> {
  const binding = await loadBinding(slug);
  if (!binding?.postHook) throw new Error("No post-session hook set");
  const recent = (await listSessions()).find((s) => s.meta.topics?.includes(slug));
  const meta: SessionMeta = recent?.meta ?? ({ id: "test", title: "Test session", startedAt: new Date().toISOString(), topics: [slug], goal: "", locale: "en-US" } as SessionMeta);
  const data = recent ? await loadSession(recent.dir) : null;
  const segments = recent ? await loadTranscript(recent.dir) : [];
  const testDir = `topics/${slug}/linked/.test`;
  const status = await runPostHook(testDir, meta, slug, segments, data?.myNotes ?? "", data?.notes ?? "");
  if (status.state !== "draft") throw new Error(status.error ?? "No draft produced");
  return { draft: await fsRead(hookDraftPath(testDir, slug)), from: recent ? `${meta.title} (${localDate(meta.startedAt)})` : "an empty test session" };
}

/** Marker lines found in the topic's pulled copy, for the Marker dropdown. */
export async function markerSuggestions(slug: string, binding: TopicBinding): Promise<string[]> {
  const path = mirrorPath(slug, binding);
  if (!(await fsExists(path).catch(() => false))) return [];
  return markerCandidates(await fsRead(path).catch(() => ""));
}
