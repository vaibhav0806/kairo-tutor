//! Vision-based element grounding: ask a vision model for target boxes, map them
//! back to display points, and reconcile the model's visual targets with real
//! OCR/box regions.

use crate::color::{sample_background, vibrant_accent};
use crate::constants;
use crate::env::{provider_env, provider_env_optional};
use crate::ocr::build_box_locator_context;
use crate::prompts::box_locator_prompt;
use crate::tutor::shared_http_client;
use crate::types::{DetectedBox, OcrElement, OverlayDisplayBounds, ScreenRegion};
use serde_json::{json, Value};
use std::time::Duration;

// Ask the grounding provider for the target boxes as raw JSON text. Both providers
// receive the SAME prompt + resized JPEG and return the same {"elements":[...]}
// shape, so the caller parses one format regardless of which provider ran.
fn grounding_timeout() -> Duration {
    Duration::from_millis(constants::GROUNDING_TIMEOUT_MS)
}

async fn anthropic_vision_text(
    prompt: &str,
    image_jpeg_base64: &str,
    timeout: Duration,
) -> Option<String> {
    let api_key = provider_env_optional("ANTHROPIC_API_KEY")?;
    if api_key.trim().is_empty() {
        return None;
    }
    let model = provider_env("ANTHROPIC_VISION_MODEL", constants::ANTHROPIC_VISION_MODEL);
    let base_url = provider_env("ANTHROPIC_BASE_URL", constants::ANTHROPIC_BASE_URL);
    let body = json!({
        "model": model,
        "max_tokens": constants::ANTHROPIC_VISION_MAX_TOKENS,
        "output_config": { "effort": constants::ANTHROPIC_VISION_EFFORT },
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": image_jpeg_base64 } },
                { "type": "text", "text": prompt },
            ],
        }],
    });
    let response = shared_http_client()
        .post(format!("{}/v1/messages", base_url.trim_end_matches('/')))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .timeout(timeout)
        .json(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        crate::klog!(grounding, warn, provider = "anthropic", status = %status, "vision request failed: {}", text.chars().take(220).collect::<String>());
        return None;
    }
    let payload = response.json::<Value>().await.ok()?;
    // Text block(s) hold the JSON — concatenate them.
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
    Some(text)
}

/// Anthropic Messages call with a system prompt, one user text block, and one
/// image. Returns the assistant's text (JSON expected via the prompt — Anthropic
/// has no json_object mode, so callers parse defensively with `clean_model_json`).
/// Fails loud: logs + times the round-trip and returns `None` on any non-2xx or
/// empty body so the caller can degrade gracefully.
pub(crate) async fn anthropic_vision_chat(
    system: &str,
    user_text: &str,
    image_base64: &str,
    media_type: &str,
    model: &str,
    timeout: Duration,
) -> Option<String> {
    let api_key = provider_env_optional("ANTHROPIC_API_KEY")?;
    if api_key.trim().is_empty() {
        crate::klog!(grounding, warn, "vision chat: ANTHROPIC_API_KEY empty");
        return None;
    }
    let base_url = provider_env("ANTHROPIC_BASE_URL", constants::ANTHROPIC_BASE_URL);
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
            return None;
        }
    };
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        crate::klog!(grounding, warn, status = %status, model = %model, "vision chat failed: {}", body.chars().take(220).collect::<String>());
        return None;
    }
    let payload = response.json::<Value>().await.ok()?;
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
        return None;
    }
    crate::klog!(grounding, info, model = %model, chars = text.len(), "vision chat ok");
    Some(text)
}

// Any OpenAI-compatible chat/completions vision endpoint (OpenRouter, Alibaba
// DashScope, etc.). The caller resolves base_url/key/model per provider; here we
// just POST the image + prompt and return the model's raw text. Used for the
// cheap Qwen grounding path (qwen3.7-plus etc.) via the user's existing key.
async fn openai_compatible_vision_text(
    base_url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    image_jpeg_base64: &str,
    timeout: Duration,
) -> Option<String> {
    let data_url = format!("data:image/jpeg;base64,{image_jpeg_base64}");
    let body = json!({
        "model": model,
        "max_tokens": constants::OPENROUTER_VISION_MAX_TOKENS,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": data_url } },
                { "type": "text", "text": prompt },
            ],
        }],
    });
    let response = shared_http_client()
        .post(format!(
            "{}/chat/completions",
            base_url.trim_end_matches('/')
        ))
        .header("Authorization", format!("Bearer {api_key}"))
        // OpenRouter attribution headers; harmlessly ignored by other hosts.
        .header("HTTP-Referer", "https://kairo.tutor")
        .header("X-Title", "Kairo Tutor")
        .timeout(timeout)
        .json(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        crate::klog!(grounding, warn, provider = "openai_compatible", status = %status, "vision request failed: {}", text.chars().take(220).collect::<String>());
        return None;
    }
    let payload = response.json::<Value>().await.ok()?;
    let text = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(text)
}

// Locate the on-screen elements the user is asking about by asking a vision model
// for bounding boxes. This is a normal messages request (NOT the computer tool):
// Claude vision returns multiple [x1,y1,x2,y2] pixel boxes + captions in one
// call, which we draw as labeled rectangles. Works on ANY app/OS (icons,
// Blender, diagrams). Returns the most relevant element first; empty when
// nothing is relevant / no key.
pub(crate) async fn detect_element_boxes(
    image_base64: &str,
    bounds: &OverlayDisplayBounds,
    user_query: &str,
    ocr_elements: &[OcrElement],
) -> Vec<DetectedBox> {
    // Swappable at runtime (no rebuild) via KAIRO_GROUNDING_PROVIDER: `anthropic`
    // (Opus/Fable, default), `openrouter` (qwen3.7-plus via the user's OpenRouter key,
    // ~12x cheaper), or `qwen` (direct DashScope). All share this prompt + image.
    let _t = crate::klog::timer("grounding", "detect_boxes");
    let provider = provider_env("KAIRO_GROUNDING_PROVIDER", constants::GROUNDING_PROVIDER).to_lowercase();
    let timeout = grounding_timeout();
    let max_edge = provider_env_optional("KAIRO_VISION_MAX_EDGE")
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|v| *v >= 256)
        .unwrap_or(constants::VISION_MAX_EDGE);
    let bounds_summary = format!(
        "x={:.1} y={:.1} w={:.1} h={:.1} scale={:.3}",
        bounds.x, bounds.y, bounds.width, bounds.height, bounds.scale_factor
    );

    // Downscale aspect-preserving so the longest edge <= max_edge. Claude returns
    // pixel boxes in THIS resized space; we normalize by (rw, rh) and map back.
    use base64::Engine;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(image_base64) else {
        crate::klog!(grounding, warn, provider = %provider, "failed to decode screenshot base64");
        return Vec::new();
    };
    let Ok(image) = image::load_from_memory(&bytes) else {
        crate::klog!(grounding, warn, provider = %provider, bytes = bytes.len(), "failed to load screenshot image");
        return Vec::new();
    };
    let (ow, oh) = (image.width(), image.height());
    if ow == 0 || oh == 0 {
        return Vec::new();
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
    // Keep the RGB buffer around to sample box backgrounds for the accent colour.
    let rgb = resized.to_rgb8();
    let mut out = std::io::Cursor::new(Vec::new());
    if rgb.write_to(&mut out, image::ImageFormat::Jpeg).is_err() {
        crate::klog!(grounding, warn, provider = %provider, original = %format!("{ow}x{oh}"), resized = %format!("{rw}x{rh}"), "failed to encode resized grounding image");
        return Vec::new();
    }
    let resized_base64 = base64::engine::general_purpose::STANDARD.encode(out.into_inner());

    let prompt = box_locator_prompt(user_query, rw, rh, &build_box_locator_context(ocr_elements));

    let (model, text) = match provider.as_str() {
        // Cheap Qwen grounding via the user's existing OpenRouter key.
        "openrouter" | "open-router" => match provider_env_optional("OPENROUTER_API_KEY") {
            Some(key) if !key.trim().is_empty() => {
                let base = provider_env("OPENROUTER_BASE_URL", constants::OPENROUTER_BASE_URL);
                let model = provider_env("KAIRO_GROUNDING_MODEL", constants::OPENROUTER_GROUNDING_MODEL);
                let text = openai_compatible_vision_text(
                    &base,
                    &key,
                    &model,
                    &prompt,
                    &resized_base64,
                    timeout,
                )
                .await;
                (model, text)
            }
            _ => ("missing-openrouter-key".to_string(), None),
        },
        // Direct Alibaba DashScope (needs a DashScope key, which some regions can't get).
        "qwen" | "qwen3" | "dashscope" | "alibaba" => {
            match provider_env_optional("DASHSCOPE_API_KEY")
                .or_else(|| provider_env_optional("QWEN_API_KEY"))
            {
                Some(key) if !key.trim().is_empty() => {
                    let base = provider_env("QWEN_BASE_URL", constants::QWEN_BASE_URL);
                    let model = provider_env("QWEN_VISION_MODEL", constants::QWEN_VISION_MODEL);
                    let text = openai_compatible_vision_text(
                        &base,
                        &key,
                        &model,
                        &prompt,
                        &resized_base64,
                        timeout,
                    )
                    .await;
                    (model, text)
                }
                _ => ("missing-qwen-key".to_string(), None),
            }
        }
        _ => {
            let model = provider_env("ANTHROPIC_VISION_MODEL", constants::ANTHROPIC_VISION_MODEL);
            let text = anthropic_vision_text(&prompt, &resized_base64, timeout).await;
            (model, text)
        }
    };
    crate::klog!(
        grounding,
        debug,
        provider = %provider,
        model = %model,
        original = %format!("{ow}x{oh}"),
        resized = %format!("{rw}x{rh}"),
        max_edge = max_edge,
        timeout_ms = timeout.as_millis(),
        bounds = %bounds_summary,
        ocr_count = ocr_elements.len(),
        query_len = user_query.len(),
        "grounding request metadata"
    );
    let Some(text) = text else {
        crate::klog!(grounding, warn, provider = %provider, model = %model, "grounding provider returned no text");
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(json_body(&text)) else {
        crate::klog!(grounding, warn, provider = %provider, model = %model, text_len = text.len(), "failed to parse grounding JSON");
        return Vec::new();
    };
    let Some(elements) = parsed.get("elements").and_then(Value::as_array) else {
        crate::klog!(grounding, warn, provider = %provider, model = %model, "grounding JSON missing elements array");
        return Vec::new();
    };

    let mut boxes = Vec::new();
    for element in elements {
        let label = element
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let Some(coords) = element.get("box").and_then(Value::as_array) else {
            continue;
        };
        let nums: Vec<f64> = coords.iter().filter_map(Value::as_f64).collect();
        if nums.len() != 4 {
            continue;
        }
        let (mut x1, mut y1, mut x2, mut y2) = (nums[0], nums[1], nums[2], nums[3]);
        if x2 < x1 {
            std::mem::swap(&mut x1, &mut x2);
        }
        if y2 < y1 {
            std::mem::swap(&mut y1, &mut y2);
        }
        let nx1 = (x1 / rw as f64).clamp(0.0, 1.0);
        let ny1 = (y1 / rh as f64).clamp(0.0, 1.0);
        let nx2 = (x2 / rw as f64).clamp(0.0, 1.0);
        let ny2 = (y2 / rh as f64).clamp(0.0, 1.0);
        if nx2 <= nx1 || ny2 <= ny1 {
            continue;
        }
        crate::klog!(
            grounding,
            debug,
            label = %label,
            model_px = %format!("[{x1:.1},{y1:.1},{x2:.1},{y2:.1}]"),
            norm = %format!("[{nx1:.4},{ny1:.4},{nx2:.4},{ny2:.4}]"),
            resized = %format!("{rw}x{rh}"),
            "grounding model box"
        );
        // Derive a vibrant accent from the pixels surrounding the box (in resized
        // space) so the highlight pops against whatever is behind it.
        let bx1 = (nx1 * rw as f64) as u32;
        let by1 = (ny1 * rh as f64) as u32;
        let bx2 = (nx2 * rw as f64) as u32;
        let by2 = (ny2 * rh as f64) as u32;
        let (ar, ag, ab) = sample_background(&rgb, bx1, by1, bx2, by2);
        let color = vibrant_accent(ar, ag, ab);
        boxes.push(DetectedBox {
            norm_x1: nx1,
            norm_y1: ny1,
            norm_x2: nx2,
            norm_y2: ny2,
            label,
            color,
        });
        // We draw exactly one box (the single most relevant element).
        if boxes.len() >= 1 {
            break;
        }
    }

    let summary: Vec<String> = boxes
        .iter()
        .map(|b| {
            format!(
                "\"{}\" [{:.3},{:.3},{:.3},{:.3}]",
                b.label, b.norm_x1, b.norm_y1, b.norm_x2, b.norm_y2
            )
        })
        .collect();
    crate::klog!(
        grounding,
        info,
        provider = %provider,
        model = %model,
        count = boxes.len(),
        elements = %summary.join(", "),
        "element boxes detected"
    );

    boxes
}

// Strip a leading/trailing ```json ... ``` markdown fence if the model wrapped
// its JSON in one (it sometimes does despite response_format json_object). Without
// this the native parse bails and ungrounded targets leak to the frontend.
fn json_body(content: &str) -> &str {
    let trimmed = content.trim();
    if !trimmed.starts_with("```") {
        return trimmed;
    }
    let inner = trimmed.trim_start_matches('`');
    let inner = inner.strip_prefix("json").unwrap_or(inner);
    inner.trim_matches(|c: char| c == '`' || c.is_whitespace())
}

// Return the first balanced JSON object substring (from the first `{` to its
// matching `}`), ignoring braces inside strings. Anthropic has no json_object
// mode, so Opus/Fable can prepend prose ("Here's the guidance:\n{...}") or add trailing
// text; this recovers the object so serde parses and the frontend never receives
// non-JSON. Returns the input unchanged when no balanced object is found (callers
// still attempt to parse). Brace/quote/backslash are all ASCII, so byte scanning
// is safe on UTF-8 (multibyte continuation bytes are >= 0x80 and never collide).
fn extract_json_object(content: &str) -> &str {
    let bytes = content.as_bytes();
    let Some(start) = content.find('{') else {
        return content;
    };
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;
    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
            }
        } else {
            match c {
                b'"' => in_string = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &content[start..=i];
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    content
}

// Strip a code fence then extract the first balanced JSON object, so callers hand
// a clean object to serde/the frontend even when the model wraps its JSON in prose
// or trailing text. Idempotent on already-clean JSON.
pub(crate) fn clean_model_json(content: &str) -> String {
    extract_json_object(json_body(content)).to_string()
}

fn display_point_bounds(bounds: &OverlayDisplayBounds) -> (f64, f64, f64, f64) {
    (
        bounds.x,
        bounds.y,
        bounds.x + bounds.width,
        bounds.y + bounds.height,
    )
}

fn padded_screen_region(
    region: &ScreenRegion,
    bounds: Option<&OverlayDisplayBounds>,
    pad_pct: f64,
    pad_min_px: f64,
    pad_max_px: f64,
) -> ScreenRegion {
    let x1 = region.x;
    let y1 = region.y;
    let x2 = region.x + region.width.max(0.0);
    let y2 = region.y + region.height.max(0.0);
    let pad_x = (pad_pct * (x2 - x1))
        .max(pad_min_px)
        .min(pad_max_px.max(pad_min_px));
    let pad_y = (pad_pct * (y2 - y1))
        .max(pad_min_px)
        .min(pad_max_px.max(pad_min_px));

    let (min_x, min_y, max_x, max_y) =
        bounds
            .map(display_point_bounds)
            .unwrap_or((0.0, 0.0, f64::INFINITY, f64::INFINITY));

    let px1 = (x1 - pad_x).max(min_x);
    let py1 = (y1 - pad_y).max(min_y);
    let px2 = (x2 + pad_x).min(max_x);
    let py2 = (y2 + pad_y).min(max_y);

    ScreenRegion {
        x: px1,
        y: py1,
        width: (px2 - px1).max(0.0),
        height: (py2 - py1).max(0.0),
    }
}

fn env_f64(name: &str, fallback: f64) -> f64 {
    provider_env_optional(name)
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| *value >= 0.0)
        .unwrap_or(fallback)
}

fn highlight_padding(region: &ScreenRegion) -> (f64, f64, f64, f64) {
    let base_pct = env_f64("KAIRO_BOX_PAD_PCT", 0.08);
    let min_px = env_f64("KAIRO_BOX_PAD_MIN_PX", 6.0);
    let max_px = env_f64("KAIRO_BOX_PAD_MAX_PX", 24.0);

    if region.width > region.height.max(1.0) * 6.0 {
        let x_pct = env_f64("KAIRO_WIDE_BOX_PAD_X_PCT", 0.015);
        let y_pct = env_f64("KAIRO_WIDE_BOX_PAD_Y_PCT", 0.18);
        let x_max = env_f64("KAIRO_WIDE_BOX_PAD_X_MAX_PX", 16.0);
        let y_max = env_f64("KAIRO_WIDE_BOX_PAD_Y_MAX_PX", 10.0);
        return (x_pct, y_pct, x_max.max(min_px), y_max.max(min_px));
    }

    (base_pct, base_pct, max_px.max(min_px), max_px.max(min_px))
}

// Replace the model's visualTargets with the grounded boxes: one labeled
// `highlight_box` rectangle per detected element, plus a single `pointer` placed
// at the center of the primary (first) detected element so the companion cursor
// flies to Claude's actual pixel target. The boxes are the ground truth; the
// model's own targets (OCR elementIds) are discarded.
pub(crate) fn apply_box_targets(
    content: String,
    boxes: &[DetectedBox],
    bounds: &OverlayDisplayBounds,
) -> String {
    let Ok(mut parsed) = serde_json::from_str::<Value>(json_body(&content)) else {
        return content;
    };

    // Display extent in display points — final AI regions use the same coordinate
    // space as the overlay/cursor WebViews.
    let (min_x, min_y, max_x, max_y) = display_point_bounds(bounds);

    // A detected box → raw (x, y, width, height) in display points, clamped to the
    // display. The companion pointer uses this exact center so padding never
    // introduces a visual offset from the model's selected element.
    let raw_rect = |b: &DetectedBox| -> (f64, f64, f64, f64) {
        let x1 = (bounds.x + b.norm_x1 * bounds.width).clamp(min_x, max_x);
        let y1 = (bounds.y + b.norm_y1 * bounds.height).clamp(min_y, max_y);
        let x2 = (bounds.x + b.norm_x2 * bounds.width).clamp(min_x, max_x);
        let y2 = (bounds.y + b.norm_y2 * bounds.height).clamp(min_y, max_y);
        (x1, y1, (x2 - x1).max(0.0), (y2 - y1).max(0.0))
    };

    // A detected box → padded (x, y, width, height) in display points, clamped to
    // the display. This is only for the drawn highlight breathing room.
    let padded_rect = |b: &DetectedBox| -> (f64, f64, f64, f64) {
        let (x1, y1, w, h) = raw_rect(b);
        let x2 = x1 + w;
        let y2 = y1 + h;
        let raw_region = ScreenRegion {
            x: x1,
            y: y1,
            width: w,
            height: h,
        };
        let (pad_x_pct, pad_y_pct, pad_x_max, pad_y_max) = highlight_padding(&raw_region);
        let min_px = env_f64("KAIRO_BOX_PAD_MIN_PX", 6.0);
        let pad_x = (pad_x_pct * (x2 - x1)).max(min_px).min(pad_x_max);
        let pad_y = (pad_y_pct * (y2 - y1)).max(min_px).min(pad_y_max);
        let px1 = (x1 - pad_x).max(min_x);
        let py1 = (y1 - pad_y).max(min_y);
        let px2 = (x2 + pad_x).min(max_x);
        let py2 = (y2 + pad_y).min(max_y);
        (px1, py1, (px2 - px1).max(0.0), (py2 - py1).max(0.0))
    };

    let mut targets: Vec<Value> = Vec::new();

    // Primary box (first = most relevant) → companion cursor at the exact center
    // of Claude's detected element. The highlight may be padded, but the cursor
    // should point at the actual control/object the model selected.
    if let Some(primary) = boxes.first() {
        let (x, y, w, h) = raw_rect(primary);
        let center_x = x + w / 2.0;
        let center_y = y + h / 2.0;
        let marker_px = 44.0;
        crate::klog!(
            grounding,
            debug,
            label = %primary.label,
            raw = %format!("[{x:.1},{y:.1},{w:.1},{h:.1}]"),
            center = %format!("[{center_x:.1},{center_y:.1}]"),
            marker_px = marker_px,
            scale = bounds.scale_factor,
            "mapped pointer target"
        );
        targets.push(json!({
            "kind": "pointer",
            "targetId": "vision-primary",
            "label": primary.label,
            "confidence": 0.95,
            "color": primary.color,
            "screenRegion": {
                "x": center_x - marker_px / 2.0,
                "y": center_y - marker_px / 2.0,
                "width": marker_px,
                "height": marker_px,
            },
        }));
    }

    // Every box → a labeled, padded highlight rectangle drawn in the overlay.
    for (index, b) in boxes.iter().enumerate() {
        let (rx, ry, rw, rh) = raw_rect(b);
        let (x, y, w, h) = padded_rect(b);
        let raw_region = ScreenRegion {
            x: rx,
            y: ry,
            width: rw,
            height: rh,
        };
        let (pad_x_pct, pad_y_pct, pad_x_max, pad_y_max) = highlight_padding(&raw_region);
        crate::klog!(
            grounding,
            debug,
            index = index,
            label = %b.label,
            raw = %format!("[{rx:.1},{ry:.1},{rw:.1},{rh:.1}]"),
            padded = %format!("[{x:.1},{y:.1},{w:.1},{h:.1}]"),
            pad_x_pct = pad_x_pct,
            pad_y_pct = pad_y_pct,
            pad_x_max = pad_x_max,
            pad_y_max = pad_y_max,
            "mapped highlight target"
        );
        targets.push(json!({
            "kind": "highlight_box",
            "targetId": format!("vision-box-{index}"),
            "label": b.label,
            "confidence": 0.9,
            "color": b.color,
            "screenRegion": {
                "x": x,
                "y": y,
                "width": w,
                "height": h,
            },
        }));
    }

    if let Some(object) = parsed.as_object_mut() {
        object.insert("visualTargets".to_string(), Value::Array(targets));
    }
    serde_json::to_string(&parsed).unwrap_or(content)
}

// Replace each model-chosen visualTarget's elementId with the real OCR region for
// that element. Targets whose elementId doesn't match a detected element are
// dropped (we can't ground them), which keeps highlights accurate. The model
// never produces coordinates — they come from OCR.
pub(crate) fn ground_visual_targets(
    content: String,
    elements: &[OcrElement],
    bounds: Option<&OverlayDisplayBounds>,
) -> String {
    let Ok(mut parsed) = serde_json::from_str::<Value>(json_body(&content)) else {
        return content;
    };
    let Some(raw_targets) = parsed
        .get("visualTargets")
        .and_then(Value::as_array)
        .cloned()
    else {
        return content;
    };

    let mut grounded: Vec<Value> = Vec::new();
    for (index, target) in raw_targets.iter().enumerate() {
        let direct_region = target.get("screenRegion").and_then(Value::as_object);
        if let Some(region) = direct_region {
            let coords = (
                region.get("x").and_then(Value::as_f64),
                region.get("y").and_then(Value::as_f64),
                region.get("width").and_then(Value::as_f64),
                region.get("height").and_then(Value::as_f64),
            );
            if let (Some(x), Some(y), Some(width), Some(height)) = coords {
                if width > 0.0 && height > 0.0 {
                    let kind = match target.get("kind").and_then(Value::as_str) {
                        Some(k @ ("pointer" | "highlight_box")) => k,
                        _ => "highlight_box",
                    };
                    let label = target
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or("Suggested target");
                    let target_id = target
                        .get("targetId")
                        .or_else(|| target.get("target_id"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("provider-target-{}", index + 1));
                    let confidence = target
                        .get("confidence")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.7);
                    let color = target.get("color").and_then(Value::as_str);
                    let mut screen_region = ScreenRegion {
                        x,
                        y,
                        width,
                        height,
                    };
                    if kind == "highlight_box" {
                        screen_region =
                            padded_screen_region(&screen_region, bounds, 0.08, 6.0, 24.0);
                    }
                    crate::klog!(
                        grounding,
                        debug,
                        kind = kind,
                        label = %label,
                        source = "provider-screen-region",
                        mapped = %format!("[{:.1},{:.1},{:.1},{:.1}]", screen_region.x, screen_region.y, screen_region.width, screen_region.height),
                        "grounded visual target"
                    );
                    let mut value = json!({
                        "kind": kind,
                        "targetId": target_id,
                        "label": label,
                        "confidence": confidence,
                        "screenRegion": {
                            "x": screen_region.x,
                            "y": screen_region.y,
                            "width": screen_region.width,
                            "height": screen_region.height,
                        },
                    });
                    if let (Some(object), Some(color)) = (value.as_object_mut(), color) {
                        object.insert("color".to_string(), Value::String(color.to_string()));
                    }
                    grounded.push(value);
                    continue;
                }
            }
        }

        let element_id = target
            .get("elementId")
            .or_else(|| target.get("targetElementId"))
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
            });
        let Some(element_id) = element_id else {
            continue;
        };
        let Some(element) = elements.iter().find(|e| e.id as u64 == element_id) else {
            continue;
        };
        let kind = match target.get("kind").and_then(Value::as_str) {
            Some(
                k @ ("pointer" | "highlight_box" | "arrow" | "underline" | "spotlight"
                | "ghost_cursor"),
            ) => k,
            _ => "highlight_box",
        };
        let label = target
            .get("label")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| element.text.clone());
        let confidence = target
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.9);
        let screen_region = if matches!(kind, "highlight_box" | "spotlight") {
            padded_screen_region(&element.region, bounds, 0.08, 6.0, 24.0)
        } else if kind == "underline" {
            padded_screen_region(&element.region, bounds, 0.12, 5.0, 16.0)
        } else {
            element.region.clone()
        };
        grounded.push(json!({
            "kind": kind,
            "targetId": format!("element-{element_id}"),
            "label": label,
            "confidence": confidence,
            "screenRegion": {
                "x": screen_region.x,
                "y": screen_region.y,
                "width": screen_region.width,
                "height": screen_region.height,
            },
        }));
    }

    if let Some(object) = parsed.as_object_mut() {
        object.insert("visualTargets".to_string(), Value::Array(grounded));
    }
    serde_json::to_string(&parsed).unwrap_or(content)
}

// Pure: parse the tutor JSON and return (label, [nx1,ny1,nx2,ny2]) for the FIRST
// target carrying a valid normalized box. Kept separate from image sampling so it
// is unit-testable without a screenshot.
// Parse a normalized [x1,y1,x2,y2] box (fractions 0..1, x2>x1, y2>y1) from a JSON
// value, or None if it isn't a valid box.
fn parse_norm_box(value: Option<&Value>) -> Option<[f64; 4]> {
    let arr = value?.as_array()?;
    if arr.len() != 4 {
        return None;
    }
    let v: Vec<f64> = arr.iter().filter_map(Value::as_f64).collect();
    if v.len() != 4 {
        return None;
    }
    let [x1, y1, x2, y2] = [v[0], v[1], v[2], v[3]];
    if ![x1, y1, x2, y2].iter().all(|c| (0.0..=1.0).contains(c)) || x2 <= x1 || y2 <= y1 {
        return None;
    }
    Some([x1, y1, x2, y2])
}


// Decode the screenshot once so per-step accent sampling doesn't re-decode the JPEG.
fn decode_rgb(image_base64: &str) -> Option<image::RgbImage> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64)
        .ok()?;
    Some(image::load_from_memory(&bytes).ok()?.to_rgb8())
}

// Vibrant accent hex sampled from behind a normalized box (default if no image).
fn sample_accent(rgb: &Option<image::RgbImage>, [nx1, ny1, nx2, ny2]: [f64; 4]) -> String {
    let Some(rgb) = rgb else {
        return vibrant_accent(90.0, 90.0, 90.0);
    };
    let (w, h) = (rgb.width() as f64, rgb.height() as f64);
    let (ar, ag, ab) = sample_background(
        rgb,
        (nx1 * w) as u32,
        (ny1 * h) as u32,
        (nx2 * w) as u32,
        (ny2 * h) as u32,
    );
    vibrant_accent(ar, ag, ab)
}

// One normalized box → a pointer (companion cursor at the raw center) + a padded
// highlight rectangle, both in display points. Used per step so the cursor+box
// move through a walkthrough one step at a time.
fn map_box_to_targets(b: &DetectedBox, bounds: &OverlayDisplayBounds, step_index: usize) -> Vec<Value> {
    let (min_x, min_y, max_x, max_y) = display_point_bounds(bounds);
    let x1 = (bounds.x + b.norm_x1 * bounds.width).clamp(min_x, max_x);
    let y1 = (bounds.y + b.norm_y1 * bounds.height).clamp(min_y, max_y);
    let x2 = (bounds.x + b.norm_x2 * bounds.width).clamp(min_x, max_x);
    let y2 = (bounds.y + b.norm_y2 * bounds.height).clamp(min_y, max_y);
    let (rx, ry, rw, rh) = (x1, y1, (x2 - x1).max(0.0), (y2 - y1).max(0.0));
    let (center_x, center_y) = (rx + rw / 2.0, ry + rh / 2.0);
    let marker_px = 44.0;
    let raw_region = ScreenRegion { x: rx, y: ry, width: rw, height: rh };
    let (pad_x_pct, pad_y_pct, pad_x_max, pad_y_max) = highlight_padding(&raw_region);
    let min_px = env_f64("KAIRO_BOX_PAD_MIN_PX", 6.0);
    let pad_x = (pad_x_pct * rw).max(min_px).min(pad_x_max);
    let pad_y = (pad_y_pct * rh).max(min_px).min(pad_y_max);
    let px1 = (rx - pad_x).max(min_x);
    let py1 = (ry - pad_y).max(min_y);
    let px2 = (rx + rw + pad_x).min(max_x);
    let py2 = (ry + rh + pad_y).min(max_y);
    vec![
        json!({
            "kind": "pointer",
            "targetId": format!("vision-primary-{step_index}"),
            "label": b.label,
            "confidence": 0.95,
            "color": b.color,
            "screenRegion": {
                "x": center_x - marker_px / 2.0,
                "y": center_y - marker_px / 2.0,
                "width": marker_px,
                "height": marker_px,
            },
        }),
        json!({
            "kind": "highlight_box",
            "targetId": format!("vision-box-{step_index}"),
            "label": b.label,
            "confidence": 0.9,
            "color": b.color,
            "screenRegion": {
                "x": px1,
                "y": py1,
                "width": (px2 - px1).max(0.0),
                "height": (py2 - py1).max(0.0),
            },
        }),
    ]
}

// Turn the tutor's raw `{ mode, steps:[{say, box?}] }` into a frontend-ready
// `{ mode, voiceText, steps:[{say, visualTargets}] }`: each step's optional box is
// mapped to a pointer + highlight in display points. A legacy `{ voiceText, box }`
// response is wrapped as a single step. `voiceText` is the joined narration (legacy
// consumers + the answer log).
pub(crate) fn apply_step_targets(
    content: &str,
    image_base64: &str,
    bounds: &OverlayDisplayBounds,
) -> String {
    let Ok(parsed) = serde_json::from_str::<Value>(extract_json_object(json_body(content))) else {
        return content.to_string();
    };
    let raw_steps: Vec<Value> = match parsed.get("steps").and_then(Value::as_array) {
        Some(arr) => arr.clone(),
        None => {
            let say = parsed
                .get("voiceText")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            vec![json!({ "say": say, "box": parsed.get("box").cloned().unwrap_or(Value::Null) })]
        }
    };
    let rgb = decode_rgb(image_base64);
    let mut out_steps: Vec<Value> = Vec::new();
    let mut says: Vec<String> = Vec::new();
    for (i, step) in raw_steps.iter().take(constants::MAX_TUTOR_STEPS).enumerate() {
        let say = step
            .get("say")
            .or_else(|| step.get("voiceText"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let targets = match parse_norm_box(step.get("box")) {
            Some(nb) => {
                let color = sample_accent(&rgb, nb);
                let db = DetectedBox {
                    norm_x1: nb[0],
                    norm_y1: nb[1],
                    norm_x2: nb[2],
                    norm_y2: nb[3],
                    label: "target".to_string(),
                    color,
                };
                map_box_to_targets(&db, bounds, i)
            }
            None => Vec::new(),
        };
        crate::klog!(grounding, debug, step = i, has_box = !targets.is_empty(), say_len = say.len(), "tutor step");
        if !say.is_empty() {
            says.push(say.clone());
        }
        out_steps.push(json!({ "say": say, "visualTargets": targets }));
    }
    let mode = parsed
        .get("mode")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            if out_steps.len() > 1 {
                "steps".to_string()
            } else {
                "single".to_string()
            }
        });
    json!({ "mode": mode, "voiceText": says.join(" "), "steps": out_steps }).to_string()
}

#[cfg(test)]
mod step_targets_tests {
    use super::apply_step_targets;
    use crate::types::OverlayDisplayBounds;
    use serde_json::Value;

    fn bounds() -> OverlayDisplayBounds {
        OverlayDisplayBounds {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 800.0,
            scale_factor: 1.0,
        }
    }

    #[test]
    fn single_step_with_box_yields_pointer_and_highlight() {
        let content = r#"{ "mode":"single", "steps":[ { "say":"Click New — I've highlighted it.", "box":[0.10,0.20,0.30,0.28] } ] }"#;
        let v: Value = serde_json::from_str(&apply_step_targets(content, "", &bounds())).unwrap();
        assert_eq!(v["mode"], "single");
        assert_eq!(v["voiceText"], "Click New — I've highlighted it.");
        let steps = v["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 1);
        let targets = steps[0]["visualTargets"].as_array().unwrap();
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0]["kind"], "pointer");
        assert_eq!(targets[1]["kind"], "highlight_box");
    }

    #[test]
    fn narration_step_without_box_has_no_targets() {
        let content = r#"{ "mode":"steps", "steps":[ { "say":"This is GitHub." }, { "say":"Your code lives here.", "box":[0.1,0.3,0.7,0.8] } ] }"#;
        let v: Value = serde_json::from_str(&apply_step_targets(content, "", &bounds())).unwrap();
        let steps = v["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        assert!(steps[0]["visualTargets"].as_array().unwrap().is_empty());
        assert_eq!(steps[1]["visualTargets"].as_array().unwrap().len(), 2);
        assert_eq!(v["voiceText"], "This is GitHub. Your code lives here.");
    }

    #[test]
    fn legacy_single_box_is_wrapped_as_one_step() {
        let content = r#"{ "voiceText":"Click New.", "box":[0.1,0.2,0.3,0.4] }"#;
        let v: Value = serde_json::from_str(&apply_step_targets(content, "", &bounds())).unwrap();
        assert_eq!(v["mode"], "single");
        let steps = v["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0]["visualTargets"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn out_of_range_box_yields_no_targets() {
        let content = r#"{ "steps":[ { "say":"x", "box":[0.9,0.2,0.1,0.4] } ] }"#;
        let v: Value = serde_json::from_str(&apply_step_targets(content, "", &bounds())).unwrap();
        assert!(v["steps"][0]["visualTargets"].as_array().unwrap().is_empty());
    }

    #[test]
    fn caps_at_max_steps() {
        let content = r#"{ "steps":[ {"say":"1"},{"say":"2"},{"say":"3"},{"say":"4"},{"say":"5"},{"say":"6"},{"say":"7"} ] }"#;
        let v: Value = serde_json::from_str(&apply_step_targets(content, "", &bounds())).unwrap();
        assert_eq!(v["steps"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn extracts_despite_prose_preamble_and_trailing_text() {
        let content = "Sure!\n{ \"steps\":[ { \"say\":\"New\", \"box\":[0.1,0.2,0.3,0.4] } ] }\nHope that helps!";
        let v: Value = serde_json::from_str(&apply_step_targets(content, "", &bounds())).unwrap();
        assert_eq!(v["steps"][0]["visualTargets"].as_array().unwrap().len(), 2);
    }
}

#[cfg(test)]
mod json_extract_tests {
    use super::extract_json_object;

    #[test]
    fn strips_prose_preamble() {
        assert_eq!(
            extract_json_object("Here's the guidance:\n{\"voiceText\":\"hi\"}"),
            "{\"voiceText\":\"hi\"}"
        );
    }

    #[test]
    fn strips_trailing_text() {
        assert_eq!(extract_json_object("{\"a\":1}\nThanks!"), "{\"a\":1}");
    }

    #[test]
    fn ignores_braces_and_quotes_inside_strings() {
        let s = "{\"t\":\"a } b { c \\\" d\"}";
        assert_eq!(extract_json_object(s), s);
    }

    #[test]
    fn returns_input_when_no_object_present() {
        assert_eq!(extract_json_object("no json here"), "no json here");
    }
}
