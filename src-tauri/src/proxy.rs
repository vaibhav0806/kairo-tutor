//! Backend proxy client. When enabled, provider calls route through the Kairo backend
//! (which holds the real provider keys and METERS the free-request quota) instead of
//! going direct to the vendor. Auth is a short-lived JWT minted from the stored session
//! (see auth.rs `fetch_jwt`). The backend forwards the exact body/form we send and returns
//! the raw provider response, so callers parse it exactly as they parse the direct call.

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
    /// A metered route returned 402 — the free-request limit is reached.
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

/// A JWT-authed POST to a backend proxy `path`. The caller attaches the body/multipart
/// and sends it. Errors with `NoAuth` when signed out.
async fn authed_post(
    app: &AppHandle,
    path: &str,
    timeout: Duration,
) -> Result<reqwest::RequestBuilder, ProxyError> {
    let jwt = fetch_jwt(app).await.ok_or(ProxyError::NoAuth)?;
    let url = format!("{}{}", constants::KAIRO_BACKEND_URL, path);
    Ok(shared_http_client().post(&url).bearer_auth(jwt).timeout(timeout))
}

/// Map a proxy response's status to a `ProxyError` (402 → QuotaExceeded), or pass it through.
async fn check_status(response: reqwest::Response) -> Result<reqwest::Response, ProxyError> {
    let status = response.status();
    if status.as_u16() == 402 {
        return Err(ProxyError::QuotaExceeded);
    }
    if !status.is_success() {
        // Keep a generous slice so the real provider/backend error is fully stored in the
        // Kairo log (the backend now surfaces the underlying message).
        let text = response.text().await.unwrap_or_default();
        return Err(ProxyError::Failed(format!(
            "{status}: {}",
            text.chars().take(600).collect::<String>()
        )));
    }
    Ok(response)
}

/// POST a JSON `body` and return the raw JSON the backend forwards back. `ask_id` (metered
/// routes only) dedupes retries so one ask counts as one unit.
pub(crate) async fn proxy_post_json(
    app: &AppHandle,
    path: &str,
    body: &Value,
    ask_id: Option<&str>,
    timeout: Duration,
) -> Result<Value, ProxyError> {
    let mut request = authed_post(app, path, timeout).await?.json(body);
    if let Some(id) = ask_id {
        request = request.header(ASK_ID_HEADER, id);
    }
    let response = request
        .send()
        .await
        .map_err(|error| ProxyError::Failed(format!("network: {error}")))?;
    check_status(response)
        .await?
        .json::<Value>()
        .await
        .map_err(|error| ProxyError::Failed(format!("parse: {error}")))
}

/// POST a multipart `form` (STT audio upload) and return the raw JSON response.
pub(crate) async fn proxy_post_multipart(
    app: &AppHandle,
    path: &str,
    form: reqwest::multipart::Form,
    timeout: Duration,
) -> Result<Value, ProxyError> {
    let response = authed_post(app, path, timeout)
        .await?
        .multipart(form)
        .send()
        .await
        .map_err(|error| ProxyError::Failed(format!("network: {error}")))?;
    check_status(response)
        .await?
        .json::<Value>()
        .await
        .map_err(|error| ProxyError::Failed(format!("parse: {error}")))
}

/// POST a JSON `body` and return the streamed response (TTS stream). The caller reads
/// `.chunk()` off it exactly as it would the vendor's stream.
pub(crate) async fn proxy_stream_request(
    app: &AppHandle,
    path: &str,
    body: &Value,
    timeout: Duration,
) -> Result<reqwest::Response, ProxyError> {
    let response = authed_post(app, path, timeout)
        .await?
        .json(body)
        .send()
        .await
        .map_err(|error| ProxyError::Failed(format!("network: {error}")))?;
    check_status(response).await
}

/// Check the user's free-request quota via `/v1/me`. Returns true when they're paywalled
/// (out of free requests and not pro). Fails OPEN (false) on any error — a check failure
/// must never block a turn.
pub(crate) async fn over_free_limit(app: &AppHandle) -> bool {
    let Some(jwt) = fetch_jwt(app).await else {
        return false;
    };
    let url = format!("{}/v1/me", constants::KAIRO_BACKEND_URL);
    let response = match shared_http_client()
        .get(&url)
        .bearer_auth(jwt)
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        _ => return false,
    };
    response
        .json::<Value>()
        .await
        .ok()
        .and_then(|me| me.get("paywalled").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// POST the vision answer+box body to the metered `/v1/vision/tutor` route, adding the
/// `_provider` routing hint (`"anthropic"` | `"openai"`). Returns the raw provider JSON.
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
