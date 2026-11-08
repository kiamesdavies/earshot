// Tool-using chat. The same loop serves the topic chat ("save this as a note")
// and the session chat ("add that to my notes", "attach the acme topic").
// Writes are limited to markdown under topics/ plus the session's own notes —
// the agent can create and edit, never delete.

import type { AgentMessage, ModelClient, Role, ToolSpec } from "./providers.ts";
import { Retriever, type Doc } from "./retrieval.ts";

export interface Workspace {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string, recursive: boolean): Promise<{ path: string; isDir: boolean }[]>;
}

export interface Tool extends ToolSpec {
  run(input: Record<string, unknown>): Promise<string>;
  /** One line for the chat transcript, e.g. "Created topics/acme/pricing.md". */
  describe(input: Record<string, unknown>): string;
}

export interface AgentAction {
  tool: string;
  summary: string;
  ok: boolean;
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/\.md$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

function topicPath(path: string): string {
  const clean = path.replace(/^\/+/, "");
  if (!/^topics\/[a-z0-9-]+\/.+\.md$/.test(clean) || clean.includes("..")) {
    throw new Error(`Can only write markdown files inside topics/<topic>/ (got "${path}")`);
  }
  return clean;
}

export function topicTools(ws: Workspace): Tool[] {
  const listTopics = async () => (await ws.list("topics", false)).filter((e) => e.isDir).map((e) => e.path.split("/").pop()!);
  return [
    {
      name: "list_topics",
      description: "List all topic folders.",
      parameters: { type: "object", properties: {} },
      describe: () => "Listed topics",
      run: async () => JSON.stringify(await listTopics()),
    },
    {
      name: "list_files",
      description: "List markdown files in a topic (prep docs and saved session notes).",
      parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
      describe: (i) => `Listed files in ${str(i.topic)}`,
      run: async (i) =>
        JSON.stringify((await ws.list(`topics/${slug(str(i.topic))}`, true)).filter((e) => !e.isDir && e.path.endsWith(".md")).map((e) => e.path)),
    },
    {
      name: "read_file",
      description: "Read a markdown file by its path (e.g. topics/acme/prep.md).",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      describe: (i) => `Read ${str(i.path)}`,
      run: async (i) => (await ws.read(str(i.path).replace(/^\/+/, ""))).slice(0, 20_000),
    },
    {
      name: "search_notes",
      description: "Keyword search across all topic notes. Returns the best matching sections.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      describe: (i) => `Searched notes for "${str(i.query)}"`,
      run: async (i) => {
        const docs: Doc[] = [];
        for (const e of await ws.list("topics", true)) if (!e.isDir && e.path.endsWith(".md")) docs.push({ path: e.path, content: await ws.read(e.path) });
        const hits = new Retriever(docs).search(str(i.query), 6, 0.5);
        return hits.length ? hits.map((h) => `## ${h.path} › ${h.heading}\n${h.text}`).join("\n\n") : "No matches.";
      },
    },
    {
      name: "create_topic",
      description: "Create a new topic folder with an initial prep.md.",
      parameters: { type: "object", properties: { name: { type: "string" }, content: { type: "string", description: "Markdown for prep.md" } }, required: ["name"] },
      describe: (i) => `Created topic ${slug(str(i.name))}`,
      run: async (i) => {
        const s = slug(str(i.name));
        const path = `topics/${s}/prep.md`;
        if (await ws.exists(path)) return `Topic ${s} already exists.`;
        await ws.mkdir(`topics/${s}`);
        await ws.write(path, str(i.content) || `# ${str(i.name)}\n`);
        return `Created ${path}`;
      },
    },
    {
      name: "create_file",
      description: "Create a new markdown file in a topic. Fails if it exists unless overwrite is true.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string" },
          filename: { type: "string", description: "e.g. pricing-notes.md" },
          content: { type: "string", description: "Full markdown content" },
          overwrite: { type: "boolean" },
        },
        required: ["topic", "filename", "content"],
      },
      describe: (i) => `Created topics/${slug(str(i.topic))}/${slug(str(i.filename))}.md`,
      run: async (i) => {
        const path = topicPath(`topics/${slug(str(i.topic))}/${slug(str(i.filename))}.md`);
        if (!i.overwrite && (await ws.exists(path))) return `${path} already exists — use append_to_file or set overwrite.`;
        await ws.write(path, str(i.content));
        return `Wrote ${path}`;
      },
    },
    {
      name: "append_to_file",
      description: "Append markdown to the end of an existing file in a topic.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      describe: (i) => `Appended to ${str(i.path)}`,
      run: async (i) => {
        const path = topicPath(str(i.path));
        await ws.append(path, `\n\n${str(i.content).trim()}\n`);
        return `Appended to ${path}`;
      },
    },
    {
      name: "replace_file",
      description: "Replace the whole content of an existing markdown file in a topic. Read it first.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      describe: (i) => `Rewrote ${str(i.path)}`,
      run: async (i) => {
        const path = topicPath(str(i.path));
        if (!(await ws.exists(path))) return `${path} does not exist — use create_file.`;
        await ws.write(path, str(i.content));
        return `Rewrote ${path}`;
      },
    },
  ];
}

export interface SessionHooks {
  appendNotes(markdown: string): Promise<void>;
  rename(title: string): Promise<void>;
  attachTopic(topic: string): Promise<void>;
}

export function sessionTools(ws: Workspace, hooks: SessionHooks): Tool[] {
  return [
    ...topicTools(ws),
    {
      name: "add_to_my_notes",
      description: "Append markdown to the user's own notes for this session (these feed the summary and are saved to the topic).",
      parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
      describe: () => "Added to your notes",
      run: async (i) => {
        await hooks.appendNotes(str(i.content));
        return "Added.";
      },
    },
    {
      name: "rename_session",
      description: "Set this session's title.",
      parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      describe: (i) => `Renamed session to "${str(i.title)}"`,
      run: async (i) => {
        await hooks.rename(str(i.title));
        return "Renamed.";
      },
    },
    {
      name: "attach_topic",
      description: "Link an existing topic to this session so its notes are used and the session summary is saved there.",
      parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
      describe: (i) => `Attached topic ${slug(str(i.topic))}`,
      run: async (i) => {
        const s = slug(str(i.topic));
        if (!(await ws.exists(`topics/${s}`))) return `No topic named ${s}.`;
        await hooks.attachTopic(s);
        return `Attached ${s}.`;
      },
    },
  ];
}

export interface AgentTurn {
  role: "user" | "assistant";
  content: string;
}

/** Runs model ↔ tools until the model answers without calling a tool (or maxSteps). */
export async function runAgent(
  client: ModelClient,
  role: Role,
  opts: { system: string; context?: string; history: AgentTurn[]; question: string; tools: Tool[]; maxSteps?: number; onAction?: (a: AgentAction) => void },
): Promise<{ answer: string; actions: AgentAction[] }> {
  const messages: AgentMessage[] = [
    ...opts.history.slice(-12).map((t): AgentMessage => (t.role === "user" ? { role: "user", content: t.content } : { role: "assistant", text: t.content, calls: [] })),
    { role: "user", content: opts.question },
  ];
  const actions: AgentAction[] = [];
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  for (let stepIndex = 0; stepIndex < (opts.maxSteps ?? 8); stepIndex++) {
    const step = await client.step(role, { system: opts.system, context: opts.context, messages, tools: opts.tools, maxTokens: 2000 });
    messages.push({ role: "assistant", text: step.text, calls: step.calls });
    if (!step.calls.length) return { answer: step.text, actions };
    const results = [];
    for (const call of step.calls) {
      const tool = byName.get(call.name);
      let output: string;
      let ok = true;
      try {
        if (!tool) throw new Error(`Unknown tool ${call.name}`);
        output = await tool.run(call.input);
      } catch (error) {
        ok = false;
        output = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      const action = { tool: call.name, summary: tool ? tool.describe(call.input) : call.name, ok };
      if (!["list_topics", "list_files", "read_file", "search_notes"].includes(call.name) || !ok) {
        actions.push(action);
        opts.onAction?.(action);
      }
      results.push({ id: call.id, name: call.name, output });
    }
    messages.push({ role: "tool", results });
  }
  return { answer: "Stopped after too many tool steps.", actions };
}
