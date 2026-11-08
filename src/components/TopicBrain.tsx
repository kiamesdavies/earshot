// "How this topic learns": its memory.md (folded forward after every call) and
// the format its summaries are written in (a skill folder or written instructions).

import { useEffect, useState } from "react";
import { memoryPath } from "../core/memory";
import { loadTopicSettings, memoryInfo, rebuildMemory, saveTopicSettings, summaryFormat, type MemoryInfo, type TopicSettings } from "../lib/topicBrain";
import { IconRefresh } from "./icons";

type FormatMode = "default" | "skill" | "written";

export function TopicBrain({ slug, onOpen, onChanged }: { slug: string; onOpen: (path: string) => void; onChanged: () => void }) {
  const [info, setInfo] = useState<MemoryInfo | null>(null);
  const [settings, setSettings] = useState<TopicSettings>({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  const load = () => {
    memoryInfo(slug).then(setInfo).catch(() => setInfo(null));
    loadTopicSettings(slug).then(setSettings);
  };
  useEffect(() => {
    load();
    setEditing(false);
    setNote("");
  }, [slug]);

  const rebuild = async () => {
    setNote("");
    try {
      const n = await rebuildMemory(slug, (done, total) => setBusy(`Folding call ${Math.min(done + 1, total)} of ${total}…`));
      setNote(n ? `Rebuilt from ${n} call${n === 1 ? "" : "s"}.` : "No saved calls to learn from yet.");
      onChanged();
      if (n) onOpen(memoryPath(slug));
    } catch (e) {
      setNote(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy("");
      load();
    }
  };

  const mode: FormatMode = settings.summarySkill ? "skill" : settings.summaryFormat ? "written" : "default";
  const formatLabel = mode === "skill" ? `Skill: ${settings.summarySkill!.split("/").filter(Boolean).pop()}` : mode === "written" ? "Your written format" : "Default (summary, decisions, to-dos…)";
  const memoryOn = settings.memory !== false;

  return (
    <div className="linked-box topic-brain">
      <div className="brain-row">
        <div>
          <strong>Memory</strong>
          <small className="muted">
            {!memoryOn
              ? "Off for this topic"
              : info?.exists
                ? `${info.folded} of ${info.sessions} calls${info.updatedAt ? ` · ${new Date(info.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}`
                : info?.sessions
                  ? `${info.sessions} calls not learned yet`
                  : "Starts after the first call"}
          </small>
        </div>
        <span className="spacer" />
        {info?.exists && (
          <button className="btn small ghost" onClick={() => onOpen(memoryPath(slug))}>
            Open
          </button>
        )}
        {memoryOn && !!info?.sessions && (
          <button className="btn small ghost" disabled={!!busy} title="Rebuild memory.md from every saved call (one model call each)" onClick={rebuild}>
            <IconRefresh size={13} /> {info.exists ? "Rebuild" : "Learn"}
          </button>
        )}
      </div>
      <div className="brain-row">
        <div>
          <strong>Summary format</strong>
          <small className="muted">{formatLabel}</small>
        </div>
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => setEditing(!editing)}>
          {editing ? "Close" : "Change"}
        </button>
      </div>
      {busy && <small className="muted">{busy}</small>}
      {note && <small className="muted">{note}</small>}
      {editing && (
        <FormatForm
          slug={slug}
          initial={settings}
          onSaved={(s) => {
            setSettings(s);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

function FormatForm({ slug, initial, onSaved }: { slug: string; initial: TopicSettings; onSaved: (s: TopicSettings) => void }) {
  const [mode, setMode] = useState<FormatMode>(initial.summarySkill ? "skill" : initial.summaryFormat ? "written" : "default");
  const [skill, setSkill] = useState(initial.summarySkill ?? "");
  const [written, setWritten] = useState(initial.summaryFormat ?? "");
  const [memory, setMemory] = useState(initial.memory !== false);
  const [check, setCheck] = useState("");

  const next: TopicSettings = {
    ...initial,
    summarySkill: mode === "skill" ? skill.trim() || undefined : undefined,
    summaryFormat: mode === "written" ? written.trim() || undefined : undefined,
    memory: memory ? undefined : false,
  };

  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        setCheck("");
        if (mode === "skill") {
          try {
            const text = await summaryFormat(next);
            setCheck(`Loaded (${text.length.toLocaleString()} characters).`);
          } catch (err) {
            setCheck(String(err).replace(/^Error: /, ""));
            return;
          }
        }
        await saveTopicSettings(slug, next);
        onSaved(next);
      }}
    >
      <label className="field">
        <span>Write summaries for this topic using</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as FormatMode)}>
          <option value="default">Earshot's default format</option>
          <option value="skill">A skill (folder with SKILL.md, or a .md file)</option>
          <option value="written">A format I write here</option>
        </select>
      </label>
      {mode === "skill" && (
        <label className="field">
          <span>Skill folder</span>
          <input value={skill} placeholder="~/.agents/skills/weekly-summary" spellCheck={false} autoCorrect="off" onChange={(e) => setSkill(e.target.value)} />
        </label>
      )}
      {mode === "written" && (
        <label className="field">
          <span>Format</span>
          <textarea
            rows={8}
            value={written}
            placeholder={"## The week in one line\n## Numbers (table: metric, this week, last week)\n## Decisions\n## Actions (owner, task, due)\n## What we missed"}
            onChange={(e) => setWritten(e.target.value)}
          />
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={memory} onChange={(e) => setMemory(e.target.checked)} /> Keep memory.md up to date after each call
      </label>
      {check && <small className="muted">{check}</small>}
      <div className="toolbar">
        <button className="btn small primary" type="submit">
          Save
        </button>
      </div>
    </form>
  );
}
