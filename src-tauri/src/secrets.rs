//! API keys live in the macOS keychain, never in settings.json.
//! The replay harness reads the same entries with `security find-generic-password`.

const SERVICE: &str = "app.earshot.desktop";

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

fn secret_get_sync(name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn secret_set_sync(name: String, value: String) -> Result<(), String> {
    if value.is_empty() {
        return match entry(&name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    entry(&name)?.set_password(&value).map_err(|e| e.to_string())
}

// Keychain calls can take tens of ms (or wait on a prompt): keep them off the main thread.
#[tauri::command]
pub async fn secret_get(name: String) -> Result<Option<String>, String> {
    crate::storage::blocking(move || secret_get_sync(name)).await
}

#[tauri::command]
pub async fn secret_set(name: String, value: String) -> Result<(), String> {
    crate::storage::blocking(move || secret_set_sync(name, value)).await
}

/// Which of these keys are saved, in one call (readiness checks).
#[tauri::command]
pub async fn secrets_present(names: Vec<String>) -> Result<Vec<bool>, String> {
    crate::storage::blocking(move || Ok(names.into_iter().map(|n| matches!(secret_get_sync(n), Ok(Some(_)))).collect())).await
}
