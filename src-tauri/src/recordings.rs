//! Call audio lives in app data, never in the (possibly iCloud-synced) data
//! folder: ~/Library/Application Support/app.earshot.desktop/recordings/<session id>/
//! holds me.m4a / them.m4a (AAC, ~15-25 MB per hour per side). Transcripts and
//! notes stay in the session folder, so deleting audio loses no text.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

use crate::logging;

pub fn dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("recordings")
}

fn size_of(path: &Path) -> u64 {
    if path.is_file() {
        return fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    fs::read_dir(path).into_iter().flatten().flatten().map(|e| size_of(&e.path())).sum()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    total_bytes: u64,
    sessions: Vec<SessionAudio>,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAudio {
    id: String,
    bytes: u64,
}

fn recordings_usage_sync(app: AppHandle) -> Usage {
    let root = dir(&app);
    let mut sessions: Vec<SessionAudio> = fs::read_dir(&root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| SessionAudio { id: e.file_name().to_string_lossy().into_owned(), bytes: size_of(&e.path()) })
        .collect();
    sessions.sort_by(|a, b| b.id.cmp(&a.id));
    Usage { total_bytes: sessions.iter().map(|s| s.bytes).sum(), sessions, path: root.to_string_lossy().into_owned() }
}

/// Deletes recordings older than `days` (all when 0), skipping `keep` (the live session).
/// Runs from the retention setting, so it removes permanently rather than via the Trash.
fn recordings_purge_sync(app: AppHandle, days: u64, keep: Option<String>) -> Result<u64, String> {
    let root = dir(&app);
    let cutoff = SystemTime::now() - Duration::from_secs(days * 86_400);
    let mut freed = 0;
    for entry in fs::read_dir(&root).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if Some(&name) == keep.as_ref() || !entry.path().is_dir() {
            continue;
        }
        let modified = entry.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::now());
        if days == 0 || modified < cutoff {
            let bytes = size_of(&entry.path());
            fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
            freed += bytes;
            logging::info("recordings", &format!("deleted audio for {name} ({bytes} bytes)"));
        }
    }
    Ok(freed)
}

fn recording_delete_sync(app: AppHandle, id: String) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return Err("bad session id".into());
    }
    let path = dir(&app).join(&id);
    if path.exists() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        logging::info("recordings", &format!("deleted audio for {id}"));
    }
    Ok(())
}

#[tauri::command]
pub fn recordings_reveal(app: AppHandle) -> Result<(), String> {
    let root = dir(&app);
    let _ = fs::create_dir_all(&root);
    std::process::Command::new("open").arg(&root).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn recordings_usage(app: AppHandle) -> Result<Usage, String> {
    crate::storage::blocking(move || Ok(recordings_usage_sync(app))).await
}

#[tauri::command]
pub async fn recordings_purge(app: AppHandle, days: u64, keep: Option<String>) -> Result<u64, String> {
    crate::storage::blocking(move || recordings_purge_sync(app, days, keep)).await
}

#[tauri::command]
pub async fn recording_delete(app: AppHandle, id: String) -> Result<(), String> {
    crate::storage::blocking(move || recording_delete_sync(app, id)).await
}
