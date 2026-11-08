// Chat entry points for sessions and topics: both run the tool-using agent
// with the right tools and context, and return the reply plus actions taken.

import { runAgent, sessionTools, topicTools, type AgentAction, type SessionHooks } from "../core/agent";
import { sessionChatPrompt, TOPIC_CHAT_SYSTEM, topicContext } from "../core/notes";
import { ModelClient } from "../core/providers";
import type { ChatMessage, Segment, SessionMeta } from "../core/types";
import { transport, workspace } from "./backend";
import { loadTopicDocs } from "./library";
import { getSettings } from "./settings";

const client = () => new ModelClient(getSettings().models, transport);

function toHistory(chat: ChatMessage[]) {
  return chat.map((m) => ({
    role: m.role,
    content: m.actions?.length ? `${m.content}\n\n(Actions taken: ${m.actions.map((a) => a.summary).join("; ")})` : m.content,
  }));
}

export async function askSession(
  args: { meta: SessionMeta; segments: Segment[]; myNotes: string; chat: ChatMessage[]; question: string; live: boolean },
  hooks: SessionHooks,
): Promise<ChatMessage> {
  const docs = await loadTopicDocs(args.meta.topics);
  const { answer, actions } = await runAgent(client(), "chat", {
    system: sessionChatPrompt(args.meta, args.segments, args.myNotes, args.live),
    context: topicContext(docs),
    history: toHistory(args.chat),
    question: args.question,
    tools: sessionTools(workspace, hooks),
  });
  return reply(answer, actions);
}

export async function askTopic(topic: string, chat: ChatMessage[], question: string): Promise<ChatMessage> {
  const docs = await loadTopicDocs([topic]);
  const { answer, actions } = await runAgent(client(), "chat", {
    system: `${TOPIC_CHAT_SYSTEM}\n\nThe current topic is "${topic}" (folder topics/${topic}/). Default to it when the user doesn't name another.`,
    context: topicContext(docs),
    history: toHistory(chat),
    question,
    tools: topicTools(workspace),
  });
  return reply(answer, actions);
}

function reply(answer: string, actions: AgentAction[]): ChatMessage {
  return {
    role: "assistant",
    content: answer || (actions.length ? "Done." : "(no answer)"),
    at: 0,
    actions: actions.map((a) => ({ summary: a.summary, ok: a.ok })),
  };
}
