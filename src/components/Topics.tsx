// Topics are folders of markdown: prep docs you write or drop in, plus notes
// saved from every call linked to the topic. Sessions read them for context.

import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { fsMkdir, fsRead, fsWrite, importFiles, reveal } from "../lib/backend";
import { listTopics, slugify, type Topic } from "../lib/library";
import { askTopic } from "../lib/assistant";
import { readJson } from "../lib/backend";
import type { ChatMessage } from "../core/types";
import { useCollapsed } from "../lib/panels";
import { ChatBox } from "./ChatBox";
import { LinkedSource } from "./LinkedSource";
import { Markdown } from "./Markdown";
import { IconCheck, IconEdit, IconFolderOpen, IconPlus, IconSend, IconTopics, IconUpload } from "./icons";

export function TopicsView() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed("topic-panel", { chat: false });

  const refresh = useCallback(async () => {
    const list = await listTopics();
    setTopics(list);
    return list;
  }, []);

  useEffect(() => {
    refresh().then((list) => setSelected((s) => s ?? list[0]?.slug ?? null));
  }, [refresh]);

  useEffect(() => {
    setEditing(false);
    if (file) fsRead(file).then(setContent).catch(() => setContent(""));
  }, [file]);

  const topic = topics.find((t) => t.slug === selected);

  useEffect(() => {
    if (selected) readJson<ChatMessage[]>(`topics/${selected}/.chat.json`, []).then(setChat);
  }, [selected]);

  const ask = async (q: string) => {
    if (!selected) return;
    const history = chat;
    const next: ChatMessage[] = [...history, { role: "user", content: q, at: Date.now() }];
    setChat(next);
    setChatBusy(true);
    let answer: ChatMessage;
    try {
      answer = await askTopic(selected, history, q);
    } catch (e) {
      answer = { role: "assistant", content: `⚠️ ${String(e)}`, at: 0 };
    }
    const final = [...next, { ...answer, at: Date.now() }];
    setChat(final);
    setChatBusy(false);
    fsWrite(`topics/${selected}/.chat.json`, JSON.stringify(final.slice(-60), null, 1)).catch(() => {});
    if (answer.actions?.some((a) => a.ok)) {
      await refresh();
      if (file) fsRead(file).then(setContent).catch(() => {});
    }
  };

  const createTopic = async () => {
    const slug = slugify(newName);
    await fsMkdir(`topics/${slug}`);
    await fsWrite(
      `topics/${slug}/prep.md`,
      `# ${newName.trim()}\n\n## People\n- \n\n## Background\n\n## What I want from upcoming calls\n- \n`,
    );
    setCreating(false);
    setNewName("");
    await refresh();
    setSelected(slug);
    setFile(`topics/${slug}/prep.md`);
    setEditing(true);
  };

  const upload = async () => {
    if (!topic) return;
    const picked = await open({ multiple: true, filters: [{ name: "Markdown / text", extensions: ["md", "markdown", "txt"] }] });
    if (!picked) return;
    const sources = Array.isArray(picked) ? picked : [picked];
    const copied = await importFiles(sources, `topics/${topic.slug}`);
    await refresh();
    if (copied[0]) setFile(copied[0]);
  };

  const newNote = async () => {
    if (!topic) return;
    const path = `topics/${topic.slug}/note-${new Date().toISOString().slice(0, 10)}-${Date.now() % 10000}.md`;
    await fsWrite(path, "# New note\n\n");
    await refresh();
    setFile(path);
    setEditing(true);
  };

  const save = async () => {
    if (!file) return;
    await fsWrite(file, content);
    setEditing(false);
    refresh();
  };

  return (
    <div className="split">
      <div className="list-col">
        <div className="list-head">
          <h2>Topics</h2>
          <button className="icon-btn" aria-label="New topic" onClick={() => setCreating(true)}>
            <IconPlus />
          </button>
        </div>
        {creating && (
          <form
            className="card new-topic"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) createTopic();
            }}
          >
            <input autoFocus value={newName} placeholder="Topic name, e.g. Acme pilot" onChange={(e) => setNewName(e.target.value)} />
            <button className="btn primary small" type="submit">
              Create
            </button>
          </form>
        )}
        {topics.map((t) => (
          <button
            key={t.slug}
            className={`card session-card ${selected === t.slug ? "selected" : ""}`}
            onClick={() => {
              setSelected(t.slug);
              setFile(null);
            }}
          >
            <IconTopics size={16} />
            <div>
              <strong>{t.slug}</strong>
              <small>
                {t.files.filter((f) => !f.isSession).length} docs · {t.files.filter((f) => f.isSession).length} sessions
              </small>
            </div>
          </button>
        ))}
        {!topics.length && !creating && (
          <p className="empty">
            A topic is a person, deal, project or anything you have recurring calls about. Its markdown files are what the copilot uses for
            connections and facts, and every call linked to it saves its notes back here.
          </p>
        )}
      </div>
      <div className="detail-col">
        {topic ? (
          <div className="topic-detail">
            <div className="topic-files">
              <h4 className="section-head">Linked source</h4>
              <LinkedSource slug={topic.slug} onChanged={refresh} />
              <div className="section-divider" />
              <h4 className="section-head">Your files</h4>
              <div className="toolbar">
                <button className="btn small" onClick={newNote}>
                  <IconPlus size={14} /> New note
                </button>
                <button className="btn small" onClick={upload}>
                  <IconUpload size={14} /> Upload .md
                </button>
                <button className="icon-btn" title="Show in Finder" onClick={() => reveal(topic.files[0]?.path ?? `topics/${topic.slug}`)}>
                  <IconFolderOpen size={16} />
                </button>
              </div>
              {topic.files.some((f) => f.path.includes("/linked/")) && (
                <>
                  <h4>Linked (read-only)</h4>
                  {topic.files
                    .filter((f) => f.path.includes("/linked/"))
                    .map((f) => (
                      <button key={f.path} className={`file ${file === f.path ? "on" : ""}`} onClick={() => setFile(f.path)}>
                        {f.name}
                      </button>
                    ))}
                </>
              )}
              <h4>Prep docs</h4>
              {topic.files
                .filter((f) => !f.isSession && !f.path.includes("/linked/"))
                .map((f) => (
                  <button key={f.path} className={`file ${file === f.path ? "on" : ""}`} onClick={() => setFile(f.path)}>
                    {f.name}
                  </button>
                ))}
              <h4>Session notes</h4>
              {topic.files.filter((f) => f.isSession).length === 0 && <p className="muted small">Calls linked to this topic save notes here.</p>}
              {topic.files
                .filter((f) => f.isSession)
                .map((f) => (
                  <button key={f.path} className={`file ${file === f.path ? "on" : ""}`} onClick={() => setFile(f.path)}>
                    {f.name.replace(/\.md$/, "")}
                  </button>
                ))}
            </div>
            <div className="topic-doc">
              {file ? (
                <>
                  <div className="toolbar">
                    <span className="muted small">{file}</span>
                    <span className="spacer" />
                    {file.includes("/linked/") ? (
                      <span className="muted small">Linked copy · edit it at the source</span>
                    ) : editing ? (
                      <button className="btn primary small" onClick={save}>
                        <IconCheck size={14} /> Save
                      </button>
                    ) : (
                      <button className="btn small" onClick={() => setEditing(true)}>
                        <IconEdit size={14} /> Edit
                      </button>
                    )}
                  </div>
                  {editing ? (
                    <textarea
                      className="editor"
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                          e.preventDefault();
                          save();
                        }
                      }}
                    />
                  ) : (
                    <Markdown text={content} />
                  )}
                </>
              ) : (
                <p className="empty">Pick a file, write a new note, or upload markdown. Names, numbers, dates and open questions are the most useful things to keep here.</p>
              )}
            </div>
            <aside className={`copilot topic-chat ${collapsed.chat ? "rail" : ""}`}>
              {collapsed.chat ? (
                <button className="rail-toggle" title="Show chat" onClick={() => toggleCollapsed("chat")}>
                  <IconSend size={16} />
                </button>
              ) : (
              <ChatBox
                onToggle={() => toggleCollapsed("chat")}
                title={`Chat · ${topic.slug}`}
                chat={chat}
                busy={chatBusy}
                onAsk={ask}
                quickActions={["What do I know so far?", "What's still open from past calls?", "Prep me for the next call"]}
                emptyText="Ask about this topic, or tell me to change it: “add this as a markdown file: …”, “append to prep.md that Dana prefers email”, “create a pricing note with …”."
                placeholder="Ask, or tell me what to save…"
              />
              )}
            </aside>
          </div>
        ) : (
          <div className="placeholder">
            <p>Create a topic to keep prep notes and call history together.</p>
          </div>
        )}
      </div>
    </div>
  );
}
