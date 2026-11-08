// The floating nudge window: always on top, draggable anywhere, one nudge or
// fact at a time. ← / → (or the arrows, or a swipe) move between them; a new
// nudge jumps into view only if you were already on the latest one.

import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clock } from "../core/copilot";
import type { SuggestionKind } from "../core/types";
import type { MiniAction, MiniState } from "../lib/mini";
import { IconBookmark, IconFact, IconLink, IconPin, IconQuestion, IconX } from "./icons";

const KIND: Record<SuggestionKind, { label: string; Icon: typeof IconQuestion }> = {
  question: { label: "Ask", Icon: IconQuestion },
  connection: { label: "Connect", Icon: IconLink },
  fact: { label: "Fact", Icon: IconFact },
  commitment: { label: "Pin down", Icon: IconPin },
};

const POSITION_KEY = "earshot:miniPosition";
const send = (action: MiniAction) => emit("mini-action", action);

export function Mini() {
  const [state, setState] = useState<MiniState | null>(null);
  const [index, setIndex] = useState(0);
  const [, setTick] = useState(0);
  const followLatest = useRef(true);
  const touchX = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fit the window's height to the card so a nudge never needs a scrollbar.
  // Re-runs when the content or the width (text wrapping) changes.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const win = getCurrentWindow();
    let pending = false;
    let again = false;
    const fit = async (): Promise<void> => {
      if (pending) {
        again = true;
        return;
      }
      pending = true;
      try {
        const [scale, inner] = await Promise.all([win.scaleFactor(), win.innerSize()]);
        const width = inner.width / scale;
        const body = el.querySelector<HTMLElement>(".mini-body-text");
        // Measure the content's own height (it is never clamped by the window),
        // then cap very long nudges and let only their text scroll.
        el.style.setProperty("--mini-body-max", "none");
        const natural = Math.ceil(el.scrollHeight) + 2;
        const cap = Math.round(window.screen.availHeight * 0.6);
        let want = natural;
        if (natural > cap && body) {
          const chrome = natural - body.scrollHeight;
          el.style.setProperty("--mini-body-max", `${cap - chrome}px`);
          want = cap;
        }
        want = Math.max(100, want);
        if (Math.abs(want - inner.height / scale) > 2) await win.setSize(new LogicalSize(width, want));
      } catch {
        /* outside Tauri (preview) */
      } finally {
        pending = false;
        if (again) {
          again = false;
          fit();
        }
      }
    };
    const observer = new ResizeObserver(() => fit());
    observer.observe(el);
    fit();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    document.body.classList.add("mini-body");
    const win = getCurrentWindow();
    // Restore where the user last put it (e.g. the middle of the screen).
    try {
      const saved = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null");
      if (saved) win.setPosition(new LogicalPosition(saved.x, saved.y)).catch(() => {});
    } catch {
      /* first run */
    }
    const offMoved = win.onMoved(async ({ payload }) => {
      const scale = await win.scaleFactor();
      try {
        localStorage.setItem(POSITION_KEY, JSON.stringify({ x: payload.x / scale, y: payload.y / scale }));
      } catch {
        /* position is a convenience */
      }
    });
    const offState = listen<MiniState>("mini-state", (e) => setState(e.payload));
    emit("mini-ready");
    return () => {
      offMoved.then((f) => f());
      offState.then((f) => f());
    };
  }, []);

  // The clock only ticks for a live session.
  const isLive = state?.phase === "live";
  useEffect(() => {
    if (!isLive) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isLive]);

  const items = state?.suggestions ?? [];
  const count = items.length;

  // Newest is last. Follow it while the user is on the latest card.
  useEffect(() => {
    if (followLatest.current) setIndex(Math.max(0, count - 1));
    else setIndex((i) => Math.min(i, Math.max(0, count - 1)));
  }, [count]);

  const go = (delta: number) => {
    setIndex((i) => {
      const next = Math.max(0, Math.min(count - 1, i + delta));
      followLatest.current = next === count - 1;
      return next;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
      if (e.key === "Escape") send({ type: "close" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const current = items[index];
  const newer = count - 1 - index;
  const elapsed = state?.startedAtMs ? (Date.now() - state.startedAtMs) / 1000 : 0;
  const meta = current ? KIND[current.kind] ?? KIND.question : null;

  return (
    <div
      ref={rootRef}
      className="mini"
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current === null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
        touchX.current = null;
      }}
    >
      <header className="mini-head" data-tauri-drag-region>
        <span className={`dot ${state?.phase === "live" ? "on" : ""}`} data-tauri-drag-region />
        <span className="mini-title" data-tauri-drag-region>
          {state?.phase === "live"
            ? clock(elapsed)
            : state?.date
              ? new Date(state.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })
              : state?.phase === "empty"
                ? "No session"
                : state?.phase ?? "…"}{" "}
          · {state?.title || "Earshot"}
        </span>
        {state?.thinking && <span className="thinking">thinking…</span>}
        <span className="spacer" data-tauri-drag-region />
        {state?.phase === "live" && (
          <button className="icon-btn tiny" title="I wanted a nudge here" onClick={() => send({ type: "mark" })}>
            <IconBookmark size={13} />
          </button>
        )}
        <button className="icon-btn tiny" title="Open Earshot" onClick={() => send({ type: "open" })}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
        <button className="icon-btn tiny" title="Hide (Esc)" onClick={() => send({ type: "close" })}>
          <IconX size={13} />
        </button>
      </header>

      {current && meta ? (
        <div className={`mini-card kind-${current.kind}`}>
          <button className="mini-nav prev" disabled={index === 0} onClick={() => go(-1)} aria-label="Previous">
            ‹
          </button>
          <div className="mini-body-text">
            <div className="mini-meta">
              <span className="kind">
                <meta.Icon size={13} /> {meta.label}
              </span>
              <span className="muted small">
                {index + 1} / {count} · {clock(current.at)}
              </span>
              {newer > 0 && (
                <button
                  className="mini-new"
                  onClick={() => {
                    followLatest.current = true;
                    setIndex(count - 1);
                  }}
                >
                  {newer} newer
                </button>
              )}
              <button className="icon-btn tiny dismiss" title="Dismiss" onClick={() => send({ type: "dismiss", id: current.id })}>
                <IconX size={11} />
              </button>
            </div>
            <p className="mini-text">{current.text}</p>
            {current.why && <p className="mini-why">{current.why}</p>}
            {current.source && <p className="nudge-source">{current.source}</p>}
          </div>
          <button className="mini-nav next" disabled={index >= count - 1} onClick={() => go(1)} aria-label="Next">
            ›
          </button>
        </div>
      ) : (
        <div className="mini-empty" data-tauri-drag-region>
          {state?.phase === "live"
            ? "Listening. Nudges and facts appear here when they'd help."
            : state?.phase === "past"
              ? "This session had no nudges."
              : state?.phase === "empty"
                ? "Open a session in Earshot, or start one, to see its nudges here. ⌃⌥N toggles this window."
                : "Waiting for the session…"}
        </div>
      )}
      {count > 1 && (
        <div className="mini-dots">
          {items.slice(-12).map((s, i) => {
            const real = Math.max(0, count - 12) + i;
            return <i key={s.id} className={real === index ? "on" : ""} onClick={() => ((followLatest.current = real === count - 1), setIndex(real))} />;
          })}
        </div>
      )}
    </div>
  );
}
