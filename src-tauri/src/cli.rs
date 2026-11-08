//! Runs a model CLI the user already has installed and logged into (claude,
//! codex, kiro-cli, ...). Apps launched from Finder get launchd's bare
//! environment, so PATH and API-key variables are taken from an interactive
//! login shell (which reads ~/.zshrc, where ~/.local/bin is usually added).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

static SHELL_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

fn shell_env() -> &'static HashMap<String, String> {
    SHELL_ENV.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut env: HashMap<String, String> = std::env::vars().collect();
        // Markers keep shell greetings/prompts out of the parsed output.
        let script = "printf '__EARSHOT_ENV__'; env -0; printf '__EARSHOT_END__'";
        if let Ok(out) = Command::new(&shell).args(["-ilc", script]).stdin(Stdio::null()).output() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let (Some(start), Some(end)) = (text.find("__EARSHOT_ENV__"), text.rfind("__EARSHOT_END__")) {
                for pair in text[start + 15..end].split('\0') {
                    if let Some((k, v)) = pair.split_once('=') {
                        env.insert(k.to_string(), v.to_string());
                    }
                }
            }
        }
        let home = std::env::var("HOME").unwrap_or_default();
        let extra = [
            format!("{home}/.local/bin"),
            format!("{home}/.claude/local"),
            format!("{home}/.bun/bin"),
            format!("{home}/.npm-global/bin"),
            format!("{home}/.volta/bin"),
            format!("{home}/.cargo/bin"),
            "/opt/homebrew/bin".into(),
            "/usr/local/bin".into(),
        ];
        let path = env.get("PATH").cloned().unwrap_or_default();
        let mut parts: Vec<String> = path.split(':').filter(|p| !p.is_empty()).map(String::from).collect();
        for dir in extra {
            if !parts.contains(&dir) {
                parts.push(dir);
            }
        }
        env.insert("PATH".into(), parts.join(":"));
        env
    })
}

/// Called from setup on a background thread so the first CLI lookup doesn't wait ~0.5s for zsh.
pub fn warm_shell_env() {
    let _ = shell_env();
}

fn resolve(command: &str) -> Option<PathBuf> {
    let expanded = command.strip_prefix("~/").map(|rest| format!("{}/{rest}", std::env::var("HOME").unwrap_or_default()));
    let command = expanded.as_deref().unwrap_or(command);
    if command.contains('/') {
        let path = PathBuf::from(command);
        return path.is_file().then_some(path);
    }
    shell_env()
        .get("PATH")?
        .split(':')
        .map(|dir| Path::new(dir).join(command))
        .find(|candidate| candidate.is_file())
}

/// Where a CLI resolves to, or None if it isn't installed / not on PATH.
#[tauri::command]
pub async fn cli_resolve(command: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || resolve(&command).map(|p| p.to_string_lossy().into_owned()))
        .await
        .ok()
        .flatten()
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[tauri::command]
pub async fn run_cli(command: String, args: Vec<String>, stdin: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let program = resolve(&command).ok_or(format!(
            "`{command}` was not found. Set its full path in Settings → Models (e.g. run `which {command}` in Terminal)."
        ))?;
        let mut child = Command::new(&program)
            .args(&args)
            .current_dir(std::env::temp_dir())
            .env_clear()
            .envs(shell_env())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{}: {e}", program.display()))?;
        let mut pipe = child.stdin.take().unwrap();
        std::thread::spawn(move || {
            let _ = pipe.write_all(stdin.as_bytes());
        });
        let (tx, rx) = std::sync::mpsc::channel();
        let pid = child.id();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });
        match rx.recv_timeout(Duration::from_secs(300)) {
            Ok(Ok(out)) if out.status.success() => Ok(strip_ansi(&String::from_utf8_lossy(&out.stdout))),
            Ok(Ok(out)) => {
                let stderr = strip_ansi(&String::from_utf8_lossy(&out.stderr));
                let stdout = strip_ansi(&String::from_utf8_lossy(&out.stdout));
                let detail = if stderr.trim().is_empty() { stdout } else { stderr };
                Err(format!("{command} exited with {}: {}", out.status, detail.chars().take(500).collect::<String>()))
            }
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => {
                let _ = Command::new("kill").arg(pid.to_string()).status();
                Err(format!("{command} timed out after 5 minutes"))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
