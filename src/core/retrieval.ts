// Local BM25 over topic markdown. Topics are small (a few dozen files), so an
// in-memory index rebuilt at session start is fast and needs no database.

export interface Doc {
  /** Path relative to the data root, e.g. topics/acme/prep.md */
  path: string;
  content: string;
}

export interface Chunk {
  path: string;
  heading: string;
  text: string;
}

export interface Hit extends Chunk {
  score: number;
}

const STOP = new Set(
  "a an and are as at be but by for from has have i if in into is it its of on or so that the their them then there these they this to was we were what when which who will with you your our us me my do does did not no yes just can could would should about".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Split markdown on headings, then cap chunk size so one long section doesn't dominate. */
export function chunkMarkdown(doc: Doc, maxChars = 1200): Chunk[] {
  const chunks: Chunk[] = [];
  let heading = doc.path.split("/").pop() ?? doc.path;
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text) return;
    for (let i = 0; i < text.length; i += maxChars) {
      chunks.push({ path: doc.path, heading, text: text.slice(i, i + maxChars) });
    }
  };
  for (const line of doc.content.split("\n")) {
    const match = /^#{1,4}\s+(.*)/.exec(line);
    if (match) {
      flush();
      heading = match[1].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return chunks;
}

export class Retriever {
  private chunks: Chunk[] = [];
  private termFreqs: Map<string, number>[] = [];
  private docFreq = new Map<string, number>();
  private avgLength = 0;
  readonly docs: Doc[];

  constructor(docs: Doc[]) {
    this.docs = docs;
    for (const doc of docs) this.chunks.push(...chunkMarkdown(doc));
    let total = 0;
    for (const chunk of this.chunks) {
      const tf = new Map<string, number>();
      const tokens = tokenize(`${chunk.heading} ${chunk.text}`);
      total += tokens.length;
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
      this.termFreqs.push(tf);
    }
    this.avgLength = this.chunks.length ? total / this.chunks.length : 0;
  }

  get size(): number {
    return this.chunks.length;
  }

  search(query: string, k = 4, minScore = 1.0): Hit[] {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length || !this.chunks.length) return [];
    const n = this.chunks.length;
    const k1 = 1.4;
    const b = 0.75;
    const scored = this.chunks.map((chunk, i) => {
      const tf = this.termFreqs[i];
      let length = 0;
      for (const c of tf.values()) length += c;
      let score = 0;
      for (const term of terms) {
        const f = tf.get(term);
        if (!f) continue;
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * length) / (this.avgLength || 1))));
      }
      return { ...chunk, score };
    });
    return scored
      .filter((h) => h.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** A compact outline of what the topics contain, for the gate prompt. */
  outline(maxChars = 1500): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const chunk of this.chunks) {
      const key = `${chunk.path} › ${chunk.heading}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${key}`);
    }
    const text = lines.join("\n");
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n- …` : text;
  }
}
