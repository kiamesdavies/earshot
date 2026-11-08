import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import type { CopilotConfig } from "../core/copilot";
import { CLI_PRESETS, ModelClient, type ProviderConfig, type Role } from "../core/providers";
import { sttConfig } from "../lib/live";
import {
  audioSelftest,
  sttCancelDownload,
  sttCatalog,
  sttDeleteModel,
  sttDownload,
  sttFindModels,
  sttPreload,
  type CatalogEntry,
  type FoundModel,
  cliResolve,
  dataRoot,
  openLogs,
  recordingsPurge,
  recordingsReveal,
  recordingsUsage,
  type RecordingsUsage,
  openPrivacySettings,
  permissions,
  secretGet,
  secretSet,
  transport,
  type PermissionReport,
} from "../lib/backend";
import { getSettings, updateSettings, useSettings } from "../lib/settings";
import { IconCheck, IconPlus, IconShield } from "./icons";
import { IntegrationsSection } from "./Integrations";

const ROLES: { role: Role; label: string; hint: string }[] = [
  { role: "gate", label: "Nudge gate", hint: "Runs at every turn-end to decide whether to speak. Fastest, cheapest model. A CLI here adds seconds of startup." },
  { role: "suggest", label: "Nudge writer", hint: "Writes the nudge when the gate says yes." },
  { role: "chat", label: "Chat & actions", hint: "Answers questions and takes actions (save notes, edit topics). Needs a model good at tool use." },
  { role: "summarize", label: "Summary", hint: "Writes post-call notes into your topics. Quality over speed; CLIs are fine." },
];

export function SettingsView() {
  const settings = useSettings();
  const [root, setRoot] = useState("");

  useEffect(() => {
    dataRoot().then(setRoot);
  }, [settings.dataRoot]);

  const providers = settings.models.providers;
  const setProviders = (next: ProviderConfig[]) => updateSettings({ models: { ...settings.models, providers: next } });
  const setRole = (role: Role, patch: Partial<{ providerId: string; model: string }>) =>
    updateSettings({ models: { ...settings.models, roles: { ...settings.models.roles, [role]: { ...settings.models.roles[role], ...patch } } } });
  const setAll = (providerId: string, model: string) =>
    updateSettings({
      models: { ...settings.models, roles: Object.fromEntries(ROLES.map(({ role }) => [role, { providerId, model }])) as typeof settings.models.roles },
    });
  const setCopilot = (patch: Partial<CopilotConfig>) => updateSettings({ copilot: { ...settings.copilot, ...patch } });

  const addCustom = (kind: "openai" | "cli") => {
    const id = `custom-${Date.now().toString(36)}`;
    setProviders([
      ...providers,
      kind === "openai"
        ? { id, name: "Custom endpoint", kind: "openai", baseUrl: "https://", secret: id }
        : { id, name: "Custom CLI", kind: "cli", command: "", args: ["{prompt}"] },
    ]);
  };

  const chooseRoot = async () => {
    const dir = await open({ directory: true, defaultPath: root });
    if (typeof dir === "string") await updateSettings({ dataRoot: dir });
  };

  return (
    <div className="settings">
      <h1>Settings</h1>

      <PermissionsSection />

      <IntegrationsSection />

      <TranscriptionSection />

      <section>
        <h2>Models</h2>
        <p className="muted">
          Pick one model for everything, or fine-tune per job below. API keys are stored in your macOS keychain. CLI providers run your own
          installed tool with your own login, on this Mac only. Check each provider's terms before using a subscription login outside its own app.
        </p>
        <UseForAll providers={providers} onApply={setAll} />
        <h3>Per job</h3>
        <div className="roles">
          {ROLES.map(({ role, label, hint }) => (
            <RoleRow
              key={role}
              role={role}
              label={label}
              hint={hint}
              providers={providers}
              providerId={settings.models.roles[role].providerId}
              model={settings.models.roles[role].model}
              onChange={(patch) => setRole(role, patch)}
            />
          ))}
        </div>

        <h3>Providers</h3>
        <div className="providers">
          {providers.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              onChange={(next) => setProviders(providers.map((x) => (x.id === p.id ? next : x)))}
              onRemove={p.id.startsWith("custom-") ? () => setProviders(providers.filter((x) => x.id !== p.id)) : undefined}
            />
          ))}
        </div>
        <div className="toolbar">
          <button className="btn small" onClick={() => addCustom("openai")}>
            <IconPlus size={14} /> OpenAI-compatible endpoint
          </button>
          <button className="btn small" onClick={() => addCustom("cli")}>
            <IconPlus size={14} /> Other CLI
          </button>
        </div>
      </section>

      <section>
        <h2>You</h2>
        <label className="field row">
          <span>Your name</span>
          <input value={settings.userName} placeholder="Shown to the model as ME" onChange={(e) => updateSettings({ userName: e.target.value })} />
        </label>
        <label className="field row">
          <span>Call language</span>
          <input value={settings.locale} placeholder="en-US" onChange={(e) => updateSettings({ locale: e.target.value })} />
        </label>
      </section>

      <section>
        <h2>Audio & calls</h2>
        <Toggle label="Transcribe the other side (system audio)" hint="Needs System Audio Recording permission (above)." value={settings.captureSystem} onChange={(v) => updateSettings({ captureSystem: v })} />
        <Toggle
          label="Echo cancellation"
          hint="For speakers instead of headphones. Earshot also drops your lines that just repeat what the other side said."
          value={settings.echoCancellation}
          onChange={(v) => updateSettings({ echoCancellation: v })}
        />
        <Toggle label="Offer to start when a call begins" hint="Shows a small prompt when another app starts using your mic." value={settings.autoPrompt} onChange={(v) => updateSettings({ autoPrompt: v })} />
        <Toggle
          label="Pop out nudges when I switch away during a call"
          hint="A small floating window, always on top, one nudge at a time. Drag it anywhere; it hides when you come back to Earshot."
          value={settings.autoPopOut}
          onChange={(v) => updateSettings({ autoPopOut: v })}
        />
        <Toggle label="Write the summary automatically when a session ends" value={settings.autoSummarize} onChange={(v) => updateSettings({ autoSummarize: v })} />
      </section>

      <section>
        <h2>When the copilot speaks</h2>
        <p className="muted">Tune against your own calls with the replay harness before changing these.</p>
        <NumberRow label="Silence before a turn counts as finished (s)" value={settings.copilot.turnSilence} step={0.1} onChange={(v) => setCopilot({ turnSilence: v })} />
        <NumberRow label="Minimum gap between nudges (s)" value={settings.copilot.cooldown} step={1} onChange={(v) => setCopilot({ cooldown: v })} />
        <NumberRow label="Minimum words in their turn" value={settings.copilot.minTurnWords} step={1} onChange={(v) => setCopilot({ minTurnWords: v })} />
        <NumberRow label="Periodic check during long stretches (s)" value={settings.copilot.periodic} step={10} onChange={(v) => setCopilot({ periodic: v })} />
      </section>

      <section>
        <h2>Storage</h2>
        <div className="field row">
          <span>Data folder</span>
          <code className="path">{root}</code>
          <button className="btn small" onClick={chooseRoot}>
            Change…
          </button>
        </div>
        <p className="muted">Topics and sessions are plain folders and markdown files. Point this at an Obsidian vault folder to read them there.</p>
        <RecordingsStorage />
      </section>

      <section>
        <h2>Stop automatically</h2>
        <p className="muted">So a session you forget to stop can't keep recording. 0 turns a rule off.</p>
        <NumberRow label="Minutes after the call ends (0.5 = 30 seconds)" value={settings.autoStop.afterCallEndMin} step={0.5} onChange={(v) => updateSettings({ autoStop: { ...settings.autoStop, afterCallEndMin: v } })} />
        <NumberRow label="Minutes with no one speaking" value={settings.autoStop.idleMin} step={1} onChange={(v) => updateSettings({ autoStop: { ...settings.autoStop, idleMin: v } })} />
        <NumberRow label="Longest session (hours)" value={settings.autoStop.maxHours} step={1} onChange={(v) => updateSettings({ autoStop: { ...settings.autoStop, maxHours: v } })} />
      </section>
    </div>
  );
}

const STATE_LABEL: Record<string, [string, string]> = {
  granted: ["Allowed", "ok"],
  denied: ["Off", "bad"],
  not_determined: ["Not asked yet", "muted"],
  unknown: ["Unknown", "muted"],
};

function PermissionsSection() {
  const settings = useSettings();
  const [report, setReport] = useState<PermissionReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ running: boolean; me?: number; them?: number; lines: string[]; errors: string[] } | null>(null);

  const refresh = () => permissions(false).then(setReport).catch(() => setReport(null));
  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const request = async () => {
    setBusy(true);
    try {
      setReport(await permissions(true));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTest({ running: true, lines: [], errors: [] });
    const messages: Record<string, unknown>[] = await audioSelftest(settings.locale, settings.captureSystem, settings.echoCancellation, 6, sttConfig([], [])).catch((e) => [{ type: "error", message: String(e) }]);
    let me = 0;
    let them = 0;
    const lines: string[] = [];
    const errors: string[] = [];
    for (const m of messages) {
      if (m.type === "level") {
        me = Math.max(me, Number(m.me) || 0);
        them = Math.max(them, Number(m.them) || 0);
      } else if (m.type === "segment" && m.final) lines.push(`${m.speaker === "me" ? "You" : "Them"}: ${m.text}`);
      else if (m.type === "error") errors.push(String(m.message));
    }
    setTest({ running: false, me, them, lines, errors });
    refresh();
  };

  const row = (label: string, state: string | undefined, pane: "microphone" | "audio", where: string) => {
    const [text, cls] = STATE_LABEL[state ?? "unknown"];
    return (
      <div className="perm-row">
        <span className="perm-label">{label}</span>
        <span className={`pill ${cls}`}>{text}</span>
        <button className="btn small" onClick={() => openPrivacySettings(pane)}>
          Open System Settings
        </button>
        <small className="muted">{where}</small>
      </div>
    );
  };

  return (
    <section>
      <h2>
        <IconShield size={16} /> Permissions & audio check
      </h2>
      {row("Microphone (you)", report?.microphone, "microphone", "Privacy & Security → Microphone")}
      {row("System audio (them)", report?.systemAudio, "audio", "Privacy & Security → Screen & System Audio Recording → System Audio Recording Only")}
      <div className="toolbar">
        <button className="btn primary small" disabled={busy} onClick={request}>
          {busy ? "Waiting for your answer…" : "Request access"}
        </button>
        <button className="btn small" disabled={test?.running} onClick={runTest}>
          {test?.running ? "Recording 6 seconds — talk, and play a video…" : "Test audio (6s)"}
        </button>
        <button className="btn small" onClick={() => openLogs()}>
          Show logs
        </button>
        <small className="muted">If you just switched a permission on, quit and reopen Earshot.</small>
      </div>
      {test && !test.running && (
        <div className="selftest">
          <div>
            Mic peak: <strong className={test.me && test.me > 0.01 ? "ok" : "bad"}>{(test.me ?? 0).toFixed(3)}</strong> · System audio peak:{" "}
            <strong className={test.them && test.them > 0.001 ? "ok" : "bad"}>{(test.them ?? 0).toFixed(3)}</strong>
            <span className="muted small"> (0 means nothing arrived)</span>
          </div>
          {test.lines.length > 0 ? (
            <ul>
              {test.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No words transcribed. Speak during the test, and play something with speech for the system-audio side.</p>
          )}
          {test.errors.map((e, i) => (
            <div key={i} className="banner warn">
              {e}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TranscriptionSection() {
  const settings = useSettings();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [others, setOthers] = useState<FoundModel[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const stt = settings.stt;

  const refresh = async () => {
    const [cat, found] = await Promise.all([sttCatalog().catch(() => []), sttFindModels().catch(() => [])]);
    setCatalog(cat ?? []);
    const known = new Set((cat ?? []).map((c) => c.path));
    setOthers((found ?? []).filter((f) => !known.has(f.path)));
  };

  useEffect(() => {
    refresh();
    const off = listen<{ id: string; progress?: number; done?: boolean; path?: string; error?: string; cancelled?: boolean }>("stt-download", async (e) => {
      const { id, progress, done, path, error, cancelled } = e.payload;
      if (progress !== undefined) setCatalog((c) => c.map((m) => (m.id === id ? { ...m, progress } : m)));
      if (error && !cancelled) setErrors((x) => ({ ...x, [id]: error }));
      if (done || error) {
        await refresh();
        // First model downloaded while on Apple's: switch to it.
        const entry = (await sttCatalog().catch(() => [])).find((m) => m.id === id);
        if (done && path && entry && getSettings().stt.engine === "apple") use(entry.engine, path);
      }
    });
    return () => void off.then((f) => f());
  }, []);

  const use = async (engine: "whisper" | "parakeet" | "apple", modelPath = "") => {
    await updateSettings({ stt: { ...getSettings().stt, engine, modelPath: engine === "apple" ? getSettings().stt.modelPath : modelPath } });
    if (engine !== "apple") sttPreload({ engine, modelPath, prompt: "", language: "en" }).catch(() => {});
  };

  const download = async (id: string) => {
    setErrors((x) => ({ ...x, [id]: "" }));
    setCatalog((c) => c.map((m) => (m.id === id ? { ...m, progress: 0 } : m)));
    await sttDownload(id);
  };

  const remove = async (m: CatalogEntry) => {
    const ok = await ask(`Move ${m.name} (${gb(m.sizeBytes)}) to the Trash?`, { title: "Delete model", kind: "warning", okLabel: "Move to Trash" });
    if (!ok) return;
    if (stt.modelPath === m.path) await use("apple");
    await sttDeleteModel(m.id);
    refresh();
  };

  const browse = async (engine: "whisper" | "parakeet") => {
    const picked = await open(engine === "whisper" ? { directory: false, filters: [{ name: "Whisper ggml model", extensions: ["bin"] }] } : { directory: true });
    if (typeof picked === "string") await use(engine, picked);
  };

  const selected = (path: string | null) => stt.engine !== "apple" && !!path && stt.modelPath === path;

  return (
    <section>
      <h2>Transcription</h2>
      <p className="muted">
        Speech is transcribed on this Mac. Pick a model, or download one. Models Handy has already downloaded show up here and are used in
        place, with no second copy. While someone is talking you see Apple's live gray words; the model's text replaces them about a second
        after each phrase.
      </p>
      <div className="model-list">
        {catalog.map((m) => {
          const downloading = m.progress !== null && m.progress !== undefined && !m.path;
          return (
            <div key={m.id} className={`model ${selected(m.path) ? "on" : ""}`}>
              <label className="model-pick">
                <input type="radio" name="stt" disabled={!m.path} checked={selected(m.path)} onChange={() => m.path && use(m.engine, m.path)} />
                <span>
                  <span className="model-title">
                    <strong>{m.name}</strong> {m.recommended && <span className="pill ok">Recommended</span>}
                  </span>
                  <small className="muted">
                    {gb(m.sizeBytes)} · {m.description}
                  </small>
                  {m.path && <small className="muted">Installed{m.source === "Handy" ? " (from Handy)" : ""}</small>}
                  {errors[m.id] && <small className="bad">{errors[m.id]}</small>}
                </span>
              </label>
              <div className="model-actions">
                {downloading ? (
                  <>
                    <div className="progress">
                      <i style={{ width: `${Math.round((m.progress ?? 0) * 100)}%` }} />
                    </div>
                    <span className="small muted">{Math.round((m.progress ?? 0) * 100)}%</span>
                    <button className="btn small" onClick={() => sttCancelDownload(m.id)}>
                      Cancel
                    </button>
                  </>
                ) : m.path ? (
                  m.source === "Earshot" && (
                    <button className="link" onClick={() => remove(m)}>
                      Delete
                    </button>
                  )
                ) : (
                  <button className="btn small primary" onClick={() => download(m.id)}>
                    Download
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {others.map((m) => (
          <div key={m.path} className={`model ${selected(m.path) ? "on" : ""}`}>
            <label className="model-pick">
              <input type="radio" name="stt" checked={selected(m.path)} onChange={() => use(m.engine, m.path)} />
              <span>
                <strong>{m.name}</strong>
                <small className="muted">
                  {m.engine === "whisper" ? "Whisper" : "Parakeet"} · found in {m.source}
                </small>
              </span>
            </label>
          </div>
        ))}
        {stt.engine !== "apple" && ![...catalog.map((c) => c.path), ...others.map((o) => o.path)].includes(stt.modelPath) && (
          <div className="model on">
            <label className="model-pick">
              <input type="radio" name="stt" checked readOnly />
              <span>
                <strong>{stt.modelPath.split("/").pop()}</strong>
                <small className="muted">Custom file · {stt.modelPath}</small>
              </span>
            </label>
          </div>
        )}
        <div className={`model ${stt.engine === "apple" ? "on" : ""}`}>
          <label className="model-pick">
            <input type="radio" name="stt" checked={stt.engine === "apple"} onChange={() => use("apple")} />
            <span>
              <strong>Apple on-device</strong>
              <small className="muted">No download. Noticeably less accurate, especially on names and on speakerphones.</small>
            </span>
          </label>
        </div>
      </div>
      <div className="toolbar">
        <button className="btn small" onClick={() => browse("whisper")}>
          Use another Whisper .bin…
        </button>
        <button className="btn small" onClick={() => browse("parakeet")}>
          Use another Parakeet folder…
        </button>
      </div>
      <label className="field">
        <span>Vocabulary: names and terms to listen for (Whisper only)</span>
        <textarea
          rows={2}
          value={stt.vocabulary}
          placeholder="Claude, OpenRouter, Obsession, Hassan, PilotX"
          onChange={(e) => updateSettings({ stt: { ...stt, vocabulary: e.target.value } })}
        />
        <small>Topic names and recurring names from your topic notes are added automatically for each session.</small>
      </label>
    </section>
  );
}

function gb(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function RecordingsStorage() {
  const settings = useSettings();
  const [usage, setUsage] = useState<RecordingsUsage | null>(null);
  const refresh = () => recordingsUsage().then(setUsage).catch(() => setUsage(null));
  useEffect(() => {
    refresh();
  }, []);
  const deleteAll = async () => {
    const ok = await ask(`Permanently delete all call recordings (${gb(usage?.totalBytes ?? 0)})? Transcripts, notes and summaries are kept.`, {
      title: "Delete recordings",
      kind: "warning",
      okLabel: "Delete recordings",
    });
    if (!ok) return;
    await recordingsPurge(0);
    refresh();
  };
  return (
    <>
      <div className="field row">
        <span>Keep call audio</span>
        <select value={settings.keepAudioDays} onChange={(e) => updateSettings({ keepAudioDays: Number(e.target.value) })}>
          <option value={0}>Don't keep (delete when the session ends)</option>
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
          <option value={-1}>Forever</option>
        </select>
      </div>
      <div className="field row">
        <span>Recordings on this Mac</span>
        <code className="path">
          {usage ? `${gb(usage.totalBytes)} in ${usage.sessions.length} session${usage.sessions.length === 1 ? "" : "s"}` : "…"}
        </code>
        <button className="btn small" onClick={() => recordingsReveal()}>
          Show
        </button>
        <button className="btn small" disabled={!usage?.totalBytes} onClick={deleteAll}>
          Delete all
        </button>
      </div>
      <p className="muted small">
        Audio is AAC (about 20 MB per hour per side) and stays in this Mac's app data, not in the data folder, so it never syncs to iCloud. It's
        only needed to re-transcribe or replay a call; transcripts and notes don't depend on it.
      </p>
    </>
  );
}

function UseForAll({ providers, onApply }: { providers: ProviderConfig[]; onApply: (providerId: string, model: string) => void }) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [model, setModel] = useState("");
  const [done, setDone] = useState(false);
  return (
    <div className="role use-all">
      <div className="role-head">
        <strong>Use one model for everything</strong>
        <small className="muted">Sets all four jobs below at once. Leave the model blank for a CLI's default.</small>
      </div>
      <div className="role-inputs">
        <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input value={model} placeholder="model id, e.g. anthropic/claude-haiku-5.5 or sonnet" onChange={(e) => setModel(e.target.value)} />
        <button
          className="btn primary small"
          onClick={() => {
            onApply(providerId, model.trim());
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          }}
        >
          {done ? <IconCheck size={14} /> : "Apply to all"}
        </button>
      </div>
    </div>
  );
}

async function testProvider(provider: ProviderConfig, model: string): Promise<string> {
  try {
    const client = new ModelClient({ providers: [provider], roles: {} as never }, transport);
    const reply = await client.completeWith(provider, model, {
      system: "Reply with the single word: ready",
      messages: [{ role: "user", content: "Are you there?" }],
      maxTokens: 20,
      temperature: 0,
    });
    return `✓ ${(reply.ms / 1000).toFixed(1)}s — "${reply.text.trim().slice(0, 40)}"`;
  } catch (e) {
    return `✗ ${String(e).replace(/^Error: /, "").slice(0, 300)}`;
  }
}

function RoleRow(props: {
  role: Role;
  label: string;
  hint: string;
  providers: ProviderConfig[];
  providerId: string;
  model: string;
  onChange: (patch: Partial<{ providerId: string; model: string }>) => void;
}) {
  const [result, setResult] = useState("");
  const [model, setModel] = useState(props.model);
  useEffect(() => setModel(props.model), [props.model]);
  const provider = props.providers.find((p) => p.id === props.providerId);

  return (
    <div className="role">
      <div className="role-head">
        <strong>{props.label}</strong>
        <small className="muted">{props.hint}</small>
      </div>
      <div className="role-inputs">
        <select value={props.providerId} onChange={(e) => props.onChange({ providerId: e.target.value })}>
          {props.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          value={model}
          placeholder={provider?.kind === "cli" ? "blank = CLI default" : "model id"}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => model !== props.model && props.onChange({ model })}
        />
        <button
          className="btn small"
          disabled={!provider}
          onClick={async () => {
            setResult("testing…");
            setResult(await testProvider(provider!, model));
          }}
        >
          Test
        </button>
      </div>
      {result && <small className={result.startsWith("✓") ? "ok" : result.startsWith("✗") ? "bad" : "muted"}>{result}</small>}
    </div>
  );
}

function ProviderRow({ provider, onChange, onRemove }: { provider: ProviderConfig; onChange: (p: ProviderConfig) => void; onRemove?: () => void }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [name, setName] = useState(provider.name);
  const [command, setCommand] = useState(provider.command ?? "");
  const [args, setArgs] = useState((provider.args ?? []).join(" "));
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);
  const [testModel, setTestModel] = useState("");
  const [result, setResult] = useState("");
  const preset = Object.values(CLI_PRESETS).find((p) => p.command === provider.command?.split("/").pop());

  useEffect(() => {
    if (provider.secret) secretGet(provider.secret).then((v) => setHasKey(!!v)).catch(() => setHasKey(false));
  }, [provider.secret]);

  useEffect(() => {
    if (provider.kind === "cli" && provider.command) cliResolve(provider.command).then(setResolved);
  }, [provider.kind, provider.command]);

  const saveKey = async () => {
    if (!provider.secret) return;
    await secretSet(provider.secret, key.trim());
    setHasKey(!!key.trim());
    setKey("");
  };

  return (
    <div className="provider">
      <div className="provider-head">
        {onRemove ? (
          <input className="name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => onChange({ ...provider, name })} />
        ) : (
          <strong>{provider.name}</strong>
        )}
        <span className="tag">{provider.kind === "cli" ? "CLI" : provider.kind === "anthropic" ? "Anthropic" : "OpenAI-compatible"}</span>
        {provider.kind === "cli" && resolved !== undefined && (
          <span className={resolved ? "ok small" : "bad small"}>{resolved ? `found: ${resolved}` : "not found — set the full path"}</span>
        )}
        {provider.secret && hasKey !== null && <span className={hasKey ? "ok small" : "bad small"}>{hasKey ? "key saved" : "no key yet"}</span>}
        {onRemove && (
          <button className="link" onClick={onRemove}>
            remove
          </button>
        )}
      </div>

      {provider.kind === "cli" ? (
        <>
          <div className="provider-inputs">
            <input
              value={command}
              placeholder="command or full path, e.g. /Users/you/.local/bin/claude"
              onChange={(e) => setCommand(e.target.value)}
              onBlur={() => command !== provider.command && onChange({ ...provider, command: command.trim() })}
            />
          </div>
          <details className="advanced">
            <summary>Arguments</summary>
            <input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              onBlur={() => onChange({ ...provider, args: args.split(/\s+/).filter(Boolean) })}
            />
            <small className="muted">
              {"{model}"} is replaced by the model (dropped with its flag when blank). {"{prompt}"} is replaced by the prompt; without it the prompt
              goes to stdin.
            </small>
          </details>
          {preset && <small className="muted">{preset.note}</small>}
        </>
      ) : (
        <div className="provider-inputs">
          <input value={baseUrl} placeholder="Base URL" onChange={(e) => setBaseUrl(e.target.value)} onBlur={() => onChange({ ...provider, baseUrl })} />
          {provider.secret ? (
            <>
              <input
                type="password"
                value={key}
                placeholder={hasKey ? "•••••••• (replace key)" : "API key"}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveKey()}
              />
              <button className="btn small" disabled={!key.trim() && !hasKey} onClick={saveKey}>
                {key.trim() ? (
                  <>
                    <IconCheck size={14} /> Save key
                  </>
                ) : (
                  "Clear"
                )}
              </button>
            </>
          ) : (
            <small className="muted">No key needed for a local server.</small>
          )}
        </div>
      )}

      <div className="provider-inputs test-row">
        <input value={testModel} placeholder={provider.kind === "cli" ? "model to test (blank = default)" : "model to test, e.g. anthropic/claude-haiku-5.5"} onChange={(e) => setTestModel(e.target.value)} />
        <button
          className="btn small"
          onClick={async () => {
            setResult("testing…");
            setResult(await testProvider({ ...provider, command: command.trim() || provider.command }, testModel.trim()));
          }}
        >
          Test
        </button>
      </div>
      {result && <small className={result.startsWith("✓") ? "ok" : result.startsWith("✗") ? "bad" : "muted"}>{result}</small>}
    </div>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" />
      <span>
        {label}
        {hint && <small className="muted">{hint}</small>}
      </span>
    </label>
  );
}

function NumberRow({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="field row">
      <span>{label}</span>
      <input type="number" value={value} step={step} min={0} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
