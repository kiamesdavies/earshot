// Post-session records for linked topics: the skill's draft, editable, and
// written back to the connector only when the user presses Publish.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { openLink, type TopicBinding } from "../core/connectors";
import type { Segment, SessionMeta } from "../core/types";
import { connectorDef, discardHook, hooksForSession, publishHook, runPostHook, type HookStatus } from "../lib/integrations";
import { Markdown } from "./Markdown";
import { IconCheck, IconEdit, IconRefresh } from "./icons";

interface Props {
  dir: string;
  meta: SessionMeta;
  segments: () => Promise<Segment[]>;
  myNotes: string;
  summary: string;
  /** Bump to reload (e.g. when hooks finish in the background). */
  version?: number;
}

type Row = { slug: string; binding: TopicBinding; status: HookStatus | null; draft: string };

export function PostHooks({ dir, meta, segments, myNotes, summary, version }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const reload = () => hooksForSession(dir, meta.topics).then(setRows).catch(() => setRows([]));
  useEffect(() => {
    reload();
  }, [dir, meta.topics.join(","), version]);
  if (!rows.length) return null;
  return (
    <div className="post-hooks">
      {rows.map((row) => (
        <HookCard key={row.slug} row={row} dir={dir} meta={meta} segments={segments} myNotes={myNotes} summary={summary} onChange={reload} />
      ))}
    </div>
  );
}

function HookCard({ row, dir, meta, segments, myNotes, summary, onChange }: { row: Row; onChange: () => void } & Omit<Props, "version">) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.draft);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setDraft(row.draft), [row.draft]);

  const def = connectorDef(row.binding.connector);
  const where = `${def?.name ?? row.binding.connector} · ${Object.values(row.binding.source).join(" · ")}`;
  const state = row.status?.state;
  const skill = row.binding.postHook?.skill.split("/").filter(Boolean).pop();
  const link = def ? openLink(def, row.binding.source, row.binding.link) : null;

  const run = async () => {
    setBusy(`Drafting with ${skill}…`);
    setError("");
    await runPostHook(dir, meta, row.slug, await segments(), myNotes, summary);
    setBusy("");
    onChange();
  };
  const publish = async () => {
    setBusy(`Publishing to ${def?.name}…`);
    setError("");
    try {
      await publishHook(dir, meta, row.slug, draft);
      setEditing(false);
      onChange();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className={`hook-card state-${state ?? "none"}`}>
      <div className="hook-head">
        <strong>Record for {row.slug}</strong>
        <span className="muted small">{where}</span>
        <span className={`pill ${state === "published" ? "ok" : state === "failed" ? "bad" : ""}`}>
          {busy ? "working…" : state === "draft" ? "draft · needs your review" : state === "published" ? "published" : state === "failed" ? "failed" : state === "running" ? "drafting…" : state === "discarded" ? "discarded" : "not run"}
        </span>
      </div>

      {state === "failed" && <p className="bad small">{row.status?.error}</p>}
      {error && <p className="bad small">{error}</p>}

      {(state === "draft" || state === "published") && draft && (
        <div className="hook-draft">{editing ? <textarea className="editor" value={draft} onChange={(e) => setDraft(e.target.value)} /> : <Markdown text={draft} />}</div>
      )}

      <div className="toolbar">
        {state === "draft" && (
          <>
            <button className="btn small primary" disabled={!!busy} onClick={publish}>
              <IconCheck size={13} /> Publish to {def?.name}
            </button>
            <button className="btn small" disabled={!!busy} onClick={() => setEditing(!editing)}>
              <IconEdit size={13} /> {editing ? "Preview" : "Edit"}
            </button>
            <button className="btn small ghost" disabled={!!busy} onClick={async () => (await discardHook(dir, row.slug), onChange())}>
              Discard
            </button>
          </>
        )}
        {(!state || state === "failed" || state === "discarded") && (
          <button className="btn small" disabled={!!busy} onClick={run}>
            <IconRefresh size={13} /> {state ? "Draft again" : `Draft with ${skill}`}
          </button>
        )}
        {state === "published" && (row.status?.link ?? link) && (
          <button className="btn small ghost" onClick={() => openUrl((row.status?.link ?? link)!)}>
            Open in {def?.name}
          </button>
        )}
        {busy && <small className="muted">{busy}</small>}
      </div>
    </div>
  );
}
