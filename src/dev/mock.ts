// Dev-only: lets the UI run in a plain browser (`pnpm dev`, open localhost:1420)
// with an in-memory backend seeded from fixtures/demo-call. A fake capture
// replays the demo transcript and a fake model returns canned nudges.
// Never loaded inside the Tauri app.

import { emit, listen } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import seed from "./seed.json";

const files = new Map<string, string>(Object.entries(seed as Record<string, string>));
const settings: Record<string, unknown> = { consentAcknowledged: true, userName: "James" };
let timers: number[] = [];

function list(path: string, recursive: boolean) {
  const prefix = path ? `${path}/` : "";
  const out = new Map<string, { name: string; path: string; isDir: boolean; modified: number; size: number }>();
  for (const [file, content] of files) {
    if (!file.startsWith(prefix)) continue;
    const parts = file.slice(prefix.length).split("/");
    const depth = recursive ? parts.length : 1;
    for (let i = 0; i < depth; i++) {
      const rel = prefix + parts.slice(0, i + 1).join("/");
      const isDir = i < parts.length - 1;
      out.set(rel, { name: parts[i], path: rel, isDir, modified: Date.now(), size: isDir ? 0 : content.length });
    }
  }
  return [...out.values()];
}

function fakeCapture(dir: string) {
  const segments = (seed as Record<string, string>)["sessions/2026-10-20-150000/transcript.jsonl"]
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const speed = 2;
  const start = Date.now();
  timers.push(window.setTimeout(() => emit("audio", { type: "started", startedAt: new Date(start).toISOString() }), 300));
  timers.push(window.setInterval(() => emit("audio", { type: "level", me: Math.random() * 0.05, them: Math.random() * 0.2 }), 250));
  for (const s of segments) {
    const words = s.text.split(" ");
    words.forEach((_: string, i: number) => {
      if (i % 4 !== 3) return;
      const at = ((s.start + ((s.end - s.start) * i) / words.length) / speed) * 1000;
      timers.push(window.setTimeout(() => emit("audio", { ...s, start: s.start / speed, end: s.end / speed, text: words.slice(0, i + 1).join(" "), final: false }), at));
    });
    timers.push(window.setTimeout(() => emit("audio", { ...s, start: s.start / speed, end: s.end / speed }), (s.end / speed) * 1000 + 300));
  }
  void dir;
}

const canned = [
  { kind: "connection", text: "Dallas sync failures were ticket ACM-118, fixed 2026-09-02 — tell Dana it's resolved.", why: "Their main rollout worry", source: "topics/acme-pilot/prep.md" },
  { kind: "connection", text: "Reno changed shift schedules in week 5 — new pickers joined mid-pilot, which explains slower onboarding.", why: "Reframes the onboarding concern", source: "topics/acme-pilot/prep.md" },
  { kind: "commitment", text: "Confirm: 3-site quote to Dana by Friday the 13th, ahead of the 14th budget review?", why: "Pin the deadline now" },
];
let cannedIndex = 0;

const mockFetch = async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  const system: string = body.messages?.[0]?.content ?? "";
  await new Promise((r) => setTimeout(r, 700));
  let content: string;
  if (system.includes("You decide whether")) {
    content = cannedIndex < canned.length ? '{"speak": true, "kind": "connection", "need": "x", "query": "dallas reno quote"}' : '{"speak": false, "need": "nothing new"}';
  } else if (system.includes("You write one nudge")) {
    content = JSON.stringify(canned[cannedIndex++ % canned.length]);
  } else if (system.includes("post-call notes")) {
    content = "## Summary\nDana is positive on the pilot but needs a 3-site quote for procurement and the CFO before the budget review on the 14th.\n\n## To-dos\n- [ ] Me — send 3-site quote — by end of next week\n";
  } else {
    content = "You could ask: **“What does a December volume spike look like for you — 2x, 3x?”**";
  }
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });
};

function mockMiniState() {
  const at = (n: number) => n;
  listen("mini-ready", () =>
    emit("mini-state", {
      title: "Acme pilot review",
      phase: "live",
      startedAtMs: Date.now() - 754_000,
      thinking: false,
      moments: 1,
      suggestions: [
        { id: "s1", kind: "connection", text: "Dallas sync failures were ticket ACM-118, fixed 2026-09-02. Tell Dana it's resolved.", why: "Their main rollout worry", source: "topics/acme-pilot/prep.md", at: at(312), triggerEnd: 310, latency: 1.6, modelMs: 900 },
        { id: "s2", kind: "fact", text: "Agreed bar was 98.5% accuracy; Reno hit ~98%, Dallas ~97%.", why: "Frame the gap before she does", source: "topics/acme-pilot/prep.md", at: at(420), triggerEnd: 418, latency: 1.8, modelMs: 1000 },
        { id: "s3", kind: "commitment", text: "Confirm: 3-site quote to Dana by Friday the 13th, ahead of the 14th budget review?", why: "Pin the deadline now", at: at(610), triggerEnd: 608, latency: 1.4, modelMs: 800 },
      ],
    }),
  );
}

export function installMock() {
  (window as unknown as { __EARSHOT_FETCH__: unknown }).__EARSHOT_FETCH__ = mockFetch;
  mockWindows(window.location.hash.startsWith("#mini") ? "mini" : "main");
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, any>;
      switch (cmd) {
        case "settings_load":
          return settings;
        case "settings_save":
          Object.assign(settings, a.settings);
          return;
        case "data_root":
          return "/Users/you/Documents/Earshot";
        case "sessions_list":
          return [...new Set([...files.keys()].filter((k) => k.startsWith("sessions/") && k.endsWith("/session.json")))].map((k) => ({
            dir: k.replace("/session.json", ""),
            meta: JSON.parse(files.get(k)!),
          }));
        case "session_load": {
          const read = (n: string) => files.get(`${a.dir}/${n}`);
          const jsonl = (n: string) => (read(n) ?? "").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
          return {
            meta: JSON.parse(read("session.json") ?? "{}"),
            suggestions: jsonl("suggestions.jsonl"),
            moments: JSON.parse(read("moments.json") ?? "[]"),
            chat: JSON.parse(read("chat.json") ?? "[]"),
            notes: read("notes.md") ?? "",
            myNotes: read("my-notes.md") ?? "",
            segmentCount: jsonl("transcript.jsonl").length,
          };
        }
        case "session_transcript":
          return (files.get(`${a.dir}/transcript.jsonl`) ?? "").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
        case "topics_list": {
          const slugs: string[] = a.slugs ?? [...new Set([...files.keys()].filter((k) => k.startsWith("topics/")).map((k) => k.split("/")[1]))];
          return slugs.map((slug) => ({
            slug,
            files: [...files.keys()]
              .filter((k) => k.startsWith(`topics/${slug}/`) && k.endsWith(".md"))
              .map((path) => ({ path, name: path.split("/").pop(), modified: Date.now(), isSession: path.includes("/sessions/"), content: a.withContent ? files.get(path) : null })),
          }));
        }
        case "secrets_present":
          return a.names.map(() => true);
        case "log_event":
          console.info(`[log ${a.level}] ${a.category}: ${a.message}`);
          return;
        case "fs_read":
          if (!files.has(a.path)) throw new Error(`${a.path}: not found`);
          return files.get(a.path);
        case "fs_exists":
          return files.has(a.path);
        case "fs_write":
          files.set(a.path, a.content);
          return;
        case "fs_append":
          files.set(a.path, (files.get(a.path) ?? "") + a.content);
          return;
        case "fs_list":
          return list(a.path, !!a.recursive);
        case "secret_get":
          return "mock-key";
        case "cli_resolve":
          return a.command === "kiro-cli" ? null : `/usr/local/bin/${a.command}`;
        case "stt_catalog":
          return [
            { id: "whisper-large-v3-turbo", engine: "whisper", name: "Whisper large-v3 turbo", description: "Fast and accurate. Uses your vocabulary hints. 99 languages.", sizeBytes: 574041195, recommended: true, path: null, source: null, progress: null },
            { id: "parakeet-v3", engine: "parakeet", name: "Parakeet v3", description: "Fastest (~0.2s per phrase). 25 European languages.", sizeBytes: 670619803, recommended: false, path: "/Users/you/Library/Application Support/com.pais.handy/models/parakeet-tdt-0.6b-v3-int8", source: "Handy", progress: null },
            { id: "whisper-large-v3", engine: "whisper", name: "Whisper large-v3", description: "Most accurate, slowest (~1s per phrase).", sizeBytes: 1081140203, recommended: false, path: "/Users/you/Library/Application Support/com.pais.handy/models/ggml-large-v3-q5_0.bin", source: "Handy", progress: null },
            { id: "whisper-small-en", engine: "whisper", name: "Whisper small (English)", description: "Light and quick for older Macs.", sizeBytes: 190098681, recommended: false, path: null, source: null, progress: 0.42 },
          ];
        case "stt_find_models":
          return [
            { engine: "whisper", name: "ggml-large-v3-q5_0.bin", path: "/Users/you/Library/Application Support/com.pais.handy/models/ggml-large-v3-q5_0.bin", source: "Handy" },
            { engine: "parakeet", name: "parakeet-tdt-0.6b-v3-int8", path: "/Users/you/Library/Application Support/com.pais.handy/models/parakeet-tdt-0.6b-v3-int8", source: "Handy" },
          ];
        case "permissions":
          return { microphone: "granted", systemAudio: a.request ? "granted" : "not_determined" };
        case "audio_selftest":
          return [{ type: "level", me: 0.2, them: 0.1 }, { type: "segment", speaker: "me", final: true, text: "Testing one two three" }];
        case "fs_trash":
          for (const k of [...files.keys()]) if (k.startsWith(a.path + "/")) files.delete(k);
          return;
        case "plugin:dialog|ask":
        case "plugin:dialog|confirm":
          return true;
        case "capture_start":
          fakeCapture(a.dir);
          return;
        case "capture_stop":
          timers.forEach((t) => (window.clearTimeout(t), window.clearInterval(t)));
          timers = [];
          setTimeout(() => emit("audio", { type: "stopped" }), 200);
          return;
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  if (window.location.hash.startsWith("#mini")) mockMiniState();
}
