//! Tutor + gate turns: build the OpenRouter chat request, run the answer turn
//! (with parallel visual grounding), and the lightweight "do I need the screen?"
//! gate. Also owns the shared pooled HTTP client.

use crate::env::{provider_env, provider_env_optional, provider_timeout_ms};
use crate::grounding::{
    anthropic_vision_chat, apply_step_targets, clean_model_json, detect_click_point_openai,
    ground_visual_targets, inject_primary_box, openai_vision_chat, VisionOutcome,
};
use crate::constants;
use crate::prompts::{ack_system_prompt, build_tutor_system_prompt, gate_system_prompt};
use crate::types::{AckInput, GateInput, TutorTurnInput};
use serde_json::{json, Value};
use std::time::Duration;

fn build_annotation_summary(input: &TutorTurnInput) -> String {
    if input.annotations.is_empty() {
        return "No user annotations.".to_string();
    }

    "The screenshot includes Kairo user markup drawn over the screen. Interpret arrows by their heads, loops/circles by what they enclose, boxes by their enclosed region, underlines by the nearby text, and freehand strokes by nearby UI. Use the markup only as visual attention guidance. Do not count the marks or expose internal annotation IDs. Describe the underlying marked content, app UI, or likely user intent instead.".to_string()
}

fn build_tutor_user_prompt(input: &TutorTurnInput) -> Result<String, String> {
    let mut context = json!({
        "userQuery": input.user_query,
        "activeApp": input.active_app.active_app,
        "windowTitle": input.active_app.window_title,
        "annotationSummary": build_annotation_summary(input),
        "screen": {
            "captured": input.screen.captured,
            "reason": input.screen.reason,
            "imageMimeType": input.screen.image_mime_type,
            "byteLength": input.screen.byte_length,
            "displayBounds": input.screen.display_bounds,
            "imageGeometry": input.screen.image_geometry,
        },
    });
    // Recent conversation for continuity (a follow-up may refer to an earlier step or
    // an interrupted walkthrough). Absent on the first turn.
    if let Some(recent) = input.recent_context.as_ref().filter(|s| !s.trim().is_empty()) {
        if let Some(object) = context.as_object_mut() {
            object.insert("recentContext".to_string(), json!(recent));
        }
    }
    // The line the gate already spoke aloud this turn — the tutor continues from it.
    if let Some(intro) = input.spoken_intro.as_ref().filter(|s| !s.trim().is_empty()) {
        if let Some(object) = context.as_object_mut() {
            object.insert("spokenIntro".to_string(), json!(intro));
        }
    }
    serde_json::to_string_pretty(&context)
        .map_err(|error| format!("Failed to build tutor prompt: {error}"))
}

pub(crate) fn build_openrouter_messages(
    input: &TutorTurnInput,
    include_screenshot: bool,
) -> Result<Value, String> {
    let user_prompt = build_tutor_user_prompt(input)?;
    let system_prompt = build_tutor_system_prompt(input);

    if include_screenshot && input.screen.captured {
        if let (Some(mime_type), Some(image_base64)) =
            (&input.screen.image_mime_type, &input.screen.image_base64)
        {
            let user_content = vec![
                json!({ "type": "text", "text": user_prompt }),
                json!({
                    "type": "image_url",
                    "image_url": { "url": format!("data:{mime_type};base64,{image_base64}") },
                }),
            ];
            return Ok(json!([
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_content },
            ]));
        }
    }

    Ok(json!([
        { "role": "system", "content": system_prompt },
        { "role": "user", "content": user_prompt },
    ]))
}

pub(crate) fn build_openrouter_request_body(
    input: &TutorTurnInput,
    model: &str,
    include_screenshot: bool,
) -> Result<Value, String> {
    Ok(json!({
        "model": model,
        "messages": build_openrouter_messages(input, include_screenshot)?,
        "response_format": { "type": "json_object" },
        "temperature": 0.2,
        "max_tokens": 700,
    }))
}

pub(crate) fn select_openrouter_request_model(
    input: &TutorTurnInput,
    text_model: &str,
    vision_model: &str,
) -> (String, bool) {
    if input.screen.captured && input.screen.image_base64.is_some() {
        return (vision_model.to_string(), true);
    }

    (text_model.to_string(), false)
}

#[derive(Debug)]
struct OpenRouterChatError {
    message: String,
    retry_without_screenshot: bool,
}

impl OpenRouterChatError {
    fn new(message: String, retry_without_screenshot: bool) -> Self {
        Self {
            message,
            retry_without_screenshot,
        }
    }
}

// One pooled HTTP client shared across providers, so connections (TLS) stay
// warm instead of a cold handshake on every STT/TTS/LLM call. Per-request
// timeouts are applied at each call site.
pub(crate) fn shared_http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            // Keep provider connections warm across intermittent turns so a voice
            // turn after a lull skips the cold TCP+TLS handshake:
            // - tcp_keepalive: OS-level probes stop NAT/firewalls reaping an idle
            //   socket (and surface a dead peer instead of hanging).
            // - pool_idle_timeout 5 min: hold an idle keep-alive connection far
            //   longer than the old 90s default (the common gap between turns).
            // - pool_max_idle_per_host: cap idle sockets so memory stays trivial
            //   (~tens of KB each across 3 hosts).
            // Best-effort: a long lull or a server-side close still reconnects, but
            // rustls TLS session resumption keeps that cheap. Staying on HTTP/1.1
            // keep-alive — h2 PING keepalive would need the extra `http2` feature,
            // not worth it here.
            .tcp_keepalive(Duration::from_secs(30))
            .pool_idle_timeout(Duration::from_secs(300))
            .pool_max_idle_per_host(4)
            .build()
            .expect("failed to build shared HTTP client")
    })
}

// Reduce a base URL to `scheme://host/`, dropping any path (e.g. `/api/v1`) so the
// warm-up request is cheap and the TLS session ticket lands on the host root.
fn root_host_url(base: &str) -> String {
    match base.find("://") {
        Some(scheme_end) => {
            let after = &base[scheme_end + 3..];
            let host = after.split('/').next().unwrap_or(after);
            format!("{}://{}/", &base[..scheme_end], host)
        }
        None => base.to_string(),
    }
}

// Warm the TLS handshake to each provider host at launch so the first real request
// (gate / vision / STT / TTS) skips the cold negotiation. All four subsystems share
// `shared_http_client()`, so warming its pool benefits every path. Session tickets
// are host-scoped, so a cheap HEAD to each root is enough. Best-effort: failures are
// logged and ignored — never a hard dependency.
pub(crate) fn prewarm_http_connections() {
    for base in [
        constants::OPENROUTER_BASE_URL,
        constants::ANTHROPIC_BASE_URL,
        constants::SARVAM_BASE_URL,
        constants::OPENAI_BASE_URL,
    ] {
        let url = root_host_url(base);
        tauri::async_runtime::spawn(async move {
            let started = std::time::Instant::now();
            match shared_http_client()
                .head(&url)
                .timeout(Duration::from_secs(10))
                .send()
                .await
            {
                Ok(response) => crate::klog!(
                    app,
                    debug,
                    host = %url,
                    status = response.status().as_u16(),
                    ms = started.elapsed().as_millis() as u64,
                    "tls prewarm ok"
                ),
                Err(error) => crate::klog!(
                    app,
                    debug,
                    host = %url,
                    ms = started.elapsed().as_millis() as u64,
                    "tls prewarm failed: {error}"
                ),
            }
        });
    }
}

async fn send_openrouter_chat_request(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    app_title: &str,
    site_url: Option<&str>,
    timeout: Duration,
    body: Value,
) -> Result<String, OpenRouterChatError> {
    let mut request = client
        .post(endpoint)
        .timeout(timeout)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .header("X-OpenRouter-Title", app_title);

    if let Some(site_url) = site_url {
        request = request.header("HTTP-Referer", site_url);
    }

    let response = request.json(&body).send().await.map_err(|error| {
        OpenRouterChatError::new(format!("OpenRouter request failed: {error}"), false)
    })?;
    let status = response.status();
    let payload = response.json::<Value>().await.map_err(|error| {
        OpenRouterChatError::new(format!("OpenRouter response was not JSON: {error}"), false)
    })?;

    if !status.is_success() {
        let message = payload
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .or_else(|| payload.get("message").and_then(Value::as_str))
            .unwrap_or("OpenRouter request failed");
        return Err(OpenRouterChatError::new(message.to_string(), true));
    }

    payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| {
            OpenRouterChatError::new(
                "OpenRouter response did not include assistant content.".to_string(),
                false,
            )
        })
}

/// Spoken when the user is out of free requests.
const FREE_LIMIT_MESSAGE: &str = "You've used all your free Kairo requests. Upgrade to keep going.";

/// The turn returned when the backend meters the user out mid-vision-turn. Shaped like any
/// other tutor turn so the frontend renders + speaks it normally.
fn quota_exceeded_turn() -> String {
    json!({
        "mode": "single",
        "voiceText": FREE_LIMIT_MESSAGE,
        "steps": [{ "say": FREE_LIMIT_MESSAGE, "visualTargets": [] }],
        "awaitClick": Value::Null,
        "done": true,
    })
    .to_string()
}

/// A gate result that speaks the free-limit prompt directly: needsScreen=false → the
/// frontend voices it with NO "let me look" filler and no metered vision turn.
fn quota_gate_response() -> String {
    json!({ "needsScreen": false, "voiceText": FREE_LIMIT_MESSAGE, "skillSlug": "" }).to_string()
}

#[tauri::command]
pub(crate) async fn run_tutor_turn(
    app: tauri::AppHandle,
    mut input: TutorTurnInput,
) -> Result<String, String> {
    let _t = crate::klog::timer("tutor", "tutor_turn");
    // Unique id per ask → one metered unit (the backend's usage_event.ask_id is a uuid
    // column, so this MUST be a real UUID; it also dedupes an accidental retry).
    let ask_id = uuid::Uuid::new_v4().to_string();
    // Resolve/validate the incoming slug against the LIVE frontmost app (it may have
    // changed since the gate ran; non-gate paths send ""). Keeps skill logic in Rust.
    input.skill_slug = if constants::SKILLS_ENABLED {
        crate::skills::resolve_slug(
            &input.skill_slug,
            &input.active_app.active_app,
            input.active_app.bundle_id.as_deref().unwrap_or(""),
            input.active_app.window_title.as_deref().unwrap_or(""),
        )
    } else {
        String::new()
    };
    crate::klog!(
        tutor,
        info,
        skill = %input.skill_slug,
        app = %input.active_app.active_app,
        title = %input.active_app.window_title.as_deref().unwrap_or(""),
        "tutor turn skill resolved"
    );
    let provider = provider_env("KAIRO_AI_PROVIDER", constants::AI_PROVIDER);
    if provider != "openrouter" {
        return Err(
            "Native tutor provider is only configured for KAIRO_AI_PROVIDER=openrouter."
                .to_string(),
        );
    }

    let api_key = provider_env_optional("OPENROUTER_API_KEY").ok_or_else(|| {
        "OPENROUTER_API_KEY is required for native OpenRouter tutor turns.".to_string()
    })?;
    let model = provider_env("OPENROUTER_MODEL", constants::OPENROUTER_MODEL);
    let vision_model = provider_env_optional("OPENROUTER_VISION_MODEL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| constants::OPENROUTER_VISION_MODEL.to_string());
    let base_url = provider_env("OPENROUTER_BASE_URL", constants::OPENROUTER_BASE_URL);
    let site_url = Some(provider_env(
        "OPENROUTER_SITE_URL",
        constants::OPENROUTER_SITE_URL,
    ));
    let app_title = provider_env("OPENROUTER_APP_TITLE", constants::OPENROUTER_APP_TITLE);
    let timeout = Duration::from_millis(provider_timeout_ms(provider_env_optional(
        "OPENROUTER_REQUEST_TIMEOUT_MS",
    )));
    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let client = shared_http_client();
    let site_url_ref = site_url.as_deref();

    let has_vision = input.screen.captured && input.screen.image_base64.is_some();

    // Alternate pointing engine: when POINTING_PROVIDER="openai", OpenAI's computer-use
    // tool finds the target box while the OpenRouter vision turn writes the narration.
    // The default "claude" leaves the single-call Fable path below fully intact.
    let pointing =
        provider_env("KAIRO_POINTING_PROVIDER", constants::POINTING_PROVIDER).to_lowercase();
    let use_openai_pointing = pointing == "openai";
    crate::klog!(tutor, info, pointing = %pointing, has_vision = has_vision, "tutor turn routing");

    // DEFAULT: one Opus/Fable vision call returns the answer AND the primary target box.
    // On ANY Opus/Fable failure (no key, non-2xx, empty, missing bounds) we fall THROUGH
    // to the legacy OpenRouter answer path below — a transient hiccup must never zero
    // out the spoken answer; the user still gets an answer, grounded from any screen
    // regions the answer itself carries. Skipped when OpenAI pointing is selected.
    if has_vision && !use_openai_pointing {
        if let (Some(image_base64), Some(bounds)) = (
            input.screen.image_base64.as_ref(),
            input.screen.display_bounds.as_ref(),
        ) {
            // Which model returns the answer+box this turn: "openai" → gpt-5.6-sol
            // (OpenAI Responses), otherwise Anthropic Fable. Both return the SAME
            // { steps:[{say, box?}] } JSON, so the clean/ground/return below is
            // IDENTICAL for both — only the model call differs.
            let tutor_provider =
                provider_env("KAIRO_TUTOR_VISION_PROVIDER", constants::TUTOR_VISION_PROVIDER)
                    .to_lowercase();
            let system_prompt = build_tutor_system_prompt(&input);
            let user_text = build_tutor_user_prompt(&input)?;
            let media_type = input
                .screen
                .image_mime_type
                .as_deref()
                .unwrap_or("image/jpeg");
            let outcome = if tutor_provider == "openai" {
                let openai_model =
                    provider_env("OPENAI_TUTOR_MODEL", constants::OPENAI_TUTOR_MODEL);
                let effort =
                    provider_env("OPENAI_VISION_EFFORT", constants::OPENAI_VISION_EFFORT);
                crate::klog!(tutor, info, provider = "openai", model = %openai_model, effort = %effort, media_type = media_type, question = %crate::klog::transcript_field(&input.user_query), "single-call vision turn (answer + box)");
                openai_vision_chat(
                    &app,
                    &ask_id,
                    &system_prompt,
                    &user_text,
                    image_base64,
                    media_type,
                    &openai_model,
                    &effort,
                    timeout,
                )
                .await
            } else {
                let tutor_model =
                    provider_env("ANTHROPIC_VISION_MODEL", constants::TUTOR_VISION_MODEL);
                crate::klog!(tutor, info, provider = "anthropic", model = %tutor_model, media_type = media_type, question = %crate::klog::transcript_field(&input.user_query), "single-call vision turn (answer + box)");
                anthropic_vision_chat(
                    &app,
                    &ask_id,
                    &system_prompt,
                    &user_text,
                    image_base64,
                    media_type,
                    &tutor_model,
                    timeout,
                )
                .await
            };
            match outcome {
                VisionOutcome::Answer(raw) => {
                    // Sanitize once so the frontend always gets a clean JSON object,
                    // even if the model wrapped it in prose/fences (no json_object mode).
                    let content = clean_model_json(&raw);
                    // Map the raw { mode, steps:[{say, box?}] } into frontend-ready steps
                    // with per-step pointer + highlight targets in display points.
                    let grounded = apply_step_targets(&content, image_base64, bounds);
                    // Diagnostic: the joined spoken answer + step count, paired with the
                    // question logged above (always shown; constants::LOG_TRANSCRIPTS).
                    if let Ok(value) = serde_json::from_str::<Value>(&grounded) {
                        let answer = value.get("voiceText").and_then(Value::as_str).unwrap_or("");
                        let steps = value.get("steps").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
                        let mode = value.get("mode").and_then(Value::as_str).unwrap_or("");
                        crate::klog!(tutor, info, mode = mode, steps = steps, answer = %crate::klog::transcript_field(answer), "single-call answer");
                    }
                    return Ok(grounded);
                }
                VisionOutcome::QuotaExceeded => {
                    crate::klog!(tutor, info, "free request limit reached; returning upgrade prompt");
                    return Ok(quota_exceeded_turn());
                }
                VisionOutcome::Failed => {
                    crate::klog!(tutor, warn, "vision turn empty; falling back to OpenRouter answer");
                    // fall through to the legacy path below.
                }
            }
        } else {
            crate::klog!(tutor, warn, "single-call vision turn missing display bounds; falling back to OpenRouter answer");
            // fall through to the legacy path below.
        }
    }

    // FALLBACK (a text-only turn, or the single-call vision path above fell through):
    // the OpenRouter answer call. OpenAI pointing, when selected, still runs in parallel.
    let answer_future = async {
        let request_body = {
            let (request_model, include_screenshot) =
                select_openrouter_request_model(&input, &model, &vision_model);
            build_openrouter_request_body(&input, &request_model, include_screenshot)?
        };
        let first = send_openrouter_chat_request(
            client, &endpoint, &api_key, &app_title, site_url_ref, timeout, request_body,
        )
        .await;
        match first {
            Ok(content) => Ok(content),
            Err(error)
                if error.retry_without_screenshot
                    && input.screen.captured
                    && input.screen.image_base64.is_some() =>
            {
                crate::klog!(tutor, warn, "screenshot request failed; retrying text-only: {}", error.message);
                send_openrouter_chat_request(
                    client, &endpoint, &api_key, &app_title, site_url_ref, timeout,
                    build_openrouter_request_body(&input, &model, false)?,
                )
                .await
                .map_err(|retry_error| {
                    format!(
                        "{} Text-only retry after screenshot failure also failed: {}",
                        error.message, retry_error.message
                    )
                })
            }
            Err(error) => Err(error.message),
        }
    };
    // OpenAI pointing: one computer-use call for the click target, run in parallel
    // with the narration answer above. None → we keep the narration's own boxes.
    let openai_point_future = async {
        if !use_openai_pointing {
            return None;
        }
        let image_base64 = input.screen.image_base64.as_deref()?;
        detect_click_point_openai(image_base64, &input.user_query).await
    };
    let (answer_result, openai_point) = tokio::join!(answer_future, openai_point_future);
    let content = answer_result?;

    // OpenAI pointing path: inject OpenAI's grounded target into the narration, then
    // shape it into the SAME unified frontend turn (mode/voiceText/steps/awaitClick)
    // the default path emits, so the overlay/cursor render identically.
    if use_openai_pointing {
        if let Some(bounds) = input.screen.display_bounds.as_ref() {
            let image_ref = input.screen.image_base64.as_deref().unwrap_or("");
            let cleaned = clean_model_json(&content);
            let had_point = openai_point.is_some();
            let grounded_json = match openai_point {
                Some(nb) => inject_primary_box(&cleaned, nb),
                None => {
                    crate::klog!(tutor, warn, "openai pointing returned no point; using narration boxes");
                    cleaned
                }
            };
            let grounded = apply_step_targets(&grounded_json, image_ref, bounds);
            if let Ok(value) = serde_json::from_str::<Value>(&grounded) {
                let answer = value.get("voiceText").and_then(Value::as_str).unwrap_or("");
                let steps = value.get("steps").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
                crate::klog!(tutor, info, pointing = "openai", grounded_point = had_point, steps = steps, answer = %crate::klog::transcript_field(answer), "openai-pointing answer");
            }
            return Ok(grounded);
        }
        crate::klog!(tutor, warn, "openai pointing missing display bounds; using OpenRouter grounding");
    }

    Ok(ground_visual_targets(content, input.screen.display_bounds.as_ref()))
}

/// One-shot OpenRouter text completion (system + user) → the assistant message
/// content. Resolves the shared OpenRouter env (key, base/site URL, app title),
/// builds the request, and posts it via the pooled client. `reasoning.effort` is
/// always `none` (these are cheap, non-thinking turns on a latency-critical path);
/// `json_object` toggles the structured `response_format` the gate needs but the
/// plain-sentence ack must not carry. Shared by `run_gate_turn` + `run_ack_turn`.
async fn openrouter_text_chat(
    app: &tauri::AppHandle,
    system: &str,
    user: &str,
    model: &str,
    timeout: Duration,
    json_object: bool,
) -> Result<String, String> {
    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        // These turns are a cheap needs-screen decision / a short spoken ack;
        // thinking adds seconds for zero benefit and sits on the critical path.
        // Disable it (OpenRouter maps effort:none → Gemini's thinkingLevel off).
        "reasoning": { "effort": "none" },
    });
    // The gate parses strict JSON; the ack is a plain sentence and must NOT be
    // forced into json_object mode.
    if json_object {
        if let Some(object) = body.as_object_mut() {
            object.insert(
                "response_format".to_string(),
                json!({ "type": "json_object" }),
            );
        }
    }

    // Proxy path (unmetered): the backend forwards this to OpenRouter /chat/completions
    // and returns the raw response, so we pull the message content the same way either way.
    if crate::proxy::proxy_enabled() {
        let payload = crate::proxy::proxy_post_json(app, "/v1/llm/chat", &body, None, timeout)
            .await
            .map_err(|error| error.describe())?;
        return openrouter_message_content(&payload)
            .ok_or_else(|| "OpenRouter proxy response had no message content.".to_string());
    }

    let api_key = provider_env_optional("OPENROUTER_API_KEY")
        .ok_or_else(|| "OPENROUTER_API_KEY is required for OpenRouter text turns.".to_string())?;
    let base_url = provider_env("OPENROUTER_BASE_URL", constants::OPENROUTER_BASE_URL);
    let site_url = provider_env("OPENROUTER_SITE_URL", constants::OPENROUTER_SITE_URL);
    let app_title = provider_env("OPENROUTER_APP_TITLE", constants::OPENROUTER_APP_TITLE);
    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    send_openrouter_chat_request(
        shared_http_client(),
        &endpoint,
        &api_key,
        &app_title,
        Some(site_url.as_str()),
        timeout,
        body,
    )
    .await
    .map_err(|error| error.message)
}

/// Pull the assistant message content out of an OpenRouter/OpenAI chat-completions JSON.
fn openrouter_message_content(payload: &Value) -> Option<String> {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Keep the gate's JSON but force `skillSlug` through the registry guardrail: an
/// unknown slug or one that doesn't match the frontmost app becomes "". When the
/// model returned no slug but the frontmost app matches a pack, the fallback fills it.
fn repair_gate_skill(content: &str, app: &str, bundle: &str, title: &str) -> String {
    let Ok(mut parsed) = serde_json::from_str::<Value>(content) else {
        return content.to_string();
    };
    if !constants::SKILLS_ENABLED {
        parsed["skillSlug"] = json!("");
        return parsed.to_string();
    }
    let picked = parsed
        .get("skillSlug")
        .and_then(Value::as_str)
        .unwrap_or("");
    let clean = crate::skills::resolve_slug(picked, app, bundle, title);
    parsed["skillSlug"] = json!(clean);
    parsed.to_string()
}

#[tauri::command]
pub(crate) async fn run_gate_turn(
    app_handle: tauri::AppHandle,
    input: GateInput,
) -> Result<String, String> {
    let _t = crate::klog::timer("gate", "gate_turn");
    // Safe default when no text provider is configured: always look (the full vision
    // turn then runs), so behaviour degrades to the pre-gate flow.
    let look = || json!({ "needsScreen": true, "voiceText": "", "skillSlug": "" }).to_string();

    if provider_env("KAIRO_AI_PROVIDER", constants::AI_PROVIDER) != "openrouter" {
        return Ok(look());
    }
    // No-key short-circuit: return look() silently. In proxy mode the backend holds the
    // key, so only short-circuit when NOT proxying (otherwise the gate runs via the proxy).
    if !crate::proxy::proxy_enabled() && provider_env_optional("OPENROUTER_API_KEY").is_none() {
        return Ok(look());
    }
    let model = provider_env("OPENROUTER_MODEL", constants::OPENROUTER_MODEL);
    let timeout = Duration::from_millis(constants::GATE_TIMEOUT_MS);

    let app = input.active_app.unwrap_or_else(|| "unknown".to_string());
    let bundle = input.bundle_id.unwrap_or_default();
    let title = input.window_title.unwrap_or_default();
    // L1: give the model the list of skill packs so it can also route a skillSlug.
    let skills_block = if constants::SKILLS_ENABLED {
        crate::skills::metadata_block()
    } else {
        String::new()
    };
    // Unified turn (RU5): recent turn-triples (continuity) + a "pointer on screen"
    // hint (mid-guide → bias needsScreen). Both are optional context lines.
    let history_line = match input.history.as_deref().map(str::trim) {
        Some(h) if !h.is_empty() => format!("\nrecentHistory:\n{h}"),
        _ => String::new(),
    };
    let pointer_line = if input.pointer_pending {
        "\nA guide pointer is currently on screen, waiting for the user to click it."
    } else {
        ""
    };
    let user_message = format!(
        "Active app: {app}\nWindow title: {title}{history_line}{pointer_line}\nUser question (spoken): \"{}\"",
        input.user_query
    );
    // Diagnostic: pair the exact question the gate saw with its answer (the "gate
    // result" line below; always shown, constants::LOG_TRANSCRIPTS).
    crate::klog!(
        gate,
        info,
        model = %model,
        app = %app,
        title = %title,
        question = %crate::klog::transcript_field(&input.user_query),
        "gate turn"
    );

    let system = gate_system_prompt(&skills_block);
    // Run the paywall check in parallel with the gate so it adds no latency: if the gate
    // decides this ask needs a (metered) screen turn AND the user is out of free requests,
    // speak the upgrade prompt directly — no "let me look" filler, no wasted vision call.
    let quota_check =
        async { crate::proxy::proxy_enabled() && crate::proxy::over_free_limit(&app_handle).await };
    let gate_call =
        openrouter_text_chat(&app_handle, &system, &user_message, &model, timeout, true);
    let (gate_result, paywalled) = tokio::join!(gate_call, quota_check);
    // Out of free requests → answer ANY ask with the upgrade prompt (no gate answer, no
    // filler, no vision). Checked in parallel with the gate so it adds no latency.
    if paywalled {
        crate::klog!(gate, info, "over free limit; upgrade prompt (no answer/vision)");
        return Ok(quota_gate_response());
    }
    match gate_result {
        Ok(content) => {
            let repaired = repair_gate_skill(&content, &app, &bundle, &title);
            crate::klog!(
                gate,
                debug,
                "gate result: {}",
                repaired.chars().take(200).collect::<String>()
            );
            Ok(repaired)
        }
        Err(error) => {
            crate::klog!(gate, warn, "turn failed; defaulting to look: {}", error);
            Ok(look())
        }
    }
}

/// The cheap text-only ack spoken immediately after a valid click, while the
/// vision model plans the next step. Screen-blind by design. MUST NEVER block the
/// guide: on ANY failure it returns "" (the frontend simply skips speaking it).
#[tauri::command]
pub(crate) async fn run_ack_turn(
    app_handle: tauri::AppHandle,
    input: AckInput,
) -> Result<String, String> {
    let _t = crate::klog::timer("follow", "run_ack_turn");
    let system = ack_system_prompt();
    let user = format!("Completed action: {}", input.completed_step);
    let timeout = Duration::from_millis(constants::ACK_TIMEOUT_MS);
    // Plain sentence → no json_object. `.unwrap_or_default()` → "" on any failure.
    let text = openrouter_text_chat(&app_handle, &system, &user, constants::ACK_MODEL, timeout, false)
        .await
        .unwrap_or_default();
    let text = text.trim().to_string();
    crate::klog!(follow, info, len = text.len(), "ack ready");
    Ok(text)
}

#[cfg(test)]
mod tests {
    #[test]
    fn repair_gate_skill_drops_wrong_app_and_fills_match() {
        // Model picked the Figma pack but frontmost app is Blender → dropped.
        let out = super::repair_gate_skill(
            "{\"needsScreen\":true,\"voiceText\":\"\",\"skillSlug\":\"figma-first-animation\"}",
            "Blender",
            "org.blender",
            "Blender",
        );
        assert!(out.contains("\"skillSlug\":\"\""));
        // Model returned no slug but app is Figma → fallback fills it.
        let out2 = super::repair_gate_skill(
            "{\"needsScreen\":true,\"voiceText\":\"\",\"skillSlug\":\"\"}",
            "Figma",
            "com.figma.Desktop",
            "Untitled – Figma",
        );
        assert!(out2.contains("figma-first-animation"));
    }
}
