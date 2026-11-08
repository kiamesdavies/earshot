//! Diagnostics go to two places:
//!  - the macOS unified log (subsystem app.earshot.desktop), visible in Console.app or with
//!    `log show --last 1h --predicate 'subsystem == "app.earshot.desktop"'`
//!  - ~/Library/Logs/Earshot/earshot.log, a plain file a user can attach to a bug report
//!    (Console.app also lists it under "Log Reports").
//! Call content (transcript text, chat, notes) is never logged — only events and errors.

use oslog::{Level, OsLog};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const MAX_BYTES: u64 = 5 * 1024 * 1024;

pub fn log_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Logs/Earshot")
}

fn oslog(category: &str) -> &'static OsLog {
    static LOGS: OnceLock<Mutex<Vec<(String, &'static OsLog)>>> = OnceLock::new();
    let logs = LOGS.get_or_init(Default::default);
    let mut logs = logs.lock().unwrap();
    if let Some((_, log)) = logs.iter().find(|(c, _)| c == category) {
        return log;
    }
    let log: &'static OsLog = Box::leak(Box::new(OsLog::new("app.earshot.desktop", category)));
    logs.push((category.to_string(), log));
    log
}

fn file() -> &'static Mutex<Option<std::fs::File>> {
    static FILE: OnceLock<Mutex<Option<std::fs::File>>> = OnceLock::new();
    FILE.get_or_init(|| {
        let dir = log_dir();
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("earshot.log");
        // Keep one previous file when the log grows past 5 MB.
        if fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
            let _ = fs::rename(&path, dir.join("earshot.1.log"));
        }
        Mutex::new(OpenOptions::new().create(true).append(true).open(path).ok())
    })
}

pub fn write(level: &str, category: &str, message: &str) {
    let os_level = match level {
        "error" => Level::Error,
        "warn" => Level::Default,
        "debug" => Level::Debug,
        _ => Level::Default,
    };
    oslog(category).with_level(os_level, message);
    if let Some(f) = file().lock().unwrap().as_mut() {
        let now = chrono_like_now();
        let _ = writeln!(f, "{now} {level:5} [{category}] {message}");
    }
}

pub fn info(category: &str, message: &str) {
    write("info", category, message);
}

pub fn error(category: &str, message: &str) {
    write("error", category, message);
}

/// UTC timestamp without pulling in a date crate.
fn chrono_like_now() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Civil-from-days (Howard Hinnant).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, now.subsec_millis())
}

/// Lets the UI record its own errors (failed model calls, notes, etc.).
#[tauri::command]
pub async fn log_event(level: String, category: String, message: String) -> Result<(), String> {
    write(&level, &format!("ui.{category}"), &message);
    Ok(())
}

#[tauri::command]
pub fn open_logs() -> Result<(), String> {
    let dir = log_dir();
    let _ = fs::create_dir_all(&dir);
    std::process::Command::new("open").arg(&dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
