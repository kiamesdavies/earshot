mod audio;
mod cli;
pub mod logging;
pub mod mcp;
pub mod models;
mod recordings;
mod secrets;
mod storage;
pub mod stt;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = storage::load_settings_value(&handle);
            let root = settings
                .get("dataRoot")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| storage::default_root(&handle));
            std::fs::create_dir_all(root.join("topics")).ok();
            std::fs::create_dir_all(root.join("sessions")).ok();
            app.manage(storage::Storage { root: Mutex::new(root) });

            let auto_prompt = settings.get("autoPrompt").and_then(|v| v.as_bool()).unwrap_or(true);
            let audio = audio::Audio::default();
            *audio.auto_prompt.lock().unwrap() = auto_prompt;
            app.manage(audio);
            logging::info("app", &format!("Earshot {} starting; data folder {}", app.package_info().version, app.state::<storage::Storage>().root.lock().unwrap().display()));
            audio::start_watch(handle.clone());
            std::thread::spawn(cli::warm_shell_env);

            // ⌃⌥N anywhere toggles the floating nudge window.
            {
                use tauri::Emitter;
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if event.state == ShortcutState::Pressed && *shortcut == toggle {
                                let _ = app.emit_to("main", "toggle-mini", ());
                            }
                        })
                        .build(),
                )?;
                if let Err(e) = app.global_shortcut().register(toggle) {
                    logging::error("app", &format!("could not register ⌃⌥N: {e}"));
                }
            }

            // `Earshot --selftest`: record 8s with system audio, log everything, quit.
            // Launched via `open`, so macOS applies Earshot's own privacy permissions.
            if std::env::args().any(|a| a == "--selftest") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let report = audio::run_selftest("en-US".into(), true, false, 8, stt::SttConfig { engine: "apple".into(), ..Default::default() });
                    let path = logging::log_dir().join("selftest.json");
                    let _ = std::fs::write(&path, serde_json::to_string_pretty(&report.unwrap_or_default()).unwrap_or_default());
                    logging::info("selftest", &format!("wrote {}", path.display()));
                    handle.exit(0);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage::settings_load,
            storage::settings_save,
            storage::data_root,
            storage::fs_read,
            storage::fs_exists,
            storage::fs_write,
            storage::fs_append,
            storage::fs_mkdir,
            storage::fs_list,
            storage::import_files,
            storage::reveal,
            storage::fs_trash,
            storage::sessions_list,
            storage::sessions_dirs,
            storage::session_meta,
            storage::system_info,
            storage::session_load,
            storage::session_transcript,
            storage::topics_list,
            storage::skill_load,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secrets_present,
            cli::cli_resolve,
            cli::run_cli,
            audio::set_auto_prompt,
            audio::capture_start,
            audio::capture_stop,
            audio::transcribe_files,
            audio::permissions,
            audio::open_privacy_settings,
            audio::audio_selftest,
            audio::mini_open,
            audio::mini_close,
            stt::stt_find_models,
            models::stt_catalog,
            models::stt_download,
            models::stt_cancel_download,
            models::stt_delete_model,
            stt::stt_preload,
            stt::stt_test_file,
            logging::log_event,
            logging::open_logs,
            mcp::mcp_connect,
            mcp::mcp_disconnect,
            mcp::mcp_status,
            mcp::mcp_tools,
            mcp::mcp_call,
            recordings::recordings_usage,
            recordings::recordings_purge,
            recordings::recording_delete,
            recordings::recordings_reveal,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                stt::shutdown();
            }
        });
}
