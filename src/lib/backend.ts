// Typed wrappers over the Tauri commands in src-tauri/src.

import { invoke } from "@tauri-apps/api/core";
import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import type { Workspace } from "../core/agent";
import type { Transport } from "../core/providers";

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  modified: number;
  size: number;
}

export const fsRead = (path: string) => invoke<string>("fs_read", { path });
export const fsExists = (path: string) => invoke<boolean>("fs_exists", { path });
export const fsWrite = (path: string, content: string) => invoke<void>("fs_write", { path, content });
export const fsAppend = (path: string, content: string) => invoke<void>("fs_append", { path, content });
export const fsMkdir = (path: string) => invoke<void>("fs_mkdir", { path });
export const fsList = (path: string, recursive = false) => invoke<Entry[]>("fs_list", { path, recursive });
export const fsTrash = (path: string) => invoke<void>("fs_trash", { path });
export const importFiles = (sources: string[], dest: string) => invoke<string[]>("import_files", { sources, dest });
export const reveal = (path: string) => invoke<void>("reveal", { path });
let rootCache: Promise<string> | null = null;
/** The data folder rarely changes; cache it (reset when Settings changes it). */
export const dataRoot = () => (rootCache ??= invoke<string>("data_root"));
export const resetDataRootCache = () => void (rootCache = null);

// Batched reads: one IPC round trip per screen instead of one per file.
export const sessionsDirs = () => invoke<{ dir: string; offlineFiles: number }[]>("sessions_dirs");
export const sessionMeta = (dir: string) => invoke<unknown>("session_meta", { dir });
export const sessionsList = () => invoke<{ dir: string; meta: unknown }[]>("sessions_list");
export const sessionLoad = (dir: string) =>
  invoke<{ meta: unknown; suggestions: unknown[]; moments: unknown[]; chat: unknown[]; notes: string; myNotes: string; segmentCount: number }>("session_load", { dir });
export const sessionTranscript = (dir: string) => invoke<unknown[]>("session_transcript", { dir });
export interface TopicFile {
  path: string;
  name: string;
  modified: number;
  isSession: boolean;
  content: string | null;
}
export const topicsList = (slugs?: string[], withContent = false) =>
  invoke<{ slug: string; files: TopicFile[] }[]>("topics_list", { slugs: slugs ?? null, withContent });

export const settingsLoad = () => invoke<Record<string, unknown>>("settings_load");
export const settingsSave = (settings: unknown) => invoke<void>("settings_save", { settings });

export const secretGet = (name: string) => invoke<string | null>("secret_get", { name });
export const secretSet = (name: string, value: string) => invoke<void>("secret_set", { name, value });
export const secretsPresent = (names: string[]) => invoke<boolean[]>("secrets_present", { names });

export const cliResolve = (command: string) => invoke<string | null>("cli_resolve", { command });

export interface PermissionReport {
  microphone: "granted" | "denied" | "not_determined" | "unknown";
  systemAudio: "granted" | "denied" | "not_determined" | "unknown";
}
export const permissions = (request = false) => invoke<PermissionReport>("permissions", { request });
export const openPrivacySettings = (pane: "microphone" | "audio") => invoke<void>("open_privacy_settings", { pane });
export const audioSelftest = (locale: string, system: boolean, aec: boolean, seconds: number, stt: SttConfig) =>
  invoke<Record<string, unknown>[]>("audio_selftest", { locale, system, aec, seconds, stt });

export interface SttConfig {
  engine: "whisper" | "parakeet" | "apple";
  modelPath: string;
  prompt: string;
  language: string;
}
export interface FoundModel {
  engine: "whisper" | "parakeet";
  name: string;
  path: string;
  source: string;
}
export interface CatalogEntry {
  id: string;
  engine: "whisper" | "parakeet";
  name: string;
  description: string;
  sizeBytes: number;
  recommended: boolean;
  path: string | null;
  source: "Earshot" | "Handy" | null;
  progress: number | null;
}
export const sttCatalog = () => invoke<CatalogEntry[]>("stt_catalog");
export const sttDownload = (id: string) => invoke<void>("stt_download", { id });
export const sttCancelDownload = (id: string) => invoke<void>("stt_cancel_download", { id });
export const sttDeleteModel = (id: string) => invoke<void>("stt_delete_model", { id });
export const sttFindModels = () => invoke<FoundModel[]>("stt_find_models");
export const sttPreload = (config: SttConfig) => invoke<void>("stt_preload", { config });
export const sttTestFile = (config: SttConfig, path: string) => invoke<string>("stt_test_file", { config, path });

export const setAutoPrompt = (enabled: boolean) => invoke<void>("set_auto_prompt", { enabled });
export const captureStart = (dir: string, locale: string, system: boolean, aec: boolean, stt: SttConfig) =>
  invoke<void>("capture_start", { dir, locale, system, aec, stt });
export const captureStop = () => invoke<void>("capture_stop");

export interface RecordingsUsage {
  totalBytes: number;
  sessions: { id: string; bytes: number }[];
  path: string;
}
export const recordingsUsage = () => invoke<RecordingsUsage>("recordings_usage");
export const recordingsPurge = (days: number, keep?: string) => invoke<number>("recordings_purge", { days, keep });
export const recordingDelete = (id: string) => invoke<void>("recording_delete", { id });
export const recordingsReveal = () => invoke<void>("recordings_reveal");

export const openLogs = () => invoke<void>("open_logs");
/** Errors and events (never call content) into the unified log + ~/Library/Logs/Earshot. */
export const logEvent = (level: "info" | "warn" | "error", category: string, message: string) =>
  invoke<void>("log_event", { level, category, message: message.slice(0, 2000) }).catch(() => {});

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsRead(path)) as T;
  } catch {
    return fallback;
  }
}

export const transport: Transport = {
  // The HTTP plugin sends requests from Rust, so provider APIs don't need CORS.
  fetch: ((...args: Parameters<typeof fetch>) =>
    ((window as unknown as { __EARSHOT_FETCH__?: typeof fetch }).__EARSHOT_FETCH__ ?? (httpFetch as unknown as typeof fetch))(...args)) as typeof fetch,
  runCli: (command: string, args: string[], stdin: string) => invoke<string>("run_cli", { command, args, stdin }),
  getSecret: secretGet,
};

/** Files the chat agent can read and write (paths relative to the data folder). */
export const workspace: Workspace = {
  read: fsRead,
  write: fsWrite,
  append: fsAppend,
  exists: fsExists,
  mkdir: fsMkdir,
  list: (path, recursive) => fsList(path, recursive),
};
