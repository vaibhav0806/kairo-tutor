//! Backend proxy client. When enabled, the vision answer+box turn routes through the
//! Kairo backend (which holds the real provider keys and METERS the free-request quota)
//! instead of going direct to the vendor. Auth is a short-lived JWT minted from the
//! stored session (see auth.rs `fetch_jwt`). The backend forwards the exact body we send
//! and returns the raw provider JSON, so callers parse the response unchanged.

use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use crate::auth::fetch_jwt;
use crate::constants;
use crate::env::provider_env_optional;
use crate::tutor::shared_http_client;

// Mirrors `ASK_ID_HEADER` in packages/shared (Rust can't import the TS constant).
const ASK_ID_HEADER: &str = "x-kairo-ask-id";

/// True when provider calls should route through the backend proxy. Runtime-overridable
/// via `KAIRO_USE_BACKEND_PROXY` (no rebuild); otherwise the compiled default.
pub(crate) fn proxy_enabled() -> bool {
    match provider_env_optional("KAIRO_USE_BACKEND_PROXY") {
        Some(v) => matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        None => constants::USE_BACKEND_PROXY,
    }
}

pub(crate) enum ProxyError {
    /// No stored session / JWT mint failed — the user is signed out.
    NoAuth,
    /// The metered route returned 402 — the free-request limit is reached.
    QuotaExceeded,
    /// Network / non-2xx / parse failure.
    Failed(String),
}

impl ProxyError {
    pub(crate) fn describe(&self) -> String {
        match self {
            ProxyError::NoAuth => "signed out (no session token)".to_string(),
            ProxyError::QuotaExceeded => "free request limit reached".to_string(),
            ProxyError::Failed(message) => message.clone(),
        }
    }
}

/// POST `body` to the metered `/v1/vision/tutor` route with a fresh JWT + ask-id, adding
/// the `_provider` routing hint the backend uses to pick the vendor endpoint. Returns the
/// raw provider JSON the backend forwards back (parsed by the caller exactly as the direct
/// response would be). `provider_hint` is `"anthropic"` or `"openai"`.
pub(crate) async fn vision_tutor(
    app: &AppHandle,
    ask_id: &str,
    provider_hint: &str,
    mut body: Value,
    timeout: Duration,
) -> Result<Value, ProxyError> {
    if let Some(object) = body.as_object_mut() {
        object.insert("_provider".to_string(), Value::String(provider_hint.to_string()));
    }
    proxy_post_json(app, "/v1/vision/tutor", &body, Some(ask_id), timeout).await
}

/// POST a JSON `body` to a backend proxy `path`, authed with a fresh JWT. `ask_id`
/// (metered routes only) dedupes retries so one ask counts as one unit. Returns the raw
/// JSON the backend returns.
async fn proxy_post_json(
    app: &AppHandle,
    path: &str,
    body: &Value,
    ask_id: Option<&str>,
    timeout: Duration,
) -> Result<Value, ProxyError> {
    let jwt = fetch_jwt(app).await.ok_or(ProxyError::NoAuth)?;
    let url = format!("{}{}", constants::KAIRO_BACKEND_URL, path);
    let mut request = shared_http_client()
        .post(&url)
        .bearer_auth(jwt)
        .timeout(timeout)
        .json(body);
    if let Some(id) = ask_id {
        request = request.header(ASK_ID_HEADER, id);
    }
    let response = request
        .send()
        .await
        .map_err(|error| ProxyError::Failed(format!("network: {error}")))?;
    let status = response.status();
    if status.as_u16() == 402 {
        return Err(ProxyError::QuotaExceeded);
    }
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(ProxyError::Failed(format!(
            "{status}: {}",
            text.chars().take(220).collect::<String>()
        )));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| ProxyError::Failed(format!("parse: {error}")))
}
