// The "should I speak now" pipeline.
//
//   transcript ──► trigger (free, deterministic) ──► gate (cheap model) ──► suggester (stronger model + retrieval)
//
// Triggers fire at turn-ends: the other person stopped talking (silence after a
// final "them" segment) or asked a question. A periodic trigger catches gaps and
// commitments during long stretches. The gate defaults to silence; a copilot
// that is wrong most of the time gets switched off.

import { extractJson, type Completion, type CompletionRequest, type Role } from "./providers.ts";
import type { Retriever } from "./retrieval.ts";
import type { Segment, Suggestion, SuggestionKind, TraceEvent } from "./types.ts";

export interface CopilotConfig {
  /** Silence after the other side's last final segment before we consider it a turn-end. */
  turnSilence: number;
  /** Minimum seconds between surfaced suggestions. */
  cooldown: number;
  /** Seconds between periodic checks when there is new talk. */
  periodic: number;
  /** Minimum words the other side must have said this turn (unless they asked a question). */
  minTurnWords: number;
  /** Seconds of transcript the models see. */
  window: number;
}

export const DEFAULT_COPILOT_CONFIG: CopilotConfig = {
  turnSilence: 1.2,
  cooldown: 20,
  periodic: 120,
  minTurnWords: 6,
  window: 240,
};

export interface CopilotDeps {
  complete(role: Role, req: CompletionRequest): Promise<Completion>;
  retriever: Retriever;
  /** What the user wants from this call (typed at session start). */
  goal: string;
  /** User's name, so the model knows who "me" is. */
  userName?: string;
  config?: Partial<CopilotConfig>;
}

export interface Trigger {
  t: number;
  kind: "turn" | "question" | "periodic";
  segment?: Segment;
  triggerEnd: number;
}

interface GateDecision {
  speak: boolean;
  kind?: SuggestionKind;
  need?: string;
  query?: string;
}

interface SuggesterReply {
  skip?: boolean;
  kind?: SuggestionKind;
  text?: string;
  why?: string;
  source?: string;
}

const KINDS: SuggestionKind[] = ["question", "connection", "fact", "commitment"];

export class Copilot {
  readonly config: CopilotConfig;
  readonly segments: Segment[] = [];
  readonly suggestions: Suggestion[] = [];
  readonly trace: TraceEvent[] = [];
  private deps: CopilotDeps;
  private lastActivity = 0;
  private lastEvaluatedId: string | null = null;
  private lastSurfaced = -Infinity;
  private lastPeriodic = 0;
  private lastPeriodicCount = 0;
  private busy = false;
  private seq = 0;

  constructor(deps: CopilotDeps) {
    this.deps = deps;
    this.config = { ...DEFAULT_COPILOT_CONFIG, ...deps.config };
  }

  get inFlight(): boolean {
    return this.busy;
  }

  /** Swap the notes the copilot draws on (a topic was attached mid-call). */
  setRetriever(retriever: Retriever): void {
    this.deps = { ...this.deps, retriever };
  }

  /** Feed every segment, volatile or final. Volatile ones only count as activity. */
  addSegment(segment: Segment, now: number): void {
    this.lastActivity = Math.max(this.lastActivity, now);
    if (!segment.final) return;
    const existing = this.segments.findIndex((s) => s.id === segment.id);
    if (existing >= 0) this.segments[existing] = segment;
    else this.segments.push(segment);
  }

  /** Cheap and synchronous: is there something worth sending to the gate right now? */
  check(now: number): Trigger | null {
    if (this.busy || now - this.lastSurfaced < this.config.cooldown) return null;
    const last = this.segments[this.segments.length - 1];
    if (last && last.speaker === "them" && last.id !== this.lastEvaluatedId) {
      const asked = /\?\s*$/.test(last.text);
      const silent = now - Math.max(last.end, this.lastActivity) >= this.config.turnSilence;
      if (asked || silent) {
        this.lastEvaluatedId = last.id;
        const words = this.currentTurn().join(" ").split(/\s+/).filter(Boolean).length;
        if (!asked && words < this.config.minTurnWords) {
          this.trace.push({ t: now, type: "prefilter-skip", reason: `short turn (${words} words)` });
          return null;
        }
        return { t: now, kind: asked ? "question" : "turn", segment: last, triggerEnd: last.end };
      }
    }
    if (now - this.lastPeriodic >= this.config.periodic && this.segments.length - this.lastPeriodicCount >= 4) {
      this.lastPeriodic = now;
      this.lastPeriodicCount = this.segments.length;
      return { t: now, kind: "periodic", triggerEnd: last?.end ?? now };
    }
    return null;
  }

  /**
   * Runs gate + suggester. `clock` returns current session time, so the same
   * code measures real latency live and in the replay harness.
   */
  async evaluate(trigger: Trigger, clock: () => number): Promise<Suggestion | null> {
    this.busy = true;
    this.trace.push({ t: trigger.t, type: "trigger", reason: trigger.kind });
    try {
      const transcript = this.transcript(trigger.t);
      const turnText = trigger.kind === "periodic" ? transcript.slice(-1200) : this.currentTurn().join(" ");
      const preHits = this.deps.retriever.search(turnText, 3);

      const gate = await this.deps.complete("gate", {
        system: GATE_SYSTEM,
        messages: [{ role: "user", content: this.gatePrompt(trigger, transcript, preHits.map((h) => `${h.path} › ${h.heading}`)) }],
        maxTokens: 120,
        temperature: 0,
      });
      const decision = extractJson<GateDecision>(gate.text);
      if (!decision?.speak) {
        const reason = decision ? (decision.need ?? "silent") : `unparseable: ${gate.text.slice(0, 160)}`;
        this.trace.push({ t: clock(), type: "gate-skip", reason, modelMs: gate.ms });
        return null;
      }
      this.trace.push({ t: clock(), type: "gate-speak", reason: `${decision.kind}: ${decision.need ?? ""}`, modelMs: gate.ms });

      const hits = this.deps.retriever.search(`${decision.query ?? ""} ${turnText}`, 4);
      const context = hits.length
        ? hits.map((h) => `<doc path="${h.path}" section="${h.heading}">\n${h.text}\n</doc>`).join("\n")
        : "(no matching notes)";
      const reply = await this.deps.complete("suggest", {
        system: SUGGEST_SYSTEM,
        messages: [{ role: "user", content: this.suggestPrompt(decision, transcript, context) }],
        maxTokens: 200,
        temperature: 0.3,
      });
      const parsed = extractJson<SuggesterReply>(reply.text);
      const modelMs = gate.ms + reply.ms;
      if (!parsed || parsed.skip || !parsed.text) {
        this.trace.push({ t: clock(), type: "suggest-skip", reason: "suggester declined", modelMs });
        return null;
      }
      const at = clock();
      const suggestion: Suggestion = {
        id: `s${++this.seq}`,
        kind: KINDS.includes(parsed.kind as SuggestionKind) ? (parsed.kind as SuggestionKind) : (decision.kind ?? "question"),
        text: parsed.text.trim(),
        why: (parsed.why ?? decision.need ?? "").trim(),
        source: parsed.source || undefined,
        at,
        triggerEnd: trigger.triggerEnd,
        latency: at - trigger.triggerEnd,
        modelMs,
      };
      this.suggestions.push(suggestion);
      this.lastSurfaced = at;
      this.trace.push({ t: at, type: "suggest", reason: suggestion.text, modelMs });
      return suggestion;
    } catch (error) {
      this.trace.push({ t: clock(), type: "error", reason: String(error) });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  /** The other side's consecutive segments since "me" last spoke. */
  private currentTurn(): string[] {
    const turn: string[] = [];
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const s = this.segments[i];
      if (s.speaker !== "them") break;
      turn.unshift(s.text);
    }
    return turn;
  }

  transcript(now: number, window = this.config.window): string {
    return formatTranscript(this.segments.filter((s) => s.end >= now - window));
  }

  private recentSuggestions(): string {
    const recent = this.suggestions.slice(-6);
    return recent.length ? recent.map((s) => `- [${s.kind}] ${s.text}`).join("\n") : "(none yet)";
  }

  private gatePrompt(trigger: Trigger, transcript: string, related: string[]): string {
    return [
      `<goal>${this.deps.goal || "(not stated)"}</goal>`,
      `<me>${this.deps.userName ?? "the user"} (lines marked ME)</me>`,
      `<notes_outline>\n${this.deps.retriever.outline() || "(no notes attached)"}\n</notes_outline>`,
      `<possibly_related_notes>\n${related.join("\n") || "(none)"}\n</possibly_related_notes>`,
      `<already_suggested>\n${this.recentSuggestions()}\n</already_suggested>`,
      `<transcript>\n${transcript}\n</transcript>`,
      `Trigger: ${trigger.kind === "question" ? "THEM just asked a question" : trigger.kind === "turn" ? "THEM just finished a turn" : "periodic check"}.`,
      `Reply with JSON only.`,
    ].join("\n\n");
  }

  private suggestPrompt(decision: GateDecision, transcript: string, context: string): string {
    return [
      `<goal>${this.deps.goal || "(not stated)"}</goal>`,
      `<gate_decision kind="${decision.kind}">${decision.need ?? ""}</gate_decision>`,
      `<notes>\n${context}\n</notes>`,
      `<already_suggested>\n${this.recentSuggestions()}\n</already_suggested>`,
      `<transcript>\n${transcript}\n</transcript>`,
      `Reply with JSON only.`,
    ].join("\n\n");
  }
}

export function formatTranscript(segments: Segment[]): string {
  return segments.map((s) => `[${clock(s.start)}] ${s.speaker === "me" ? "ME" : "THEM"}: ${s.text}`).join("\n");
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const GATE_SYSTEM = `You decide whether a live-call assistant should interrupt the user (ME) with one short on-screen nudge, right now, mid-call.

Default to silence. Only speak when a nudge would clearly change what ME says next:
- question: THEM said something vague, surprising, or consequential that ME should probe before the moment passes, and ME hasn't already asked.
- connection: what THEM said relates to something specific in ME's notes (see outline / related notes) that ME may not remember.
- fact: THEM asked something or claimed something that ME's notes answer or contradict.
- commitment: someone just committed to a deliverable, date, number, or decision that should be pinned down.

Stay silent for: small talk, ME already handling it, anything already suggested, generic advice ("ask for more detail"), restating what was said.

Output exactly one JSON object:
{"speak": false, "need": "<why silent, 5 words>"}
or
{"speak": true, "kind": "question|connection|fact|commitment", "need": "<what ME needs, <=12 words>", "query": "<keywords to search ME's notes>"}`;

const SUGGEST_SYSTEM = `You write one nudge for a person (ME) in a live call. They will glance at it for two seconds while listening.

Rules:
- text: <= 22 words. For a question, write the exact question ME could ask, in ME's voice. For a connection/fact, state the specific detail from the notes (names, numbers, dates). For a commitment, the precise thing to confirm.
- why: <= 12 words, the reason it matters now.
- source: the notes path you used, or "" if none.
- Never invent facts that are not in the notes or transcript. Copy names, numbers and dates exactly as written there; never add a month, year or figure that isn't stated. If the notes don't support a connection/fact, or you can't beat what ME would think of anyway, return {"skip": true}.
- Do not repeat anything in already_suggested.

Output exactly one JSON object: {"kind": "...", "text": "...", "why": "...", "source": "..."} or {"skip": true}`;
