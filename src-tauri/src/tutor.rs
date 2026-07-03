//! Tutor + gate turns: build the OpenRouter chat request, run the answer turn
//! (with parallel visual grounding), and the lightweight "do I need the screen?"
//! gate. Also owns the shared pooled HTTP client.

use crate::env::{provider_env, provider_env_optional, provider_timeout_ms};
use crate::grounding::{
    anthropic_vision_chat, apply_box_targets, boxes_from_content, clean_model_json,
    detect_element_boxes, ground_visual_targets,
};
use crate::ocr::{build_screen_elements_block, ocr_tutor_screenshot};
use crate::prompts::{build_tutor_system_prompt, gate_system_prompt};
use crate::types::{GateInput, OcrElement, TutorTurnInput};
use crate::{DEFAULT_OPENROUTER_VISION_MODEL, DEFAULT_TUTOR_VISION_MODEL};
use serde_json::{json, Value};
use std::time::Duration;

fn build_annotation_summary(input: &TutorTurnInput) -> String {
    if input.annotations.is_empty() {
        return "No user annotations.".to_string();
    }

    "The screenshot includes Kairo user markup drawn over the screen. Interpret arrows by their heads, loops/circles by what they enclose, boxes by their enclosed region, underlines by the nearby text, and freehand strokes by nearby UI. Use the markup only as visual attention guidance. Do not count the marks or expose internal annotation IDs. Describe the underlying marked content, app UI, or likely user intent instead.".to_string()
}

fn build_tutor_user_prompt(input: &TutorTurnInput) -> Result<String, String> {
    serde_json::to_string_pretty(&json!({
        "userQuery": input.user_query,
        "activeApp": input.active_app,
        "annotationSummary": build_annotation_summary(input),
        "screen": {
            "captured": input.screen.captured,
            "reason": input.screen.reason,
            "imageMimeType": input.screen.image_mime_type,
            "byteLength": input.screen.byte_length,
            "displayBounds": input.screen.display_bounds,
            "imageGeometry": input.screen.image_geometry,
        },
        "skillLandmarks": input.skill.landmarks,
    }))
    .map_err(|error| format!("Failed to build tutor prompt: {error}"))
}

pub(crate) fn build_openrouter_messages(
    input: &TutorTurnInput,
    include_screenshot: bool,
    elements: &[OcrElement],
) -> Result<Value, String> {
    let user_prompt = build_tutor_user_prompt(input)?;
    let system_prompt = build_tutor_system_prompt(input);
    let elements_block = build_screen_elements_block(elements);

    if include_screenshot && input.screen.captured {
        if let (Some(mime_type), Some(image_base64)) =
            (&input.screen.image_mime_type, &input.screen.image_base64)
        {
            let mut user_content = vec![json!({ "type": "text", "text": user_prompt })];
            if !elements_block.is_empty() {
                user_content.push(json!({ "type": "text", "text": elements_block }));
            }
            user_content.push(json!({
                "type": "image_url",
                "image_url": { "url": format!("data:{mime_type};base64,{image_base64}") },
            }));
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
    elements: &[OcrElement],
) -> Result<Value, String> {
    Ok(json!({
        "model": model,
        "messages": build_openrouter_messages(input, include_screenshot, elements)?,
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
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("failed to build shared HTTP client")
    })
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

#[tauri::command]
pub(crate) async fn run_tutor_turn(input: TutorTurnInput) -> Result<String, String> {
    let _t = crate::klog::timer("tutor", "tutor_turn");
    let provider = provider_env("KAIRO_AI_PROVIDER", "mock");
    if provider != "openrouter" {
        return Err(
            "Native tutor provider is only configured for KAIRO_AI_PROVIDER=openrouter."
                .to_string(),
        );
    }

    let api_key = provider_env_optional("OPENROUTER_API_KEY").ok_or_else(|| {
        "OPENROUTER_API_KEY is required for native OpenRouter tutor turns.".to_string()
    })?;
    let model = provider_env("OPENROUTER_MODEL", "~openai/gpt-latest");
    let vision_model = provider_env_optional("OPENROUTER_VISION_MODEL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_OPENROUTER_VISION_MODEL.to_string());
    let base_url = provider_env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
    let site_url = provider_env_optional("OPENROUTER_SITE_URL");
    let app_title = provider_env("OPENROUTER_APP_TITLE", "Kairo Tutor");
    let timeout = Duration::from_millis(provider_timeout_ms(provider_env_optional(
        "OPENROUTER_REQUEST_TIMEOUT_MS",
    )));
    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    // OCR the screenshot (fast, local) for the Set-of-Mark fallback and for
    // snapping the Computer Use point onto a tight text box.
    let ocr_elements = ocr_tutor_screenshot(&input);

    let client = shared_http_client();
    let site_url_ref = site_url.as_deref();

    let separate_grounding = provider_env("KAIRO_SEPARATE_GROUNDING", "false")
        .trim()
        .eq_ignore_ascii_case("true");
    let has_vision = input.screen.captured && input.screen.image_base64.is_some();

    // DEFAULT: one Opus vision call returns the answer AND the primary target box.
    // On ANY Opus failure (no key, non-2xx, empty, missing bounds) we fall THROUGH
    // to the legacy OpenRouter answer path below — a transient hiccup must never
    // zero out the spoken answer; the user still gets an answer, grounded via OCR.
    if has_vision && !separate_grounding {
        if let (Some(image_base64), Some(bounds)) = (
            input.screen.image_base64.as_ref(),
            input.screen.display_bounds.as_ref(),
        ) {
            let tutor_model = provider_env("ANTHROPIC_VISION_MODEL", DEFAULT_TUTOR_VISION_MODEL);
            let system_prompt = build_tutor_system_prompt(&input);
            let user_prompt = build_tutor_user_prompt(&input)?;
            let elements_block = build_screen_elements_block(&ocr_elements);
            let user_text = if elements_block.is_empty() {
                user_prompt
            } else {
                format!("{user_prompt}\n\n{elements_block}")
            };
            let media_type = input
                .screen
                .image_mime_type
                .as_deref()
                .unwrap_or("image/jpeg");
            crate::klog!(tutor, info, model = %tutor_model, media_type = media_type, question = %crate::klog::transcript_field(&input.user_query), "single-call vision turn (answer + box)");
            match anthropic_vision_chat(
                &system_prompt,
                &user_text,
                image_base64,
                media_type,
                &tutor_model,
                timeout,
            )
            .await
            {
                Some(raw) => {
                    // Sanitize once so the frontend always gets a clean JSON object,
                    // even if Opus wrapped it in prose/fences (no json_object mode).
                    let content = clean_model_json(&raw);
                    // Diagnostic: the exact spoken answer, paired with the question
                    // logged above. Text shown only under KAIRO_LOG_TRANSCRIPTS.
                    if let Some(voice) = serde_json::from_str::<Value>(&content)
                        .ok()
                        .as_ref()
                        .and_then(|value| value.get("voiceText"))
                        .and_then(Value::as_str)
                    {
                        crate::klog!(tutor, info, answer = %crate::klog::transcript_field(voice), "single-call answer");
                    }
                    let detected = boxes_from_content(&content, image_base64);
                    return Ok(if detected.is_empty() {
                        // No explicit box (e.g. text-only target) — ground the model's
                        // own elementId/screenRegion targets via OCR.
                        crate::klog!(tutor, info, "single-call: no box in response; OCR-grounding model targets");
                        ground_visual_targets(content, &ocr_elements, Some(bounds))
                    } else {
                        apply_box_targets(content, &detected, bounds)
                    });
                }
                None => {
                    crate::klog!(tutor, warn, "opus vision turn empty; falling back to OpenRouter answer");
                    // fall through to the legacy path below.
                }
            }
        } else {
            crate::klog!(tutor, warn, "single-call vision turn missing display bounds; falling back to OpenRouter answer");
            // fall through to the legacy path below.
        }
    }

    // LEGACY (KAIRO_SEPARATE_GROUNDING=true, or a text-only turn): the OpenRouter
    // answer call, plus — for vision — the separate grounding call in parallel.
    let answer_future = async {
        let request_body = {
            let (request_model, include_screenshot) =
                select_openrouter_request_model(&input, &model, &vision_model);
            build_openrouter_request_body(&input, &request_model, include_screenshot, &ocr_elements)?
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
                    build_openrouter_request_body(&input, &model, false, &[])?,
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
    let boxes_future = async {
        if !has_vision || !separate_grounding {
            return Vec::new();
        }
        let (Some(image_base64), Some(bounds)) =
            (&input.screen.image_base64, &input.screen.display_bounds)
        else {
            return Vec::new();
        };
        detect_element_boxes(image_base64, bounds, &input.user_query, &ocr_elements).await
    };
    let (answer_result, detected_boxes) = tokio::join!(answer_future, boxes_future);
    let content = answer_result?;
    match (detected_boxes.is_empty(), input.screen.display_bounds.as_ref()) {
        (false, Some(bounds)) => Ok(apply_box_targets(content, &detected_boxes, bounds)),
        _ => Ok(ground_visual_targets(content, &ocr_elements, input.screen.display_bounds.as_ref())),
    }
}

#[tauri::command]
pub(crate) async fn run_gate_turn(input: GateInput) -> Result<String, String> {
    let _t = crate::klog::timer("gate", "gate_turn");
    // Safe default when no text provider is configured: always look (the full vision
    // turn then runs), so behaviour degrades to the pre-gate flow.
    let look = || json!({ "needsScreen": true, "voiceText": "" }).to_string();

    if provider_env("KAIRO_AI_PROVIDER", "mock") != "openrouter" {
        return Ok(look());
    }
    let Some(api_key) = provider_env_optional("OPENROUTER_API_KEY") else {
        return Ok(look());
    };
    let model = provider_env("OPENROUTER_MODEL", "~openai/gpt-latest");
    let base_url = provider_env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
    let site_url = provider_env_optional("OPENROUTER_SITE_URL");
    let app_title = provider_env("OPENROUTER_APP_TITLE", "Kairo Tutor");
    let timeout = Duration::from_millis(
        provider_env_optional("OPENROUTER_GATE_TIMEOUT_MS")
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(3_500),
    );
    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let app = input.active_app.unwrap_or_else(|| "unknown".to_string());
    let title = input.window_title.unwrap_or_default();
    let url = input.url.unwrap_or_default();
    let user_message = format!(
        "Active app: {app}\nWindow title: {title}\nPage URL: {url}\nUser question (spoken): \"{}\"",
        input.user_query
    );
    // Diagnostic: pair the exact question the gate saw with its answer (the "gate
    // result" line below). Text shown only under KAIRO_LOG_TRANSCRIPTS.
    crate::klog!(
        gate,
        info,
        model = %model,
        app = %app,
        question = %crate::klog::transcript_field(&input.user_query),
        "gate turn"
    );
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": gate_system_prompt() },
            { "role": "user", "content": user_message },
        ],
        "response_format": { "type": "json_object" },
    });

    match send_openrouter_chat_request(
        shared_http_client(),
        &endpoint,
        &api_key,
        &app_title,
        site_url.as_deref(),
        timeout,
        body,
    )
    .await
    {
        Ok(content) => {
            crate::klog!(
                gate,
                debug,
                "gate result: {}",
                content.chars().take(200).collect::<String>()
            );
            Ok(content)
        }
        Err(error) => {
            crate::klog!(
                gate,
                warn,
                "turn failed; defaulting to look: {}",
                error.message
            );
            Ok(look())
        }
    }
}
