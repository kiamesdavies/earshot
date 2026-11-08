// The small always-on-top card shown when another app starts using the mic.

import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { IconMic, IconX } from "./icons";

export function Prompt() {
  const initial = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("app") ?? "A call";
  const [app, setApp] = useState(initial);

  useEffect(() => {
    document.body.classList.add("prompt-body");
    const off = listen<string>("prompt-app", (e) => setApp(e.payload));
    return () => void off.then((f) => f());
  }, []);

  const act = async (action: "start" | "dismiss") => {
    await emit("prompt-action", { action, app });
    await getCurrentWindow().close();
  };

  return (
    <div className="prompt" data-tauri-drag-region>
      <div className="prompt-icon">
        <IconMic size={20} />
      </div>
      <div className="prompt-text" data-tauri-drag-region>
        <strong>{app} is using your mic</strong>
        <span>Take notes and get nudges for this call?</span>
      </div>
      <div className="prompt-actions">
        <button className="btn primary small" onClick={() => act("start")}>
          Start
        </button>
        <button className="icon-btn" aria-label="Dismiss" onClick={() => act("dismiss")}>
          <IconX size={16} />
        </button>
      </div>
    </div>
  );
}
