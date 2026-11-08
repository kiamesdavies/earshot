// Main-window side of the floating nudge window. The mini window is its own
// webview, so state is pushed to it as events and its buttons come back as
// "mini-action" events handled here. It shows the live session when there is
// one, otherwise the past session open in the main window.

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Suggestion } from "../core/types";
import { dismissSuggestion, markMoment, stopSession, useLiveStore } from "./live";

export interface MiniState {
  title: string;
  phase: string;
  startedAtMs: number;
  /** Set for a past session: when it happened. */
  date?: string;
  suggestions: Suggestion[];
  thinking: boolean;
  moments: number;
}

export type MiniAction = { type: "dismiss"; id: string } | { type: "mark" } | { type: "open" } | { type: "stop" } | { type: "close" };

let open = false;
/** Opened by the user (button / shortcut, stays) vs. by leaving the app (hides on return). */
let manual = false;
let lastSent = "";
/** The past session the main window is showing, offered when nothing is live. */
let past: MiniState | null = null;
let hiddenInPast = new Set<string>();

const isLive = () => ["starting", "live", "stopping", "summarizing"].includes(useLiveStore.get().phase);

function snapshot(): MiniState | null {
  if (isLive()) {
    const s = useLiveStore.get();
    return {
      title: s.meta?.title ?? "",
      phase: s.phase,
      startedAtMs: s.startedAtMs,
      suggestions: s.suggestions.filter((x) => !x.dismissed),
      thinking: s.thinking,
      moments: s.moments.length,
    };
  }
  if (!past) return null;
  return { ...past, suggestions: past.suggestions.filter((x) => !hiddenInPast.has(x.id)) };
}

function push(force = false) {
  if (!open) return;
  const state = snapshot() ?? { title: "", phase: "empty", startedAtMs: 0, suggestions: [], thinking: false, moments: 0 };
  const json = JSON.stringify(state);
  if (!force && json === lastSent) return;
  lastSent = json;
  emitTo("mini", "mini-state", state).catch(() => {});
}

/** Called by the past-session view as it opens/closes, so the window can show it. */
export function setMiniPast(state: MiniState | null) {
  if (state?.title !== past?.title || state?.date !== past?.date) hiddenInPast = new Set();
  past = state;
  push();
}

export async function openMini(byUser: boolean) {
  manual = manual || byUser;
  if (open) return push(true);
  open = true;
  await invoke("mini_open");
}

export async function closeMini() {
  open = false;
  manual = false;
  lastSent = "";
  await invoke("mini_close").catch(() => {});
}

export const toggleMini = () => (open ? closeMini() : openMini(true));
export const miniIsManual = () => manual;

/** Call once from the main window. */
export function installMiniBridge(autoPopOut: () => boolean): () => void {
  let wasLive = false;
  const unsubscribe = useLiveStore.subscribe(() => {
    const live = isLive();
    // An auto-opened window goes away with the call; one the user opened stays (and falls back to the past session).
    if (open && wasLive && !live && !manual) closeMini();
    else push();
    wasLive = live;
  });
  const offReady = listen("mini-ready", () => push(true));
  const offToggle = listen("toggle-mini", () => toggleMini());
  const offAction = listen<MiniAction>("mini-action", async (e) => {
    const action = e.payload;
    if (action.type === "dismiss") {
      if (isLive()) dismissSuggestion(action.id);
      else {
        hiddenInPast.add(action.id);
        push();
      }
    }
    if (action.type === "mark") markMoment();
    if (action.type === "stop") stopSession();
    if (action.type === "close") closeMini();
    if (action.type === "open") {
      const win = getCurrentWindow();
      await win.unminimize();
      await win.show();
      await win.setFocus();
      if (!manual || isLive()) closeMini();
    }
  });
  // Like Teams: leaving Earshot mid-call pops the nudges out; coming back tucks them away.
  const offFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (useLiveStore.get().phase !== "live") return;
    if (!focused && autoPopOut()) openMini(false);
    if (focused && open && !manual) closeMini();
  });
  return () => {
    unsubscribe();
    offReady.then((f) => f());
    offToggle.then((f) => f());
    offAction.then((f) => f());
    offFocus.then((f) => f());
  };
}
