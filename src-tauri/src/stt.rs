//! Local speech-to-text with the same engines Handy uses (transcribe-rs):
//! Whisper (whisper.cpp + Metal) and Parakeet (ONNX). The audio sidecar cuts
//! each utterance into a WAV; a single worker thread transcribes them in order.
//! The loaded model is kept between sessions.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams};
use transcribe_rs::onnx::Quantization;
use transcribe_rs::whisper_cpp::{WhisperEngine, WhisperInferenceParams};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SttConfig {
    /// "whisper", "parakeet" or "apple".
    pub engine: String,
    pub model_path: String,
    /// Words to bias Whisper toward (names, products, jargon).
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub language: String,
}

enum Engine {
    Whisper(WhisperEngine),
    Parakeet(ParakeetModel),
}

struct Loaded {
    key: (String, String),
    engine: Engine,
}

pub struct Chunk {
    pub id: String,
    pub speaker: String,
    pub start: f64,
    pub end: f64,
    pub path: PathBuf,
}

pub enum Job {
    Configure(SttConfig),
    Transcribe(Chunk),
    /// Calls back once every job queued before it has finished.
    Flush,
    /// Frees the model. whisper.cpp's Metal backend asserts if it is still
    /// alive when the process exits, which macOS reports as a crash.
    Shutdown,
}

static WORKER: OnceLock<Mutex<Sender<(Job, Box<dyn Fn(Value) + Send>)>>> = OnceLock::new();

/// Queue a job; `emit` receives status and segment messages (same shape as sidecar output).
pub fn submit(job: Job, emit: impl Fn(Value) + Send + 'static) {
    let sender = WORKER.get_or_init(|| {
        let (tx, rx) = channel::<(Job, Box<dyn Fn(Value) + Send>)>();
        std::thread::Builder::new()
            .name("earshot-stt".into())
            .spawn(move || {
                let mut loaded: Option<Loaded> = None;
                let mut config = SttConfig::default();
                for (job, emit) in rx {
                    match job {
                        Job::Configure(c) => {
                            config = c;
                            if let Err(e) = ensure_loaded(&mut loaded, &config, &*emit) {
                                crate::logging::error("stt", &e);
                                emit(json!({ "type": "error", "message": e }));
                            }
                        }
                        Job::Transcribe(chunk) => {
                            let started = Instant::now();
                            match transcribe_chunk(&mut loaded, &config, &chunk, &*emit) {
                                Ok(Some(text)) => emit(json!({
                                    "type": "segment", "id": chunk.id, "speaker": chunk.speaker,
                                    "start": chunk.start, "end": chunk.end, "text": text, "final": true,
                                    "engine": config.engine, "sttMs": started.elapsed().as_millis() as u64,
                                })),
                                Ok(None) => {}
                                Err(e) => {
                                    crate::logging::error("stt", &format!("{} failed: {e}", chunk.id));
                                    emit(json!({ "type": "error", "message": format!("Transcription failed: {e}") }))
                                }
                            }
                            let _ = std::fs::remove_file(&chunk.path);
                        }
                        Job::Flush => emit(json!({ "type": "flushed" })),
                        Job::Shutdown => {
                            loaded = None;
                            emit(json!({ "type": "shutdown" }));
                        }
                    }
                }
            })
            .expect("spawn stt worker");
        Mutex::new(tx)
    });
    let _ = sender.lock().unwrap().send((job, Box::new(emit)));
}

fn ensure_loaded(loaded: &mut Option<Loaded>, config: &SttConfig, emit: &dyn Fn(Value)) -> Result<(), String> {
    let key = (config.engine.clone(), config.model_path.clone());
    if loaded.as_ref().is_some_and(|l| l.key == key) {
        return Ok(());
    }
    *loaded = None;
    let path = PathBuf::from(&config.model_path);
    if !path.exists() {
        return Err(format!("Speech model not found at {}. Pick one in Settings → Transcription.", config.model_path));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    emit(json!({ "type": "status", "message": format!("Loading speech model {name}…") }));
    let started = Instant::now();
    let engine = match config.engine.as_str() {
        "whisper" => Engine::Whisper(WhisperEngine::load(&path).map_err(|e| e.to_string())?),
        "parakeet" => {
            let quantization = if name.contains("int8") { Quantization::Int8 } else { Quantization::FP32 };
            Engine::Parakeet(ParakeetModel::load(&path, &quantization).map_err(|e| e.to_string())?)
        }
        other => return Err(format!("Unknown speech engine {other}")),
    };
    crate::logging::info("stt", &format!("loaded {} {} in {:.1}s", config.engine, config.model_path, started.elapsed().as_secs_f32()));
    emit(json!({ "type": "status", "message": format!("Speech model ready ({:.1}s)", started.elapsed().as_secs_f32()) }));
    *loaded = Some(Loaded { key, engine });
    Ok(())
}

/// Whisper invents these on breath, clicks and silence.
const HALLUCINATIONS: &[&str] = &["thank you.", "thanks for watching!", "thank you for watching.", "you", "bye.", "so", "okay.", "."];

fn transcribe_chunk(loaded: &mut Option<Loaded>, config: &SttConfig, chunk: &Chunk, emit: &dyn Fn(Value)) -> Result<Option<String>, String> {
    ensure_loaded(loaded, config, emit)?;
    let samples = transcribe_rs::audio::read_wav_samples(&chunk.path).map_err(|e| e.to_string())?;
    let text = match &mut loaded.as_mut().unwrap().engine {
        Engine::Whisper(engine) => {
            let params = WhisperInferenceParams {
                language: Some(if config.language.is_empty() { "en".into() } else { config.language.clone() }),
                initial_prompt: (!config.prompt.trim().is_empty()).then(|| config.prompt.clone()),
                ..Default::default()
            };
            engine.transcribe_with(&samples, &params).map_err(|e| e.to_string())?.text
        }
        Engine::Parakeet(model) => model.transcribe_with(&samples, &ParakeetParams::default()).map_err(|e| e.to_string())?.text,
    };
    let text = text.trim().to_string();
    let seconds = samples.len() as f64 / 16_000.0;
    if text.is_empty() || (seconds < 2.0 && HALLUCINATIONS.contains(&text.to_lowercase().as_str())) {
        return Ok(None);
    }
    Ok(Some(text))
}

/// Release the model before the app exits (waits up to 3s).
pub fn shutdown() {
    if WORKER.get().is_none() {
        return;
    }
    let (tx, rx) = channel();
    submit(Job::Shutdown, move |_| {
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(std::time::Duration::from_secs(3));
}

/// Transcribe one WAV file synchronously (Settings "test", replay harness).
pub fn transcribe_file(config: &SttConfig, path: &Path) -> Result<String, String> {
    let mut loaded = None;
    let chunk = Chunk { id: "file".into(), speaker: "me".into(), start: 0.0, end: 0.0, path: path.to_path_buf() };
    Ok(transcribe_chunk(&mut loaded, config, &chunk, &|_| {})?.unwrap_or_default())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundModel {
    engine: String,
    name: String,
    path: String,
    source: String,
}

/// Models already on disk from Handy (and Earshot's own models folder).
fn stt_find_models_sync(app: tauri::AppHandle) -> Vec<FoundModel> {
    use tauri::Manager;
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs = vec![(PathBuf::from(format!("{home}/Library/Application Support/com.pais.handy/models")), "Handy")];
    if let Ok(dir) = app.path().app_data_dir() {
        dirs.push((dir.join("models"), "Earshot"));
    }
    let mut found = Vec::new();
    for (dir, source) in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let engine = if path.is_dir() && (path.join("encoder-model.int8.onnx").exists() || path.join("encoder-model.onnx").exists()) {
                "parakeet"
            } else if name.starts_with("ggml-") && name.ends_with(".bin") {
                "whisper"
            } else {
                continue;
            };
            found.push(FoundModel { engine: engine.into(), name, path: path.to_string_lossy().into_owned(), source: source.into() });
        }
    }
    found.sort_by(|a, b| a.engine.cmp(&b.engine).then(b.name.cmp(&a.name)));
    found
}

/// Preload the model so the first utterance isn't delayed by loading.
#[tauri::command]
pub fn stt_preload(app: tauri::AppHandle, config: SttConfig) {
    use tauri::Emitter;
    if config.engine == "apple" {
        return;
    }
    submit(Job::Configure(config), move |msg| {
        let _ = app.emit("stt", msg);
    });
}

#[tauri::command]
pub async fn stt_test_file(config: SttConfig, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let text = transcribe_file(&config, Path::new(&path))?;
        Ok(format!("{text}\n\n({:.1}s)", started.elapsed().as_secs_f32()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stt_find_models(app: tauri::AppHandle) -> Result<Vec<FoundModel>, String> {
    crate::storage::blocking(move || Ok(stt_find_models_sync(app))).await
}
