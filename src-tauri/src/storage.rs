//! Plain files on disk are the source of truth: topics are folders of markdown,
//! sessions are folders with transcript.jsonl, notes.md and the two WAVs.
//! Every path from the UI is relative to the data root and may not escape it.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct Storage {
    pub root: Mutex<PathBuf>,
}

impl Storage {
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, String> {
        let rel_path = Path::new(rel);
        if rel_path.is_absolute() || rel_path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(format!("path escapes data folder: {rel}"));
        }
        Ok(self.root.lock().unwrap().join(rel_path))
    }
}

pub fn default_root(app: &AppHandle) -> PathBuf {
    app.path()
        .document_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("Earshot")
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn load_settings_value(app: &AppHandle) -> Value {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Object(Default::default()))
}

/// Runs disk work off the main thread. Tauri runs plain (sync) commands on the
/// main thread, which serialized every read and froze the UI while it waited.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn settings_load(app: AppHandle) -> Result<Value, String> {
    blocking(move || Ok(load_settings_value(&app))).await
}

#[tauri::command]
pub async fn settings_save(app: AppHandle, storage: State<'_, Storage>, settings: Value) -> Result<(), String> {
    if let Some(root) = settings.get("dataRoot").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        *storage.root.lock().unwrap() = PathBuf::from(root);
    }
    blocking(move || {
        let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        fs::write(settings_path(&app)?, text).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub fn data_root(storage: State<Storage>) -> String {
    storage.root.lock().unwrap().to_string_lossy().into_owned()
}

#[tauri::command]
pub async fn fs_read(storage: State<'_, Storage>, path: String) -> Result<String, String> {
    let full = storage.resolve(&path)?;
    blocking(move || fs::read_to_string(full).map_err(|e| format!("{path}: {e}"))).await
}

#[tauri::command]
pub async fn fs_exists(storage: State<'_, Storage>, path: String) -> Result<bool, String> {
    let full = storage.resolve(&path)?;
    blocking(move || Ok(full.exists())).await
}

#[tauri::command]
pub async fn fs_write(storage: State<'_, Storage>, path: String, content: String) -> Result<(), String> {
    let full = storage.resolve(&path)?;
    blocking(move || {
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(full, content).map_err(|e| format!("{path}: {e}"))
    })
    .await
}

#[tauri::command]
pub async fn fs_append(storage: State<'_, Storage>, path: String, content: String) -> Result<(), String> {
    use std::io::Write;
    let full = storage.resolve(&path)?;
    blocking(move || {
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = fs::OpenOptions::new().create(true).append(true).open(full).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes()).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn fs_mkdir(storage: State<'_, Storage>, path: String) -> Result<(), String> {
    let full = storage.resolve(&path)?;
    blocking(move || fs::create_dir_all(full).map_err(|e| e.to_string())).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    modified: u64,
    size: u64,
}

/// Lists a folder; `recursive` walks subfolders (topics have a sessions/ subfolder).
#[tauri::command]
pub async fn fs_list(storage: State<'_, Storage>, path: String, recursive: Option<bool>) -> Result<Vec<Entry>, String> {
    let base = storage.resolve(&path)?;
    blocking(move || {
        let mut out = Vec::new();
        if base.exists() {
            walk(&base, &path, recursive.unwrap_or(false), &mut out)?;
        }
        Ok(out)
    })
    .await
}

fn walk(dir: &Path, rel: &str, recursive: bool, out: &mut Vec<Entry>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(Entry { name, path: child_rel.clone(), is_dir: meta.is_dir(), modified, size: meta.len() });
        if recursive && meta.is_dir() {
            walk(&entry.path(), &child_rel, true, out)?;
        }
    }
    Ok(())
}

// ---- batched reads: one round trip instead of one per file ----

fn read_opt(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    read_opt(path)
        .map(|text| text.lines().filter(|l| !l.trim().is_empty()).filter_map(|l| serde_json::from_str(l).ok()).collect())
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListItem {
    dir: String,
    meta: Value,
}

/// True when iCloud ("Optimize Mac Storage") has evicted the file: reading it waits for a download.
fn is_dataless(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        const SF_DATALESS: u32 = 0x4000_0000;
        fs::symlink_metadata(path).map(|m| m.st_flags() & SF_DATALESS != 0).unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        false
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDir {
    dir: String,
    /// Files in the folder that iCloud has evicted (each read downloads it first).
    offline_files: usize,
}

/// Session folders, newest first, without reading any file: instant even when iCloud has evicted them.
/// The UI then loads each session's session.json on its own (session_meta), in parallel.
#[tauri::command]
pub async fn sessions_dirs(storage: State<'_, Storage>) -> Result<Vec<SessionDir>, String> {
    let root = storage.resolve("sessions")?;
    let started = std::time::Instant::now();
    let result = blocking(move || {
        let mut out: Vec<SessionDir> = fs::read_dir(&root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_dir() && !e.file_name().to_string_lossy().starts_with('.'))
            .map(|e| {
                let offline_files = fs::read_dir(e.path()).into_iter().flatten().flatten().filter(|f| is_dataless(&f.path())).count();
                SessionDir { dir: format!("sessions/{}", e.file_name().to_string_lossy()), offline_files }
            })
            .collect();
        out.sort_by(|a, b| b.dir.cmp(&a.dir));
        Ok(out)
    })
    .await;
    crate::logging::info("perf", &format!("sessions_dirs: {:?} in {} ms", result.as_ref().map(|v| v.len()), started.elapsed().as_millis()));
    result
}

/// One session's session.json.
#[tauri::command]
pub async fn session_meta(storage: State<'_, Storage>, dir: String) -> Result<Value, String> {
    let path = storage.resolve(&dir)?.join("session.json");
    let started = std::time::Instant::now();
    let offline = is_dataless(&path);
    let result = blocking(move || {
        let text = read_opt(&path).ok_or_else(|| format!("{}: no session.json", path.display()))?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    })
    .await;
    let ms = started.elapsed().as_millis();
    if ms > 300 || offline {
        crate::logging::info("perf", &format!("session_meta {dir}: {} ms{}", ms, if offline { " (downloaded from iCloud)" } else { "" }));
    }
    result
}

/// Every session's session.json, newest first.
#[tauri::command]
pub async fn sessions_list(storage: State<'_, Storage>) -> Result<Vec<SessionListItem>, String> {
    let root = storage.resolve("sessions")?;
    let started = std::time::Instant::now();
    let result = blocking(move || {
        let mut out: Vec<SessionListItem> = fs::read_dir(&root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_dir())
            .filter_map(|e| {
                let meta: Value = serde_json::from_str(&read_opt(&e.path().join("session.json"))?).ok()?;
                Some(SessionListItem { dir: format!("sessions/{}", e.file_name().to_string_lossy()), meta })
            })
            .collect();
        out.sort_by(|a, b| b.meta["startedAt"].as_str().unwrap_or("").cmp(a.meta["startedAt"].as_str().unwrap_or("")));
        Ok(out)
    })
    .await;
    crate::logging::info("perf", &format!("sessions_list: {:?} in {} ms", result.as_ref().map(|v| v.len()), started.elapsed().as_millis()));
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBundle {
    meta: Value,
    suggestions: Vec<Value>,
    moments: Value,
    chat: Value,
    notes: String,
    my_notes: String,
    /// Number of transcript lines; the transcript itself loads separately (session_transcript).
    segment_count: usize,
}

/// Everything a session page needs for first paint, in one call. The transcript
/// (can be MBs) is fetched on its own so the Summary tab doesn't wait for it.
#[tauri::command]
pub async fn session_load(storage: State<'_, Storage>, dir: String) -> Result<SessionBundle, String> {
    let base = storage.resolve(&dir)?;
    let started = std::time::Instant::now();
    let label = dir.clone();
    let result = blocking(move || {
        // Read the files side by side: when iCloud has evicted them, each read waits for a
        // download, and doing them in parallel costs one wait instead of six.
        let b = &base;
        let json = |name: &str, fallback: Value| read_opt(&b.join(name)).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(fallback);
        std::thread::scope(|s| {
            let segment_count = s.spawn(|| {
                fs::File::open(b.join("transcript.jsonl"))
                    .map(|f| std::io::BufRead::lines(std::io::BufReader::new(f)).count())
                    .unwrap_or(0)
            });
            let meta = s.spawn(|| json("session.json", Value::Object(Default::default())));
            let suggestions = s.spawn(|| read_jsonl(&b.join("suggestions.jsonl")));
            let moments = s.spawn(|| json("moments.json", Value::Array(vec![])));
            let chat = s.spawn(|| json("chat.json", Value::Array(vec![])));
            let notes = s.spawn(|| read_opt(&b.join("notes.md")).unwrap_or_default());
            let my_notes = s.spawn(|| read_opt(&b.join("my-notes.md")).unwrap_or_default());
            Ok(SessionBundle {
                meta: meta.join().unwrap_or_default(),
                suggestions: suggestions.join().unwrap_or_default(),
                moments: moments.join().unwrap_or(Value::Array(vec![])),
                chat: chat.join().unwrap_or(Value::Array(vec![])),
                notes: notes.join().unwrap_or_default(),
                my_notes: my_notes.join().unwrap_or_default(),
                segment_count: segment_count.join().unwrap_or(0),
            })
        })
    })
    .await;
    crate::logging::info("perf", &format!("session_load {label}: {} in {} ms", if result.is_ok() { "ok" } else { "error" }, started.elapsed().as_millis()));
    result
}

/// A session's transcript, parsed in Rust (no 8,000 JSON.parse calls in the UI).
#[tauri::command]
pub async fn session_transcript(storage: State<'_, Storage>, dir: String) -> Result<Vec<Value>, String> {
    let base = storage.resolve(&dir)?;
    let started = std::time::Instant::now();
    let result = blocking(move || Ok(read_jsonl(&base.join("transcript.jsonl")))).await;
    crate::logging::info("perf", &format!("session_transcript {dir}: {:?} lines in {} ms", result.as_ref().map(|v| v.len()), started.elapsed().as_millis()));
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicDoc {
    path: String,
    name: String,
    modified: u64,
    is_session: bool,
    /// Only filled when requested (with_content), so listing stays cheap.
    content: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicListing {
    slug: String,
    files: Vec<TopicDoc>,
}

/// Topics and their markdown files in one call; `slugs` limits it, `with_content` adds file text.
#[tauri::command]
pub async fn topics_list(storage: State<'_, Storage>, slugs: Option<Vec<String>>, with_content: Option<bool>) -> Result<Vec<TopicListing>, String> {
    let root = storage.resolve("topics")?;
    let data_root = storage.resolve("")?;
    blocking(move || {
        let with_content = with_content.unwrap_or(false);
        let mut topics = Vec::new();
        let names: Vec<String> = match slugs {
            Some(s) => s,
            None => fs::read_dir(&root)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| e.path().is_dir() && !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
        };
        for slug in names {
            if slug.contains('/') || slug.contains("..") {
                continue;
            }
            let rel = format!("topics/{slug}");
            let mut entries = Vec::new();
            let dir = data_root.join(&rel);
            if dir.exists() {
                walk(&dir, &rel, true, &mut entries)?;
            }
            let mut files: Vec<TopicDoc> = entries
                .into_iter()
                .filter(|e| !e.is_dir && e.name.ends_with(".md"))
                .map(|e| TopicDoc {
                    content: with_content.then(|| read_opt(&data_root.join(&e.path)).unwrap_or_default()),
                    is_session: e.path.contains("/sessions/"),
                    path: e.path,
                    name: e.name,
                    modified: e.modified,
                })
                .collect();
            files.sort_by(|a, b| a.is_session.cmp(&b.is_session).then(b.modified.cmp(&a.modified)));
            topics.push(TopicListing { slug, files });
        }
        topics.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(topics)
    })
    .await
}

/// Copy user-picked files (from the open dialog) into a topic folder.
#[tauri::command]
pub async fn import_files(storage: State<'_, Storage>, sources: Vec<String>, dest: String) -> Result<Vec<String>, String> {
    let dest_dir = storage.resolve(&dest)?;
    blocking(move || {
        fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        let mut copied = Vec::new();
        for source in sources {
            let src = PathBuf::from(&source);
            let name = src.file_name().ok_or("bad file name")?.to_string_lossy().into_owned();
            fs::copy(&src, dest_dir.join(&name)).map_err(|e| format!("{source}: {e}"))?;
            copied.push(format!("{dest}/{name}"));
        }
        Ok(copied)
    })
    .await
}

#[tauri::command]
pub fn reveal(app: AppHandle, storage: State<Storage>, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let full = storage.resolve(&path)?;
    app.opener().reveal_item_in_dir(full).map_err(|e| e.to_string())
}

/// Deletes by moving to the macOS Trash, so a mistaken delete is recoverable.
#[tauri::command]
pub async fn fs_trash(storage: State<'_, Storage>, path: String) -> Result<(), String> {
    if path.trim_matches('/').is_empty() || path == "topics" || path == "sessions" {
        return Err("refusing to delete a top-level folder".into());
    }
    let full = storage.resolve(&path)?;
    blocking(move || trash(full, &path)).await
}

fn trash(full: PathBuf, path: &str) -> Result<(), String> {
    if !full.exists() {
        return Ok(());
    }
    let trash = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?).join(".Trash");
    let name = full.file_name().ok_or("bad path")?.to_string_lossy().into_owned();
    let mut target = trash.join(&name);
    if target.exists() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        target = trash.join(format!("{name} {stamp}"));
    }
    fs::rename(&full, &target).map_err(|e| format!("Could not move {path} to Trash: {e}"))
}

/// Reads a skill's instructions (a folder containing SKILL.md, or the .md file
/// itself) for a post-session hook. Only markdown is readable through this.
#[tauri::command]
pub async fn skill_load(path: String) -> Result<String, String> {
    blocking(move || {
        let home = std::env::var("HOME").unwrap_or_default();
        let expanded = path.strip_prefix("~/").map(|rest| format!("{home}/{rest}")).unwrap_or(path.clone());
        let mut file = PathBuf::from(&expanded);
        if file.is_dir() {
            file = file.join("SKILL.md");
        }
        if file.extension().and_then(|e| e.to_str()) != Some("md") {
            return Err(format!("{path}: a skill must be a folder with SKILL.md or a .md file"));
        }
        fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))
    })
    .await
}

/// "macOS 26.1 (arm64)" for feedback reports.
#[tauri::command]
pub fn system_info() -> String {
    let version = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "?".into());
    format!("macOS {version} ({})", std::env::consts::ARCH)
}
