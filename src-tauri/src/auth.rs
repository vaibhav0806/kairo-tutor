//! Google-only desktop auth. Opens the system browser at the backend's `/auth/start`, receives the
//! `kairo://auth-callback?code=…` deep link, exchanges the one-time code over HTTPS for a durable
//! session token, and mints short-lived JWTs for proxied calls.
//!
//! The session token is stored as a 0600 file in the app's Application Support dir (NOT the macOS
//! Keychain). A session token is a revocable bearer token, and file storage avoids the Keychain ACL
//! password prompt that fires on every self-signed rebuild. If we ever ship a Developer-ID-signed +
//! notarized build, revisit the Keychain + a `keychain-access-groups` entitlement (prompt-free then).

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::constants;

fn session_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("session.token"))
}

pub(crate) fn store_session(app: &AppHandle, token: &str) -> Result<(), String> {
    let path = session_path(app).ok_or("no config dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir: {e}"))?;
    }
    std::fs::write(&path, token).map_err(|e| format!("write: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub(crate) fn read_session(app: &AppHandle) -> Option<String> {
    let token = std::fs::read_to_string(session_path(app)?).ok()?;
    let token = token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

pub(crate) fn clear_session(app: &AppHandle) {
    if let Some(path) = session_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

/// Open the system browser at the backend's Google start route.
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
pub fn get_auth_status(app: AppHandle) -> AuthStatus {
    AuthStatus {
        signed_in: read_session(&app).is_some(),
    }
}

#[tauri::command]
pub fn sign_out(app: AppHandle) -> Result<(), String> {
    clear_session(&app);
    let _ = app.emit("auth:changed", false);
    klog!(auth, info, "signed out (session file cleared)");
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
                Some(token) => match store_session(app, token) {
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

/// Command: hand the webview a short-lived JWT for authed backend calls (/v1/me, /v1/onboarding).
#[tauri::command]
pub async fn get_backend_jwt(app: AppHandle) -> Option<String> {
    fetch_jwt(&app).await
}

/// Fetch a short-lived JWT from the backend using the stored session token (for the proxy path).
pub(crate) async fn fetch_jwt(app: &AppHandle) -> Option<String> {
    let session = read_session(app)?;
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
