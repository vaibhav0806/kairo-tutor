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

const PENDING_AUTH_FILE: &str = "pending-auth.state";
const PENDING_AUTH_TTL_SECS: u64 = 10 * 60;

pub(crate) struct AuthCallback {
    pub(crate) code: String,
    pub(crate) state: String,
}

fn session_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("session.token"))
}

fn pending_auth_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(PENDING_AUTH_FILE))
}

fn write_private_file(path: &PathBuf, value: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir: {e}"))?;
    }
    std::fs::write(path, value).map_err(|e| format!("write: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub(crate) fn store_session(app: &AppHandle, token: &str) -> Result<(), String> {
    let path = session_path(app).ok_or("no config dir")?;
    write_private_file(&path, token)
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
pub fn start_google_auth(app: AppHandle) -> Result<(), String> {
    let state = uuid::Uuid::new_v4().simple().to_string();
    let path = pending_auth_path(&app).ok_or("no config dir")?;
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("system clock: {e}"))?
        .as_secs();
    write_private_file(&path, &format!("{created_at}\n{state}"))?;
    let url = format!(
        "{}/auth/start?desktop_state={state}",
        crate::proxy::backend_url()
    );
    let opened = std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("failed to open browser: {e}"));
    if opened.is_err() {
        let _ = std::fs::remove_file(path);
    }
    opened?;
    klog!(auth, info, "opened system browser for google sign-in");
    Ok(())
}

pub(crate) fn parse_auth_callback(url: &tauri::Url) -> Option<AuthCallback> {
    if url.scheme() != "kairo" || url.host_str() != Some("auth-callback") {
        return None;
    }

    let mut code = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" if code.is_none() => code = Some(value.into_owned()),
            "state" if state.is_none() => state = Some(value.into_owned()),
            "code" | "state" => return None,
            _ => {}
        }
    }
    match (code, state) {
        (Some(code), Some(state)) if !code.is_empty() && !state.is_empty() => {
            Some(AuthCallback { code, state })
        }
        _ => None,
    }
}

pub(crate) fn consume_pending_auth_state(path: &std::path::Path, returned: &str) -> bool {
    let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return false;
    };
    consume_pending_auth_state_at(path, returned, now.as_secs())
}

fn consume_pending_auth_state_at(
    path: &std::path::Path,
    returned: &str,
    now_secs: u64,
) -> bool {
    let Ok(pending) = std::fs::read_to_string(path) else {
        return false;
    };
    let Some((created_at, expected)) = pending.split_once('\n') else {
        let _ = std::fs::remove_file(path);
        return false;
    };
    let Ok(created_at) = created_at.parse::<u64>() else {
        let _ = std::fs::remove_file(path);
        return false;
    };
    if created_at > now_secs || now_secs - created_at >= PENDING_AUTH_TTL_SECS {
        let _ = std::fs::remove_file(path);
        return false;
    }
    if expected.trim() != returned {
        return false;
    }
    std::fs::remove_file(path).is_ok()
}

pub(crate) fn accept_auth_callback(app: &AppHandle, url: &tauri::Url) -> Option<String> {
    let Some(callback) = parse_auth_callback(url) else {
        klog!(auth, warn, "rejected malformed auth callback");
        return None;
    };
    let Some(path) = pending_auth_path(app) else {
        klog!(
            auth,
            warn,
            "rejected auth callback without config directory"
        );
        return None;
    };
    if !consume_pending_auth_state(&path, &callback.state) {
        klog!(
            auth,
            warn,
            "rejected unsolicited or mismatched auth callback"
        );
        return None;
    }
    klog!(auth, info, "accepted correlated auth callback");
    Some(callback.code)
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
    let url = format!("{}/auth/exchange", crate::proxy::backend_url());
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
    let url = format!("{}/api/auth/token", crate::proxy::backend_url());
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

#[cfg(test)]
mod tests {
    use super::{consume_pending_auth_state, consume_pending_auth_state_at, parse_auth_callback};
    use std::{fs, path::PathBuf};

    fn pending_path() -> PathBuf {
        std::env::temp_dir().join(format!("kairo-auth-test-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn matching_callback_consumes_pending_state() {
        let path = pending_path();
        fs::write(&path, "100\nexpected-state").unwrap();
        let url =
            tauri::Url::parse("kairo://auth-callback?code=one-time-code&state=expected-state")
                .unwrap();

        let callback = parse_auth_callback(&url).unwrap();
        assert!(consume_pending_auth_state_at(&path, &callback.state, 200));
        assert_eq!(callback.code, "one-time-code");
        assert!(!path.exists());
    }

    #[test]
    fn mismatched_callback_is_rejected_without_consuming_pending_state() {
        let path = pending_path();
        fs::write(&path, "100\nexpected-state").unwrap();
        let url =
            tauri::Url::parse("kairo://auth-callback?code=attacker-code&state=attacker-state")
                .unwrap();

        let callback = parse_auth_callback(&url).unwrap();
        assert!(!consume_pending_auth_state_at(&path, &callback.state, 200));
        assert_eq!(fs::read_to_string(&path).unwrap(), "100\nexpected-state");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn unsolicited_replayed_and_wrong_host_callbacks_are_rejected() {
        let path = pending_path();
        let callback = parse_auth_callback(
            &tauri::Url::parse("kairo://auth-callback?code=code&state=state").unwrap(),
        )
        .unwrap();
        assert!(!consume_pending_auth_state(&path, &callback.state));

        let wrong_host = tauri::Url::parse("kairo://evil?code=code&state=state").unwrap();
        assert!(parse_auth_callback(&wrong_host).is_none());
    }

    #[test]
    fn expired_callback_state_is_rejected_and_deleted() {
        let path = pending_path();
        fs::write(&path, "100\nexpected-state").unwrap();

        assert!(!consume_pending_auth_state_at(&path, "expected-state", 700));
        assert!(!path.exists());
    }
}
