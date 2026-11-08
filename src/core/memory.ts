// Topic memory: the topic's "brain". Every call linked to a topic is saved as
// its own session note, and those pile up. Instead of feeding all of them to
// the model (and silently dropping the oldest when they no longer fit), each
// topic keeps one living file, memory.md, that every new call is folded into:
// people, facts, decisions, open loops, a timeline, and lessons about how these
// calls go. Context for a call = memory.md + prep docs + the last few session
// notes in full. Older sessions stay on disk and in search, but the model
// reads them through the memory. This is compaction, done once per call,
// written as markdown the user can read and correct.

import type { Completion, CompletionRequest, Role } from "./providers.ts";
import type { Doc } from "./retrieval.ts";
import type { Moment } from "./types.ts";

type Complete = (role: Role, req: CompletionRequest) => Promise<Completion>;

export const MEMORY_FILE = "memory.md";
export const memoryPath = (slug: string) => `topics/${slug}/${MEMORY_FILE}`;
export const topicSettingsPath = (slug: string) => `topics/${slug}/topic-settings.json`;

/** Per-topic choices: how its summaries look and how it remembers. */
export interface TopicSettings {
  /** Skill folder or .md file whose instructions define this topic's summary format. */
  summarySkill?: string;
  /** Or: the format written inline. Used when no skill is set. */
  summaryFormat?: string;
  /** Keep memory.md up to date after each call. Default true. */
  memory?: boolean;
}

export const isMemoryDoc = (path: string) => path.endsWith(`/${MEMORY_FILE}`) && !path.includes("/sessions/") && !path.includes("/linked/");
export const isSessionDoc = (path: string) => path.includes("/sessions/");

export interface SessionForMemory {
  title: string;
  date: string;
  /** The summary written for this topic. */
  notes: string;
  myNotes?: string;
  /** Points where the user bookmarked "I wished I had help here". */
  moments?: Moment[];
  /** Source file, cited in the memory. */
  file?: string;
}

/** Fold one call into the topic's memory. Returns the new memory.md. */
export async function foldIntoMemory(complete: Complete, topic: string, memory: string, session: SessionForMemory, prep = ""): Promise<string> {
  const reply = await complete("summarize", {
    system: MEMORY_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `<topic name="${topic}">`,
          prep.trim() ? `<prep_docs>\n${prep.trim().slice(0, 20_000)}\n</prep_docs>` : "",
          `<current_memory>\n${memory.trim() || "(empty: this is the first call folded in)"}\n</current_memory>`,
          `<new_call title="${session.title}" date="${session.date}"${session.file ? ` file="${session.file}"` : ""}>`,
          session.notes.trim(),
          session.myNotes?.trim() ? `<my_notes>\n${session.myNotes.trim()}\n</my_notes>` : "",
          session.moments?.length ? `<wished_for_help>\n${session.moments.map((m) => `- at ${Math.round(m.t)}s${m.note ? `: ${m.note}` : ""}`).join("\n")}\n</wished_for_help>` : "",
          `</new_call>`,
          `</topic>`,
          "Write the updated memory.md now.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    maxTokens: 5000,
    reasoning: true,
  });
  return cleanMemory(reply.text, topic);
}

function cleanMemory(text: string, topic: string): string {
  let out = text.trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, "$1").trim();
  if (!out.startsWith("# ")) out = `# ${topic}: memory\n\n${out}`;
  return `${out}\n`;
}

/**
 * Topic docs as one context block, compacted: memory first, then prep docs,
 * then the newest `recent` session notes in full. Older sessions are left to
 * the memory (and to search) instead of being cut off at an arbitrary length.
 */
export function compactTopicDocs(docs: Doc[], recent = 3): { docs: Doc[]; folded: number } {
  const memory = docs.filter((d) => isMemoryDoc(d.path));
  if (!memory.length) return { docs, folded: 0 };
  const prep = docs.filter((d) => !isMemoryDoc(d.path) && !isSessionDoc(d.path));
  const sessions = docs.filter((d) => isSessionDoc(d.path)).sort((a, b) => b.path.localeCompare(a.path));
  return { docs: [...memory, ...prep, ...sessions.slice(0, recent)], folded: Math.max(0, sessions.length - recent) };
}

const MEMORY_SYSTEM = `You maintain memory.md: the long-term memory of one topic (a person, deal, project or team ME has recurring calls about). It is read before every future call on this topic, by ME, by the live copilot, and possibly by other people and AI agents. It replaces re-reading every past call, so it must hold everything that still matters.

You get the current memory and one new call. Return the complete updated memory.md. Merge, don't append: update facts in place, move closed items out of "Open loops", note what changed. Never paste transcript. Keep it under about 1,500 words; when it grows, compress the oldest, least useful detail first, never names, numbers, dates or commitments that are still live.

Use exactly these sections:
# <Topic>: memory
_Updated <date of the new call> · <N> calls folded in_
## In one line
Where things stand now.
## People
Name, role, what they care about, how they like to work.
## Facts and numbers
Exact as said, with the date learned, e.g. "Pick accuracy target 98.5% (2026-10-20)".
## Decisions so far
## Open loops
- [ ] Owner, what, due date. Remove when done (mention it under the timeline instead).
## What changed
Reversals and contradictions, old value then new value, with dates. Keep the last few.
## Timeline
One line per call, newest first: date, title, the single most important outcome.
## Lessons for the next call
What worked, what didn't, what ME should ask or prepare. Learn from the call itself and from <wished_for_help>, the moments ME bookmarked because they wanted help. Each lesson one line, specific and actionable.

Rules: specific over general; exact names, numbers and dates; mark anything uncertain with "(unconfirmed)". The user may have edited the memory by hand: keep their edits unless the new call contradicts them.`;
