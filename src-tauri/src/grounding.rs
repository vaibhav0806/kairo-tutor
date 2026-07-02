//! Vision-based element grounding: ask a vision model for target boxes, map them
//! back to screen pixels, and reconcile the model's visual targets with real
//! OCR/box regions.

use crate::color::{sample_background, vibrant_accent};
use crate::env::{provider_env, provider_env_optional};
use crate::ocr::build_box_locator_context;
use crate::prompts::box_locator_prompt;
use crate::tutor::shared_http_client;
use crate::types::{DetectedBox, OcrElement, OverlayDisplayBounds, ScreenRegion};
use serde_json::{json, Value};
use std::time::Duration;

// Longest edge (px) we downscale the screenshot to before sending it to Claude
// vision. Aspect ratio is preserved so returned pixel boxes map back cleanly.
// Tunable at runtime via KAIRO_VISION_MAX_EDGE (no rebuild) — raise toward 2576
// for tiny pro-app icons, browser chrome, and dense professional toolbars.
const DEFAULT_VISION_MAX_EDGE: u32 = 1568;

// Ask the grounding provider for the target boxes as raw JSON text. Both providers
// receive the SAME prompt + resized JPEG and return the same {"elements":[...]}
// shape, so the caller parses one format regardless of which provider ran.
async fn anthropic_vision_text(prompt: &str, image_jpeg_base64: &str) -> Option<String> {
    let api_key = provider_env_optional("ANTHROPIC_API_KEY")?;
    if api_key.trim().is_empty() {
        return None;
    }
    let model = provider_env("ANTHROPIC_VISION_MODEL", "claude-opus-4-8");
    let base_url = provider_env("ANTHROPIC_BASE_URL", "https://api.anthropic.com");
    let body = json!({
        "model": model,
        "max_tokens": 1024,
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
        .timeout(Duration::from_secs(25))
        .json(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        eprintln!(
            "[boxes-diag] anthropic vision {status}: {}",
            text.chars().take(220).collect::<String>()
        );
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
) -> Option<String> {
    let data_url = format!("data:image/jpeg;base64,{image_jpeg_base64}");
    let body = json!({
        "model": model,
        "max_tokens": 1024,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": data_url } },
                { "type": "text", "text": prompt },
            ],
        }],
    });
    let response = shared_http_client()
        .post(format!("{}/chat/completions", base_url.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {api_key}"))
        // OpenRouter attribution headers; harmlessly ignored by other hosts.
        .header("HTTP-Referer", "https://kairo.tutor")
        .header("X-Title", "Kairo Tutor")
        .timeout(Duration::from_secs(25))
        .json(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        eprintln!(
            "[boxes-diag] grounding {status}: {}",
            text.chars().take(220).collect::<String>()
        );
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
    // (Opus, default), `openrouter` (qwen3.7-plus via the user's OpenRouter key,
    // ~12x cheaper), or `qwen` (direct DashScope). All share this prompt + image.
    let provider = provider_env("KAIRO_GROUNDING_PROVIDER", "anthropic").to_lowercase();
    let max_edge = provider_env_optional("KAIRO_VISION_MAX_EDGE")
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|v| *v >= 256)
        .unwrap_or(DEFAULT_VISION_MAX_EDGE);
    let _ = bounds; // display bounds are applied later when mapping boxes to px

    // Downscale aspect-preserving so the longest edge <= max_edge. Claude returns
    // pixel boxes in THIS resized space; we normalize by (rw, rh) and map back.
    use base64::Engine;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(image_base64) else {
        return Vec::new();
    };
    let Ok(image) = image::load_from_memory(&bytes) else {
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
        return Vec::new();
    }
    let resized_base64 = base64::engine::general_purpose::STANDARD.encode(out.into_inner());

    let prompt = box_locator_prompt(user_query, rw, rh, &build_box_locator_context(ocr_elements));

    let text = match provider.as_str() {
        // Cheap Qwen grounding via the user's existing OpenRouter key.
        "openrouter" | "open-router" => {
            match provider_env_optional("OPENROUTER_API_KEY") {
                Some(key) if !key.trim().is_empty() => {
                    let base = provider_env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
                    let model = provider_env("KAIRO_GROUNDING_MODEL", "qwen/qwen3.7-plus");
                    openai_compatible_vision_text(&base, &key, &model, &prompt, &resized_base64)
                        .await
                }
                _ => None,
            }
        }
        // Direct Alibaba DashScope (needs a DashScope key, which some regions can't get).
        "qwen" | "qwen3" | "dashscope" | "alibaba" => {
            match provider_env_optional("DASHSCOPE_API_KEY")
                .or_else(|| provider_env_optional("QWEN_API_KEY"))
            {
                Some(key) if !key.trim().is_empty() => {
                    let base = provider_env(
                        "QWEN_BASE_URL",
                        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
                    );
                    let model = provider_env("QWEN_VISION_MODEL", "qwen3.7-plus");
                    openai_compatible_vision_text(&base, &key, &model, &prompt, &resized_base64)
                        .await
                }
                _ => None,
            }
        }
        _ => anthropic_vision_text(&prompt, &resized_base64).await,
    };
    let Some(text) = text else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(json_body(&text)) else {
        return Vec::new();
    };
    let Some(elements) = parsed.get("elements").and_then(Value::as_array) else {
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
    eprintln!("[boxes] {} element(s): {}", boxes.len(), summary.join(", "));

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

fn display_physical_bounds(bounds: &OverlayDisplayBounds) -> (f64, f64, f64, f64, f64) {
    let scale_factor = if bounds.scale_factor > 0.0 {
        bounds.scale_factor
    } else {
        1.0
    };
    (
        bounds.x * scale_factor,
        bounds.y * scale_factor,
        (bounds.x + bounds.width) * scale_factor,
        (bounds.y + bounds.height) * scale_factor,
        scale_factor,
    )
}

fn padded_screen_region(
    region: &ScreenRegion,
    bounds: Option<&OverlayDisplayBounds>,
    pad_pct: f64,
    pad_min_px: f64,
) -> ScreenRegion {
    let x1 = region.x;
    let y1 = region.y;
    let x2 = region.x + region.width.max(0.0);
    let y2 = region.y + region.height.max(0.0);
    let scale_factor = bounds
        .map(|b| {
            if b.scale_factor > 0.0 {
                b.scale_factor
            } else {
                1.0
            }
        })
        .unwrap_or(1.0);
    let pad_min_px = pad_min_px * scale_factor;
    let pad_x = (pad_pct * (x2 - x1)).max(pad_min_px);
    let pad_y = (pad_pct * (y2 - y1)).max(pad_min_px);

    let (min_x, min_y, max_x, max_y) = bounds
        .map(|b| {
            let (min_x, min_y, max_x, max_y, _) = display_physical_bounds(b);
            (min_x, min_y, max_x, max_y)
        })
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

    // Display extent in physical px — used to clamp padded boxes to the screen.
    let (min_x, min_y, max_x, max_y, scale_factor) = display_physical_bounds(bounds);

    // Padding: grow each side by max(min_px, pct * size) so the box has breathing
    // room instead of hugging the element exactly. Tunable at runtime (no rebuild).
    let pad_pct = provider_env_optional("KAIRO_BOX_PAD_PCT")
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| *v >= 0.0)
        .unwrap_or(0.30);
    let pad_min_px = provider_env_optional("KAIRO_BOX_PAD_MIN_PX")
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| *v >= 0.0)
        .unwrap_or(14.0)
        * scale_factor;

    // A detected box → raw (x, y, width, height) in physical px, clamped to the
    // display. The companion pointer uses this exact center so padding never
    // introduces a visual offset from the model's selected element.
    let raw_rect = |b: &DetectedBox| -> (f64, f64, f64, f64) {
        let x1 = ((bounds.x + b.norm_x1 * bounds.width) * scale_factor).clamp(min_x, max_x);
        let y1 = ((bounds.y + b.norm_y1 * bounds.height) * scale_factor).clamp(min_y, max_y);
        let x2 = ((bounds.x + b.norm_x2 * bounds.width) * scale_factor).clamp(min_x, max_x);
        let y2 = ((bounds.y + b.norm_y2 * bounds.height) * scale_factor).clamp(min_y, max_y);
        (x1, y1, (x2 - x1).max(0.0), (y2 - y1).max(0.0))
    };

    // A detected box → padded (x, y, width, height) in physical px, clamped to
    // the display. This is only for the drawn highlight breathing room.
    let padded_rect = |b: &DetectedBox| -> (f64, f64, f64, f64) {
        let (x1, y1, w, h) = raw_rect(b);
        let x2 = x1 + w;
        let y2 = y1 + h;
        let pad_x = (pad_pct * (x2 - x1)).max(pad_min_px);
        let pad_y = (pad_pct * (y2 - y1)).max(pad_min_px);
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
        let marker_px = 44.0 * scale_factor;
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
        let (x, y, w, h) = padded_rect(b);
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
                        Some(
                            k @ ("pointer" | "highlight_box" | "arrow" | "underline" | "spotlight"
                            | "ghost_cursor"),
                        ) => k,
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
                    if matches!(kind, "highlight_box" | "spotlight") {
                        screen_region = padded_screen_region(&screen_region, bounds, 0.25, 14.0);
                    } else if kind == "underline" {
                        screen_region = padded_screen_region(&screen_region, bounds, 0.18, 8.0);
                    }
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
            padded_screen_region(&element.region, bounds, 0.30, 14.0)
        } else if kind == "underline" {
            padded_screen_region(&element.region, bounds, 0.22, 10.0)
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
