// Bring-your-own-model layer. Three wire formats cover everything:
//  - Anthropic Messages API (with prompt caching for topic context)
//  - OpenAI-compatible chat completions (OpenAI, OpenRouter, Ollama, LM Studio, Groq, ...)
//  - A locally installed CLI (claude, codex, kiro-cli, or any command) using the user's own login
//
// `complete` is single-shot text. `step` adds tool calling: native tool APIs for
// the HTTP providers, and a tagged-JSON protocol for CLIs.

export type ProviderKind = "anthropic" | "openai" | "cli";

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  /** Keychain account holding the API key; absent for keyless local servers. */
  secret?: string;
  /** CLI: binary name or full path. */
  command?: string;
  /**
   * CLI: argument template. `{model}` is replaced by the model (and the flag
   * before it dropped when the model is empty); `{prompt}` by the prompt. With
   * no `{prompt}` the prompt is written to stdin.
   */
  args?: string[];
}

export type Role = "gate" | "suggest" | "summarize" | "chat";

export interface RoleConfig {
  providerId: string;
  model: string;
}

export interface ModelSettings {
  providers: ProviderConfig[];
  roles: Record<Role, RoleConfig>;
}

export interface Transport {
  fetch: typeof fetch;
  runCli(command: string, args: string[], stdin: string): Promise<string>;
  getSecret(name: string): Promise<string | null>;
}

export interface CompletionRequest {
  system: string;
  /** Large, stable context (topic docs). Cached where the provider supports it. */
  context?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  temperature?: number;
  /** Let the model think before answering. Off for the latency-critical live path. */
  reasoning?: boolean;
}

export interface Completion {
  text: string;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

// ---- tool calling ----

export interface ToolSpec {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; calls: ToolCall[] }
  | { role: "tool"; results: { id: string; name: string; output: string }[] };

export interface StepRequest {
  system: string;
  context?: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  maxTokens: number;
}

export interface StepResult {
  text: string;
  calls: ToolCall[];
  ms: number;
}

export const CLI_PRESETS: Record<string, { command: string; args: string[]; note: string }> = {
  claude: {
    command: "claude",
    args: ["-p", "--output-format", "text", "--model", "{model}"],
    note: "Claude Code. Prompt goes on stdin. Model: sonnet, opus, haiku or a full id; empty uses your default.",
  },
  codex: {
    command: "codex",
    args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--model", "{model}", "-"],
    note: "Codex, in a read-only sandbox (file changes go through Earshot's own tools). Prompt goes on stdin. With a ChatGPT login, pick a supported model, e.g. gpt-5.6-terra.",
  },
  kiro: {
    command: "kiro-cli",
    args: ["chat", "--no-interactive", "--wrap", "never", "{prompt}"],
    note: "Kiro CLI. Uses the model selected in Kiro. Needs `kiro-cli login` (or KIRO_API_KEY in your shell).",
  },
};

export const PROVIDER_PRESETS: ProviderConfig[] = [
  { id: "anthropic", name: "Anthropic API", kind: "anthropic", baseUrl: "https://api.anthropic.com", secret: "anthropic" },
  { id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", secret: "openrouter" },
  { id: "openai", name: "OpenAI API", kind: "openai", baseUrl: "https://api.openai.com/v1", secret: "openai" },
  { id: "ollama", name: "Ollama (local)", kind: "openai", baseUrl: "http://localhost:11434/v1" },
  { id: "lmstudio", name: "LM Studio (local)", kind: "openai", baseUrl: "http://localhost:1234/v1" },
  { id: "claude-cli", name: "Claude Code CLI", kind: "cli", command: CLI_PRESETS.claude.command, args: CLI_PRESETS.claude.args },
  { id: "codex-cli", name: "Codex CLI", kind: "cli", command: CLI_PRESETS.codex.command, args: CLI_PRESETS.codex.args },
  { id: "kiro-cli", name: "Kiro CLI", kind: "cli", command: CLI_PRESETS.kiro.command, args: CLI_PRESETS.kiro.args },
];

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  providers: PROVIDER_PRESETS,
  roles: {
    gate: { providerId: "openrouter", model: "anthropic/claude-haiku-5.5" },
    suggest: { providerId: "openrouter", model: "anthropic/claude-haiku-5.5" },
    summarize: { providerId: "openrouter", model: "anthropic/claude-sonnet-5.5" },
    chat: { providerId: "openrouter", model: "anthropic/claude-sonnet-5.5" },
  },
};

/** Short human label, e.g. "claude-haiku-5.5 · OpenRouter". */
export function describeRole(settings: ModelSettings, role: Role): string {
  const r = settings.roles[role];
  const p = settings.providers.find((x) => x.id === r.providerId);
  const model = r.model ? r.model.split("/").pop() : "default model";
  return `${model} · ${p?.name ?? r.providerId}`;
}

export class ModelClient {
  private settings: ModelSettings;
  private transport: Transport;

  constructor(settings: ModelSettings, transport: Transport) {
    this.settings = settings;
    this.transport = transport;
  }

  provider(role: Role): { provider: ProviderConfig; model: string } {
    const roleConfig = this.settings.roles[role];
    const provider = this.settings.providers.find((p) => p.id === roleConfig.providerId);
    if (!provider) throw new Error(`No provider "${roleConfig.providerId}" configured for ${role}`);
    return { provider, model: roleConfig.model };
  }

  async complete(role: Role, req: CompletionRequest): Promise<Completion> {
    const { provider, model } = this.provider(role);
    return this.completeWith(provider, model, req);
  }

  /** Used by Settings → Test for a provider that isn't assigned to any role yet. */
  async completeWith(provider: ProviderConfig, model: string, req: CompletionRequest): Promise<Completion> {
    const started = Date.now();
    const result =
      provider.kind === "anthropic"
        ? await this.anthropic(provider, model, req)
        : provider.kind === "openai"
          ? await this.openai(provider, model, req)
          : { text: await this.cli(provider, model, flatten(req.system, req.context, req.messages.map((m) => [m.role, m.content]))) };
    return { ...result, ms: Date.now() - started };
  }

  /** One model turn that may request tool calls. */
  async step(role: Role, req: StepRequest): Promise<StepResult> {
    const { provider, model } = this.provider(role);
    const started = Date.now();
    const result =
      provider.kind === "anthropic"
        ? await this.anthropicStep(provider, model, req)
        : provider.kind === "openai"
          ? await this.openaiStep(provider, model, req)
          : await this.cliStep(provider, model, req);
    return { ...result, ms: Date.now() - started };
  }

  private async key(provider: ProviderConfig): Promise<string | null> {
    if (!provider.secret) return null;
    const key = await this.transport.getSecret(provider.secret);
    if (!key) throw new Error(`No API key saved for ${provider.name}. Add one in Settings → Models → Providers.`);
    return key;
  }

  // ---- Anthropic ----

  private async anthropicPost(provider: ProviderConfig, body: object) {
    const key = await this.key(provider);
    const res = await this.transport.fetch(`${trimSlash(provider.baseUrl ?? "https://api.anthropic.com")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) },
      body: JSON.stringify(body),
    });
    return readJson(res, provider);
  }

  private anthropicSystem(system: string, context?: string) {
    const blocks: object[] = [{ type: "text", text: system }];
    if (context) blocks.push({ type: "text", text: context, cache_control: { type: "ephemeral" } });
    return blocks;
  }

  private async anthropic(provider: ProviderConfig, model: string, req: CompletionRequest): Promise<Omit<Completion, "ms">> {
    const body = await this.anthropicPost(provider, {
      model,
      system: this.anthropicSystem(req.system, req.context),
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.3,
      ...(req.reasoning ? {} : { thinking: { type: "disabled" } }),
    });
    return {
      text: anthropicText(body),
      inputTokens: body.usage?.input_tokens,
      outputTokens: body.usage?.output_tokens,
      cachedTokens: body.usage?.cache_read_input_tokens,
    };
  }

  private async anthropicStep(provider: ProviderConfig, model: string, req: StepRequest) {
    const messages = req.messages.map((m) =>
      m.role === "user"
        ? { role: "user", content: m.content }
        : m.role === "assistant"
          ? {
              role: "assistant",
              content: [
                ...(m.text ? [{ type: "text", text: m.text }] : []),
                ...m.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
              ],
            }
          : { role: "user", content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.output })) },
    );
    const body = await this.anthropicPost(provider, {
      model,
      system: this.anthropicSystem(req.system, req.context),
      messages,
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      max_tokens: req.maxTokens,
      thinking: { type: "disabled" },
    });
    const calls: ToolCall[] = (body.content ?? [])
      .filter((b: { type: string }) => b.type === "tool_use")
      .map((b: { id: string; name: string; input: Record<string, unknown> }) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
    return { text: anthropicText(body), calls };
  }

  // ---- OpenAI-compatible ----

  private async openaiPost(provider: ProviderConfig, body: Record<string, unknown>, reasoning?: boolean) {
    const key = await this.key(provider);
    const res = await this.transport.fetch(`${trimSlash(provider.baseUrl ?? "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(provider.id === "openrouter" ? { "X-Title": "Earshot" } : {}),
      },
      body: JSON.stringify({
        ...body,
        // OpenRouter routes many reasoning models that otherwise spend the whole budget thinking.
        ...(provider.id === "openrouter" && !reasoning ? { reasoning: { enabled: false } } : {}),
      }),
    });
    const json = await readJson(res, provider);
    const choice = json.choices?.[0];
    if (!choice?.message?.content && !choice?.message?.tool_calls?.length && choice?.finish_reason === "length") {
      throw new Error(`${provider.name}: ran out of tokens before answering (reasoning model?) — pick a non-reasoning model`);
    }
    return json;
  }

  private async openai(provider: ProviderConfig, model: string, req: CompletionRequest): Promise<Omit<Completion, "ms">> {
    const system = req.context ? `${req.system}\n\n${req.context}` : req.system;
    const body = await this.openaiPost(
      provider,
      { model, messages: [{ role: "system", content: system }, ...req.messages], max_tokens: req.maxTokens, temperature: req.temperature ?? 0.3 },
      req.reasoning,
    );
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
      cachedTokens: body.usage?.prompt_tokens_details?.cached_tokens,
    };
  }

  private async openaiStep(provider: ProviderConfig, model: string, req: StepRequest) {
    const system = req.context ? `${req.system}\n\n${req.context}` : req.system;
    const messages: object[] = [{ role: "system", content: system }];
    for (const m of req.messages) {
      if (m.role === "user") messages.push({ role: "user", content: m.content });
      else if (m.role === "assistant")
        messages.push({
          role: "assistant",
          content: m.text || null,
          ...(m.calls.length
            ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
            : {}),
        });
      else for (const r of m.results) messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
    }
    const body = await this.openaiPost(provider, {
      model,
      messages,
      tools: req.tools.map((t) => ({ type: "function", function: t })),
      max_tokens: req.maxTokens,
    });
    const message = body.choices?.[0]?.message ?? {};
    const calls: ToolCall[] = (message.tool_calls ?? []).map((c: { id: string; function: { name: string; arguments: string } }) => ({
      id: c.id,
      name: c.function.name,
      input: safeParse(c.function.arguments),
    }));
    return { text: message.content ?? "", calls };
  }

  // ---- CLI ----

  private async cli(provider: ProviderConfig, model: string, prompt: string): Promise<string> {
    const template = provider.args ?? ["{prompt}"];
    const args: string[] = [];
    let usesPrompt = false;
    for (const arg of template) {
      if (arg.includes("{model}") && !model) {
        // Drop the value and the flag right before it ("--model {model}").
        if (args.length && args[args.length - 1].startsWith("-")) args.pop();
        continue;
      }
      if (arg.includes("{prompt}")) usesPrompt = true;
      args.push(arg.replace("{model}", model).replace("{prompt}", prompt));
    }
    const command = provider.command ?? "claude";
    try {
      const out = await this.transport.runCli(command, args, usesPrompt ? "" : prompt);
      return out.trim();
    } catch (error) {
      const message = String(error);
      if (/oauth|authenticat|log ?in|not logged|unauthori[sz]ed|expired/i.test(message)) {
        const name = command.split("/").pop();
        throw new Error(`${provider.name} isn't logged in (${message.replace(/^Error: /, "").slice(0, 120)}). Open Terminal, run \`${name}\` and log in${name === "claude" ? " with /login" : ""}, then press Test.`);
      }
      throw error;
    }
  }

  private async cliStep(provider: ProviderConfig, model: string, req: StepRequest) {
    const toolHelp = req.tools.length
      ? `\n\nYou can use these tools. To call one, reply with one or more blocks exactly like:\n<tool_call>{"name": "tool_name", "input": {...}}</tool_call>\nThen stop — results come back in the next message. When you are done, answer normally with no <tool_call> block.\n\nTools:\n${req.tools
          .map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.parameters)}`)
          .join("\n")}`
      : "";
    const turns: [string, string][] = req.messages.map((m) =>
      m.role === "user"
        ? ["user", m.content]
        : m.role === "assistant"
          ? ["assistant", [m.text, ...m.calls.map((c) => `<tool_call>${JSON.stringify({ name: c.name, input: c.input })}</tool_call>`)].filter(Boolean).join("\n")]
          : ["user", m.results.map((r) => `<tool_result name="${r.name}">\n${r.output}\n</tool_result>`).join("\n")],
    );
    const text = await this.cli(provider, model, flatten(req.system + toolHelp, req.context, turns));
    const calls: ToolCall[] = [];
    const cleaned = text.replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (_, json: string) => {
      const parsed = safeParse(json) as { name?: string; input?: Record<string, unknown> };
      if (parsed.name) calls.push({ id: `cli-${Date.now()}-${calls.length}`, name: parsed.name, input: parsed.input ?? {} });
      return "";
    });
    return { text: cleaned.trim(), calls };
  }
}

function flatten(system: string, context: string | undefined, turns: [string, string][]): string {
  return [system, context ?? "", ...turns.map(([role, content]) => `${role === "user" ? "USER" : "ASSISTANT"}:\n${content}`)]
    .filter(Boolean)
    .join("\n\n");
}

function anthropicText(body: { content?: { type: string; text?: string }[] }): string {
  return (body.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

function safeParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function readJson(res: Response, provider: ProviderConfig) {
  const raw = await res.text();
  if (!res.ok) throw new Error(`${provider.name} ${res.status}: ${raw.slice(0, 300)}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${provider.name} returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

/** Pull the first JSON object out of a model reply (tolerates code fences and chatter). */
export function extractJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
