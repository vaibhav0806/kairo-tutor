//! Map model boxes to on-screen targets: normalize + pad boxes into display-point
//! pointer/highlight regions, shape the unified tutor turn, and inject a single
//! grounded pointing box.

use crate::color::{sample_background, vibrant_accent};
use crate::constants;
use crate::env::provider_env_optional;
use crate::types::{DetectedBox, OverlayDisplayBounds, ScreenRegion};
use serde_json::{json, Value};

use super::model_json::{extract_json_object, json_body};

// Point Kairo at exactly ONE grounded target: override the primary control's box
// with `nb` (the OpenAI-grounded normalized box) and null out every other box, so no
// ungrounded model guess leaks to the overlay. Prefers `await_click` (an explicit
// click target) when present; otherwise attaches to the step the narration meant to
// highlight (first step with a box, else the first step). Additive-safe: on parse
// failure or an empty turn, returns the input unchanged. `nb` = [x1,y1,x2,y2] as
// fractions 0..1 — the same shape `apply_step_targets` maps to display points.
pub(crate) fn inject_primary_box(content: &str, nb: [f64; 4]) -> String {
    let Ok(mut parsed) = serde_json::from_str::<Value>(extract_json_object(json_body(content)))
    else {
        return content.to_string();
    };
    let box_val = json!([nb[0], nb[1], nb[2], nb[3]]);
    let has_await = parsed
        .get("await_click")
        .map(Value::is_object)
        .unwrap_or(false);

    // Which step the narration intended to point at — captured before we null boxes.
    let primary_step_idx = parsed
        .get("steps")
        .and_then(Value::as_array)
        .and_then(|steps| {
            steps
                .iter()
                .position(|s| s.get("box").map(|b| !b.is_null()).unwrap_or(false))
        });

    if let Some(steps) = parsed.get_mut("steps").and_then(Value::as_array_mut) {
        for step in steps.iter_mut() {
            if let Some(object) = step.as_object_mut() {
                object.insert("box".to_string(), Value::Null);
            }
        }
        // No explicit click target → attach the grounded box to the primary step.
        if !has_await {
            let idx = primary_step_idx.unwrap_or(0);
            if let Some(step) = steps.get_mut(idx).and_then(Value::as_object_mut) {
                step.insert("box".to_string(), box_val.clone());
            }
        }
    }
    if has_await {
        if let Some(await_click) = parsed.get_mut("await_click").and_then(Value::as_object_mut) {
            await_click.insert("box".to_string(), box_val);
        }
    }
    serde_json::to_string(&parsed).unwrap_or_else(|_| content.to_string())
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

// Ground the model's visualTargets that already carry a numeric screenRegion into
// display points (padding highlight boxes so they breathe). Targets without a usable
// region are dropped, so only real coordinates reach the overlay.
pub(crate) fn ground_visual_targets(
    content: String,
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
    let accent = crate::accent::current();
    let Some(rgb) = rgb else {
        // 3:1 = WCAG AA floor for large text / UI components (a stroke/box/pointer).
        return crate::color::ensure_contrast(&vibrant_accent(&accent, 90.0, 90.0, 90.0), 90.0, 90.0, 90.0, 3.0);
    };
    let (w, h) = (rgb.width() as f64, rgb.height() as f64);
    let (ar, ag, ab) = sample_background(
        rgb,
        (nx1 * w) as u32,
        (ny1 * h) as u32,
        (nx2 * w) as u32,
        (ny2 * h) as u32,
    );
    // Blend toward the user accent, then guarantee a legible contrast floor against the pixels.
    let blended = vibrant_accent(&accent, ar, ag, ab);
    crate::color::ensure_contrast(&blended, ar, ag, ab, 3.0)
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

// Turn the tutor's raw unified turn `{ steps:[{say, box?}], await_click?, done? }`
// into a frontend-ready superset `{ mode, voiceText, steps:[{say, visualTargets}],
// awaitClick, done }`: each step's optional box is mapped to a pointer + highlight in
// display points. A legacy `{ voiceText, box }` response is wrapped as a single step.
// `voiceText` is the joined narration (legacy consumers + the answer log). `mode` is
// still derived (the frontend reads it: steps.len()>1 → "steps" else "single") unless
// the model explicitly emits one.
//
// GOLDEN RULE — additive only: when `await_click` is absent/null, the emitted
// `mode`/`voiceText`/`steps` are byte-identical to before, and `awaitClick` is null +
// `done` is false, so single/steps render exactly as today. When `await_click` is
// present + non-null its normalized box is mapped via the SAME `map_box_to_targets`
// as steps (→ a pointer + highlight_box in display points) and its `wait` bucket is
// passed through.
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

    // NEW (unified turn): an optional single target the user should click, and a
    // `done` flag. When `await_click` is present + non-null with a valid box, map it
    // via the SAME `map_box_to_targets` as steps (→ pointer + highlight_box in display
    // points) and pass through its `wait` bucket. Absent/null/malformed → awaitClick
    // null (graceful degrade — no panic). This is additive: with no await_click the
    // output above is unchanged, so single/steps render exactly as today.
    let await_click = parsed
        .get("await_click")
        .filter(|v| !v.is_null())
        .and_then(|ac| {
            let nb = parse_norm_box(ac.get("box"))?;
            let wait = ac
                .get("wait")
                .and_then(Value::as_str)
                .unwrap_or("ui-settle")
                .to_string();
            // Which mouse button the step needs. MUST be passed through: the frontend
            // pointer-watch matches it against the actual click, and a dropped button
            // defaults to "left" → a right-click step would nudge "left-click instead".
            let button = ac
                .get("button")
                .and_then(Value::as_str)
                .unwrap_or("left")
                .to_string();
            let color = sample_accent(&rgb, nb);
            let db = DetectedBox {
                norm_x1: nb[0],
                norm_y1: nb[1],
                norm_x2: nb[2],
                norm_y2: nb[3],
                label: "target".to_string(),
                color,
            };
            let targets = map_box_to_targets(&db, bounds, 0);
            Some(json!({ "visualTargets": targets, "wait": wait, "button": button }))
        })
        .unwrap_or(Value::Null);
    let done = parsed.get("done").and_then(Value::as_bool).unwrap_or(false);
    crate::klog!(tutor, debug, mode = %mode, steps = out_steps.len(), await_click = !await_click.is_null(), done = done, "unified tutor turn shaped");
    json!({
        "mode": mode,
        "voiceText": says.join(" "),
        "steps": out_steps,
        "awaitClick": await_click,
        "done": done,
    })
    .to_string()
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
        // MAX_TUTOR_STEPS was raised to 7; nine input steps must cap to exactly 7.
        let content = r#"{ "steps":[ {"say":"1"},{"say":"2"},{"say":"3"},{"say":"4"},{"say":"5"},{"say":"6"},{"say":"7"},{"say":"8"},{"say":"9"} ] }"#;
        let v: Value = serde_json::from_str(&apply_step_targets(content, "", &bounds())).unwrap();
        assert_eq!(
            v["steps"].as_array().unwrap().len(),
            crate::constants::MAX_TUTOR_STEPS
        );
    }

    #[test]
    fn extracts_despite_prose_preamble_and_trailing_text() {
        let content = "Sure!\n{ \"steps\":[ { \"say\":\"New\", \"box\":[0.1,0.2,0.3,0.4] } ] }\nHope that helps!";
        let v: Value = serde_json::from_str(&apply_step_targets(content, "", &bounds())).unwrap();
        assert_eq!(v["steps"][0]["visualTargets"].as_array().unwrap().len(), 2);
    }

    // Unified turn (RU1): a hands-on step + an await_click target the user should
    // click. awaitClick must be non-null with a highlight_box carrying a numeric
    // screenRegion, its wait passed through, done=false, and the steps shaped as today.
    #[test]
    fn unified_await_click_yields_targets_and_passthrough() {
        let content = r#"{ "steps":[ { "say":"Right-click the file.", "box":null } ], "await_click": { "box":[0.10,0.20,0.30,0.28], "wait":"page-load", "button":"right" }, "done": false }"#;
        let v: Value = serde_json::from_str(&apply_step_targets(content, "", &bounds())).unwrap();
        // steps shaped exactly as today: one step, say preserved, null box → no targets.
        let steps = v["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0]["say"], "Right-click the file.");
        assert!(steps[0]["visualTargets"].as_array().unwrap().is_empty());
        assert_eq!(v["voiceText"], "Right-click the file.");
        assert_eq!(v["mode"], "single");
        // await_click → non-null with pointer + highlight_box, wait + button passed through.
        let ac = &v["awaitClick"];
        assert!(!ac.is_null(), "awaitClick must be present");
        assert_eq!(ac["wait"], "page-load");
        assert_eq!(ac["button"], "right", "await_click.button MUST survive the reshape");
        let targets = ac["visualTargets"].as_array().unwrap();
        let highlight = targets
            .iter()
            .find(|t| t["kind"] == "highlight_box")
            .expect("await_click has a highlight_box target");
        assert!(
            highlight["screenRegion"]["x"].is_number(),
            "highlight_box screenRegion.x is numeric (mapped to display points)"
        );
        assert!(
            targets.iter().any(|t| t["kind"] == "pointer"),
            "await_click also has a pointer target"
        );
        assert_eq!(v["done"], false);
    }

    // An await_click that omits `button` defaults to "left" (every pre-right-click flow
    // is unchanged), never null/missing on the emitted awaitClick.
    #[test]
    fn await_click_without_button_defaults_to_left() {
        let content = r#"{ "steps":[ { "say":"Click Save.", "box":null } ], "await_click": { "box":[0.1,0.2,0.3,0.28], "wait":"ui-settle" }, "done": false }"#;
        let v: Value = serde_json::from_str(&apply_step_targets(content, "", &bounds())).unwrap();
        assert_eq!(v["awaitClick"]["button"], "left");
    }

    // The pre-unified shape (no await_click / done) must reshape byte-identically to
    // today for mode/voiceText/steps, only GAINING awaitClick=null + done=false.
    #[test]
    fn old_shape_without_await_click_is_null_and_not_done() {
        let content = r#"{ "steps":[ { "say":"Click New — I've highlighted it.", "box":[0.10,0.20,0.30,0.28] } ] }"#;
        let v: Value = serde_json::from_str(&apply_step_targets(content, "", &bounds())).unwrap();
        // NEW fields degrade gracefully.
        assert!(v["awaitClick"].is_null(), "no await_click → null");
        assert_eq!(v["done"], false);
        // Everything the frontend reads today is unchanged.
        assert_eq!(v["mode"], "single");
        assert_eq!(v["voiceText"], "Click New — I've highlighted it.");
        let steps = v["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 1);
        let targets = steps[0]["visualTargets"].as_array().unwrap();
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0]["kind"], "pointer");
        assert_eq!(targets[1]["kind"], "highlight_box");
    }
}

#[cfg(test)]
mod inject_tests {
    use super::inject_primary_box;
    use serde_json::{json, Value};

    #[test]
    fn inject_overrides_await_click_and_nulls_step_boxes() {
        let content = r#"{ "steps":[ {"say":"Open the menu.","box":[0.1,0.1,0.2,0.2]} ], "await_click": {"box":[0.5,0.5,0.6,0.6],"wait":"ui-settle"}, "done": false }"#;
        let out = inject_primary_box(content, [0.11, 0.22, 0.33, 0.44]);
        let v: Value = serde_json::from_str(&out).unwrap();
        // await_click box replaced with the grounded box; wait untouched.
        assert_eq!(v["await_click"]["box"], json!([0.11, 0.22, 0.33, 0.44]));
        assert_eq!(v["await_click"]["wait"], "ui-settle");
        // Every step box nulled (only the grounded target points).
        assert!(v["steps"][0]["box"].is_null());
    }

    #[test]
    fn inject_attaches_to_primary_step_when_no_await_click() {
        let content = r#"{ "steps":[ {"say":"This is the toolbar."}, {"say":"Click here.","box":[0.1,0.1,0.2,0.2]} ], "done": false }"#;
        let out = inject_primary_box(content, [0.7, 0.8, 0.9, 0.95]);
        let v: Value = serde_json::from_str(&out).unwrap();
        // The step that had a box (index 1) gets the grounded box; the other stays null.
        assert!(v["steps"][0]["box"].is_null());
        assert_eq!(v["steps"][1]["box"], json!([0.7, 0.8, 0.9, 0.95]));
    }

    #[test]
    fn inject_falls_back_to_first_step_when_no_boxes() {
        let content = r#"{ "steps":[ {"say":"Do this."} ], "done": false }"#;
        let out = inject_primary_box(content, [0.1, 0.2, 0.3, 0.4]);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["steps"][0]["box"], json!([0.1, 0.2, 0.3, 0.4]));
    }

    #[test]
    fn inject_returns_input_on_parse_failure() {
        assert_eq!(inject_primary_box("not json", [0.1, 0.2, 0.3, 0.4]), "not json");
    }
}
