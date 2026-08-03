//! Backend proxy client. When enabled, provider calls route through the Kairo backend
//! (which holds the real provider keys and METERS the free-request quota) instead of
//! going direct to the vendor. Auth is a short-lived JWT minted from the stored session
//! (see auth.rs `fetch_jwt`). The backend forwards the exact body/form we send and returns
//! the raw provider response, so callers parse it exactly as they parse the direct call.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use crate::auth::fetch_jwt;
use crate::constants;
use crate::env::provider_env_optional;
use crate::tutor::shared_http_client;

// Mirrors `ASK_ID_HEADER` in packages/shared (Rust can't import the TS constant).
const ASK_ID_HEADER: &str = "x-kairo-ask-id";

/// True while an onboarding practice turn owns push-to-talk. Onboarding demos run PRE-sign-in
/// (value-first), so their provider calls must NEVER require a JWT or hit the credit meter — they
/// transparently route to the unauthenticated, IP-rate-limited `/v1/onboarding/*` sibling routes.
pub(crate) fn onboarding_active() -> bool {
    crate::input::ONBOARDING_PTT.load(Ordering::SeqCst)
}

/// Map an authed/metered product proxy path to its unauthenticated onboarding sibling.
/// Unknown paths pass through unchanged (borrowing the input, hence the tied lifetime).
fn onboarding_sibling(path: &str) -> &str {
    match path {
        "/v1/stt" => "/v1/onboarding/stt",
        "/v1/llm/chat" => "/v1/onboarding/gate",
        "/v1/vision/tutor" => "/v1/onboarding/vision",
        "/v1/tts/stream" => "/v1/onboarding/tts/stream",
        _ => path,
    }
}

/// Build the POST for `path`. During an onboarding practice turn, reroute to the unauthenticated
/// onboarding sibling (no JWT, no metering); otherwise a JWT-authed POST (`NoAuth` when signed out).
async fn proxy_post_builder(
    app: &AppHandle,
    path: &str,
    timeout: Duration,
) -> Result<reqwest::RequestBuilder, ProxyError> {
    if onboarding_active() {
        let sibling = onboarding_sibling(path);
        crate::klog!(
            app,
            debug,
            path = sibling,
            "onboarding turn → unauthenticated proxy route"
        );
        let url = format!("{}{}", backend_url(), sibling);
        return Ok(shared_http_client().post(&url).timeout(timeout));
    }
    authed_post(app, path, timeout).await
}

fn backend_url_for_target(target: Option<&str>) -> &'static str {
    match target {
        Some("local") => constants::KAIRO_LOCAL_BACKEND_URL,
        Some("hosted") | None => constants::KAIRO_HOSTED_BACKEND_URL,
        Some(other) => {
            crate::klog!(
                app,
                warn,
                target = other,
                "unknown backend target; using hosted"
            );
            constants::KAIRO_HOSTED_BACKEND_URL
        }
    }
}

/// The single backend URL baked into this packaged build.
pub(crate) fn backend_url() -> String {
    backend_url_for_target(option_env!("KAIRO_BACKEND_TARGET")).to_string()
}

/// WebViews use this instead of maintaining a second frontend URL.
#[tauri::command]
pub(crate) fn get_backend_url() -> String {
    backend_url()
}

/// True when provider calls should route through the backend proxy. Runtime-overridable
/// via `KAIRO_USE_BACKEND_PROXY` (no rebuild); otherwise the compiled default.
pub(crate) fn proxy_enabled() -> bool {
    match provider_env_optional("KAIRO_USE_BACKEND_PROXY") {
        Some(v) => matches!(
            v.trim().to_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        None => constants::USE_BACKEND_PROXY,
    }
}

pub(crate) enum ProxyError {
    /// No stored session / JWT mint failed — the user is signed out.
    NoAuth,
    /// A metered route returned 402 — the free-request limit is reached.
    QuotaExceeded,
    /// Network / non-2xx / parse failure.
    Failed {
        class: &'static str,
        status: Option<u16>,
    },
}

impl ProxyError {
    fn failed(class: &'static str, status: Option<u16>) -> Self {
        Self::Failed { class, status }
    }

    pub(crate) fn describe(&self) -> String {
        match self {
            ProxyError::NoAuth => "signed out (no session token)".to_string(),
            ProxyError::QuotaExceeded => "free request limit reached".to_string(),
            ProxyError::Failed {
                class,
                status: Some(status),
            } => format!("backend request failed ({class}, HTTP {status})"),
            ProxyError::Failed {
                class,
                status: None,
            } => format!("backend request failed ({class})"),
        }
    }

    pub(crate) fn class(&self) -> &'static str {
        match self {
            ProxyError::NoAuth => "auth",
            ProxyError::QuotaExceeded => "quota",
            ProxyError::Failed { class, .. } => class,
        }
    }

    pub(crate) fn status(&self) -> Option<u16> {
        match self {
            ProxyError::Failed { status, .. } => *status,
            ProxyError::NoAuth | ProxyError::QuotaExceeded => None,
        }
    }
}

pub(crate) fn request_error_class(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_decode() {
        "decode"
    } else {
        "request"
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
    let url = format!("{}{}", backend_url(), path);
    Ok(shared_http_client()
        .post(&url)
        .bearer_auth(jwt)
        .timeout(timeout))
}

/// Map a proxy response's status to a `ProxyError` (402 → QuotaExceeded), or pass it through.
async fn check_status(response: reqwest::Response) -> Result<reqwest::Response, ProxyError> {
    let status = response.status();
    if status.as_u16() == 402 {
        return Err(ProxyError::QuotaExceeded);
    }
    if !status.is_success() {
        return Err(ProxyError::failed("http", Some(status.as_u16())));
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
    let mut request = proxy_post_builder(app, path, timeout).await?.json(body);
    if let Some(id) = ask_id {
        request = request.header(ASK_ID_HEADER, id);
    }
    let response = request
        .send()
        .await
        .map_err(|error| ProxyError::failed(request_error_class(&error), None))?;
    check_status(response)
        .await?
        .json::<Value>()
        .await
        .map_err(|_| ProxyError::failed("decode", None))
}

/// GET a backend `path` as JSON with the session JWT attached.
pub(crate) async fn proxy_get_json(
    app: &AppHandle,
    path: &str,
    timeout: Duration,
) -> Result<Value, ProxyError> {
    let jwt = fetch_jwt(app).await.ok_or(ProxyError::NoAuth)?;
    let url = format!("{}{}", backend_url(), path);
    let response = shared_http_client()
        .get(&url)
        .bearer_auth(jwt)
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| ProxyError::failed(request_error_class(&error), None))?;
    check_status(response)
        .await?
        .json::<Value>()
        .await
        .map_err(|_| ProxyError::failed("decode", None))
}

/// PATCH a JSON `body` to a backend `path` (settings writes) and return the updated resource.
pub(crate) async fn proxy_patch_json(
    app: &AppHandle,
    path: &str,
    body: &Value,
    timeout: Duration,
) -> Result<Value, ProxyError> {
    let jwt = fetch_jwt(app).await.ok_or(ProxyError::NoAuth)?;
    let url = format!("{}{}", backend_url(), path);
    let response = shared_http_client()
        .patch(&url)
        .bearer_auth(jwt)
        .timeout(timeout)
        .json(body)
        .send()
        .await
        .map_err(|error| ProxyError::failed(request_error_class(&error), None))?;
    check_status(response)
        .await?
        .json::<Value>()
        .await
        .map_err(|_| ProxyError::failed("decode", None))
}

/// POST a multipart `form` (STT audio upload) and return the raw JSON response.
pub(crate) async fn proxy_post_multipart(
    app: &AppHandle,
    path: &str,
    form: reqwest::multipart::Form,
    timeout: Duration,
) -> Result<Value, ProxyError> {
    let response = proxy_post_builder(app, path, timeout)
        .await?
        .multipart(form)
        .send()
        .await
        .map_err(|error| ProxyError::failed(request_error_class(&error), None))?;
    check_status(response)
        .await?
        .json::<Value>()
        .await
        .map_err(|_| ProxyError::failed("decode", None))
}

/// POST a JSON `body` and return the streamed response (TTS stream). The caller reads
/// `.chunk()` off it exactly as it would the vendor's stream.
pub(crate) async fn proxy_stream_request(
    app: &AppHandle,
    path: &str,
    body: &Value,
    timeout: Duration,
) -> Result<reqwest::Response, ProxyError> {
    let response = proxy_post_builder(app, path, timeout)
        .await?
        .json(body)
        .send()
        .await
        .map_err(|error| ProxyError::failed(request_error_class(&error), None))?;
    check_status(response).await
}

/// Command: is the signed-in user out of free requests? The notch calls this the instant
/// push-to-talk is released, BEFORE transcribing — so a paywalled user never triggers STT /
/// gate / vision (no provider spend), and we play the cached upgrade line instead. Only
/// meaningful with the proxy on (that's where metering lives).
#[tauri::command]
pub(crate) async fn check_paywalled(app: tauri::AppHandle) -> bool {
    proxy_enabled() && !onboarding_active() && over_free_limit(&app).await
}

/// Check the user's free-request quota via `/v1/me`. Returns true when they're paywalled
/// (out of free requests and not pro). Fails OPEN (false) on any error — a check failure
/// must never block a turn.
pub(crate) async fn over_free_limit(app: &AppHandle) -> bool {
    let Some(jwt) = fetch_jwt(app).await else {
        return false;
    };
    let url = format!("{}/v1/me", backend_url());
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

/// GET `/v1/me` → the plan/usage/account JSON for the settings page + notch. null on any error.
#[tauri::command]
pub(crate) async fn fetch_me(app: AppHandle) -> Option<Value> {
    let jwt = fetch_jwt(&app).await?;
    let url = format!("{}/v1/me", backend_url());
    let response = shared_http_client()
        .get(&url)
        .bearer_auth(jwt)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().await.ok()
}

/// Open the system browser at `url` (macOS `open`, same as the OAuth flow).
fn open_in_browser(url: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|_| "billing returned an invalid URL".to_string())?;
    if parsed.scheme() != "https" {
        crate::klog!(
            app,
            error,
            scheme = parsed.scheme(),
            "refused non-HTTPS billing URL"
        );
        return Err("billing returned an unsafe URL".to_string());
    }
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to open browser: {error}"))
}

fn billing_error_message(code: &str, operation: &str) -> String {
    match code {
        "subscription_exists" => "You already have an active or pending subscription.".to_string(),
        "no_billing_subscription" => "There is no subscription to manage yet.".to_string(),
        "billing_sync_pending" => {
            "Your billing account is still syncing. Please try again in a moment.".to_string()
        }
        "provider_error" => format!("{operation} is temporarily unavailable. Please try again."),
        _ => format!("Could not {operation}. Please try again."),
    }
}

async fn billing_post(app: &AppHandle, path: &str, operation: &str) -> Result<Value, String> {
    let jwt = fetch_jwt(app)
        .await
        .ok_or_else(|| "signed out".to_string())?;
    let response = shared_http_client()
        .post(format!("{}{}", backend_url(), path))
        .bearer_auth(jwt)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| {
            crate::klog!(
                app,
                error,
                operation,
                "billing network request failed: {error}"
            );
            format!("Could not {operation}. Check your connection and try again.")
        })?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| {
        crate::klog!(
            app,
            error,
            operation,
            status = status.as_u16(),
            "billing response parse failed: {error}"
        );
        format!("Could not {operation}. The server returned an invalid response.")
    })?;
    if !status.is_success() {
        let code = body
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("billing_error");
        crate::klog!(
            app,
            warn,
            operation,
            status = status.as_u16(),
            code,
            "billing request failed"
        );
        return Err(billing_error_message(code, operation));
    }
    Ok(body)
}

/// Start a Pro checkout and open Dodo's returned HTTPS URL.
#[tauri::command]
pub(crate) async fn start_checkout(app: AppHandle) -> Result<(), String> {
    let _timer = crate::klog::timer("app", "billing_checkout");
    let body = billing_post(&app, "/v1/billing/checkout", "start checkout").await?;
    let checkout_url = body
        .get("checkout_url")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::klog!(
                app,
                error,
                "successful checkout response missing checkout_url"
            );
            "Could not start checkout. The server returned an incomplete response.".to_string()
        })?;
    crate::klog!(app, info, "billing: opening checkout in browser");
    open_in_browser(checkout_url)
}

/// Ask the backend to reconcile the local entitlement against Dodo.
#[tauri::command]
pub(crate) async fn sync_billing(app: AppHandle) -> Result<Value, String> {
    let _timer = crate::klog::timer("app", "billing_sync");
    billing_post(&app, "/v1/billing/sync", "sync billing").await
}

/// Open the Dodo customer portal (manage / cancel): POST `/v1/billing/portal` → open the url.
#[tauri::command]
pub(crate) async fn open_billing_portal(app: AppHandle) -> Result<(), String> {
    let _timer = crate::klog::timer("app", "billing_portal");
    let body = billing_post(&app, "/v1/billing/portal", "open subscription settings").await?;
    let portal_url = body.get("url").and_then(Value::as_str).ok_or_else(|| {
        crate::klog!(app, error, "successful portal response missing url");
        "Could not open subscription settings. The server returned an incomplete response."
            .to_string()
    })?;
    crate::klog!(app, info, "billing: opening customer portal in browser");
    open_in_browser(portal_url)
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
        object.insert(
            "_provider".to_string(),
            Value::String(provider_hint.to_string()),
        );
    }
    proxy_post_json(app, "/v1/vision/tutor", &body, Some(ask_id), timeout).await
}

/// The same metered vision turn, streamed. Returns the raw SSE response for the caller to read.
///
/// Deliberately a different backend route from `vision_tutor`, not a flag on it: the buffered
/// route stays untouched as the fallback for when a stream dies partway.
pub(crate) async fn vision_tutor_stream(
    app: &AppHandle,
    provider_hint: &str,
    mut body: Value,
    timeout: Duration,
) -> Result<reqwest::Response, ProxyError> {
    if let Some(object) = body.as_object_mut() {
        object.insert(
            "_provider".to_string(),
            Value::String(provider_hint.to_string()),
        );
    }
    proxy_stream_request(app, "/v1/vision/tutor/stream", &body, timeout).await
}

#[cfg(test)]
mod tests {
    use super::{backend_url_for_target, ProxyError};
    use crate::constants::{KAIRO_HOSTED_BACKEND_URL, KAIRO_LOCAL_BACKEND_URL};

    #[test]
    fn backend_target_is_centralized_and_safe_by_default() {
        assert_eq!(
            backend_url_for_target(Some("local")),
            KAIRO_LOCAL_BACKEND_URL
        );
        assert_eq!(
            backend_url_for_target(Some("hosted")),
            KAIRO_HOSTED_BACKEND_URL
        );
        assert_eq!(backend_url_for_target(None), KAIRO_HOSTED_BACKEND_URL);
        assert_eq!(
            backend_url_for_target(Some("typo")),
            KAIRO_HOSTED_BACKEND_URL
        );
    }

    #[test]
    fn billing_errors_are_actionable_instead_of_missing_field_messages() {
        assert_eq!(
            super::billing_error_message("subscription_exists", "start checkout"),
            "You already have an active or pending subscription."
        );
        assert_eq!(
            super::billing_error_message("provider_error", "start checkout"),
            "start checkout is temporarily unavailable. Please try again."
        );
    }

    #[test]
    fn proxy_errors_expose_only_class_and_status() {
        let error = ProxyError::failed("http", Some(502));

        assert_eq!(error.describe(), "backend request failed (http, HTTP 502)");
        assert_eq!(error.class(), "http");
        assert_eq!(error.status(), Some(502));
    }
}
