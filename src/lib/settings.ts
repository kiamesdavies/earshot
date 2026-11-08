import { useEffect, useState } from "react";
import { DEFAULT_COPILOT_CONFIG, type CopilotConfig } from "../core/copilot";
import type { ConnectorDef } from "../core/connectors";
import { DEFAULT_MODEL_SETTINGS, type ModelSettings } from "../core/providers";
import { resetDataRootCache, setAutoPrompt, settingsLoad, settingsSave, sttCatalog } from "./backend";

export interface Settings {
  userName: string;
  locale: string;
  captureSystem: boolean;
  echoCancellation: boolean;
  autoPrompt: boolean;
  autoSummarize: boolean;
  consentAcknowledged: boolean;
  dataRoot: string;
  models: ModelSettings;
  copilot: CopilotConfig;
  /** Speech-to-text: a local Whisper/Parakeet model (e.g. Handy's), or Apple's on-device model. */
  stt: { engine: "whisper" | "parakeet" | "apple"; modelPath: string; vocabulary: string };
  /** Days to keep call audio (transcripts and notes are always kept). 0 = delete when the session ends, -1 = forever. */
  keepAudioDays: number;
  /** Stop a session automatically so a forgotten one can't record for days. */
  autoStop: { afterCallEndMin: number; idleMin: number; maxHours: number };
  /** Pop the floating nudge window out when you switch away from Earshot during a call. */
  autoPopOut: boolean;
  /** MCP servers added by the user (built-in connectors live in core/connectors.ts). */
  customConnectors?: ConnectorDef[];
}

export const DEFAULT_SETTINGS: Settings = {
  userName: "",
  locale: navigator.language || "en-US",
  captureSystem: true,
  echoCancellation: true,
  autoPrompt: true,
  autoSummarize: true,
  consentAcknowledged: false,
  dataRoot: "",
  models: DEFAULT_MODEL_SETTINGS,
  copilot: DEFAULT_COPILOT_CONFIG,
  stt: { engine: "apple", modelPath: "", vocabulary: "" },
  keepAudioDays: 14,
  autoStop: { afterCallEndMin: 2, idleMin: 15, maxHours: 4 },
  autoPopOut: true,
};

let current: Settings = DEFAULT_SETTINGS;
const listeners = new Set<(s: Settings) => void>();

export async function loadSettings(): Promise<Settings> {
  const saved = (await settingsLoad()) as Partial<Settings>;
  const models = saved.models ?? DEFAULT_MODEL_SETTINGS;
  // Keep presets added in newer versions without clobbering the user's edits.
  const known = new Set(models.providers.map((p) => p.id));
  // Older versions stored CLI providers without a command/args template.
  const upgraded = models.providers.map((p) => {
    const preset = DEFAULT_MODEL_SETTINGS.providers.find((d) => d.id === p.id);
    return p.kind === "cli" && !p.command && preset ? { ...p, command: preset.command, args: preset.args } : p;
  });
  current = {
    ...DEFAULT_SETTINGS,
    ...saved,
    models: { ...models, providers: [...upgraded, ...DEFAULT_MODEL_SETTINGS.providers.filter((p) => !known.has(p.id))] },
    copilot: { ...DEFAULT_COPILOT_CONFIG, ...saved.copilot },
    stt: { ...DEFAULT_SETTINGS.stt, ...saved.stt },
    autoStop: { ...DEFAULT_SETTINGS.autoStop, ...saved.autoStop },
  };
  // First run: use the best local model already on disk (Handy's), else Apple's.
  if (!saved.stt) {
    const installed = ((await sttCatalog().catch(() => null)) ?? []).filter((m) => m.path);
    const pick = installed.find((m) => m.recommended) ?? installed.find((m) => m.engine === "whisper") ?? installed[0];
    if (pick?.path) {
      current.stt = { ...current.stt, engine: pick.engine, modelPath: pick.path };
      await settingsSave(current);
    }
  }
  listeners.forEach((l) => l(current));
  return current;
}

export function getSettings(): Settings {
  return current;
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  current = { ...current, ...patch };
  listeners.forEach((l) => l(current));
  await settingsSave(current);
  if ("dataRoot" in patch) resetDataRootCache();
  if ("autoPrompt" in patch) await setAutoPrompt(current.autoPrompt);
}

export function useSettings(): Settings {
  const [value, setValue] = useState(current);
  useEffect(() => {
    listeners.add(setValue);
    return () => void listeners.delete(setValue);
  }, []);
  return value;
}
