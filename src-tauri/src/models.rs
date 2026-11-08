//! Speech model catalog: what can be downloaded, what is already on disk
//! (Earshot's own folder, or Handy's, which uses the same files), and the
//! download itself with progress, cancel and resumable `.part` files.

use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

const HF_WHISPER: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const HF_PARAKEET_V3: &str = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main";

struct CatalogModel {
    id: &'static str,
    engine: &'static str,
    name: &'static str,
    description: &'static str,
    /// File name for Whisper, folder name for Parakeet — same names Handy uses.
    target: &'static str,
    files: &'static [(&'static str, u64)],
    base_url: &'static str,
    recommended: bool,
}

const CATALOG: &[CatalogModel] = &[
    CatalogModel {
        id: "whisper-large-v3-turbo",
        engine: "whisper",
        name: "Whisper large-v3 turbo",
        description: "Fast and accurate. Uses your vocabulary hints. 99 languages.",
        target: "ggml-large-v3-turbo-q5_0.bin",
        files: &[("ggml-large-v3-turbo-q5_0.bin", 574_041_195)],
        base_url: HF_WHISPER,
        recommended: true,
    },
    CatalogModel {
        id: "parakeet-v3",
        engine: "parakeet",
        name: "Parakeet v3",
        description: "Fastest (~0.2s per phrase). 25 European languages. No vocabulary hints.",
        target: "parakeet-tdt-0.6b-v3-int8",
        files: &[
            ("encoder-model.int8.onnx", 652_183_999),
            ("decoder_joint-model.int8.onnx", 18_202_004),
            ("nemo128.onnx", 139_764),
            ("vocab.txt", 93_939),
            ("config.json", 97),
        ],
        base_url: HF_PARAKEET_V3,
        recommended: false,
    },
    CatalogModel {
        id: "whisper-large-v3",
        engine: "whisper",
        name: "Whisper large-v3",
        description: "Most accurate, slowest (~1s per phrase). Uses vocabulary hints.",
        target: "ggml-large-v3-q5_0.bin",
        files: &[("ggml-large-v3-q5_0.bin", 1_081_140_203)],
        base_url: HF_WHISPER,
        recommended: false,
    },
    CatalogModel {
        id: "whisper-small-en",
        engine: "whisper",
        name: "Whisper small (English)",
        description: "Light and quick for older Macs. English only, less accurate.",
        target: "ggml-small.en-q5_1.bin",
        files: &[("ggml-small.en-q5_1.bin", 190_098_681)],
        base_url: HF_WHISPER,
        recommended: false,
    },
];

fn earshot_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("models")
}

fn handy_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Application Support/com.pais.handy/models")
}

fn is_complete(model: &CatalogModel, path: &Path) -> bool {
    if model.engine == "parakeet" {
        model.files.iter().all(|(f, _)| path.join(f).is_file())
    } else {
        path.is_file()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    id: String,
    engine: String,
    name: String,
    description: String,
    size_bytes: u64,
    recommended: bool,
    /// Where it's installed, if anywhere (Earshot's copy wins over Handy's).
    path: Option<String>,
    source: Option<String>,
    /// 0..1 while a download is running.
    progress: Option<f64>,
}

#[derive(Default)]
struct Download {
    cancel: Arc<AtomicBool>,
    progress: f64,
}

fn downloads() -> &'static Mutex<HashMap<String, Download>> {
    static D: OnceLock<Mutex<HashMap<String, Download>>> = OnceLock::new();
    D.get_or_init(Default::default)
}

#[tauri::command]
pub async fn stt_catalog(app: AppHandle) -> Result<Vec<CatalogEntry>, String> {
    crate::storage::blocking(move || Ok(catalog(&app))).await
}

fn catalog(app: &AppHandle) -> Vec<CatalogEntry> {
    // Copy progress out and drop the lock before touching the disk.
    let progress: HashMap<&str, f64> = downloads().lock().unwrap().iter().filter_map(|(id, d)| CATALOG.iter().find(|m| m.id == id).map(|m| (m.id, d.progress))).collect();
    let (mine_dir, handy) = (earshot_dir(app), handy_dir());
    CATALOG
        .iter()
        .map(|m| {
            let mine = mine_dir.join(m.target);
            let handy = handy.join(m.target);
            let (path, source) = if is_complete(m, &mine) {
                (Some(mine), Some("Earshot"))
            } else if is_complete(m, &handy) {
                (Some(handy), Some("Handy"))
            } else {
                (None, None)
            };
            CatalogEntry {
                id: m.id.into(),
                engine: m.engine.into(),
                name: m.name.into(),
                description: m.description.into(),
                size_bytes: m.files.iter().map(|(_, s)| s).sum(),
                recommended: m.recommended,
                path: path.map(|p| p.to_string_lossy().into_owned()),
                source: source.map(String::from),
                progress: progress.get(m.id).copied(),
            }
        })
        .collect()
}

/// Starts a download in the background; progress arrives as `stt-download` events.
#[tauri::command]
pub fn stt_download(app: AppHandle, id: String) -> Result<(), String> {
    let model = CATALOG.iter().find(|m| m.id == id).ok_or(format!("Unknown model {id}"))?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = downloads().lock().unwrap();
        if active.contains_key(&id) {
            return Ok(());
        }
        active.insert(id.clone(), Download { cancel: cancel.clone(), progress: 0.0 });
    }
    std::thread::spawn(move || {
        let mut last_emit = Instant::now();
        let result = download_to(&earshot_dir(&app), model.id, &cancel, |progress, received, total| {
            if last_emit.elapsed().as_millis() < 250 {
                return;
            }
            last_emit = Instant::now();
            if let Some(d) = downloads().lock().unwrap().get_mut(model.id) {
                d.progress = progress;
            }
            let _ = app.emit("stt-download", json!({ "id": model.id, "progress": progress, "received": received, "total": total }));
        });
        downloads().lock().unwrap().remove(model.id);
        let payload = match result {
            Ok(path) => json!({ "id": model.id, "done": true, "path": path }),
            Err(e) if cancel.load(Ordering::Relaxed) => json!({ "id": model.id, "cancelled": true, "error": e }),
            Err(e) => json!({ "id": model.id, "error": e }),
        };
        let _ = app.emit("stt-download", payload);
    });
    Ok(())
}

/// Downloads a catalog model into `root`, resuming any `.part` left by an earlier attempt.
pub fn download_to(root: &Path, id: &str, cancel: &AtomicBool, mut on_progress: impl FnMut(f64, u64, u64)) -> Result<String, String> {
    let model = CATALOG.iter().find(|m| m.id == id).ok_or(format!("Unknown model {id}"))?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let total: u64 = model.files.iter().map(|(_, s)| s).sum();
    // Whisper: one file. Parakeet: a folder of files, assembled in "<name>.part/".
    let staging = root.join(format!("{}.part", model.target));
    if model.engine == "parakeet" {
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    let mut done_before: u64 = 0;
    for (file, size) in model.files {
        let dest = if model.engine == "parakeet" { staging.join(file) } else { staging.clone() };
        let have = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        if have == *size {
            done_before += size;
            continue;
        }
        // Resume a partial file with a Range request.
        let mut request = ureq::get(&format!("{}/{}", model.base_url, file));
        if have > 0 && have < *size {
            request = request.set("Range", &format!("bytes={have}-"));
        }
        let response = request.call().map_err(|e| format!("{file}: {e}"))?;
        let resumed = response.status() == 206;
        let mut out = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&dest)
            .map_err(|e| e.to_string())?;
        let mut received = if resumed { have } else { 0 };
        let mut reader = response.into_reader();
        let mut buffer = vec![0u8; 1 << 16];
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let n = reader.read(&mut buffer).map_err(|e| format!("{file}: {e}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
            received += n as u64;
            on_progress((done_before + received) as f64 / total as f64, done_before + received, total);
        }
        if received != *size {
            return Err(format!("{file}: download incomplete ({received} of {size} bytes) — try again to resume"));
        }
        done_before += size;
    }
    let final_path = root.join(model.target);
    let _ = fs::remove_dir_all(&final_path);
    fs::rename(&staging, &final_path).map_err(|e| e.to_string())?;
    Ok(final_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn stt_cancel_download(id: String) {
    if let Some(d) = downloads().lock().unwrap().get(&id) {
        d.cancel.store(true, Ordering::Relaxed);
    }
}

/// Removes Earshot's own copy (moved to the Trash). Handy's files are never touched.
fn stt_delete_model_sync(app: AppHandle, id: String) -> Result<(), String> {
    let model = CATALOG.iter().find(|m| m.id == id).ok_or(format!("Unknown model {id}"))?;
    let path = earshot_dir(&app).join(model.target);
    if !path.exists() {
        return Ok(());
    }
    let trash = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?).join(".Trash");
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    fs::rename(&path, trash.join(format!("{} {stamp}", model.target))).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stt_delete_model(app: AppHandle, id: String) -> Result<(), String> {
    crate::storage::blocking(move || stt_delete_model_sync(app, id)).await
}
