// A topic's link to a connector: where it pulls from before sessions and
// which skill drafts the record after them.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { normaliseMarker, openLink, type TopicBinding, type WriteMode } from "../core/connectors";
import { bindingPath, connectorDef, connectors, loadBinding, markerSuggestions, mcpStatus, pullTopic, sampleDraft, saveBinding, sourceOptions, testTopicLink, type TestStep } from "../lib/integrations";
import { Markdown } from "./Markdown";
import { fsTrash } from "../lib/backend";
import { IconLink, IconRefresh } from "./icons";

const EMPTY: TopicBinding = { connector: "spacesheep", source: {}, pull: "on-session-start" };

export function LinkedSource({ slug, onChanged }: { slug: string; onChanged: () => void }) {
  const [binding, setBinding] = useState<TopicBinding | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setEditing(false);
    setMessage("");
    loadBinding(slug).then(setBinding);
  }, [slug]);

  const refresh = async () => {
    setBusy("Refreshing…");
    setMessage("");
    try {
      const r = await pullTopic(slug);
      setBinding(await loadBinding(slug));
      setMessage(r ? `✓ Pulled ${r.chars.toLocaleString()} characters` : "");
      onChanged();
    } catch (e) {
      setMessage(`✗ ${String(e).replace(/^Error: /, "")}`);
    } finally {
      setBusy("");
    }
  };

  if (binding === undefined) return null;
  if (editing || binding === null) {
    if (!editing)
      return (
        <div className="linked-box">
          <button className="btn small" onClick={() => setEditing(true)}>
            <IconLink size={14} /> Link to a connector
          </button>
          <small className="muted">Back this topic with a page in Spacesheep, Notion or another MCP server.</small>
        </div>
      );
    return (
      <LinkForm
        slug={slug}
        initial={binding ?? EMPTY}
        onCancel={() => setEditing(false)}
        onUnlink={
          binding
            ? async () => {
                // The linked copy stays as a normal file; only the link is removed.
                await fsTrash(bindingPath(slug));
                setBinding(null);
                setEditing(false);
              }
            : undefined
        }
        onSave={async (b) => {
          await saveBinding(slug, b);
          setBinding(b);
          setEditing(false);
          refresh();
        }}
      />
    );
  }

  const def = connectorDef(binding.connector);
  const link = def ? openLink(def, binding.source, binding.link) : null;
  return (
    <div className="linked-box on">
      <div className="linked-head">
        <IconLink size={14} />
        <strong>{def?.name ?? binding.connector}</strong>
        <button className="link" onClick={() => setEditing(true)}>
          edit
        </button>
      </div>
      <small className="muted">{Object.values(binding.source).join(" · ")}</small>
      <small className="muted">
        {binding.pull === "on-session-start" ? "Refreshed before each session" : "Refreshed by hand"}
        {binding.lastPulledAt ? ` · last ${new Date(binding.lastPulledAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}` : ""}
      </small>
      {binding.postHook && <small className="muted">After sessions: {binding.postHook.skill.split("/").filter(Boolean).pop()} drafts the record</small>}
      <div className="toolbar">
        <button className="btn small" disabled={!!busy} onClick={refresh}>
          <IconRefresh size={13} /> {busy || "Refresh"}
        </button>
        {link && (
          <button className="btn small ghost" onClick={() => openUrl(link)}>
            Open
          </button>
        )}
      </div>
      {message && <small className={message.startsWith("✓") ? "ok" : "bad"}>{message}</small>}
      <LinkTest slug={slug} hasHook={!!binding.postHook} onPulled={async () => (setBinding(await loadBinding(slug)), onChanged())} />
    </div>
  );
}

const PHASE: Record<TestStep["phase"], string> = { connection: "Connection", before: "Before a session", after: "After a session" };

/** Runs the same steps a real session would, without publishing anything. */
function LinkTest({ slug, hasHook, onPulled }: { slug: string; hasHook: boolean; onPulled: () => void }) {
  const [steps, setSteps] = useState<TestStep[] | null>(null);
  const [busy, setBusy] = useState("");
  const [sample, setSample] = useState<{ draft: string; from: string } | null>(null);
  const [sampleError, setSampleError] = useState("");

  const run = async () => {
    setBusy("Testing…");
    setSample(null);
    setSampleError("");
    try {
      setSteps(await testTopicLink(slug));
      onPulled();
    } finally {
      setBusy("");
    }
  };
  const draft = async () => {
    setBusy("Drafting a sample record…");
    setSampleError("");
    try {
      setSample(await sampleDraft(slug));
    } catch (e) {
      setSampleError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy("");
    }
  };

  const allOk = steps?.every((s) => s.ok);
  return (
    <div className="link-test">
      <div className="toolbar">
        <button className="btn small" disabled={!!busy} onClick={run}>
          {steps ? "Test again" : "Test before & after"}
        </button>
        {busy && <small className="muted">{busy}</small>}
      </div>
      {steps && (
        <ul className="test-steps">
          {steps.map((s, i) => (
            <li key={i} className={s.ok ? "ok" : "bad"}>
              <span className="step-mark">{s.ok ? "✓" : "✗"}</span>
              <span>
                <strong>{PHASE[s.phase]} · {s.name}</strong>
                <small>{s.detail}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
      {steps && allOk && hasHook && !sample && (
        <button className="btn small" disabled={!!busy} onClick={draft} title="Runs the skill on this topic's latest session, as after a call. Uses your model; nothing is published.">
          Draft a sample record
        </button>
      )}
      {sampleError && <small className="bad">{sampleError}</small>}
      {sample && (
        <div className="sample-draft">
          <small className="muted">Sample from {sample.from}. Not published.</small>
          <Markdown text={sample.draft} />
        </div>
      )}
    </div>
  );
}

function LinkForm({ slug, initial, onSave, onCancel, onUnlink }: { slug: string; initial: TopicBinding; onSave: (b: TopicBinding) => void; onCancel: () => void; onUnlink?: () => void }) {
  const [b, setB] = useState<TopicBinding>(initial);
  const [hookOn, setHookOn] = useState(!!initial.postHook);
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const def = connectorDef(b.connector);
  const [markers, setMarkers] = useState<string[]>([]);
  useEffect(() => {
    if (initial.connector) markerSuggestions(slug, initial).then(setMarkers).catch(() => {});
  }, [slug]);

  useEffect(() => {
    Promise.all(connectors().map(async (c) => [c.id, await mcpStatus(c.id).catch(() => false)] as const)).then((pairs) => setConnected(Object.fromEntries(pairs)));
  }, []);

  const hook = b.postHook ?? { skill: "", write: "insert-after-marker" as WriteMode, marker: "", label: "{title}", publishedLink: "" };
  const setHook = (patch: Partial<typeof hook>) => setB({ ...b, postHook: { ...hook, ...patch } });
  const valid = def && def.source.every((f) => b.source[f.key]?.trim()) && (!hookOn || hook.skill.trim());

  return (
    <form
      className="linked-box form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave({ ...b, postHook: hookOn ? { ...hook, marker: normaliseMarker(hook.marker ?? "") } : undefined });
      }}
    >
      <label className="field">
        <span>Connector</span>
        <select value={b.connector} onChange={(e) => setB({ ...b, connector: e.target.value, source: {} })}>
          {connectors().map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {connected[c.id] === false ? " (not connected)" : ""}
            </option>
          ))}
        </select>
        {connected[b.connector] === false && <small className="bad">Connect it first in Settings → Integrations.</small>}
      </label>
      {def?.source.map((f) => (
        <SourceFieldInput
          key={`${b.connector}-${f.key}`}
          connector={b.connector}
          field={f}
          source={b.source}
          ready={connected[b.connector] !== false && def.source.filter((o) => o.key !== f.key).every((o) => b.source[o.key]?.trim())}
          onChange={(value) => setB({ ...b, source: { ...b.source, [f.key]: value } })}
        />
      ))}
      <label className="field">
        <span>Section to open (optional)</span>
        <input value={b.link ?? ""} placeholder="#agenda" onChange={(e) => setB({ ...b, link: e.target.value })} />
      </label>
      <label className="field">
        <span>Refresh</span>
        <select value={b.pull} onChange={(e) => setB({ ...b, pull: e.target.value as TopicBinding["pull"] })}>
          <option value="on-session-start">Before each session</option>
          <option value="manual">Only when I press Refresh</option>
        </select>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={hookOn} onChange={(e) => setHookOn(e.target.checked)} />
        <span className="switch" />
        <span>
          After a session, draft the record with a skill
          <small className="muted">You review the draft; it's written back only when you press Publish.</small>
        </span>
      </label>
      {hookOn && (
        <>
          <label className="field">
            <span>Skill folder</span>
            <input value={hook.skill} placeholder="~/.agents/skills/weekly-meeting" onChange={(e) => setHook({ skill: e.target.value })} />
          </label>
          <label className="field">
            <span>Write the approved record</span>
            <select value={hook.write} onChange={(e) => setHook({ write: e.target.value as WriteMode })}>
              <option value="insert-after-marker">Under a marker line (newest first)</option>
              <option value="append">At the end</option>
            </select>
          </label>
          {hook.write === "insert-after-marker" && (
            <label className="field">
              <span>Marker line</span>
              <input
                value={hook.marker ?? ""}
                placeholder="<!-- meetings start -->"
                list="marker-suggestions"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(e) => setHook({ marker: normaliseMarker(e.target.value) })}
              />
              <datalist id="marker-suggestions">
                {markers.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {!!markers.length && !markers.includes(normaliseMarker(hook.marker ?? "")) && (
                <small className="muted">
                  Not found in the pulled file. Found:{" "}
                  {markers.map((m) => (
                    <button key={m} type="button" className="btn small ghost" onClick={() => setHook({ marker: m })}>
                      {m}
                    </button>
                  ))}
                </small>
              )}
            </label>
          )}
          <label className="field">
            <span>After publishing, open (optional)</span>
            <input value={hook.publishedLink ?? ""} placeholder="#meeting-{isoDate}" onChange={(e) => setHook({ publishedLink: e.target.value })} />
            <small>Where Open goes once the record is published, e.g. the new meeting's page.</small>
          </label>
          <label className="field">
            <span>Version label</span>
            <input value={hook.label ?? ""} placeholder="Meeting {date}" onChange={(e) => setHook({ label: e.target.value })} />
            <small>{"{date}"}, {"{isoDate}"} and {"{title}"} are filled in.</small>
          </label>
        </>
      )}
      <div className="toolbar">
        <button className="btn small primary" type="submit" disabled={!valid}>
          Save link
        </button>
        <button className="btn small ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
        {onUnlink && (
          <button className="link" type="button" onClick={onUnlink}>
            Unlink
          </button>
        )}
      </div>
    </form>
  );
}

/** A source field: a dropdown when the connector can list values (e.g. a space's files), else free text. */
function SourceFieldInput({
  connector,
  field,
  source,
  ready,
  onChange,
}: {
  connector: string;
  field: { key: string; label: string; placeholder?: string; options?: unknown };
  source: Record<string, string>;
  ready: boolean;
  onChange: (value: string) => void;
}) {
  const [options, setOptions] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [typing, setTyping] = useState(false);
  const deps = JSON.stringify(Object.fromEntries(Object.entries(source).filter(([k]) => k !== field.key)));

  useEffect(() => {
    if (!field.options || !ready) return setOptions(null);
    let cancelled = false;
    setError("");
    sourceOptions(connector, field.key, source)
      .then((list) => !cancelled && setOptions(list))
      .catch((e) => !cancelled && (setOptions(null), setError(String(e).replace(/^Error: /, ""))));
    return () => {
      cancelled = true;
    };
  }, [connector, field.key, ready, deps]);

  const value = source[field.key] ?? "";
  const useList = options && options.length > 0 && !typing;
  return (
    <label className="field">
      <span>{field.label}</span>
      {useList ? (
        <select value={options!.includes(value) ? value : ""} onChange={(e) => (e.target.value === "__type" ? setTyping(true) : onChange(e.target.value))}>
          <option value="" disabled>
            Choose…
          </option>
          {options!.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
          <option value="__type">Type a path instead…</option>
        </select>
      ) : (
        <input value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
      {!!field.options && !ready && <small>Fill in the fields above to pick from a list.</small>}
      {error && <small className="bad">Couldn't list them: {error}</small>}
    </label>
  );
}
