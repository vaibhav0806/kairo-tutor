//! Google-only desktop auth. Opens the system browser at the backend's `/auth/start`, receives the
//! `kairo://auth-callback?code=…` deep link, exchanges the one-time code over HTTPS for a durable
//! session token stored in the macOS Keychain, and mints short-lived JWTs for proxied calls.
//!
//! The AI points, the user acts — and the app never handles the Google secret: the backend owns the
//! whole OAuth dance; only a single-use code ever travels through the `kairo://` URL.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::constants;

const KEYCHAIN_SERVICE: &str = "com.kairo.tutor";
const SESSION_ITEM: &str = "session";

fn entry(item: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, item).map_err(|e| format!("keychain entry: {e}"))
}

pub(crate) fn store_session(token: &str) -> Result<(), String> {
    entry(SESSION_ITEM)?
        .set_password(token)
        .map_err(|e| format!("keychain set: {e}"))
}

pub(crate) fn read_session() -> Option<String> {
    entry(SESSION_ITEM).ok()?.get_password().ok()
}

pub(crate) fn clear_session() -> Result<(), String> {
    match entry(SESSION_ITEM)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete: {e}")),
    }
}

/// Open the system browser at the backend's Google start route (reuses the `open` pattern).
#[tauri::command]
pub fn start_google_auth() -> Result<(), String> {
    let url = format!("{}/auth/start", constants::KAIRO_BACKEND_URL);
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("failed to open browser: {e}"))?;
    klog!(auth, info, "opened system browser for google sign-in");
    Ok(())
}

#[derive(Serialize)]
pub struct AuthStatus {
    pub signed_in: bool,
}

#[tauri::command]
pub fn get_auth_status() -> AuthStatus {
    AuthStatus {
        signed_in: read_session().is_some(),
    }
}

#[tauri::command]
pub fn sign_out(app: AppHandle) -> Result<(), String> {
    clear_session()?;
    let _ = app.emit("auth:changed", false);
    klog!(auth, info, "signed out (keychain cleared)");
    Ok(())
}

/// Called by the deep-link handler: exchange the one-time code for a session token, store it, and
/// notify the UI. The raw code is never logged.
pub(crate) async fn exchange_code(app: &AppHandle, code: &str) {
    let url = format!("{}/auth/exchange", constants::KAIRO_BACKEND_URL);
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await;

    match res {
        Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
            Ok(v) => match v.get("sessionToken").and_then(|t| t.as_str()) {
                Some(token) => match store_session(token) {
                    Ok(()) => {
                        let _ = app.emit("auth:changed", true);
                        klog!(auth, info, "session stored; sign-in complete");
                    }
                    Err(e) => klog!(auth, error, "failed to store session: {e}"),
                },
                None => klog!(auth, error, "exchange response missing sessionToken"),
            },
            Err(e) => klog!(auth, error, "exchange parse failed: {e}"),
        },
        Ok(r) => klog!(auth, error, status = r.status().as_u16(), "code exchange failed"),
        Err(e) => klog!(auth, error, "exchange request failed: {e}"),
    }
}

/// Fetch a short-lived JWT from the backend using the stored session token (for the proxy path).
#[allow(dead_code)] // consumed by the provider-repoint work (Plan 2b)
pub(crate) async fn fetch_jwt() -> Option<String> {
    let session = read_session()?;
    let url = format!("{}/api/auth/token", constants::KAIRO_BACKEND_URL);
    let res = reqwest::Client::new()
        .get(&url)
        .bearer_auth(&session)
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let v = res.json::<serde_json::Value>().await.ok()?;
    v.get("token").and_then(|t| t.as_str()).map(str::to_string)
}
