import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../core/types";
import { Markdown } from "./Markdown";
import { IconBookmark, IconCheck, IconSend, IconSparkle, IconX } from "./icons";

interface Props {
  chat: ChatMessage[];
  busy: boolean;
  onAsk: (q: string) => void;
  quickActions?: string[];
  placeholder?: string;
  emptyText?: string;
  onMark?: () => void;
  title?: string;
  collapsed?: boolean;
  onToggle?: () => void;
}

/** Chat with an assistant that can take actions; actions show under its reply. */
export function ChatBox({ chat, busy, onAsk, quickActions = [], placeholder = "How can I help?", emptyText, onMark, title = "Chat", collapsed, onToggle }: Props) {
  const [input, setInput] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [chat.length, busy]);

  const send = (q: string) => {
    if (!q.trim() || busy) return;
    onAsk(q.trim());
    setInput("");
  };

  if (collapsed)
    return (
      <section className="chat collapsed">
        <header className="collapsible" onClick={onToggle}>
          <span className="chev">▸</span>
          <h3>{title}</h3>
          {chat.length > 0 && <span className="muted small">{chat.length} messages</span>}
        </header>
      </section>
    );

  return (
    <section className="chat">
      <header className={onToggle ? "collapsible" : undefined} onClick={onToggle}>
        {onToggle && <span className="chev">▾</span>}
        <h3>{title}</h3>
      </header>
      <div className="chat-scroll" ref={scroller}>
        {chat.length === 0 && emptyText && <p className="empty">{emptyText}</p>}
        {chat.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === "assistant" ? <Markdown text={m.content} /> : m.content}
            {m.actions && m.actions.length > 0 && (
              <ul className="actions">
                {m.actions.map((a, j) => (
                  <li key={j} className={a.ok ? "ok" : "bad"}>
                    {a.ok ? <IconCheck size={12} /> : <IconX size={12} />} {a.summary}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {busy && <div className="msg assistant pending">…</div>}
      </div>
      {quickActions.length > 0 && (
        <div className="quick">
          {quickActions.map((q) => (
            <button key={q} className="quick-btn" disabled={busy} onClick={() => send(q)}>
              <IconSparkle size={12} /> {q}
            </button>
          ))}
        </div>
      )}
      <div className="composer">
        <textarea
          rows={1}
          value={input}
          placeholder={placeholder}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <button className="icon-btn" aria-label="Send" disabled={busy || !input.trim()} onClick={() => send(input)}>
          <IconSend size={16} />
        </button>
        {onMark && (
          <button className="icon-btn mark" title="Mark: I wanted a nudge here (⌘B)" aria-label="Mark moment" onClick={onMark}>
            <IconBookmark size={16} />
          </button>
        )}
      </div>
    </section>
  );
}
