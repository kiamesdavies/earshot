// Feedback: drafts a GitHub issue and opens it in the browser, where the user
// reviews and submits it with their own GitHub account. Nothing is sent from the app.

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { IconX } from "./icons";

export const REPO_URL = "https://github.com/kiamesdavies/earshot";

type Kind = "bug" | "idea" | "question";
const KINDS: Record<Kind, { label: string; githubLabel: string; prompt: string; placeholder: string }> = {
  bug: {
    label: "Something's broken",
    githubLabel: "bug",
    prompt: "What happened, and what did you expect?",
    placeholder: "I pressed Publish and… I expected…\n\nSteps: 1. … 2. …",
  },
  idea: { label: "An idea", githubLabel: "enhancement", prompt: "What would you like Earshot to do?", placeholder: "It would help if…" },
  question: { label: "A question", githubLabel: "question", prompt: "What would you like to know?", placeholder: "How do I…" },
};

export function issueUrl(kind: Kind, title: string, body: string, system: string): string {
  const full = `${body.trim()}${system ? `\n\n---\n${system}` : ""}`;
  const params = new URLSearchParams({ title: title.trim(), body: full.slice(0, 6000), labels: KINDS[kind].githubLabel });
  return `${REPO_URL}/issues/new?${params}`;
}

export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [includeSystem, setIncludeSystem] = useState(true);
  const [system, setSystem] = useState("");

  useEffect(() => {
    Promise.all([getVersion().catch(() => "?"), invoke<string>("system_info").catch(() => "macOS")]).then(([v, os]) => setSystem(`Earshot ${v} · ${os}`));
  }, []);

  const k = KINDS[kind];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          await openUrl(issueUrl(kind, title, body, includeSystem ? system : ""));
          onClose();
        }}
      >
        <header>
          <h2>Send feedback</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <div className="segmented">
          {(Object.keys(KINDS) as Kind[]).map((key) => (
            <button key={key} type="button" className={kind === key ? "on" : ""} onClick={() => setKind(key)}>
              {KINDS[key].label}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Title</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A short summary" />
        </label>
        <label className="field">
          <span>{k.prompt}</span>
          <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder={k.placeholder} />
        </label>
        <label className="check small">
          <input type="checkbox" checked={includeSystem} onChange={(e) => setIncludeSystem(e.target.checked)} /> Include {system || "app and macOS version"}
        </label>
        <p className="muted small">
          This opens a GitHub issue in your browser for you to check and submit. Nothing is sent from Earshot, and no transcripts or notes are included. Don't paste
          anything private: issues are public.
        </p>
        <footer>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!title.trim()}>
            Open on GitHub
          </button>
        </footer>
      </form>
    </div>
  );
}
