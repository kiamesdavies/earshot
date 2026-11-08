// Connectors: external places a topic can be backed by (Spacesheep, Notion, …),
// reached over MCP. Every MCP server names its tools differently, so each
// connector has an adapter mapping Earshot's four operations onto that
// server's tools. An operation without a mapping falls back to an agent that
// is given the server's tools and asked to do it.

import type { Tool } from "./agent.ts";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

export interface McpCaller {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  tools(): Promise<McpTool[]>;
}

/** Fields that identify one document in a connector, e.g. {space, file} or {pageId}. */
export interface SourceField {
  key: string;
  label: string;
  placeholder?: string;
  /** Offer a dropdown: call this tool (once the other fields are filled) and list values from its result. */
  options?: ToolMapping & { list: string; value: string };
}

/** One adapter operation: which tool, its argument template, and where the answer is. */
export interface ToolMapping {
  tool: string;
  /** Values may contain {placeholders}: source fields, plus content/marker/label/date for writes. */
  args: Record<string, unknown>;
  /** Dotted path to the text in the result (structured content or JSON text). Default: all text content. */
  pick?: string;
  /** Paging: read `from` in each result and send it back as `arg` until it equals one of `done`. */
  next?: { from: string; arg: string; done: string[] };
}

export type WriteMode = "insert-after-marker" | "append";

export interface ConnectorDef {
  id: string;
  name: string;
  url: string;
  description: string;
  source: SourceField[];
  /** URL to open a source in the browser. */
  openUrl?: string;
  read?: ToolMapping;
  write?: Partial<Record<WriteMode, ToolMapping>>;
  /** Tools a post-session agent may use freely (reads). Others are never given to it. */
  readOnlyTools?: string[];
  builtin?: boolean;
}

export interface SourceRef {
  [key: string]: string;
}

export const BUILTIN_CONNECTORS: ConnectorDef[] = [
  {
    id: "spacesheep",
    name: "Spacesheep",
    url: "https://mcp.spacesheep.dev/mcp",
    description: "Spacesheep pages: read a page's file before a session, write the post-session record after.",
    source: [
      { key: "space", label: "Space", placeholder: "@you/page-slug or space id" },
      {
        key: "file",
        label: "File in the space",
        placeholder: "docs/meetings.md",
        options: { tool: "list_files", args: { space: "{space}" }, list: "files", value: "path" },
      },
    ],
    openUrl: "https://spacesheep.dev/{space}{link}",
    read: { tool: "get_file", args: { space: "{space}", file: "{file}" }, pick: "file.content", next: { from: "next_offset", arg: "offset", done: ["0", ""] } },
    write: {
      "insert-after-marker": {
        tool: "create_version",
        args: { space: "{space}", label: "{label}", replacements: [{ path: "{file}", old_string: "{marker}", new_string: "{marker}\n\n{content}\n" }] },
      },
    },
    readOnlyTools: ["get_file", "list_files", "get_space", "list_spaces", "list_versions", "search_spaces"],
    builtin: true,
  },
  {
    id: "notion",
    name: "Notion",
    url: "https://mcp.notion.com/mcp",
    description: "Notion pages. Reads and writes go through an agent until a tool mapping is added.",
    source: [{ key: "page", label: "Page URL or ID", placeholder: "https://www.notion.so/…" }],
    openUrl: "{page}",
    readOnlyTools: ["notion-fetch", "notion-search"],
    builtin: true,
  },
];

/** Replace {placeholders} in strings, recursively through objects and arrays. */
export function fill(template: unknown, vars: Record<string, string>): unknown {
  if (typeof template === "string") {
    // A whole-string placeholder keeps the value as-is; inline ones are interpolated.
    return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? vars[key] : match));
  }
  if (Array.isArray(template)) return template.map((t) => fill(t, vars));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fill(v, vars)]));
  }
  return template;
}

/** All text in an MCP tools/call result. */
export function resultText(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[]; structuredContent?: unknown };
  return (r?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function dig(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), value);
}

/** The document text from a read: structured content, JSON-in-text, or plain text. */
/** A value from a tool result's structured content or its JSON text. */
export function pickValue(result: unknown, path: string): unknown {
  const r = result as { structuredContent?: unknown };
  if (r?.structuredContent !== undefined) {
    const v = dig(r.structuredContent, path);
    if (v !== undefined) return v;
  }
  try {
    return dig(JSON.parse(resultText(result)), path);
  } catch {
    return undefined;
  }
}

export function pickText(result: unknown, pick?: string): string {
  const r = result as { structuredContent?: unknown; isError?: boolean };
  const text = resultText(result);
  if (r?.isError) throw new Error(text || "The tool reported an error");
  if (pick) {
    const structured = r?.structuredContent !== undefined ? dig(r.structuredContent, pick) : undefined;
    if (typeof structured === "string") return structured;
    try {
      const parsed = dig(JSON.parse(text), pick);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* not JSON: the text is the document */
    }
  }
  return text;
}

/**
 * The error in a tool result, or null. Servers report failures either with isError
 * or inside a normal result as JSON ({code: "invalid", message, violations} / {error}).
 */
export function toolFailure(result: unknown): string | null {
  const r = result as { isError?: boolean; structuredContent?: unknown };
  const text = resultText(result);
  if (r?.isError) return text || "The tool reported an error";
  let body: unknown = r?.structuredContent;
  if (body === undefined) {
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as { code?: unknown; error?: unknown; message?: unknown; violations?: unknown; ok?: unknown; success?: unknown };
  const failedCode = typeof b.code === "string" && !/^(ok|success|created|done)$/i.test(b.code) && (b.message !== undefined || b.violations !== undefined);
  if (failedCode || b.error || b.ok === false || b.success === false || (Array.isArray(b.violations) && b.violations.length)) {
    const msg = typeof b.message === "string" ? b.message : typeof b.error === "string" ? b.error : (b.error as { message?: string })?.message;
    return msg || text.slice(0, 300);
  }
  return null;
}

/** Check a call against the tool's published input schema, with an error a person can act on. */
export function checkArgs(tool: McpTool | undefined, name: string, args: Record<string, unknown>): void {
  if (!tool) throw new Error(`The server has no tool named "${name}". Update this connector's mapping (Settings → Integrations).`);
  const required = tool.inputSchema?.required ?? [];
  const missing = required.filter((k) => !(k in args));
  if (missing.length) {
    throw new Error(`"${name}" needs ${missing.join(", ")} but the mapping sends ${Object.keys(args).join(", ") || "nothing"}. Its parameters: ${Object.keys(tool.inputSchema?.properties ?? {}).join(", ")}.`);
  }
}

export class ConnectorClient {
  readonly def: ConnectorDef;
  private mcp: McpCaller;
  private toolCache: Promise<McpTool[]> | null = null;

  constructor(def: ConnectorDef, mcp: McpCaller) {
    this.def = def;
    this.mcp = mcp;
  }

  tools(): Promise<McpTool[]> {
    return (this.toolCache ??= this.mcp.tools());
  }

  private async run(mapping: ToolMapping, vars: Record<string, string>): Promise<unknown> {
    const args = fill(mapping.args, vars) as Record<string, unknown>;
    checkArgs((await this.tools()).find((t) => t.name === mapping.tool), mapping.tool, args);
    const result = await this.mcp.call(mapping.tool, args);
    const failure = toolFailure(result);
    if (failure) throw new Error(`${this.def.name} refused ${mapping.tool}: ${failure}`);
    return result;
  }

  /** Pull a source as markdown, following pages if the server splits large files. */
  async read(source: SourceRef): Promise<string> {
    const mapping = this.def.read;
    if (!mapping) throw new NeedsAgent("read");
    let text = "";
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const args = fill(mapping.args, source) as Record<string, unknown>;
      if (cursor !== undefined && mapping.next) args[mapping.next.arg] = cursor;
      checkArgs((await this.tools()).find((t) => t.name === mapping.tool), mapping.tool, args);
      const result = await this.mcp.call(mapping.tool, args);
      const failure = toolFailure(result);
      if (failure) throw new Error(`${this.def.name} refused ${mapping.tool}: ${failure}`);
      text += pickText(result, mapping.pick);
      const next = mapping.next ? pickValue(result, mapping.next.from) : undefined;
      if (next === undefined || next === null || mapping.next!.done.includes(String(next))) return text;
      cursor = String(next);
    }
    return text;
  }

  /** Choices for a source field (e.g. the files in a space), or null when the field is free text. */
  async options(fieldKey: string, source: SourceRef): Promise<string[] | null> {
    const field = this.def.source.find((f) => f.key === fieldKey);
    if (!field?.options) return null;
    const result = await this.run(field.options, source);
    const list = pickValue(result, field.options.list);
    if (!Array.isArray(list)) return [];
    return list.map((item) => (typeof item === "string" ? item : String((item as Record<string, unknown>)[field.options!.value] ?? ""))).filter(Boolean);
  }

  /** Check a write would be accepted (tool exists, arguments match its schema) without sending it. */
  async validateWrite(source: SourceRef, mode: WriteMode, extra: Record<string, string>): Promise<{ tool: string; args: Record<string, unknown> }> {
    const mapping = this.def.write?.[mode];
    if (!mapping) throw new NeedsAgent("write");
    const args = fill(mapping.args, { ...source, ...extra, content: "(test)" }) as Record<string, unknown>;
    checkArgs((await this.tools()).find((t) => t.name === mapping.tool), mapping.tool, args);
    return { tool: mapping.tool, args };
  }

  async write(source: SourceRef, content: string, mode: WriteMode, extra: Record<string, string>): Promise<string> {
    const mapping = this.def.write?.[mode];
    if (!mapping) throw new NeedsAgent("write");
    return resultText(await this.run(mapping, { ...source, ...extra, content }));
  }

  /** The server's tools as agent tools. `allowWrites` false keeps only the adapter's read-only list. */
  async agentTools(allowWrites = false): Promise<Tool[]> {
    const allowed = new Set(this.def.readOnlyTools ?? []);
    const looksReadOnly = (name: string) => allowed.has(name) || (!allowed.size && /^(get|list|read|search|fetch|query|find)/i.test(name));
    return (await this.tools())
      .filter((t) => allowWrites || looksReadOnly(t.name))
      .map((t) => ({
        name: `${this.def.id}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
        description: `[${this.def.name}] ${t.description ?? t.name}`.slice(0, 1000),
        parameters: { type: "object" as const, properties: t.inputSchema?.properties ?? {}, required: t.inputSchema?.required ?? [] },
        describe: () => `${this.def.name}: ${t.name}`,
        run: async (input) => resultText(await this.mcp.call(t.name, input)).slice(0, 20_000) || "(empty result)",
      }));
  }
}

/** Undo macOS smart punctuation in a typed marker ("—" for "--", curly quotes). */
export function normaliseMarker(marker: string): string {
  return marker.replace(/—/g, "--").replace(/–/g, "--").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
}

/** HTML comment lines in a document: candidate markers to offer in a dropdown. */
export function markerCandidates(doc: string): string[] {
  return [...new Set(doc.split("\n").map((l) => l.trim()).filter((l) => /^<!--.*-->$/.test(l) && !/^<!-- meeting: /.test(l)))];
}

/** Thrown when an operation has no tool mapping; the caller runs the agent fallback instead. */
export class NeedsAgent extends Error {
  constructor(op: string) {
    super(`No ${op} mapping`);
  }
}

export function openLink(def: ConnectorDef, source: SourceRef, link = ""): string | null {
  if (!def.openUrl) return null;
  return fill(def.openUrl, { ...source, link }) as string;
}

/** A topic backed by a connector: topics/<slug>/topic.json */
export interface TopicBinding {
  connector: string;
  source: SourceRef;
  /** Anchor or path appended to the open link, e.g. "#agenda". */
  link?: string;
  pull: "on-session-start" | "manual";
  postHook?: PostHook;
  lastPulledAt?: string;
}

export interface PostHook {
  /** Folder (or SKILL.md path) of the skill that turns a session into the record. */
  skill: string;
  /** How an approved draft is written back. */
  write: WriteMode;
  /** For insert-after-marker: the line the new record goes under. */
  marker?: string;
  /** Version label template, e.g. "Meeting {date}". */
  label?: string;
  /** Where Open goes after publishing, e.g. "#meeting-{isoDate}" (the new meeting's page). */
  publishedLink?: string;
}
