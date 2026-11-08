// Post-call notes, titles and chat prompts. Output is markdown so it can be
// written straight into a topic folder and read by any editor (Obsidian, ...).
// The user's own notes are first-class input: they steer the summary and are
// saved with it, so the next call on the same topic starts from both.

import { formatTranscript } from "./copilot.ts";
import type { Completion, CompletionRequest, Role } from "./providers.ts";
import type { Doc } from "./retrieval.ts";
import type { Segment, SessionMeta, Suggestion } from "./types.ts";

type Complete = (role: Role, req: CompletionRequest) => Promise<Completion>;

/** Topic docs as one cacheable context block. Most recent session notes are kept when trimming. */
export function topicContext(docs: Doc[], maxChars = 60_000): string {
  if (!docs.length) return "";
  const ordered = [...docs.filter((d) => !d.path.includes("/sessions/")), ...docs.filter((d) => d.path.includes("/sessions/")).sort((a, b) => b.path.localeCompare(a.path))];
  let out = "<topic_notes>\n";
  for (const doc of ordered) {
    const block = `<doc path="${doc.path}">\n${doc.content.trim()}\n</doc>\n`;
    if (out.length + block.length > maxChars) {
      out += `<!-- ${docs.length} docs total; older ones omitted for length -->\n`;
      break;
    }
    out += block;
  }
  return `${out}</topic_notes>`;
}

export async function summarize(
  complete: Complete,
  meta: SessionMeta,
  segments: Segment[],
  suggestions: Suggestion[],
  docs: Doc[],
  myNotes: string,
  /** A topic's own summary format (skill instructions), replacing the default sections. */
  format?: string,
): Promise<string> {
  const reply = await complete("summarize", {
    system: format?.trim() ? customSummarySystem(format) : SUMMARY_SYSTEM,
    context: topicContext(docs),
    messages: [
      {
        role: "user",
        content: [
          `<session title="${meta.title}" started="${meta.startedAt}" goal="${meta.goal}">`,
          formatTranscript(segments.filter((s) => s.final)) || "(no transcript)",
          `</session>`,
          myNotes.trim() ? `<my_notes>\n${myNotes.trim()}\n</my_notes>` : "",
          suggestions.length ? `<nudges_shown>\n${suggestions.map((s) => `- ${s.text}`).join("\n")}\n</nudges_shown>` : "",
          "Write the notes now.",
        ].join("\n"),
      },
    ],
    maxTokens: 4000,
    reasoning: true,
  });
  return reply.text.trim();
}

/** A short title from the first minutes of a call. */
export async function generateTitle(complete: Complete, segments: Segment[], myNotes: string, goal: string): Promise<string> {
  const reply = await complete("gate", {
    system: "Name this call in 3-6 words, like a meeting title (e.g. \"Acme pilot pricing review\"). Use names of companies, people or projects mentioned. Reply with the title only — no quotes, no punctuation at the end.",
    messages: [
      {
        role: "user",
        content: `${goal ? `Goal: ${goal}\n` : ""}${myNotes ? `Notes: ${myNotes.slice(0, 800)}\n` : ""}Transcript:\n${formatTranscript(segments.filter((s) => s.final).slice(0, 40))}`,
      },
    ],
    maxTokens: 30,
    temperature: 0.2,
  });
  return reply.text.trim().replace(/^["'#\s]+|["'.\s]+$/g, "").slice(0, 80);
}

/** Final markdown saved to each linked topic's sessions/ folder. */
export function sessionMarkdown(meta: SessionMeta, notes: string, myNotes: string, segments: Segment[]): string {
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(meta.title)}`,
    `date: ${meta.startedAt}`,
    `duration_min: ${Math.round((meta.durationSec ?? 0) / 60)}`,
    `topics: [${meta.topics.map((t) => JSON.stringify(t)).join(", ")}]`,
    meta.app ? `app: ${meta.app}` : "",
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  const transcript = formatTranscript(segments.filter((s) => s.final));
  const mine = myNotes.trim() ? `\n\n## My notes\n\n${myNotes.trim()}` : "";
  return `${frontmatter}\n\n# ${meta.title}\n\n${notes}${mine}\n\n<details>\n<summary>Transcript</summary>\n\n${transcript
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n")}\n\n</details>\n`;
}

export function sessionChatPrompt(meta: SessionMeta, segments: Segment[], myNotes: string, live: boolean): string {
  return `${SESSION_CHAT_SYSTEM}

${live ? "The call is happening right now — be brief." : "The call has ended."}
<session title="${meta.title}" goal="${meta.goal || "(not stated)"}" topics="${meta.topics.join(", ") || "none"}">
<transcript>
${formatTranscript(segments.filter((s) => s.final)) || "(nothing yet)"}
</transcript>
<my_notes>
${myNotes.trim() || "(empty)"}
</my_notes>
</session>`;
}

export const TOPIC_CHAT_SYSTEM = `You help the user (ME) maintain their notes for a topic — a person, deal, or project they have recurring calls about. Each topic is a folder of markdown files: prep docs plus notes saved from past calls.
You can read, search, create and edit markdown files with tools. When the user asks to save, add, record or update something, do it with a tool, then confirm in one line which file changed. Prefer appending to an existing relevant file over creating near-duplicates. Write clean markdown with headings, and keep names, numbers and dates exact.
When answering questions, cite which file the answer came from.`;

const SESSION_CHAT_SYSTEM = `You are ME's private assistant for a call (ME = the user, THEM = the other side). Answer from the transcript, ME's notes and topic notes. Be concrete.
If ME asks what to say or ask, give 1-3 options they could say verbatim. If the answer isn't in the material, say so.
You have tools: add to ME's session notes, rename the session, attach a topic, and read/create/edit topic markdown files. Use them when ME asks you to save, note, remember, file or update something, then confirm in one line.`;

const SUMMARY_SYSTEM = `You write post-call notes for ME from a call transcript (ME = the user, THEM = the other side) and ME's own notes taken during the call.
ME's notes show what ME found important — give them priority, and fold them into the right sections. Use the topic notes (prep docs and earlier calls) for names and context, and say what moved forward since the last call.

Write markdown with exactly these sections (omit a section only if truly empty):
## Summary
3-5 sentences: what the call was about and where it landed.
## Decisions
## To-dos
- [ ] Owner — task — due date if mentioned
## Open questions
## What changed since last time
New facts, reversals, or contradictions vs. the topic notes.
## Highlights
Short direct quotes worth keeping, with timestamps.

Be specific: names, numbers, dates exactly as said. No filler. Do not include a top-level title.`;

const SUMMARY_BASE = `You write post-call notes for ME from a call transcript (ME = the user, THEM = the other side) and ME's own notes taken during the call.
ME's notes show what ME found important: give them priority. Use the topic notes (memory, prep docs and earlier calls) for names and context, and say what moved forward since the last call.
Be specific: names, numbers, dates exactly as said. No filler. Never invent facts that are not in the material; if the format asks for something the call didn't cover, say "Not covered".`;

/** The summary prompt when a topic brings its own format (a skill or written instructions). */
export function customSummarySystem(format: string): string {
  return `${SUMMARY_BASE}

ME chose the format for this topic's notes. Follow it exactly: its sections, order, headings, tone and length. It overrides any default structure.
<format>
${format.trim().slice(0, 30_000)}
</format>
Return only the notes in that format, as markdown.`;
}
