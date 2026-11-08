import { useEffect, useState } from "react";
import { describeRole } from "../core/providers";
import { listTopics } from "../lib/library";
import { modelProblems } from "../lib/readiness";
import { startSession } from "../lib/live";
import { useSettings } from "../lib/settings";
import { TopicPicker } from "./TopicPicker";
import { IconMic, IconX } from "./icons";

const LAST_TOPICS = "earshot:lastTopics";

export function StartDialog({ app, onClose, onOpenSettings }: { app?: string; onClose: () => void; onOpenSettings?: () => void }) {
  const settings = useSettings();
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [selected, setSelected] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(LAST_TOPICS) ?? "[]");
    } catch {
      return [];
    }
  });

  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => {
    listTopics().then((list) => setSelected((s) => s.filter((slug) => list.some((t) => t.slug === slug))));
    modelProblems(settings).then(setProblems);
  }, []);

  const start = async () => {
    try {
      localStorage.setItem(LAST_TOPICS, JSON.stringify(selected));
    } catch {
      /* per-device convenience only */
    }
    onClose();
    await startSession({ title: title.trim(), goal: goal.trim(), topics: selected, app });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal wide"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <header>
          <h2>{app ? `Start notes for this ${app} call` : "Start a session"}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <div className="field">
          <span>Topics: past notes and prep the copilot can draw on. This call's notes are saved back here.</span>
          <TopicPicker selected={selected} onChange={setSelected} />
        </div>
        <label className="field">
          <span>Title (optional, named automatically from the conversation if blank)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Named automatically" />
        </label>
        <label className="field">
          <span>What do you want out of this call? (optional)</span>
          <textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Confirm the pilot hit its criteria and get a decision timeline" />
          <small>The copilot only speaks up when it helps with this.</small>
        </label>
        <p className="muted small">
          Nudges: {describeRole(settings.models, "gate")} · Summary: {describeRole(settings.models, "summarize")} · Speech:{" "}
          {settings.stt.engine === "apple" ? "Apple" : settings.stt.modelPath.split("/").pop()}
        </p>
        {settings.stt.engine === "apple" && (
          <div className="banner info">
            Transcription is using Apple's basic model. A downloaded model is much more accurate.{" "}
            {onOpenSettings && (
              <button type="button" className="link" onClick={onOpenSettings}>
                Choose a speech model
              </button>
            )}
          </div>
        )}
        {problems.length > 0 && (
          <div className="banner warn">
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
            <div>You can still record, but nudges, chat or the summary will fail until this is fixed in Settings → Models.</div>
          </div>
        )}
        <footer>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" autoFocus>
            <IconMic size={16} /> Start listening
          </button>
        </footer>
      </form>
    </div>
  );
}
