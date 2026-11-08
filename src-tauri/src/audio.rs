//! Owns the Swift sidecar (`earshot-audio`): a long-lived `watch` process for
//! call detection and one `capture` process per session. Sidecar stdout is JSON
//! lines; each is forwarded to the UI as an `audio` event.

use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::logging;
use crate::storage::Storage;
use crate::stt::{self, Chunk, Job, SttConfig};

#[derive(Default)]
pub struct Audio {
    capture: Mutex<Option<CaptureHandle>>,
    mic_users: Mutex<BTreeSet<String>>,
    pub auto_prompt: Mutex<bool>,
}

struct CaptureHandle {
    pid: u32,
    stdin: Option<ChildStdin>,
}

fn sidecar_path() -> PathBuf {
    // Bundled: Tauri puts externalBin next to the main executable.
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)) {
        let bundled = dir.join("earshot-audio");
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../audio/.build/release/earshot-audio"))
}

fn friendly_name(bundle_id: &str) -> String {
    const KNOWN: &[(&str, &str)] = &[
        ("us.zoom", "Zoom"),
        ("com.microsoft.teams", "Microsoft Teams"),
        ("com.apple.FaceTime", "FaceTime"),
        ("com.tinyspeck.slackmacgap", "Slack"),
        ("net.whatsapp", "WhatsApp"),
        ("com.hnc.Discord", "Discord"),
        ("com.google.Chrome", "Google Chrome"),
        ("company.thebrowser", "Arc"),
        ("com.apple.Safari", "Safari"),
        ("com.apple.WebKit", "Safari"),
        ("org.mozilla.firefox", "Firefox"),
        ("com.brave.Browser", "Brave"),
        ("com.microsoft.edgemac", "Edge"),
        ("com.cisco.webexmeetings", "Webex"),
        ("com.apple.mobilephone", "Phone"),
    ];
    KNOWN
        .iter()
        .find(|(prefix, _)| bundle_id.starts_with(prefix))
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| if bundle_id.is_empty() { "An app".into() } else { bundle_id.to_string() })
}

/// Long-lived call detector; restarts the sidecar if it dies.
pub fn start_watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        let child = Command::new(sidecar_path())
            .args(["watch", "--interval", "1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        match child {
            Ok(mut child) => {
                let reader = BufReader::new(child.stdout.take().unwrap());
                for line in reader.lines().map_while(Result::ok) {
                    if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                        if msg["type"] == "mic_users" {
                            on_mic_users(&app, &msg["apps"]);
                        }
                    }
                }
                let _ = child.wait();
            }
            Err(e) => logging::error("watch", &format!("earshot-audio watch failed to start ({}): {e}", sidecar_path().display())),
        }
        std::thread::sleep(Duration::from_secs(5));
    });
}

fn on_mic_users(app: &AppHandle, apps: &Value) {
    let audio = app.state::<Audio>();
    let capture_pid = audio.capture.lock().unwrap().as_ref().map(|c| c.pid);
    let own_id = &app.config().identifier;
    let current: BTreeSet<String> = apps
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["pid"].as_u64().map(|p| p as u32) != capture_pid)
        .filter_map(|a| a["bundleId"].as_str().map(String::from))
        .filter(|id| !id.starts_with(own_id.as_str()))
        .collect();
    let previous = std::mem::replace(&mut *audio.mic_users.lock().unwrap(), current.clone());
    let started: Vec<&String> = current.difference(&previous).collect();

    if let Some(bundle_id) = started.first() {
        let name = friendly_name(bundle_id);
        logging::info("watch", &format!("call detected: {bundle_id} ({name}); mic users now {current:?}"));
        let _ = app.emit("call-detected", json!({ "bundleId": bundle_id, "app": name }));
        if capture_pid.is_none() && *audio.auto_prompt.lock().unwrap() {
            show_prompt(app, &name);
        }
    } else if current.is_empty() && !previous.is_empty() {
        let _ = app.emit("call-ended", json!({}));
        if let Some(prompt) = app.get_webview_window("prompt") {
            let _ = prompt.close();
        }
    }
}

/// Small always-on-top card, top-right, like Granola's "meeting detected".
fn show_prompt(app: &AppHandle, app_name: &str) {
    if let Some(existing) = app.get_webview_window("prompt") {
        let _ = existing.emit("prompt-app", app_name);
        let _ = existing.show();
        return;
    }
    let encoded: String = app_name
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    let (x, y) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let size = m.size().to_logical::<f64>(m.scale_factor());
            (size.width - 376.0, 44.0)
        })
        .unwrap_or((900.0, 44.0));
    let _ = WebviewWindowBuilder::new(app, "prompt", WebviewUrl::App(format!("index.html#prompt?app={encoded}").into()))
        .title("Earshot")
        .inner_size(360.0, 104.0)
        .position(x, y)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible_on_all_workspaces(true)
        .build();
}

#[tauri::command]
pub fn set_auto_prompt(audio: State<Audio>, enabled: bool) {
    *audio.auto_prompt.lock().unwrap() = enabled;
}

#[tauri::command]
pub fn capture_start(
    app: AppHandle,
    audio: State<Audio>,
    storage: State<Storage>,
    dir: String,
    locale: String,
    system: bool,
    aec: bool,
    stt: SttConfig,
) -> Result<(), String> {
    let mut slot = audio.capture.lock().unwrap();
    if slot.is_some() {
        return Err("A session is already recording".into());
    }
    let _ = storage.resolve(&dir)?;
    // Audio stays on this Mac (the data folder may be in iCloud Drive): only
    // text goes to the session folder; recordings go to app data.
    let session_id = std::path::Path::new(&dir).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let full_dir = crate::recordings::dir(&app).join(&session_id);
    let mut args = vec![
        "capture".to_string(),
        "--dir".into(),
        full_dir.to_string_lossy().into_owned(),
        "--locale".into(),
        locale,
    ];
    if !system {
        args.push("--no-system".into());
    }
    if !aec {
        args.push("--no-aec".into());
    }
    let local_stt = stt.engine != "apple";
    if local_stt {
        args.push("--chunks".into());
        let app_stt = app.clone();
        stt::submit(Job::Configure(stt), move |msg| {
            let _ = app_stt.emit("audio", msg);
        });
    }
    let mut child: Child = Command::new(sidecar_path())
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start audio capture: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    *slot = Some(CaptureHandle { pid: child.id(), stdin: child.stdin.take() });
    drop(slot);

    logging::info("capture", &format!("start {} {:?}", sidecar_path().display(), args));
    let app_err = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            logging::info("audio", &line);
            let _ = app_err.emit("audio", json!({ "type": "log", "message": line }));
        }
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            log_message("capture", &msg);
            if local_stt && msg["type"] == "chunk" {
                let chunk = Chunk {
                    id: msg["id"].as_str().unwrap_or_default().to_string(),
                    speaker: msg["speaker"].as_str().unwrap_or("me").to_string(),
                    start: msg["start"].as_f64().unwrap_or(0.0),
                    end: msg["end"].as_f64().unwrap_or(0.0),
                    path: PathBuf::from(msg["path"].as_str().unwrap_or_default()),
                };
                let app_stt = app.clone();
                stt::submit(Job::Transcribe(chunk), move |out| {
                    let _ = app_stt.emit("audio", out);
                });
                continue;
            }
            // Hold "stopped" until queued utterances are transcribed, so the
            // last words make it into the transcript before notes are written.
            if local_stt && msg["type"] == "stopped" {
                let app_done = app.clone();
                stt::submit(Job::Flush, move |_| {
                    let _ = app_done.emit("audio", json!({ "type": "stopped" }));
                });
                continue;
            }
            let _ = app.emit("audio", msg);
        }
        let code = child.wait().ok().and_then(|s| s.code());
        logging::info("capture", &format!("sidecar exited with {code:?}"));
        app.state::<Audio>().capture.lock().unwrap().take();
        let _ = app.emit("audio", json!({ "type": "exited", "code": code }));
    });
    Ok(())
}

/// Asks the sidecar to finalize (it flushes transcripts and closes the WAVs),
/// and kills it if it hasn't exited within 20s.
#[tauri::command]
pub fn capture_stop(audio: State<Audio>) -> Result<(), String> {
    let mut slot = audio.capture.lock().unwrap();
    let Some(handle) = slot.as_mut() else { return Ok(()) };
    if let Some(mut stdin) = handle.stdin.take() {
        let _ = stdin.write_all(b"stop\n");
    }
    let pid = handle.pid;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        let _ = Command::new("kill").arg(pid.to_string()).status();
    });
    Ok(())
}

#[tauri::command]
pub async fn transcribe_files(me: Option<String>, them: Option<String>, locale: String) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec!["transcribe".to_string(), "--locale".into(), locale];
        if let Some(me) = me {
            args.extend(["--me".into(), me]);
        }
        if let Some(them) = them {
            args.extend(["--them".into(), them]);
        }
        let out = Command::new(sidecar_path()).args(&args).output().map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sidecar messages worth keeping in the logs. Never the words themselves.
pub fn log_message(category: &str, msg: &Value) {
    match msg["type"].as_str().unwrap_or_default() {
        "level" | "preview" => {}
        "segment" => {
            if msg["final"] == true {
                logging::info(category, &format!("segment {} {} {:.1}-{:.1}s chars={} engine={} sttMs={}", msg["id"], msg["speaker"], msg["start"].as_f64().unwrap_or(0.0), msg["end"].as_f64().unwrap_or(0.0), msg["text"].as_str().map(str::len).unwrap_or(0), msg["engine"], msg["sttMs"]));
            }
        }
        "error" => logging::error(category, &msg.to_string()),
        _ => logging::info(category, &msg.to_string()),
    }
}

/// Microphone + system-audio permission state, optionally asking for both.
/// The request runs in the sidecar so the prompts are attributed to Earshot.
#[tauri::command]
pub async fn permissions(request: bool) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec!["permissions"];
        if request {
            args.push("--request");
        }
        let out = Command::new(sidecar_path()).args(&args).output().map_err(|e| e.to_string())?;
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .find(|v| v["type"] == "permissions")
            .ok_or_else(|| "no permission report from audio helper".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn open_privacy_settings(pane: String) -> Result<(), String> {
    let anchor = match pane.as_str() {
        "microphone" => "Privacy_Microphone",
        _ => "Privacy_AudioCapture",
    };
    Command::new("open")
        .arg(format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Records a few seconds into a temp folder and returns every sidecar message,
/// so Settings can show levels, transcript and errors without starting a session.
#[tauri::command]
pub async fn audio_selftest(locale: String, system: bool, aec: bool, seconds: u64, stt: SttConfig) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || run_selftest(locale, system, aec, seconds, stt))
        .await
        .map_err(|e| e.to_string())?
}

/// Records a few seconds and returns every sidecar message (also logged).
pub fn run_selftest(locale: String, system: bool, aec: bool, seconds: u64, stt: SttConfig) -> Result<Vec<Value>, String> {
    logging::info("selftest", &format!("start system={system} aec={aec} seconds={seconds} engine={}", stt.engine));
    {
        let dir = std::env::temp_dir().join(format!("earshot-selftest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut args = vec!["capture".to_string(), "--dir".into(), dir.to_string_lossy().into_owned(), "--locale".into(), locale];
        if !system {
            args.push("--no-system".into());
        }
        if !aec {
            args.push("--no-aec".into());
        }
        if stt.engine != "apple" {
            args.push("--chunks".into());
        }
        let mut child = Command::new(sidecar_path())
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut stdin = child.stdin.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                logging::info("selftest", &line);
            }
        });
        let stdout = child.stdout.take().unwrap();
        // Count the recording time from "capturing", not from launch: model
        // assets and permission prompts can take several seconds.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut out = Vec::new();
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if v["type"] == "status" && v["message"] == "capturing" || v["type"] == "error" && v["fatal"] == true {
                        let _ = ready_tx.send(());
                    }
                    out.push(v);
                }
            }
            out
        });
        let _ = ready_rx.recv_timeout(Duration::from_secs(30));
        std::thread::sleep(Duration::from_secs(seconds.clamp(2, 30)));
        let _ = stdin.write_all(b"stop\n");
        drop(stdin);
        let pid = child.id();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(15));
            let _ = Command::new("kill").arg(pid.to_string()).status();
        });
        let _ = child.wait();
        let mut messages = reader.join().map_err(|_| "self-test reader panicked".to_string())?;
        if stt.engine != "apple" {
            let chunks: Vec<Value> = messages.iter().filter(|m| m["type"] == "chunk").cloned().collect();
            for c in chunks {
                let path = PathBuf::from(c["path"].as_str().unwrap_or_default());
                match stt::transcribe_file(&stt, &path) {
                    Ok(text) if !text.is_empty() => messages.push(json!({ "type": "segment", "final": true, "speaker": c["speaker"], "text": text })),
                    Ok(_) => {}
                    Err(e) => messages.push(json!({ "type": "error", "message": e })),
                }
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        for m in &messages {
            log_message("selftest", m);
        }
        let peak = |key: &str| messages.iter().filter(|m| m["type"] == "level").filter_map(|m| m[key].as_f64()).fold(0.0, f64::max);
        logging::info("selftest", &format!("done: me peak={:.4} them peak={:.4} finals={}", peak("me"), peak("them"), messages.iter().filter(|m| m["type"] == "segment" && m["final"] == true).count()));
        Ok(messages)
    }
}

/// Compact always-on-top window with one nudge at a time (like Teams' mini
/// meeting view). It doesn't take focus, so it never interrupts typing.
#[tauri::command]
pub fn mini_open(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("mini") {
        let _ = win.show();
        return Ok(());
    }
    let (x, y) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let size = m.size().to_logical::<f64>(m.scale_factor());
            (size.width - 460.0, size.height - 300.0)
        })
        .unwrap_or((900.0, 600.0));
    WebviewWindowBuilder::new(&app, "mini", WebviewUrl::App("index.html#mini".into()))
        .title("Earshot nudges")
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .inner_size(420.0, 210.0)
        .min_inner_size(300.0, 100.0)
        .position(x, y)
        .resizable(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(|e| e.to_string())?;
    logging::info("mini", "opened");
    Ok(())
}

#[tauri::command]
pub fn mini_close(app: AppHandle) {
    if let Some(win) = app.get_webview_window("mini") {
        let _ = win.close();
        logging::info("mini", "closed");
    }
}
