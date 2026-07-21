//! Vision provider calls: the single-call answer+box turns (Anthropic Fable /
//! OpenAI Responses) and the OpenAI computer-use pointing turn. Each fails loud —
//! it logs + times the round-trip and returns None on any non-2xx or empty body.

use crate::constants;
use crate::env::{provider_env, provider_env_optional};
use crate::tutor::shared_http_client;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::AppHandle;

/// Result of the single-call vision turn. `Answer` carries the raw model content (the
/// caller cleans + grounds it); `QuotaExceeded` means the backend proxy metered the user
/// out (free limit reached) → the caller surfaces an upgrade prompt; `Failed` is any
/// other error → the caller falls through to the OpenRouter answer path.
pub(crate) enum VisionOutcome {
    Answer(String),
    QuotaExceeded,
    Failed,
}

fn grounding_timeout() -> Duration {
    Duration::from_millis(constants::GROUNDING_TIMEOUT_MS)
}

/// Anthropic Messages call with a system prompt, one user text block, and one
/// image. Returns the assistant's text (JSON expected via the prompt — Anthropic
/// has no json_object mode, so callers parse defensively with `clean_model_json`).
/// Fails loud: logs + times the round-trip and returns `None` on any non-2xx or
/// empty body so the caller can degrade gracefully.
pub(crate) async fn anthropic_vision_chat(
    app: &AppHandle,
    ask_id: &str,
    system: &str,
    user_text: &str,
    image_base64: &str,
    media_type: &str,
    model: &str,
    timeout: Duration,
) -> VisionOutcome {
    let body = json!({
        "model": model,
        "max_tokens": constants::ANTHROPIC_VISION_MAX_TOKENS,
        "output_config": { "effort": constants::ANTHROPIC_VISION_EFFORT },
        "system": system,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": user_text },
                { "type": "image", "source": {
                    "type": "base64", "media_type": media_type, "data": image_base64
                }}
            ]
        }]
    });
    let _t = crate::klog::timer("grounding", "opus_vision_chat");

    // Proxy path (metered): the backend forwards this exact body to Anthropic and hands
    // back the raw response, so the parsing below is identical to the direct path.
    let payload = if crate::proxy::proxy_enabled() {
        match crate::proxy::vision_tutor(app, ask_id, "anthropic", body, timeout).await {
            Ok(payload) => payload,
            Err(crate::proxy::ProxyError::QuotaExceeded) => return VisionOutcome::QuotaExceeded,
            Err(error) => {
                crate::klog!(grounding, warn, model = %model, "vision chat via proxy failed: {}", error.describe());
                return VisionOutcome::Failed;
            }
        }
    } else {
        let Some(api_key) =
            provider_env_optional("ANTHROPIC_API_KEY").filter(|key| !key.trim().is_empty())
        else {
            crate::klog!(grounding, warn, "vision chat: ANTHROPIC_API_KEY empty");
            return VisionOutcome::Failed;
        };
        let base_url = provider_env("ANTHROPIC_BASE_URL", constants::ANTHROPIC_BASE_URL);
        let response = match shared_http_client()
            .post(format!("{}/v1/messages", base_url.trim_end_matches('/')))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .timeout(timeout)
            .json(&body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                crate::klog!(grounding, warn, model = %model, "vision chat request failed: {error}");
                return VisionOutcome::Failed;
            }
        };
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            crate::klog!(grounding, warn, status = %status, model = %model, "vision chat failed: {}", body.chars().take(220).collect::<String>());
            return VisionOutcome::Failed;
        }
        match response.json::<Value>().await {
            Ok(payload) => payload,
            Err(error) => {
                crate::klog!(grounding, warn, model = %model, "vision chat parse failed: {error}");
                return VisionOutcome::Failed;
            }
        }
    };

    if payload.get("stop_reason").and_then(Value::as_str) == Some("max_tokens") {
        crate::klog!(grounding, warn, model = %model, "vision response truncated at max_tokens");
    }
    // Concatenate every text block (Anthropic can split output across blocks).
    let text = payload
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        crate::klog!(grounding, warn, model = %model, "vision chat returned no text");
        return VisionOutcome::Failed;
    }
    crate::klog!(grounding, info, model = %model, chars = text.len(), "vision chat ok");
    VisionOutcome::Answer(text)
}

/// OpenAI Responses call with a system prompt, one user text block, and one image,
/// for the single-call answer+box tutor turn (the OpenAI mirror of
/// `anthropic_vision_chat`). Posts to `/v1/responses` with Bearer auth and
/// `reasoning.effort`, and sends the screenshot AS-IS (no further downscale — the
/// capture pipeline already sized it, same as the Anthropic path). Returns the
/// assistant's concatenated `output_text` (JSON expected via the prompt — callers
/// parse defensively with `clean_model_json`). Fails loud: logs + times the
/// round-trip and returns `None` on any non-2xx or empty body so the caller falls
/// through to the OpenRouter answer path.
pub(crate) async fn openai_vision_chat(
    app: &AppHandle,
    ask_id: &str,
    system_prompt: &str,
    user_text: &str,
    image_base64: &str,
    media_type: &str,
    model: &str,
    effort: &str,
    timeout: Duration,
) -> VisionOutcome {
    let data_url = format!("data:{media_type};base64,{image_base64}");
    // gpt-5.6-sol rejects reasoning.effort:"minimal" (valid: none|low|medium|high|xhigh).
    let body = json!({
        "model": model,
        "reasoning": { "effort": effort },
        "instructions": system_prompt,
        "input": [{
            "role": "user",
            "content": [
                { "type": "input_text", "text": user_text },
                { "type": "input_image", "image_url": data_url }
            ]
        }],
        "max_output_tokens": constants::ANTHROPIC_VISION_MAX_TOKENS,
    });
    crate::klog!(tutor, info, provider = "openai", model = %model, effort = %effort, "openai vision (answer+box) request");
    let _t = crate::klog::timer("tutor", "openai_vision");

    // Proxy path (metered): the backend forwards this body to OpenAI's /v1/responses and
    // hands back the raw response, so the parsing below is identical to the direct path.
    let payload = if crate::proxy::proxy_enabled() {
        match crate::proxy::vision_tutor(app, ask_id, "openai", body, timeout).await {
            Ok(payload) => payload,
            Err(crate::proxy::ProxyError::QuotaExceeded) => return VisionOutcome::QuotaExceeded,
            Err(error) => {
                crate::klog!(tutor, warn, provider = "openai", model = %model, "openai vision via proxy failed: {}", error.describe());
                return VisionOutcome::Failed;
            }
        }
    } else {
        let Some(api_key) =
            provider_env_optional("OPENAI_API_KEY").filter(|key| !key.trim().is_empty())
        else {
            crate::klog!(tutor, warn, provider = "openai", "vision chat: OPENAI_API_KEY empty");
            return VisionOutcome::Failed;
        };
        let base_url = provider_env("OPENAI_BASE_URL", constants::OPENAI_BASE_URL);
        let response = match shared_http_client()
            .post(format!("{}/v1/responses", base_url.trim_end_matches('/')))
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .timeout(timeout)
            .json(&body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                crate::klog!(tutor, warn, provider = "openai", model = %model, "openai vision request failed: {error}");
                return VisionOutcome::Failed;
            }
        };
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            crate::klog!(tutor, warn, provider = "openai", status = %status, model = %model, "openai vision failed: {}", body.chars().take(240).collect::<String>());
            return VisionOutcome::Failed;
        }
        match response.json::<Value>().await {
            Ok(payload) => payload,
            Err(error) => {
                crate::klog!(tutor, warn, provider = "openai", model = %model, "openai vision parse failed: {error}");
                return VisionOutcome::Failed;
            }
        }
    };
    // Responses shape: output[] holds items; the assistant text lives in the item
    // with type=="message", whose content[] carries {type:"output_text", text}.
    let text = payload
        .get("output")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        })
        .and_then(|item| item.get("content").and_then(Value::as_array))
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("output_text"))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        crate::klog!(tutor, warn, provider = "openai", model = %model, "openai vision returned no text");
        return VisionOutcome::Failed;
    }
    // Token usage for cost/latency tracking (never the content itself).
    let usage = payload.get("usage");
    let input_tokens = usage
        .and_then(|u| u.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let total_tokens = usage
        .and_then(|u| u.get("total_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    crate::klog!(
        tutor,
        info,
        provider = "openai",
        model = %model,
        input_tokens = input_tokens,
        output_tokens = output_tokens,
        total_tokens = total_tokens,
        chars = text.len(),
        "openai vision chat ok"
    );
    VisionOutcome::Answer(text)
}

// Any OpenAI-compatible chat/completions vision endpoint (OpenRouter, Alibaba
// DashScope, etc.). The caller resolves base_url/key/model per provider; here we
// just POST the image + prompt and return the model's raw text. Used for the
// Run ONE turn of OpenAI's built-in computer-use loop to locate the single control
// the user should act on, and return it as a normalized [x1,y1,x2,y2] box (fractions
// 0..1 of the screenshot). This is the alternate pointing engine (POINTING_PROVIDER=
// "openai"): we send the resized screenshot + the ask, take the model's FIRST click
// action's (x, y), and synthesize a small square target around it. We never execute
// the click — Kairo points, the user acts. Returns None on any failure (no key,
// non-2xx, no click action) so the caller degrades to the narration's own boxes.
pub(crate) async fn detect_click_point_openai(
    image_base64: &str,
    user_query: &str,
) -> Option<[f64; 4]> {
    let _t = crate::klog::timer("grounding", "openai_point");
    let api_key = provider_env_optional("OPENAI_API_KEY")?;
    if api_key.trim().is_empty() {
        crate::klog!(grounding, warn, provider = "openai", "OPENAI_API_KEY empty; no OpenAI pointing");
        return None;
    }
    let model = provider_env("OPENAI_COMPUTER_USE_MODEL", constants::OPENAI_COMPUTER_USE_MODEL);
    let base_url = provider_env("OPENAI_BASE_URL", constants::OPENAI_BASE_URL);
    // Same reasoning effort as the Claude path (defaults to ANTHROPIC_VISION_EFFORT).
    let effort = provider_env("OPENAI_VISION_EFFORT", constants::OPENAI_VISION_EFFORT);
    let timeout = grounding_timeout();
    let max_edge = provider_env_optional("KAIRO_VISION_MAX_EDGE")
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|v| *v >= 256)
        .unwrap_or(constants::VISION_MAX_EDGE);

    // Downscale aspect-preserving (longest edge <= max_edge). computer-use returns
    // click coords in THIS resized pixel space; we normalize by (rw, rh).
    use base64::Engine;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(image_base64) else {
        crate::klog!(grounding, warn, provider = "openai", "failed to decode screenshot base64");
        return None;
    };
    let Ok(image) = image::load_from_memory(&bytes) else {
        crate::klog!(grounding, warn, provider = "openai", bytes = bytes.len(), "failed to load screenshot image");
        return None;
    };
    let (ow, oh) = (image.width(), image.height());
    if ow == 0 || oh == 0 {
        return None;
    }
    let long = ow.max(oh);
    let scale = if long > max_edge {
        max_edge as f64 / long as f64
    } else {
        1.0
    };
    let rw = ((ow as f64 * scale).round() as u32).max(1);
    let rh = ((oh as f64 * scale).round() as u32).max(1);
    let resized = image.resize_exact(rw, rh, image::imageops::FilterType::Triangle);
    let mut out = std::io::Cursor::new(Vec::new());
    if resized
        .to_rgb8()
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .is_err()
    {
        crate::klog!(grounding, warn, provider = "openai", resized = %format!("{rw}x{rh}"), "failed to encode resized image");
        return None;
    }
    let resized_base64 = base64::engine::general_purpose::STANDARD.encode(out.into_inner());
    let data_url = format!("data:image/jpeg;base64,{resized_base64}");

    let instruction = format!(
        "You are viewing the user's screen, a {rw}x{rh} pixel image (origin top-left, x right, y down). The user asked: \"{user_query}\". Identify the SINGLE control they should click or look at, and click it — exactly once, on the precise control, not a nearby heading, label, tooltip, or large region. Do not type or take any other action. Ignore Kairo's own notch, answer card, purple labels, and cursor."
    );

    // ONE built-in computer-use turn: seed the current screenshot so the model can
    // click immediately (no screenshot round-trip). We read only its first action.
    let body = json!({
        "model": model,
        "tools": [{ "type": "computer" }],
        // Mirror the Claude path's effort knob (Anthropic sends output_config.effort;
        // OpenAI's equivalent is reasoning.effort).
        "reasoning": { "effort": effort },
        "input": [{
            "role": "user",
            "content": [
                { "type": "input_text", "text": instruction },
                { "type": "input_image", "image_url": data_url },
            ],
        }],
    });

    crate::klog!(
        grounding,
        debug,
        provider = "openai",
        model = %model,
        effort = %effort,
        resized = %format!("{rw}x{rh}"),
        max_edge = max_edge,
        timeout_ms = timeout.as_millis(),
        query_len = user_query.len(),
        "openai computer-use request"
    );

    let response = match shared_http_client()
        .post(format!("{}/v1/responses", base_url.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .timeout(timeout)
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            crate::klog!(grounding, warn, provider = "openai", model = %model, "computer-use request failed: {error}");
            return None;
        }
    };
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        crate::klog!(grounding, warn, provider = "openai", status = %status, model = %model, "computer-use failed: {}", text.chars().take(240).collect::<String>());
        return None;
    }
    let payload = response.json::<Value>().await.ok()?;
    let Some((cx, cy)) = extract_openai_click_point(&payload) else {
        crate::klog!(grounding, warn, provider = "openai", model = %model, "no click action in computer-use response");
        return None;
    };

    // Normalize the click center, then grow a small square target around it (in pixel
    // space, so it stays visually square regardless of the screen's aspect ratio).
    let ncx = (cx / rw as f64).clamp(0.0, 1.0);
    let ncy = (cy / rh as f64).clamp(0.0, 1.0);
    let half_px = (constants::OPENAI_POINT_BOX_HALF_FRAC * rw.max(rh) as f64).max(6.0);
    let half_nx = half_px / rw as f64;
    let half_ny = half_px / rh as f64;
    let nx1 = (ncx - half_nx).clamp(0.0, 1.0);
    let ny1 = (ncy - half_ny).clamp(0.0, 1.0);
    let nx2 = (ncx + half_nx).clamp(0.0, 1.0);
    let ny2 = (ncy + half_ny).clamp(0.0, 1.0);
    if nx2 <= nx1 || ny2 <= ny1 {
        crate::klog!(grounding, warn, provider = "openai", "degenerate box around click point");
        return None;
    }
    crate::klog!(
        grounding,
        info,
        provider = "openai",
        model = %model,
        click_px = %format!("[{cx:.0},{cy:.0}]"),
        resized = %format!("{rw}x{rh}"),
        norm_box = %format!("[{nx1:.4},{ny1:.4},{nx2:.4},{ny2:.4}]"),
        "openai click point grounded"
    );
    Some([nx1, ny1, nx2, ny2])
}

// Pull the first positional (x, y) out of an OpenAI Responses computer-use payload.
// Scans `output[]` for a `computer_call` item and reads its first action carrying
// numeric x + y. Tolerates both the newer `actions:[...]` array and the classic
// single `action:{...}` object. Returns None when the model returned no click (e.g.
// it asked for a screenshot first, or nothing was relevant).
fn extract_openai_click_point(payload: &Value) -> Option<(f64, f64)> {
    let output = payload.get("output").and_then(Value::as_array)?;
    for item in output {
        if item.get("type").and_then(Value::as_str) != Some("computer_call") {
            continue;
        }
        let actions: Vec<&Value> = match item.get("actions").and_then(Value::as_array) {
            Some(array) => array.iter().collect(),
            None => item.get("action").into_iter().collect(),
        };
        for action in actions {
            if let (Some(x), Some(y)) = (
                action.get("x").and_then(Value::as_f64),
                action.get("y").and_then(Value::as_f64),
            ) {
                return Some((x, y));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::extract_openai_click_point;
    use serde_json::json;

    #[test]
    fn extracts_click_from_actions_array() {
        let payload = json!({
            "output": [
                { "type": "reasoning", "summary": [] },
                { "type": "computer_call", "call_id": "c1", "actions": [
                    { "type": "click", "x": 405, "y": 157, "button": "left" }
                ]},
            ]
        });
        assert_eq!(extract_openai_click_point(&payload), Some((405.0, 157.0)));
    }

    #[test]
    fn extracts_click_from_singular_action() {
        let payload = json!({
            "output": [
                { "type": "computer_call", "call_id": "c1", "action": { "type": "click", "x": 12, "y": 34 } },
            ]
        });
        assert_eq!(extract_openai_click_point(&payload), Some((12.0, 34.0)));
    }

    #[test]
    fn skips_actions_without_coordinates() {
        // A screenshot-first action (no x/y) must be skipped in favour of the click.
        let payload = json!({
            "output": [
                { "type": "computer_call", "actions": [
                    { "type": "screenshot" },
                    { "type": "click", "x": 7, "y": 9 }
                ]},
            ]
        });
        assert_eq!(extract_openai_click_point(&payload), Some((7.0, 9.0)));
    }

    #[test]
    fn returns_none_when_no_computer_call() {
        let payload = json!({ "output": [ { "type": "message", "content": [] } ] });
        assert_eq!(extract_openai_click_point(&payload), None);
    }
}
