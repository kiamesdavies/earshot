import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { lazy, Suspense, useEffect, useState } from "react";
import { IconMic, IconSessions, IconSettings, IconStop, IconTopics } from "./components/icons";
import { SessionsView } from "./components/Sessions";
const SettingsView = lazy(() => import("./components/Settings").then((m) => ({ default: m.SettingsView })));
import { StartDialog } from "./components/StartDialog";
const TopicsView = lazy(() => import("./components/Topics").then((m) => ({ default: m.TopicsView })));
import { recordingsPurge, sttPreload } from "./lib/backend";
import { noteCallEnded, noteCallStarted, stopSession, sttConfig, useLiveSelector } from "./lib/live";
import { installMiniBridge } from "./lib/mini";
import { getSettings, loadSettings, updateSettings, useSettings } from "./lib/settings";
import "./styles.css";

type View = "sessions" | "topics" | "settings";

export default function App() {
  const settings = useSettings();
  const live = { phase: useLiveSelector((s) => s.phase) };
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>("sessions");
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState<{ app?: string } | null>(null);
  const [callEnded, setCallEnded] = useState(false);

  useEffect(() => {
    loadSettings().then((s) => {
      setLoaded(true);
      // Heavy background work waits until the window has painted and settled:
      // loading the speech model reads ~550 MB and competes with first clicks.
      window.setTimeout(() => {
        if (s.stt.engine !== "apple") sttPreload(sttConfig([], [])).catch(() => {});
        // Retention: drop call audio older than the setting (text is never touched).
        if (s.keepAudioDays > 0) recordingsPurge(s.keepAudioDays).catch(() => {});
      }, 4000);
    });
    const offPrompt = listen<{ action: string; app: string }>("prompt-action", async (e) => {
      if (e.payload.action !== "start") return;
      const win = getCurrentWindow();
      await win.unminimize();
      await win.show();
      await win.setFocus();
      setView("sessions");
      setStarting({ app: e.payload.app });
    });
    const offEnded = listen("call-ended", () => {
      setCallEnded(true);
      noteCallEnded();
    });
    const offDetected = listen("call-detected", () => noteCallStarted());
    const uninstallMini = installMiniBridge(() => getSettings().autoPopOut);
    return () => {
      offPrompt.then((f) => f());
      offEnded.then((f) => f());
      offDetected.then((f) => f());
      uninstallMini();
    };
  }, []);

  useEffect(() => {
    if (live.phase !== "live") setCallEnded(false);
  }, [live.phase]);

  const isRecording = live.phase === "live" || live.phase === "starting";

  return (
    <div className="app">
      <nav className="rail" data-tauri-drag-region>
        <div className="logo" data-tauri-drag-region>
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden>
            <path d="M11 22c0-3 1.5-4 3-5.5S17 13 17 10.5a5.5 5.5 0 0 0-11 0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            <path d="M11 22a3 3 0 0 0 6 0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            <path d="M21 9a8 8 0 0 1 0 12M24.5 6a12.5 12.5 0 0 1 0 18" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </div>
        <RailButton icon={<IconSessions />} label="Sessions" on={view === "sessions"} onClick={() => setView("sessions")} />
        <RailButton icon={<IconTopics />} label="Topics" on={view === "topics"} onClick={() => setView("topics")} />
        <RailButton icon={<IconSettings />} label="Settings" on={view === "settings"} onClick={() => setView("settings")} />
        <div className="spacer" />
        {isRecording ? (
          <button className="start-btn recording" onClick={() => stopSession()}>
            <IconStop size={18} />
            <span>Stop</span>
          </button>
        ) : (
          <button
            className="start-btn"
            disabled={live.phase === "stopping" || live.phase === "summarizing"}
            onClick={() => {
              setView("sessions");
              setStarting({});
            }}
          >
            <IconMic size={18} />
            <span>Start Session</span>
          </button>
        )}
      </nav>

      <main className="main">
        {callEnded && isRecording && (
          <div className="toast">
            The call seems to have ended.
            <button className="btn small primary" onClick={() => stopSession()}>
              Stop & write notes
            </button>
            <button className="btn small ghost" onClick={() => setCallEnded(false)}>
              Keep listening
            </button>
          </div>
        )}
        {view === "sessions" && <SessionsView selected={selected} onSelect={setSelected} />}
        <Suspense fallback={<div className="placeholder">Loading…</div>}>
          {loaded && view === "topics" && <TopicsView />}
          {loaded && view === "settings" && <SettingsView />}
        </Suspense>
      </main>

      {starting && (
        <StartDialog
          app={starting.app}
          onClose={() => setStarting(null)}
          onOpenSettings={() => {
            setStarting(null);
            setView("settings");
          }}
        />
      )}

      {loaded && !settings.consentAcknowledged && (
        <div className="modal-backdrop">
          <div className="modal">
            <header>
              <h2>Before your first call</h2>
            </header>
            <p>
              Earshot records your microphone and your Mac's audio and transcribes them on this Mac. Transcript excerpts and your topic notes are
              sent to the model provider you choose in Settings (or stay local with Ollama / LM Studio).
            </p>
            <p>
              Recording laws differ by place: some require <strong>everyone on the call</strong> to agree to being recorded. Tell the people you're
              talking to, and get their OK where it's required.
            </p>
            <footer>
              <button className="btn primary" onClick={() => updateSettings({ consentAcknowledged: true })}>
                I understand
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function RailButton({ icon, label, on, onClick }: { icon: React.ReactNode; label: string; on: boolean; onClick: () => void }) {
  return (
    <button className={`rail-btn ${on ? "on" : ""}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
