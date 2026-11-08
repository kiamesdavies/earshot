// Shared types for the live pipeline. Everything in src/core is free of Tauri
// imports so the replay harness can run it under plain Node.

export type Speaker = "me" | "them";

export interface Segment {
  id: string;
  speaker: Speaker;
  text: string;
  /** Seconds from session start. */
  start: number;
  end: number;
  final: boolean;
}

export type SuggestionKind = "question" | "connection" | "fact" | "commitment";

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  text: string;
  why: string;
  source?: string;
  /** Session time (s) the suggestion appeared on screen. */
  at: number;
  /** Session time (s) the triggering speech ended. */
  triggerEnd: number;
  /** at - triggerEnd. */
  latency: number;
  /** Wall-clock model time for gate + suggester. */
  modelMs: number;
  dismissed?: boolean;
  pinned?: boolean;
}

/** A moment the user marked as "I wanted a nudge here" — the eval ground truth. */
export interface Moment {
  t: number;
  note?: string;
  kind?: SuggestionKind;
}

export interface TraceEvent {
  t: number;
  type: "trigger" | "prefilter-skip" | "gate-skip" | "gate-speak" | "suggest" | "suggest-skip" | "error";
  reason?: string;
  modelMs?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: number;
  /** Tool actions the assistant took while answering, e.g. "Created topics/acme/pricing.md". */
  actions?: { summary: string; ok: boolean }[];
}

export interface SessionMeta {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  durationSec?: number;
  topics: string[];
  goal: string;
  app?: string;
  locale: string;
  /** True until the user (or auto-title) gives the session a real name. */
  autoTitle?: boolean;
  /** Which model/provider handled each job, e.g. {gate: "claude-haiku-5.5 · OpenRouter"}. */
  models?: Record<string, string>;
}
