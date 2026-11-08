import { ask } from "@tauri-apps/plugin-dialog";
import { memo, useEffect, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { clock } from "../core/copilot";
import type { ChatMessage, Moment, Segment, SessionMeta, Suggestion } from "../core/types";
import { askSession } from "../lib/assistant";
import { dataRoot, fsRead, fsTrash, fsWrite, logEvent, recordingDelete, reveal, topicsList, type TopicFile } from "../lib/backend";
import { listSessions, loadSession, loadTranscript, type SessionData, type SessionSummary } from "../lib/library";
import {
  annotateMoment,
  askLive,
  dismissSuggestion,
  generateNotes,
  markMoment,
  renameLive,
  resetLive,
  saveToTopics,
  setLiveTopics,
  setMyNotes,
  stopSession,
  useLevels,
  useLive,
  useLiveSelector,
} from "../lib/live";
import { openMini, setMiniPast } from "../lib/mini";
import { CopilotPanel } from "./CopilotPanel";
import { PostHooks } from "./PostHooks";
import { Markdown } from "./Markdown";
import { TopicPicker } from "./TopicPicker";
import { IconEdit, IconFolderOpen, IconRefresh, IconSessions, IconStop, IconTrash } from "./icons";

export function SessionsView({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  // Only what the list shows, so live transcript updates don't re-render every card.
  const live = {
    phase: useLiveSelector((s) => s.phase),
    meta: useLiveSelector((s) => s.meta),
    dir: useLiveSelector((s) => s.dir),
    status: useLiveSelector((s) => s.status),
  };
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const isActive = live.phase !== "idle";

  const refresh = () => {
    const t0 = performance.now();
    return listSessions()
      .then((list) => {
        setSessions(list);
        logEvent("info", "perf", `sessions list: ${list.length} in ${Math.round(performance.now() - t0)} ms (${Math.round(performance.now())} ms after launch)`);
      })
      .catch(console.error);
  };
  useEffect(() => {
    refresh();
  }, [live.phase, live.meta?.title]);

  useEffect(() => {
    if (live.phase === "starting") onSelect("live");
  }, [live.phase, onSelect]);

  const remove = async (s: SessionSummary) => {
    const ok = await ask(`Move "${s.meta.title}" to the Trash? Its recording, transcript and notes go with it. Notes already saved into topics stay.`, {
      title: "Delete session",
      kind: "warning",
      okLabel: "Move to Trash",
    });
    if (!ok) return;
    await fsTrash(s.dir);
    await recordingDelete(s.meta.id).catch(() => {});
    if (selected === s.dir) onSelect(null);
    refresh();
  };

  const pastSessions = sessions.filter((s) => !(isActive && s.dir === live.dir));

  return (
    <div className="split">
      <div className="list-col">
        <div className="list-head">
          <h2>Sessions</h2>
          <span className="count">{pastSessions.length + (isActive ? 1 : 0)}</span>
        </div>
        {isActive && live.meta && (
          <button className={`card session-card live ${selected === "live" ? "selected" : ""}`} onClick={() => onSelect("live")}>
            <span className={`dot ${live.phase === "live" ? "on" : ""}`} />
            <div>
              <strong>{live.meta.title}</strong>
              <small>{live.phase === "live" ? "Live now" : live.phase === "error" ? "Error" : live.status || live.phase}</small>
            </div>
          </button>
        )}
        {pastSessions.map((s) => (
          <div key={s.dir} className={`card session-card ${selected === s.dir ? "selected" : ""}`} role="button" tabIndex={0} onClick={() => onSelect(s.dir)}>
            <IconSessions size={16} />
            <div>
              <strong>{s.meta.title}</strong>
              <small>
                {new Date(s.meta.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                {s.meta.durationSec ? ` · ${Math.max(1, Math.round(s.meta.durationSec / 60))} min` : ""}
              </small>
              {s.meta.topics.length > 0 && <small className="topics-line">{s.meta.topics.join(", ")}</small>}
            </div>
            <button
              className="icon-btn tiny card-action"
              title="Move to Trash"
              aria-label="Delete session"
              onClick={(e) => {
                e.stopPropagation();
                remove(s);
              }}
            >
              <IconTrash size={13} />
            </button>
          </div>
        ))}
        {!isActive && pastSessions.length === 0 && (
          <p className="empty">No sessions yet. Start one from the button at the bottom left, or join a call and Earshot will offer to.</p>
        )}
      </div>
      <div className="detail-col">
        {selected === "live" && isActive ? (
          <LiveDetail onClosed={(dir) => onSelect(dir)} />
        ) : selected && selected !== "live" ? (
          <PastDetail key={selected} dir={selected} onChanged={refresh} />
        ) : (
          <div className="placeholder">
            <p>Select a session, or start a new one.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Meter({ value, label }: { value: number; label: string }) {
  const pct = Math.min(100, Math.round(Math.sqrt(value) * 140));
  return (
    <div className="meter" title={label}>
      <span>{label}</span>
      <div>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Meters() {
  const levels = useLevels();
  return (
    <>
      <Meter label="You" value={levels.me} />
      <Meter label="Them" value={levels.them} />
    </>
  );
}

function useElapsed(startMs: number, running: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return startMs ? (Date.now() - startMs) / 1000 : 0;
}

function Title({ title, onRename, auto }: { title: string; onRename: (t: string) => void; auto?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  useEffect(() => setValue(title), [title]);
  if (editing)
    return (
      <input
        className="title-input"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (value.trim() && value !== title) onRename(value.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setValue(title);
            setEditing(false);
          }
        }}
      />
    );
  return (
    <h1 className="title" onClick={() => setEditing(true)} title="Rename">
      {title} {auto && <span className="muted small">(will be named from the conversation)</span>}
      <IconEdit size={14} />
    </h1>
  );
}

function ModelsLine({ meta }: { meta: SessionMeta }) {
  if (!meta.models) return null;
  return (
    <p className="models-line">
      <span>Nudges: {meta.models.gate}</span>
      <span>Chat: {meta.models.chat}</span>
      <span>Notes: {meta.models.summarize}</span>
    </p>
  );
}

type LiveTab = "transcript" | "mynotes" | "topics" | "moments" | "summary";

function LiveDetail({ onClosed }: { onClosed: (dir: string) => void }) {
  const live = useLive();
  const [tab, setTab] = useState<LiveTab>("transcript");
  const elapsed = useElapsed(live.startedAtMs, live.phase === "live");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        markMoment();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (live.phase === "done" && live.notes) setTab("summary");
  }, [live.phase, live.notes]);

  if (!live.meta) return null;
  const busy = live.phase === "stopping" || live.phase === "summarizing";

  return (
    <div className="detail">
      <div className="detail-main">
        <header className="detail-head">
          <div>
            <Title title={live.meta.title} auto={live.meta.autoTitle} onRename={renameLive} />
            <p className="muted">
              {live.phase === "live" ? (
                <>
                  <span className="dot on" /> Live · {clock(elapsed)}
                </>
              ) : (
                live.status || live.phase
              )}
              {` · ${live.meta.topics.length ? live.meta.topics.join(", ") : "no topic"}`}
              {live.docCount > 0 && ` (${live.docCount} docs)`}
              {live.echoDropped > 0 && ` · ${live.echoDropped} echoed lines removed`}
            </p>
            <ModelsLine meta={live.meta} />
          </div>
          <div className="head-actions">
            {live.phase === "live" && (
              <>
                <Meters />
              </>
            )}
            {live.phase === "live" && (
              <button className="btn" title="Floating window with one nudge at a time; stays on top of your call (⌃⌥N)" onClick={() => openMini(true)}>
                Pop out
              </button>
            )}
            {(live.phase === "live" || live.phase === "starting") && (
              <button className="btn danger" onClick={() => stopSession()}>
                <IconStop size={14} /> Stop
              </button>
            )}
            {(live.phase === "done" || live.phase === "error") && (
              <button
                className="btn"
                onClick={() => {
                  const dir = live.dir;
                  resetLive();
                  onClosed(dir);
                }}
              >
                Close
              </button>
            )}
          </div>
        </header>
        {live.meta.goal && <p className="goal">Goal: {live.meta.goal}</p>}
        {live.error && <div className="banner error">{live.error}</div>}
        {live.warnings.slice(-2).map((w, i) => (
          <div key={i} className="banner warn">
            {w}
          </div>
        ))}
        {busy && <div className="banner info">{live.status}</div>}
        <nav className="tabs">
          {(
            [
              ["transcript", "Transcript"],
              ["mynotes", "My notes"],
              ["topics", "Topics"],
              ["moments", "Marked moments"],
              ...(live.phase === "done" || live.notes ? [["summary", "Summary"]] : []),
            ] as [LiveTab, string][]
          ).map(([id, label]) => (
            <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              {label}
              {id === "moments" && live.moments.length > 0 && <em>{live.moments.length}</em>}
              {id === "mynotes" && live.myNotes.trim() && <em>●</em>}
            </button>
          ))}
        </nav>
        <div className={`tab-body ${tab === "transcript" ? "fill" : ""}`}>
          {tab === "transcript" && <Transcript segments={live.segments} follow />}
          {tab === "mynotes" && <MyNotes value={live.myNotes} onChange={setMyNotes} />}
          {tab === "topics" && <TopicsTab topics={live.meta.topics} onChange={setLiveTopics} />}
          {tab === "moments" && <Moments moments={live.moments} editable />}
          {tab === "summary" && (
            <>
              <PostHooks dir={live.dir} meta={live.meta} segments={async () => live.segments} myNotes={live.myNotes} summary={live.notes} version={live.hooksVersion} />
              {live.notes ? <Markdown text={live.notes} /> : <p className="empty">No summary yet.</p>}
            </>
          )}
        </div>
      </div>
      <CopilotPanel
        live={live.phase === "live"}
        suggestions={live.suggestions}
        moments={live.moments}
        chat={live.chat}
        busy={live.chatBusy}
        thinking={live.thinking}
        onAsk={askLive}
        onMark={live.phase === "live" ? () => markMoment() : undefined}
        onDismiss={dismissSuggestion}
      />
    </div>
  );
}

function MyNotes({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="mynotes">
      <p className="muted small">
        Your own notes. They're saved as you type, steer the summary, and are saved with it into this session's topics, so the next call on the
        topic picks up from here.
      </p>
      <textarea className="editor" value={value} placeholder="- Dana sounded hesitant about Dallas&#10;- Ask Leo for the week-by-week numbers" onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function TopicsTab({ topics, onChange }: { topics: string[]; onChange: (topics: string[]) => void }) {
  const [files, setFiles] = useState<TopicFile[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState<Record<string, string>>({});
  useEffect(() => {
    setFiles(null);
    // Names only: file text is read when a preview is opened.
    const t0 = performance.now();
    (topics.length ? topicsList(topics) : Promise.resolve([])).then((list) => {
      setFiles(list.flatMap((t) => t.files));
      logEvent("info", "perf", `topics tab: ${list.length} topics in ${Math.round(performance.now() - t0)} ms`);
    });
  }, [topics.join(",")]);
  const toggle = (path: string) => {
    const next = open === path ? null : path;
    setOpen(next);
    if (next && content[next] === undefined) fsRead(next).then((text) => setContent((c) => ({ ...c, [next]: text })));
  };
  return (
    <div className="topics-tab">
      <TopicPicker selected={topics} onChange={onChange} />
      <h4>What the copilot can see {files ? `(${files.length} files)` : ""}</h4>
      {files === null ? (
        <p className="empty">Loading…</p>
      ) : files.length === 0 ? (
        <p className="empty">No topic attached. Attach one so nudges and notes can use its history.</p>
      ) : null}
      <ul className="doc-list">
        {(files ?? []).map((d) => (
          <li key={d.path}>
            <button className={`file ${open === d.path ? "on" : ""}`} onClick={() => toggle(d.path)}>
              {d.path.replace(/^topics\//, "")}
            </button>
            {open === d.path && (
              <div className="doc-preview">{content[d.path] === undefined ? <p className="muted small">Loading…</p> : <Markdown text={content[d.path]} />}</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Virtualized: only the rows on screen are in the DOM, so an 8,000-line call opens instantly. */
const Transcript = memo(function Transcript({ segments, follow, loading }: { segments: Segment[]; follow?: boolean; loading?: boolean }) {
  if (loading) return <p className="empty">Loading transcript…</p>;
  if (!segments.length) return <p className="empty">{follow ? "Waiting for speech…" : "No transcript was recorded for this session."}</p>;
  return (
    <Virtuoso
      className="transcript"
      style={{ height: "100%" }}
      data={segments}
      computeItemKey={(_, s) => s.id}
      initialTopMostItemIndex={follow ? segments.length - 1 : 0}
      followOutput={follow ? "smooth" : false}
      itemContent={(_, s) => (
        <div className={`line ${s.speaker} ${s.final ? "" : "volatile"}`}>
          <span className="who">{s.speaker === "me" ? "You" : "Them"}</span>
          <span className="when">{clock(s.start)}</span>
          <p>{s.text}</p>
        </div>
      )}
    />
  );
});

function Moments({ moments, editable, suggestions }: { moments: Moment[]; editable?: boolean; suggestions?: Suggestion[] }) {
  if (!moments.length)
    return (
      <p className="empty">
        Press the bookmark button (or ⌘B) whenever you wish you'd had a nudge, and add a few words on what you needed. These marked moments are
        how the replay harness scores the copilot.
      </p>
    );
  return (
    <ul className="moments">
      {moments.map((m, i) => {
        const near = suggestions?.filter((s) => s.at >= m.t - 45 && s.at <= m.t + 10) ?? [];
        return (
          <li key={i}>
            <span className="when">{clock(m.t)}</span>
            {editable ? (
              <input defaultValue={m.note ?? ""} placeholder="What did you need here?" onBlur={(e) => annotateMoment(i, e.target.value)} />
            ) : (
              <span>{m.note || <em className="muted">no note</em>}</span>
            )}
            {suggestions && <span className={`badge ${near.length ? "ok" : "miss"}`}>{near.length ? "nudge nearby" : "missed"}</span>}
          </li>
        );
      })}
    </ul>
  );
}

type PastTab = "summary" | "mynotes" | "transcript" | "topics" | "nudges";

function PastDetail({ dir, onChanged }: { dir: string; onChanged: () => void }) {
  const [data, setData] = useState<SessionData | null>(null);
  const [tab, setTab] = useState<PastTab>("summary");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [root, setRoot] = useState("");
  const dataRef = useRef<SessionData | null>(null);
  const notesTimer = useRef<number | null>(null);
  const transcriptPromise = useRef<Promise<Segment[]> | null>(null);
  /** Anything that needs the words (summary, chat, saving to topics) waits for the lazy transcript. */
  const segmentsNow = async () => (transcriptPromise.current ? await transcriptPromise.current : (dataRef.current?.segments ?? []));
  dataRef.current = data;

  useEffect(() => {
    let cancelled = false;
    const t0 = performance.now();
    loadSession(dir).then((d) => {
      if (cancelled) return;
      logEvent("info", "perf", `session open ${d.meta.id}: ${Math.round(performance.now() - t0)} ms (${d.segmentCount} lines pending)`);
      setData(d);
      if (!d.notes) setTab(d.myNotes ? "mynotes" : "transcript");
      // The transcript can be MBs: fetch it after the page has painted.
      transcriptPromise.current = loadTranscript(dir);
      transcriptPromise.current.then((segments) => {
        logEvent("info", "perf", `transcript ${d.meta.id}: ${segments.length} lines in ${Math.round(performance.now() - t0)} ms`);
        if (!cancelled) setData((cur) => (cur ? { ...cur, segments } : cur));
      });
    });
    dataRoot().then(setRoot);
    return () => {
      cancelled = true;
      setMiniPast(null);
    };
  }, [dir]);

  // Offer this session's nudges to the floating window (Pop out / ⌃⌥N).
  useEffect(() => {
    if (!data) return;
    setMiniPast({
      title: data.meta.title,
      phase: "past",
      startedAtMs: 0,
      date: data.meta.startedAt,
      suggestions: data.suggestions,
      thinking: false,
      moments: data.moments.length,
    });
  }, [data?.meta.title, data?.suggestions]);

  if (!data) return <div className="placeholder">Loading…</div>;
  const { meta } = data;

  const update = (patch: Partial<SessionData>) => setData((d) => (d ? { ...d, ...patch } : d));
  const saveMeta = async (next: SessionMeta) => {
    update({ meta: next });
    await fsWrite(`${dir}/session.json`, JSON.stringify(next, null, 2));
    onChanged();
  };

  const regenerate = async () => {
    setWorking(true);
    setError("");
    try {
      const notes = await generateNotes(dir, meta, await segmentsNow(), data.suggestions, data.myNotes);
      update({ notes });
      setTab("summary");
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };

  const setMine = (text: string) => {
    update({ myNotes: text });
    if (notesTimer.current) window.clearTimeout(notesTimer.current);
    notesTimer.current = window.setTimeout(() => fsWrite(`${dir}/my-notes.md`, text), 400);
  };

  const setTopics = async (topics: string[]) => {
    const next = { ...meta, topics };
    await saveMeta(next);
    if (data.notes) await saveToTopics(next, data.notes, data.myNotes, await segmentsNow());
  };

  const askPast = async (q: string) => {
    const current = dataRef.current!;
    const history = current.chat;
    const next: ChatMessage[] = [...history, { role: "user", content: q, at: 0 }];
    update({ chat: next });
    setChatBusy(true);
    let answer: ChatMessage;
    try {
      answer = await askSession(
        { meta: current.meta, segments: await segmentsNow(), myNotes: current.myNotes, chat: history, question: q, live: false },
        {
          appendNotes: async (md) => {
            const latest = (await fsRead(`${dir}/my-notes.md`).catch(() => dataRef.current?.myNotes ?? "")).trim();
            setMine(`${latest}\n\n${md.trim()}`.trim());
          },
          rename: async (title) => saveMeta({ ...dataRef.current!.meta, title, autoTitle: false }),
          attachTopic: async (topic) => setTopics([...new Set([...dataRef.current!.meta.topics, topic])]),
        },
      );
    } catch (e) {
      answer = { role: "assistant", content: `⚠️ ${String(e)}`, at: 0 };
    }
    const final = [...next, answer];
    update({ chat: final });
    setChatBusy(false);
    fsWrite(`${dir}/chat.json`, JSON.stringify(final, null, 1)).catch(() => {});
  };

  const tabs: [PastTab, string, string?][] = [
    ["summary", "Summary"],
    ["mynotes", "My notes", data.myNotes.trim() ? "●" : undefined],
    ["transcript", "Transcript", String(data.segmentCount)],
    ["topics", "Topics", String(meta.topics.length)],
    ["nudges", "Nudges & moments", `${data.suggestions.length}/${data.moments.length}`],
  ];

  return (
    <div className="detail">
      <div className="detail-main">
        <header className="detail-head">
          <div>
            <Title title={meta.title} onRename={(title) => saveMeta({ ...meta, title, autoTitle: false })} />
            <p className="muted">
              {new Date(meta.startedAt).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}
              {meta.durationSec ? ` · ${Math.max(1, Math.round(meta.durationSec / 60))} minutes` : ""}
              {meta.app ? ` · ${meta.app}` : ""}
              {` · ${meta.topics.length ? meta.topics.join(", ") : "no topic"}`}
            </p>
            <ModelsLine meta={meta} />
          </div>
          <div className="head-actions">
            <button className="btn" disabled={!data.suggestions.length} title="Floating window with one nudge at a time (⌃⌥N)" onClick={() => openMini(true)}>
              Pop out
            </button>
            <button className="btn" onClick={() => reveal(`${dir}/session.json`)}>
              <IconFolderOpen size={14} /> Show files
            </button>
          </div>
        </header>
        {meta.goal && <p className="goal">Goal: {meta.goal}</p>}
        {error && <div className="banner error">{error}</div>}
        <nav className="tabs">
          {tabs.map(([id, label, badge]) => (
            <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              {label} {badge && <em>{badge}</em>}
            </button>
          ))}
        </nav>
        <div className={`tab-body ${tab === "transcript" ? "fill" : ""}`}>
          {tab === "summary" && (
            <>
              <div className="toolbar">
                <button className="btn" disabled={working || (!data.segmentCount && !data.myNotes.trim())} onClick={regenerate}>
                  <IconRefresh size={14} /> {working ? "Writing summary…" : data.notes ? "Regenerate summary" : "Generate summary"}
                </button>
                <span className="muted small">
                  Uses transcript + your notes{meta.topics.length ? ` · saved to ${meta.topics.map((t) => `topics/${t}`).join(", ")}` : " · attach a topic to save it there"}
                </span>
              </div>
              <PostHooks dir={dir} meta={meta} segments={segmentsNow} myNotes={data.myNotes} summary={data.notes} />
              {data.notes ? <Markdown text={data.notes} /> : <p className="empty">No summary yet.</p>}
            </>
          )}
          {tab === "mynotes" && <MyNotes value={data.myNotes} onChange={setMine} />}
          {tab === "transcript" && <Transcript segments={data.segments} loading={data.segmentCount > 0 && !data.segments.length} />}
          {tab === "topics" && <TopicsTab topics={meta.topics} onChange={setTopics} />}
          {tab === "nudges" && (
            <div className="nudge-review">
              <h3>Marked moments</h3>
              <Moments moments={data.moments} suggestions={data.suggestions} />
              <h3>Score this session</h3>
              <p className="muted">Run the copilot again over this recording with any model and get precision, recall and latency against your marked moments:</p>
              <pre className="code">pnpm replay "{root}/{dir}" --data-root "{root}"</pre>
            </div>
          )}
        </div>
      </div>
      <CopilotPanel live={false} suggestions={data.suggestions} moments={data.moments} chat={data.chat} busy={chatBusy} onAsk={askPast} />
    </div>
  );
}
