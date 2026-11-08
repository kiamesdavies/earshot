// Pick topics for a session: search, toggle, or create one on the spot.

import { useEffect, useState } from "react";
import { fsMkdir, fsWrite } from "../lib/backend";
import { listTopics, slugify, type Topic } from "../lib/library";
import { IconPlus } from "./icons";

export function TopicPicker({ selected, onChange }: { selected: string[]; onChange: (topics: string[]) => void }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [query, setQuery] = useState("");

  const refresh = () => listTopics().then(setTopics);
  useEffect(() => {
    refresh();
  }, []);

  const toggle = (slug: string) => onChange(selected.includes(slug) ? selected.filter((x) => x !== slug) : [...selected, slug]);
  const q = query.trim().toLowerCase();
  const matches = topics.filter((t) => !q || t.slug.includes(slugify(q)));
  const exact = topics.some((t) => t.slug === slugify(q));

  const create = async () => {
    const slug = slugify(query);
    await fsMkdir(`topics/${slug}`);
    await fsWrite(`topics/${slug}/prep.md`, `# ${query.trim()}\n\n## People\n- \n\n## Background\n\n## What I want from upcoming calls\n- \n`);
    await refresh();
    onChange([...selected, slug]);
    setQuery("");
  };

  return (
    <div className="topic-picker">
      <input
        value={query}
        placeholder={topics.length ? "Search or create a topic…" : "Name a topic to create it (person, deal, project)…"}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (q && !exact) create();
          else if (matches[0]) toggle(matches[0].slug);
        }}
      />
      <div className="chips">
        {matches.map((t) => (
          <button type="button" key={t.slug} className={`chip ${selected.includes(t.slug) ? "on" : ""}`} onClick={() => toggle(t.slug)}>
            {t.slug} <em>{t.files.length}</em>
          </button>
        ))}
        {q && !exact && (
          <button type="button" className="chip create" onClick={create}>
            <IconPlus size={12} /> Create “{query.trim()}”
          </button>
        )}
      </div>
      {selected.length > 0 && <small className="muted">Selected: {selected.join(", ")}</small>}
    </div>
  );
}
