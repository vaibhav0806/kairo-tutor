# Single-Call Opus Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the spoken answer and the pointed target come from ONE Opus 4.8 vision call so they can never disagree, and stop the voice from naming on-screen positions (prompt-only) so words can't contradict the pointer.

**Architecture:** Today `run_tutor_turn` fires two parallel calls — the OpenRouter/Gemini "tutor" (writes `voiceText` + targets) and the Anthropic/Opus "grounder" (`detect_element_boxes`, draws the box) — then throws away the tutor's target and uses the grounder's box, driven by the *raw question*. They disagree. This plan routes the vision turn to a single **direct Anthropic Opus** call that returns `voiceText` **and** a precise normalized `box` for the primary target, in one JSON. That box feeds the existing (scale-robust) `apply_box_targets` mapping; text targets still snap via OCR. The old two-call path is preserved behind an opt-in env flag as an escape hatch. Words and pointer now come from one brain.

**Tech Stack:** Rust (Tauri v2, reqwest, serde_json, `image`), Anthropic Messages API (Opus 4.8), Rust unit tests, Vitest.

---

## Global constraints

- **Logging is mandatory** (`klog!`, subsystems `tutor`, `grounding`). Log the single-call decision, the extracted box, and provider/model.
- Reuse Vaibhav's coordinate contract: **all final regions are display points**; the box arrives normalized `0..1` and maps via existing `apply_box_targets` (`grounding.rs:453-467`). Do not reintroduce `scale_factor` math.
- **Lever 1 is prompt-only** — no deterministic post-processing of `voiceText`.
- Verify on the packaged app; tail `~/Library/Logs/Kairo/kairo-latest.log`.

## File structure

- **Modify** `src-tauri/src/prompts.rs` — `build_tutor_system_prompt`: add the Lever-1 rule + the `box` field (normalized) + primary-target precision guidance. `box_locator_prompt` stays (used only by the gated legacy path).
- **Modify** `src-tauri/src/grounding.rs` — generalize the Anthropic caller to `anthropic_vision_chat(system,user,image,model,timeout)`; add `boxes_from_content()` (parse tutor JSON → `DetectedBox`, sampling the accent from the screenshot).
- **Modify** `src-tauri/src/tutor.rs` — route the vision answer turn to Opus (direct Anthropic); remove the parallel grounding join in the default path; use `boxes_from_content` → `apply_box_targets`, else `ground_visual_targets`. Keep the legacy 2-call path behind `KAIRO_SEPARATE_GROUNDING`.
- **Modify** `src-tauri/src/lib.rs:68` — `DEFAULT_OPENROUTER_VISION_MODEL` stays for the legacy path; add a default Opus model constant for the direct path.
- **Modify** `.env.example` — document the single-call default + the `KAIRO_SEPARATE_GROUNDING` escape hatch.

---

## Task 1: Prompt — Lever 1 + normalized `box` + precision

**Files:** Modify `src-tauri/src/prompts.rs:32-44` (`build_tutor_system_prompt`)

- [ ] **Step 1: Update the schema + rules**

Replace the `visualTargets` schema line and add two rules. In `build_tutor_system_prompt`, change the `VisualTarget = ...` string and append the new rules so the array reads:

```rust
        "Return ONLY JSON: { mode: \"idle\"|\"stuck_help\"|\"guided_lesson\", skillSlug: string, voiceText: string, screenText: string, visualTargets: VisualTarget[], expectedNextState: string }. Use \"\" for empty strings, never null. Prefer mode stuck_help or guided_lesson; idle only for no-op.".to_string(),
        "VisualTarget = { kind, label, elementId?, screenRegion?, box? }. kind: pointer (click point), highlight_box (control/region), arrow, ghost_cursor, underline, spotlight. Put your BEST target FIRST. For that primary target you MUST return an exact `box`: [x1,y1,x2,y2] as fractions 0..1 of the screenshot (origin top-left, x right, y down), tightly around the SINGLE control the user should act on — not a nearby heading, label, tooltip, or large region. Infer icon-only controls from shape + toolbar context. For extra text targets you may use elementId from SCREEN ELEMENTS instead.".to_string(),
        "For where/how/show questions, point at the exact control. Use at most 3 targets, best first; return [] if nothing on screen is relevant. Ignore Kairo's own notch, answer card, purple labels, cursor, and overlays unless the user asks about Kairo.".to_string(),
        "voiceText MUST NOT describe on-screen position or direction — never say \"top-right\", \"left pane\", \"on the left\", \"below\", \"next to\". The on-screen pointer shows WHERE; your words give the action and why. Refer to the target as \"this\" or \"the control I've highlighted\". Example: not \"click the New button on the left\" but \"click New to start a fresh repository — I've highlighted it\".".to_string(),
```

(Keep the remaining rules — direct-answer, annotations, skill, constraints — unchanged.)

- [ ] **Step 2: Compile-check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/prompts.rs
git commit -m "feat(prompts): single-call tutor emits precise box; voice never names positions"
```

---

## Task 2: Generalize the Anthropic vision caller

**Files:** Modify `src-tauri/src/grounding.rs:31-77` (`anthropic_vision_text`)

- [ ] **Step 1: Add a system-aware chat helper**

Add (next to `anthropic_vision_text`) a generalized caller that takes a system prompt + user text + image and returns the assistant text:

```rust
/// Anthropic Messages call with a system prompt, one user text block, and one
/// image. Returns the assistant's text (JSON expected via the prompt — Anthropic
/// has no json_object mode, so callers parse defensively with `json_body`).
async fn anthropic_vision_chat(
    system: &str,
    user_text: &str,
    image_jpeg_base64: &str,
    model: &str,
    timeout: Duration,
) -> Option<String> {
    let api_key = provider_env_optional("ANTHROPIC_API_KEY")?;
    if api_key.trim().is_empty() {
        return None;
    }
    let base_url = provider_env("ANTHROPIC_BASE_URL", "https://api.anthropic.com");
    let body = json!({
        "model": model,
        "max_tokens": 900,
        "system": system,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": user_text },
                { "type": "image", "source": {
                    "type": "base64", "media_type": "image/jpeg", "data": image_jpeg_base64
                }}
            ]
        }]
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
    let payload = response.json::<Value>().await.ok()?;
    payload
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| blocks.first())
        .and_then(|block| block.get("text"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}
```

Make it `pub(crate)` so `tutor.rs` can call it.

- [ ] **Step 2: Compile-check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles (unused-fn warning until Task 4 wires it — fine).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/grounding.rs
git commit -m "feat(grounding): add system-aware Anthropic vision chat helper"
```

---

## Task 3: Extract the primary box from tutor JSON (TDD)

**Files:** Modify `src-tauri/src/grounding.rs` (add `boxes_from_content` + a `#[cfg(test)]` test)

- [ ] **Step 1: Write the failing test**

Add to the tests module at the bottom of `grounding.rs` (create one if absent):

```rust
#[cfg(test)]
mod content_box_tests {
    use super::boxes_from_content_norm;

    #[test]
    fn extracts_first_target_with_a_normalized_box() {
        let content = r#"{
          "voiceText": "Click New — I've highlighted it.",
          "visualTargets": [
            { "kind": "pointer", "label": "New repo", "box": [0.10, 0.20, 0.30, 0.28] },
            { "kind": "highlight_box", "label": "Sidebar", "elementId": "screen-3" }
          ]
        }"#;
        let boxes = boxes_from_content_norm(content);
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].0, "New repo");
        assert_eq!(boxes[0].1, [0.10, 0.20, 0.30, 0.28]);
    }

    #[test]
    fn returns_empty_when_no_target_has_a_box() {
        let content = r#"{ "visualTargets": [ { "kind": "underline", "elementId": "screen-1" } ] }"#;
        assert!(boxes_from_content_norm(content).is_empty());
    }

    #[test]
    fn ignores_out_of_range_or_inverted_boxes() {
        let content = r#"{ "visualTargets": [ { "label": "x", "box": [0.9, 0.2, 0.1, 0.4] } ] }"#;
        assert!(boxes_from_content_norm(content).is_empty());
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml content_box`
Expected: FAIL — `boxes_from_content_norm` not found.

- [ ] **Step 3: Implement the pure extractor + the color-sampling wrapper**

Add to `grounding.rs`:

```rust
// Pure: parse the tutor JSON and return (label, [nx1,ny1,nx2,ny2]) for the FIRST
// target carrying a valid normalized box. Kept separate from image sampling so it
// is unit-testable without a screenshot.
pub(crate) fn boxes_from_content_norm(content: &str) -> Vec<(String, [f64; 4])> {
    let Ok(parsed) = serde_json::from_str::<Value>(json_body(content)) else {
        return Vec::new();
    };
    let Some(targets) = parsed.get("visualTargets").and_then(Value::as_array) else {
        return Vec::new();
    };
    for target in targets {
        let Some(arr) = target.get("box").and_then(Value::as_array) else {
            continue;
        };
        if arr.len() != 4 {
            continue;
        }
        let v: Vec<f64> = arr.iter().filter_map(Value::as_f64).collect();
        if v.len() != 4 {
            continue;
        }
        let [x1, y1, x2, y2] = [v[0], v[1], v[2], v[3]];
        let in_range = [x1, y1, x2, y2].iter().all(|c| (0.0..=1.0).contains(c));
        if !in_range || x2 <= x1 || y2 <= y1 {
            continue;
        }
        let label = target
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or("target")
            .to_string();
        return vec![(label, [x1, y1, x2, y2])];
    }
    Vec::new()
}

// Build a DetectedBox from the tutor's normalized box, sampling the accent colour
// from the screenshot so the highlight pops (mirrors detect_element_boxes).
pub(crate) fn boxes_from_content(content: &str, image_base64: &str) -> Vec<DetectedBox> {
    let norm = boxes_from_content_norm(content);
    let Some((label, [nx1, ny1, nx2, ny2])) = norm.into_iter().next() else {
        return Vec::new();
    };
    // Default accent if the image can't be decoded; sampled below when it can.
    let mut color = vibrant_accent(90, 90, 90);
    use base64::Engine;
    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(image_base64) {
        if let Ok(image) = image::load_from_memory(&bytes) {
            let rgb = image.to_rgb8();
            let (w, h) = (rgb.width() as f64, rgb.height() as f64);
            let (ar, ag, ab) = sample_background(
                &rgb,
                (nx1 * w) as u32,
                (ny1 * h) as u32,
                (nx2 * w) as u32,
                (ny2 * h) as u32,
            );
            color = vibrant_accent(ar, ag, ab);
        }
    }
    crate::klog!(grounding, debug, label = %label, norm = %format!("[{nx1:.4},{ny1:.4},{nx2:.4},{ny2:.4}]"), "box from tutor content");
    vec![DetectedBox {
        norm_x1: nx1,
        norm_y1: ny1,
        norm_x2: nx2,
        norm_y2: ny2,
        label,
        color,
    }]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml content_box`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/grounding.rs
git commit -m "feat(grounding): extract primary target box from tutor JSON"
```

---

## Task 4: Route the vision turn to a single Opus call

**Files:** Modify `src-tauri/src/tutor.rs:184-305` (`run_tutor_turn`); import from `grounding`.

- [ ] **Step 1: Add a default Opus model constant**

In `src-tauri/src/lib.rs` (near line 68):

```rust
// Direct-Anthropic model for the single-call vision tutor turn (answer + box).
const DEFAULT_TUTOR_VISION_MODEL: &str = "claude-opus-4-8";
```
Export it (mark `pub(crate)`), and add `use crate::DEFAULT_TUTOR_VISION_MODEL;` to `tutor.rs`.

- [ ] **Step 2: Update imports in `tutor.rs`**

```rust
use crate::grounding::{
    anthropic_vision_chat, apply_box_targets, boxes_from_content, detect_element_boxes,
    ground_visual_targets,
};
```

- [ ] **Step 3: Rewrite the answer/grounding section of `run_tutor_turn`**

Replace the parallel `answer_future` / `boxes_future` / `tokio::join!` / match block (`tutor.rs:218-304`) with a single-call default path plus the gated legacy path:

```rust
    let separate_grounding = provider_env("KAIRO_SEPARATE_GROUNDING", "false")
        .trim()
        .eq_ignore_ascii_case("true");
    let has_vision = input.screen.captured && input.screen.image_base64.is_some();

    // DEFAULT: one Opus vision call returns the answer AND the primary target box.
    if has_vision && !separate_grounding {
        let (Some(image_base64), Some(bounds)) =
            (&input.screen.image_base64, &input.screen.display_bounds)
        else {
            return Err("vision turn missing screenshot or display bounds".to_string());
        };
        let tutor_model = provider_env("ANTHROPIC_VISION_MODEL", DEFAULT_TUTOR_VISION_MODEL);
        let system_prompt = build_tutor_system_prompt(&input);
        let user_prompt = build_tutor_user_prompt(&input)?;
        let elements_block = build_screen_elements_block(&ocr_elements);
        let user_text = if elements_block.is_empty() {
            user_prompt
        } else {
            format!("{user_prompt}\n\n{elements_block}")
        };
        crate::klog!(tutor, info, model = %tutor_model, "single-call vision turn (answer + box)");
        let Some(content) = anthropic_vision_chat(
            &system_prompt,
            &user_text,
            image_base64,
            &tutor_model,
            timeout,
        )
        .await
        else {
            return Err("Opus vision turn returned no content (check ANTHROPIC_API_KEY).".to_string());
        };

        let detected = boxes_from_content(&content, image_base64);
        return Ok(if detected.is_empty() {
            // No explicit box (e.g. text-only target) — ground the model's own
            // elementId/screenRegion targets via OCR.
            ground_visual_targets(content, &ocr_elements, Some(bounds))
        } else {
            apply_box_targets(content, &detected, bounds)
        });
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
```

(`build_tutor_system_prompt`, `build_tutor_user_prompt`, and `build_screen_elements_block` are already imported/defined in `tutor.rs`. Keep the `model`/`vision_model`/`client`/`endpoint`/`site_url_ref` bindings above this block for the legacy path.)

- [ ] **Step 4: Compile-check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles; no unused-fn warnings (`detect_element_boxes` still used by the legacy path).

- [ ] **Step 5: Run the full Rust suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all pass (existing `apply_box_targets` test + new `content_box` tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/tutor.rs
git commit -m "feat(tutor): single Opus vision call for answer + box; legacy 2-call behind env flag"
```

---

## Task 5: Defaults + `.env` docs

**Files:** Modify `.env.example`

- [ ] **Step 1: Document the new behaviour**

In `.env.example`, near the grounding/vision block, add:

```bash
# Grounding is now single-call by default: one Opus vision turn (ANTHROPIC_VISION_MODEL)
# returns BOTH the spoken answer and the target box, so they can't disagree.
# Requires ANTHROPIC_API_KEY. To restore the legacy two-call path (OpenRouter answer
# + separate Opus grounding), set:
# KAIRO_SEPARATE_GROUNDING=true
```

- [ ] **Step 2: Local `.env` note (manual)**

The single-call path uses `ANTHROPIC_API_KEY` + `ANTHROPIC_VISION_MODEL` (`claude-opus-4-8`) — the author's `.env` already has both, so no local change is required to try it. `OPENROUTER_VISION_MODEL` now only matters when `KAIRO_SEPARATE_GROUNDING=true`.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document single-call Opus grounding + escape hatch"
```

---

## Task 6: Verify (unit + smoke + live repro)

- [ ] **Step 1: Green suites**

Run: `npm run typecheck && npm run test && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all pass.

- [ ] **Step 2: Confirm Opus reachability + latency**

Run: `npm run smoke:providers` (and/or a direct `curl https://api.anthropic.com/v1/messages` with the key). Confirm `claude-opus-4-8` responds and note the round-trip; compare against the old two-call `max(Flash,Opus)`.

- [ ] **Step 3: Live repro of the exact bug**

Build + launch:
```bash
npm run tauri:build -- --bundles app
open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```
On the GitHub dashboard, ask **"where can I create a new repo?"**. Assert:
- The highlighted control and the spoken answer refer to the **same** button.
- `voiceText` names **no** position ("top-right"/"left"/etc.).
- Logs show ONE `tutor` `single-call vision turn`, a `box from tutor content`, a `mapped pointer target`, and **no** `grounding … detect_boxes` span.

- [ ] **Step 4:** Toggle `KAIRO_SEPARATE_GROUNDING=true`, relaunch, confirm the legacy two-call path still works (escape hatch intact).

- [ ] **Step 5:** Finish the branch (see superpowers:finishing-a-development-branch).

---

## Self-review notes

- **Spec coverage:** Lever 1 (voice never names positions) → Task 1 prompt rule. Option C single-call on Opus → Tasks 2–4 (Anthropic chat helper + box extraction + `run_tutor_turn` rewrite). Escape hatch → `KAIRO_SEPARATE_GROUNDING` (Tasks 4,5).
- **Type consistency:** `DetectedBox { norm_x1, norm_y1, norm_x2, norm_y2, label, color }` matches `grounding.rs:325-331` and the fields `apply_box_targets` reads (`grounding.rs:464-467`). `boxes_from_content` returns `Vec<DetectedBox>`, consumed by `apply_box_targets(content, &detected, bounds)` — same signature as today's grounding path.
- **Known tradeoff (accepted):** Opus-as-tutor localizes icons slightly less tightly than the dedicated grounder did; text targets stay accurate via OCR; the env flag reverts instantly without a rebuild.
- **Open verification:** Opus 4.8 latency via direct Anthropic (Task 6 Step 2) — if materially slower than the old parallel path, revisit routing (e.g. OpenRouter). Not expected, since the old turn already waited on Opus.
