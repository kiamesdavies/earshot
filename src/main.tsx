import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import "./styles.css";

// Each window (main, floating nudges, call prompt) only loads its own code.
const App = lazy(() => import("./App"));
const Mini = lazy(() => import("./components/Mini").then((m) => ({ default: m.Mini })));
const Prompt = lazy(() => import("./components/Prompt").then((m) => ({ default: m.Prompt })));

import { logEvent } from "./lib/backend";

window.addEventListener("error", (e) => logEvent("error", "js", `${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => logEvent("error", "js", `unhandled: ${String(e.reason)}`));

async function boot() {
  // Plain-browser preview with a fake backend (see src/dev/mock.ts).
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installMock } = await import("./dev/mock");
    installMock();
  }
  const isPrompt = window.location.hash.startsWith("#prompt");
  const isMini = window.location.hash.startsWith("#mini");
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Suspense fallback={null}>{isPrompt ? <Prompt /> : isMini ? <Mini /> : <App />}</Suspense>
    </React.StrictMode>,
  );
}

boot();
