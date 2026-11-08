// Topics and sessions on disk.
//
//   topics/<slug>/*.md            user prep docs (uploaded or written in-app)
//   topics/<slug>/sessions/*.md   notes saved from calls linked to this topic
//   sessions/<id>/session.json    SessionMeta
//   sessions/<id>/transcript.jsonl, suggestions.jsonl, moments.json, chat.json, notes.md, me.wav, them.wav

import type { Doc } from "../core/retrieval";
import type { ChatMessage, Moment, Segment, SessionMeta, Suggestion } from "../core/types";
import { sessionLoad, sessionsList, sessionTranscript, topicsList } from "./backend";

export interface Topic {
  slug: string;
  files: { path: string; name: string; modified: number; isSession: boolean }[];
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

export async function listTopics(): Promise<Topic[]> {
  return (await topicsList()).map((t) => ({ slug: t.slug, files: t.files }));
}

/** All markdown in these topics, read in one call. */
export async function loadTopicDocs(slugs: string[]): Promise<Doc[]> {
  if (!slugs.length) return [];
  return (await topicsList(slugs, true)).flatMap((t) => t.files.map((f) => ({ path: f.path, content: f.content ?? "" })));
}

export interface SessionSummary {
  meta: SessionMeta;
  dir: string;
}

export async function listSessions(): Promise<SessionSummary[]> {
  return (await sessionsList()) as SessionSummary[];
}

export interface SessionData {
  meta: SessionMeta;
  segments: Segment[];
  suggestions: Suggestion[];
  moments: Moment[];
  chat: ChatMessage[];
  notes: string;
  myNotes: string;
  /** Lines in transcript.jsonl, known before the transcript itself is loaded. */
  segmentCount: number;
}

/** Everything the session page shows first. The transcript loads separately (loadTranscript). */
export async function loadSession(dir: string): Promise<SessionData> {
  const b = await sessionLoad(dir);
  return {
    meta: b.meta as SessionMeta,
    segments: [],
    segmentCount: b.segmentCount,
    suggestions: b.suggestions as Suggestion[],
    moments: b.moments as Moment[],
    chat: b.chat as ChatMessage[],
    notes: b.notes,
    myNotes: b.myNotes,
  };
}

export async function loadTranscript(dir: string): Promise<Segment[]> {
  return (await sessionTranscript(dir)) as Segment[];
}

export function newSessionId(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
