// Replay harness: run a recorded session through the live copilot pipeline and
// score its nudges against the moments the user marked as "I wanted a nudge here".
//
//   node scripts/replay.ts <sessionDir> [options]
//
// <sessionDir> holds what the app records for every session:
//   transcript.jsonl   final segments ({speaker, text, start, end})
//   moments.json       [{t, note?, kind?}] — ground truth, marked live with the bookmark button
//   session.json       {goal, topics} (optional)
//   me.m4a, them.m4a   (in app data) used with --transcribe to regenerate transcript.jsonl on-device
//
// Options:
//   --data-root <dir>        where topics/ live (default ~/Documents/Earshot)
//   --gate <provider:model>  e.g. openrouter:anthropic/claude-haiku-5.5
//   --suggest <provider:model>
//   --before 45 --after 10   match window around a moment, seconds
//   --stt-delay 0.4          assumed delay between end of speech and a final transcript
//   --transcribe             re-transcribe me.wav/them.wav with the audio sidecar first
//   --runs 1                 repeat to see run-to-run variance
//   --judge <provider:model>  model that checks a nudge actually addresses the moment's note
//                            (default: the gate model). --no-judge matches on time only.
//
// Time is simulated but model calls are real: when the copilot evaluates, the
// session clock advances by the actual wall-clock time the models took, so the
// reported latency is what you'd see live (minus real STT jitter).
// API keys come from env (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY)
// or the app's keychain entries.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Copilot, clock } from "../src/core/copilot.ts";
import { DEFAULT_MODEL_SETTINGS, ModelClient, type ModelSettings, type Transport } from "../src/core/providers.ts";
import { Retriever, type Doc } from "../src/core/retrieval.ts";
import type { Moment, Segment, Suggestion } from "../src/core/types.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const sessionDir = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!sessionDir) {
  console.error("usage: node scripts/replay.ts <sessionDir> [--gate provider:model] [--suggest provider:model] ...");
  process.exit(2);
}
const dataRoot = resolve(flag("data-root", join(homedir(), "Documents", "Earshot"))!);
const before = Number(flag("before", "45"));
const after = Number(flag("after", "10"));
const sttDelay = Number(flag("stt-delay", "0.4"));
const runs = Number(flag("runs", "1"));
const repoRoot = resolve(import.meta.dirname, "..");

const ENV_KEYS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  openai: ["OPENAI_API_KEY", "OPENAI_KEY"],
};

const transport: Transport = {
  fetch: globalThis.fetch,
  async getSecret(name) {
    for (const key of ENV_KEYS[name] ?? []) if (process.env[key]) return process.env[key]!;
    try {
      return execFileSync("security", ["find-generic-password", "-s", "app.earshot.desktop", "-a", name, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  },
  runCli(tool, args, stdin) {
    return new Promise((ok, fail) => {
      const child = spawn(tool, args, { cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => (code === 0 ? ok(out) : fail(new Error(`${tool} exited ${code}: ${err.slice(0, 300)}`))));
      child.stdin.end(stdin);
    });
  },
};

function settings(): ModelSettings {
  const s: ModelSettings = structuredClone(DEFAULT_MODEL_SETTINGS);
  for (const role of ["gate", "suggest", "chat"] as const) {
    const value = flag(role);
    if (!value) continue;
    const [providerId, ...model] = value.split(":");
    s.roles[role] = { providerId, model: model.join(":") };
  }
  return s;
}

/** Does this nudge address what the user said they needed at that moment? Time alone over-credits. */
async function judge(client: ModelClient, suggestion: Suggestion, moment: Moment): Promise<boolean> {
  if (!moment.note) return true;
  const reply = await client.complete("chat", {
    system: "You grade a live-call assistant. Answer with exactly YES or NO.",
    messages: [
      {
        role: "user",
        content: `The user marked this moment: "${moment.note}"\nThe assistant showed: "${suggestion.text}"\nWould this nudge have given the user what the marked moment describes (same subject and the same need, even if worded differently)? YES or NO.`,
      },
    ],
    maxTokens: 5,
    temperature: 0,
  });
  return /^\s*yes/i.test(reply.text);
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function loadTopicDocs(topics: string[]): Doc[] {
  const docs: Doc[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md")) docs.push({ path: relative(dataRoot, full), content: readFileSync(full, "utf8") });
    }
  };
  for (const topic of topics) {
    const dir = join(dataRoot, "topics", topic);
    if (existsSync(dir)) walk(dir);
    else console.warn(`topic not found: ${dir}`);
  }
  return docs;
}

function transcribe(dir: string): void {
  const bin = join(repoRoot, "audio/.build/release/earshot-audio");
  const args = ["transcribe"];
  // Audio lives in app data (AAC) since recordings moved out of the data folder; older sessions have WAVs beside the transcript.
  const audioDir = join(homedir(), "Library/Application Support/app.earshot.desktop/recordings", dir.split("/").pop()!);
  for (const speaker of ["me", "them"]) {
    const found = [join(audioDir, `${speaker}.m4a`), join(dir, `${speaker}.m4a`), join(dir, `${speaker}.wav`)].find((p) => existsSync(p));
    if (found) args.push(`--${speaker}`, found);
  }
  const out = execFileSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const segments = out.split("\n").filter((l) => l.includes('"segment"'));
  writeFileSync(join(dir, "transcript.jsonl"), segments.join("\n") + "\n");
  console.log(`transcribed ${segments.length} segments`);
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

interface RunResult {
  suggestions: Suggestion[];
  matched: Map<Suggestion, Moment>;
  missed: Moment[];
  trace: Copilot["trace"];
}

async function runOnce(segments: Segment[], moments: Moment[], goal: string, docs: Doc[], client: ModelClient, judgeClient: ModelClient | null): Promise<RunResult> {
  const copilot = new Copilot({
    complete: (role, req) => client.complete(role, req),
    retriever: new Retriever(docs),
    goal,
  });
  const arrivals = segments.map((s) => ({ seg: s, arrive: s.end + sttDelay })).sort((a, b) => a.arrive - b.arrive);
  const end = (arrivals.at(-1)?.arrive ?? 0) + 5;
  let t = 0;
  let i = 0;
  while (t <= end) {
    while (i < arrivals.length && arrivals[i].arrive <= t) {
      copilot.addSegment(arrivals[i].seg, arrivals[i].arrive);
      i++;
    }
    const trigger = copilot.check(t);
    if (trigger) {
      const base = t;
      const wall = Date.now();
      const now = () => base + (Date.now() - wall) / 1000;
      try {
        const s = await copilot.evaluate(trigger, now);
        if (s) console.log(`  [${clock(s.at)}] ${s.kind.padEnd(10)} ${s.text}  (${s.latency.toFixed(1)}s)`);
      } catch (error) {
        console.error(`  [${clock(base)}] error: ${error}`);
      }
      t = now();
      continue;
    }
    t += 0.25;
  }

  // Greedy one-to-one matching: each moment takes the closest unmatched suggestion
  // in its window that the judge agrees addresses it.
  const matched = new Map<Suggestion, Moment>();
  const missed: Moment[] = [];
  for (const m of [...moments].sort((a, b) => a.t - b.t)) {
    const candidates = copilot.suggestions
      .filter((s) => !matched.has(s) && s.at >= m.t - before && s.at <= m.t + after)
      .sort((a, b) => Math.abs(a.at - m.t) - Math.abs(b.at - m.t));
    let hit: Suggestion | undefined;
    for (const c of candidates) {
      if (!judgeClient || (await judge(judgeClient, c, m))) {
        hit = c;
        break;
      }
    }
    if (hit) matched.set(hit, m);
    else missed.push(m);
  }
  return { suggestions: copilot.suggestions, matched, missed, trace: copilot.trace };
}

async function main() {
  const dir = resolve(sessionDir!);
  if (argv.includes("--transcribe")) transcribe(dir);
  const segments = readJsonl<Segment>(join(dir, "transcript.jsonl")).filter((s) => s.final !== false);
  const moments: Moment[] = existsSync(join(dir, "moments.json")) ? JSON.parse(readFileSync(join(dir, "moments.json"), "utf8")) : [];
  const meta = existsSync(join(dir, "session.json")) ? JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) : {};
  const docs = loadTopicDocs(meta.topics ?? []);
  const s = settings();
  const client = new ModelClient(s, transport);
  const judgeSpec = flag("judge");
  const judgeSettings: ModelSettings = structuredClone(s);
  if (judgeSpec) {
    const [providerId, ...model] = judgeSpec.split(":");
    judgeSettings.roles.chat = { providerId, model: model.join(":") };
  } else {
    judgeSettings.roles.chat = s.roles.gate;
  }
  const judgeClient = argv.includes("--no-judge") ? null : new ModelClient(judgeSettings, transport);
  console.log(`replaying ${segments.length} segments, ${moments.length} marked moments, ${docs.length} topic docs`);
  console.log(`gate=${s.roles.gate.providerId}:${s.roles.gate.model} suggest=${s.roles.suggest.providerId}:${s.roles.suggest.model}\n`);

  const results: RunResult[] = [];
  for (let r = 0; r < runs; r++) {
    if (runs > 1) console.log(`run ${r + 1}/${runs}`);
    results.push(await runOnce(segments, moments, meta.goal ?? "", docs, client, judgeClient));
  }

  const rows = results.map((r) => {
    const precision = r.suggestions.length ? r.matched.size / r.suggestions.length : NaN;
    const recall = moments.length ? (moments.length - r.missed.length) / moments.length : NaN;
    return { r, precision, recall };
  });
  const all = results.flatMap((r) => r.suggestions);
  const latencies = all.map((x) => x.latency);
  const modelMs = all.map((x) => x.modelMs);
  const gateMs = results.flatMap((r) => r.trace.filter((e) => e.type === "gate-skip" || e.type === "gate-speak").map((e) => e.modelMs ?? 0));
  const triggers = results.reduce((n, r) => n + r.trace.filter((e) => e.type === "trigger").length, 0);
  const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const last = results.at(-1)!;
  const report = `# Replay — ${dir.split("/").pop()}

- Date: ${new Date().toISOString()}
- Gate: \`${s.roles.gate.providerId}:${s.roles.gate.model}\` · Suggest: \`${s.roles.suggest.providerId}:${s.roles.suggest.model}\`
- Segments: ${segments.length} · Marked moments: ${moments.length} · Topic docs: ${docs.length} · Runs: ${runs}
- Match window: moment −${before}s / +${after}s · Judge: ${judgeClient ? `\`${judgeSettings.roles.chat.providerId}:${judgeSettings.roles.chat.model}\`` : "off (time only)"} · Assumed STT delay: ${sttDelay}s

| Metric | Value |
|---|---|
| Suggestions surfaced (per run) | ${fmt(all.length / runs, 1)} |
| Triggers evaluated (per run) | ${fmt(triggers / runs, 1)} |
| Precision (surfaced that matched a moment) | ${fmt(mean(rows.map((x) => x.precision)))} |
| Recall (moments that got a nudge) | ${fmt(mean(rows.map((x) => x.recall)))} |
| Latency p50 / p95 (end of their speech → on screen) | ${fmt(percentile(latencies, 50), 1)}s / ${fmt(percentile(latencies, 95), 1)}s |
| Model time p50 / p95 (gate + suggester) | ${fmt(percentile(modelMs, 50) / 1000, 1)}s / ${fmt(percentile(modelMs, 95) / 1000, 1)}s |
| Gate call p50 | ${fmt(percentile(gateMs, 50) / 1000, 1)}s |

## Suggestions (last run)

| At | Kind | Suggestion | Matched moment | Latency |
|---|---|---|---|---|
${last.suggestions.map((x) => `| ${clock(x.at)} | ${x.kind} | ${x.text.replace(/\|/g, "\\|")} | ${last.matched.get(x) ? `${clock(last.matched.get(x)!.t)} ${last.matched.get(x)!.note ?? ""}` : "—"} | ${x.latency.toFixed(1)}s |`).join("\n")}

## Missed moments (last run)

${last.missed.map((m) => `- ${clock(m.t)} ${m.note ?? ""}`).join("\n") || "None."}
`;
  const outDir = join(dir, "replays");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(outDir, `${stamp}.md`), report);
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ settings: s.roles, results: results.map((r) => ({ suggestions: r.suggestions, missed: r.missed, trace: r.trace })) }, null, 2));
  console.log(`\n${report}\nsaved ${relative(process.cwd(), join(outDir, `${stamp}.md`))}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
