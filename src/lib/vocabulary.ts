// Builds the vocabulary hint for Whisper: the user's own list, topic names,
// and proper nouns that recur in the topic notes (people, companies, products).

import type { Doc } from "../core/retrieval";

const COMMON = new Set("The This That There These Then When What Where Which Who Why How And But For With From Into About After Before Also Just Some Next Last First Notes Summary Decisions Open Questions Highlights Background People Goal Goals Meeting Call Today Tomorrow Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December".split(" "));

export function buildVocabulary(userWords: string, userName: string, topics: string[], docs: Doc[], max = 40): string {
  const words: string[] = [];
  const add = (w: string) => {
    const clean = w.trim();
    if (clean && !words.some((x) => x.toLowerCase() === clean.toLowerCase())) words.push(clean);
  };
  userWords.split(/[,\n]/).forEach(add);
  if (userName) add(userName);
  topics.forEach((t) => add(t.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ")));
  const counts = new Map<string, number>();
  for (const doc of docs) {
    for (const m of doc.content.matchAll(/\b[A-Z][a-zA-Z0-9]+(?:[ .-][A-Z0-9][a-zA-Z0-9]+)*\b/g)) {
      const term = m[0];
      if (term.length < 3 || COMMON.has(term)) continue;
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).forEach(([t]) => add(t));
  return words.slice(0, max).join(", ");
}
