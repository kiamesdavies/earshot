// Right-hand panel for sessions: nudge cards on top, tool-using chat below.

import { useState } from "react";
import { useCollapsed } from "../lib/panels";
import { clock } from "../core/copilot";
import type { ChatMessage, Moment, Suggestion, SuggestionKind } from "../core/types";
import { ChatBox } from "./ChatBox";
import { IconFact, IconLink, IconPin, IconQuestion, IconSend, IconSparkle, IconX } from "./icons";

const KIND_META: Record<SuggestionKind, { label: string; Icon: typeof IconQuestion }> = {
  question: { label: "Ask", Icon: IconQuestion },
  connection: { label: "Connect", Icon: IconLink },
  fact: { label: "Fact", Icon: IconFact },
  commitment: { label: "Pin down", Icon: IconPin },
};

const LIVE_ACTIONS = ["What should I ask next?", "Summarize the last 5 minutes", "What have we each committed to so far?", "What contradicts my notes?"];
const PAST_ACTIONS = ["What were the action items?", "Save the key decisions to the topic", "What should I prep for next time?"];

interface Props {
  live: boolean;
  suggestions: Suggestion[];
  moments: Moment[];
  chat: ChatMessage[];
  busy: boolean;
  thinking?: boolean;
  onAsk: (q: string) => void;
  onMark?: () => void;
  onDismiss?: (id: string) => void;
}

export function CopilotPanel({ live, suggestions, moments, chat, busy, thinking, onAsk, onMark, onDismiss }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [collapsed, toggle] = useCollapsed("session-panel", { nudges: false, chat: false });
  const visible = suggestions.filter((s) => !s.dismissed).slice().reverse();
  const shown = live && !showAll ? visible.slice(0, 3) : visible;

  // Both collapsed: a thin strip so the transcript or notes get the width.
  if (collapsed.nudges && collapsed.chat)
    return (
      <aside className="copilot rail">
        <button className="rail-toggle" title="Show nudges" onClick={() => toggle("nudges")}>
          <IconSparkle size={16} />
          {visible.length > 0 && <em>{visible.length}</em>}
        </button>
        <button className="rail-toggle" title="Show chat" onClick={() => toggle("chat")}>
          <IconSend size={16} />
        </button>
      </aside>
    );

  return (
    <aside className={`copilot ${collapsed.chat ? "chat-collapsed" : ""} ${collapsed.nudges ? "nudges-collapsed" : ""}`}>
      <section className="nudges">
        <header className="collapsible" onClick={() => toggle("nudges")}>
          <span className="chev">{collapsed.nudges ? "▸" : "▾"}</span>
          <h3>Nudges</h3>
          {collapsed.nudges && visible.length > 0 && <span className="muted small">{visible.length}</span>}
          {thinking && <span className="thinking">thinking…</span>}
          {live && <span className="muted small">{moments.length} marked</span>}
        </header>
        {collapsed.nudges ? null : shown.length === 0 ? (
          <p className="empty">
            {live
              ? "Listening. Nudges appear when the other side finishes a point worth acting on — most of the time it stays quiet."
              : "No nudges were shown in this session."}
          </p>
        ) : (
          <ul>
            {shown.map((s, i) => {
              const { label, Icon } = KIND_META[s.kind] ?? KIND_META.question;
              return (
                <li key={s.id} className={`nudge kind-${s.kind} ${live && i === 0 ? "fresh" : ""}`}>
                  <div className="nudge-head">
                    <span className="kind">
                      <Icon size={14} /> {label}
                    </span>
                    <span className="muted small">
                      {clock(s.at)} · {s.latency.toFixed(1)}s
                    </span>
                    {onDismiss && (
                      <button className="icon-btn tiny" aria-label="Dismiss" onClick={() => onDismiss(s.id)}>
                        <IconX size={12} />
                      </button>
                    )}
                  </div>
                  <p className="nudge-text">{s.text}</p>
                  {s.why && <p className="nudge-why">{s.why}</p>}
                  {s.source && <p className="nudge-source">{s.source}</p>}
                </li>
              );
            })}
          </ul>
        )}
        {!collapsed.nudges && live && visible.length > 3 && (
          <button className="link" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show latest" : `Show all ${visible.length}`}
          </button>
        )}
      </section>
      <ChatBox
        chat={chat}
        busy={busy}
        onAsk={onAsk}
        quickActions={live ? LIVE_ACTIONS : PAST_ACTIONS}
        emptyText={
          live
            ? "Ask about the call so far, or tell me to do things: \"add that to my notes\", \"save their pricing to the acme topic\"."
            : "Ask about this call, or tell me to save things to a topic."
        }
        onMark={onMark}
        collapsed={collapsed.chat}
        onToggle={() => toggle("chat")}
      />
    </aside>
  );
}
