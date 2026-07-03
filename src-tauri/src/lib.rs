use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::Sender,
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{Emitter, Listener, LogicalSize, Manager, State};
use tauri_nspanel::{tauri_panel, PanelHandle};
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

mod prompts;

#[macro_use]
mod klog;

mod types;
use types::*;

mod env;

mod platform;
use platform::get_active_app;

mod permissions;
use permissions::{
    get_permission_status, open_permission_settings, request_required_permissions,
    should_show_setup_window,
};
#[cfg(target_os = "macos")]
use permissions::ensure_input_monitoring_access;

mod capture;
use capture::capture_screen;
#[cfg(target_os = "macos")]
use capture::main_display_bounds;

mod ocr;

mod color;

mod grounding;

mod tutor;
use tutor::{run_gate_turn, run_tutor_turn};

mod speech;
use speech::{synthesize_speech, transcribe_audio};

mod audio;
use audio::spawn_audio_capture;

mod panels;
use panels::{
    configure_overlay_window, cursor_window, emit_overlay_payload, ensure_cursor_panel,
    ensure_notch_panel, ensure_overlay_panel, overlay_window, show_notch_with_payload,
    spawn_mouse_tracker, store_notch_payload, store_overlay_payload, typing_notch_payload,
};

mod input;
use input::{spawn_context_input_tap, spawn_context_poll, spawn_ptt_tap};

const KAIRO_ACTIVATION_SHORTCUT: &str = "CommandOrControl+Shift+Space";
// Toggle the pen directly without opening the notch first. Avoids ⌥⌃ (the
// push-to-talk chord) so holding it never starts a recording.
const KAIRO_PEN_SHORTCUT: &str = "Alt+Shift+P";
const DEFAULT_OPENROUTER_VISION_MODEL: &str = "google/gemini-2.5-flash";

// Non-activating NSPanel for the notch. A non-activating panel can receive
// input without activating the app, so showing it does not pull the user out
// of another app's full-screen Space (a plain NSWindow cannot do this).
// Both Kairo surfaces are non-activating panels that CAN become key. A plain
// borderless NSWindow returns canBecomeKeyWindow=NO, so it can never take focus
// and every click falls through to the app behind it — that's why the overlay
// couldn't catch pen draws. (One tauri_panel! block: the macro imports helpers,
// so it can only be invoked once.)
tauri_panel! {
    panel!(NotchPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })

    panel!(OverlayPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })

    // The companion cursor never takes input — it is permanently click-through —
    // so it must NOT become key (otherwise it could steal focus from the user's app).
    panel!(CursorPanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
}

#[derive(Default)]
struct OverlayState {
    current_payload: Mutex<Option<OverlayPayload>>,
    panel: Mutex<Option<PanelHandle<tauri::Wry>>>,
    window: Mutex<Option<tauri::WebviewWindow>>,
}

#[derive(Default)]
struct NotchState {
    current_payload: Mutex<Option<NotchPayload>>,
    // The crate's panel registry lookup (get_webview_panel) and panel.to_window()
    // are unreliable after hide/show, so we keep our own handles to the panel
    // (for show/hide) and its backing window (for size/position/emit).
    panel: Mutex<Option<PanelHandle<tauri::Wry>>>,
    window: Mutex<Option<tauri::WebviewWindow>>,
}

// The always-on companion cursor lives in its own click-through panel so it is
// isolated from the overlay/annotation lifecycle. We keep handles to drive it.
#[derive(Default)]
struct CursorState {
    panel: Mutex<Option<PanelHandle<tauri::Wry>>>,
    window: Mutex<Option<tauri::WebviewWindow>>,
}

// Watches for the user moving on after Kairo points at something — an app/tab
// switch, a page navigation, or a scroll/click — so stale guidance (the
// highlight box + companion cursor) can be cleared instead of hovering over the
// wrong place. Armed only while a teaching target is on screen. Plain mouse
// *movement* is deliberately ignored, so moving toward the target never counts
// as "the user moved on" (the key guard against false resets). Arc-wrapped so the
// background watcher threads and the Tauri commands share one flag.
#[derive(Clone)]
struct ContextWatch {
    armed: Arc<AtomicBool>,
    // (bundleId, windowTitle) of the app the guidance was drawn for, captured when
    // the box is revealed. Compared against the live frontmost app to detect moves.
    baseline: Arc<Mutex<Option<(String, String)>>>,
    // When arming happened; enforces a short settle window so the reveal's own
    // transient (or the click that opened the notch) never trips an instant reset.
    armed_at: Arc<Mutex<Option<Instant>>>,
    // Push-to-talk: true while the ⌥⌃ chord is held. Shares the same input tap.
    ptt_active: Arc<AtomicBool>,
}

impl Default for ContextWatch {
    fn default() -> Self {
        Self {
            armed: Arc::new(AtomicBool::new(false)),
            baseline: Arc::new(Mutex::new(None)),
            armed_at: Arc::new(Mutex::new(None)),
            ptt_active: Arc::new(AtomicBool::new(false)),
        }
    }
}

// ---------------------------------------------------------------------------
// Native microphone capture (cpal) for push-to-talk.
//
// WHY native: a WebView `getUserMedia` track keeps the macOS mic indicator lit for
// as long as it is held (spec-mandated), so "instant + indicator-off" is impossible
// there. Native audio ties the indicator to *running I/O* only: we build + play the
// input stream on ⌥⌃-down and drop it on release, so the mic is active ONLY while
// recording, and native start is a few ms (vs getUserMedia's ~1-2s). Cross-platform
// via cpal (CoreAudio today, WASAPI on Windows later).
// ---------------------------------------------------------------------------

enum AudioCommand {
    // Build the armed input stream at launch so the first press is warm.
    Warm,
    // Carries the chord-down instant so we can log time-to-record-start.
    Start(Instant),
    Stop,
}

#[derive(Default)]
struct AudioCapture {
    tx: Mutex<Option<Sender<AudioCommand>>>,
    // True while the mic stream is running; drives the level emitter.
    capturing: Arc<AtomicBool>,
    // Latest normalized mic level (0..1) as f32 bits, for the cursor listening halo.
    level: Arc<AtomicU32>,
}

#[tauri::command]
fn show_overlay(
    app: tauri::AppHandle,
    state: State<'_, OverlayState>,
    payload: OverlayPayload,
) -> Result<(), String> {
    let panel = ensure_overlay_panel(&app)?;
    let window = overlay_window(&app)?;
    configure_overlay_window(&window, &payload)?;
    store_overlay_payload(&state, Some(payload.clone()))?;
    if payload.mode.as_deref() == Some("annotate") {
        // Make the panel key so it actually receives pen clicks/drags.
        panel.show_and_make_key();
    } else {
        // Visual guidance is click-through — show without stealing key focus.
        panel.show();
    }
    emit_overlay_payload(&window, payload)
}

#[tauri::command]
fn update_overlay(
    app: tauri::AppHandle,
    state: State<'_, OverlayState>,
    payload: OverlayPayload,
) -> Result<(), String> {
    let window = overlay_window(&app)?;
    configure_overlay_window(&window, &payload)?;
    store_overlay_payload(&state, Some(payload.clone()))?;
    emit_overlay_payload(&window, payload)
}

// One log line pushed up from a frontend WebView. `fields` is already-formatted
// `key=value` text (or empty); the frontend does its own redaction.
#[derive(serde::Deserialize)]
struct FeLogLine {
    level: String,
    webview: String,
    sub: String,
    message: String,
}

// Batched frontend logging: the WebViews queue lines and flush a whole batch in a
// single IPC call (see src/core/logger.ts), so there is no IPC round-trip per log.
#[tauri::command]
fn debug_log_batch(lines: Vec<FeLogLine>) {
    for line in lines {
        klog::frontend(&line.level, &line.webview, &line.sub, &line.message);
    }
}

// Back-compat single-line entry point (older callers). Routes into the same file.
#[tauri::command]
fn debug_log(message: String) {
    klog::frontend("info", "unknown", "legacy", &message);
}

#[tauri::command]
fn get_display_bounds() -> DisplayBounds {
    #[cfg(target_os = "macos")]
    {
        main_display_bounds()
    }
    #[cfg(not(target_os = "macos"))]
    {
        DisplayBounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
            scale_factor: 1.0,
        }
    }
}

#[tauri::command]
fn get_current_overlay_payload(
    state: State<'_, OverlayState>,
) -> Result<Option<OverlayPayload>, String> {
    state
        .current_payload
        .lock()
        .map(|payload| payload.clone())
        .map_err(|_| "Failed to lock overlay payload state.".to_string())
}

#[tauri::command]
fn hide_overlay(_app: tauri::AppHandle, state: State<'_, OverlayState>) -> Result<(), String> {
    store_overlay_payload(&state, None)?;
    if let Some(panel) = state
        .panel
        .lock()
        .map_err(|_| "Failed to lock overlay panel state.".to_string())?
        .clone()
    {
        panel.hide();
    }
    Ok(())
}

// Send the companion cursor flying to (and resting near) an AI target.
#[tauri::command]
fn cursor_point(app: tauri::AppHandle, payload: CursorPointPayload) -> Result<(), String> {
    let window = cursor_window(&app)?;
    window
        .emit("cursor:point", payload)
        .map_err(|error| format!("Failed to send cursor point: {error}"))
}

// Return the companion cursor to shadowing the real mouse.
#[tauri::command]
fn cursor_release(app: tauri::AppHandle) -> Result<(), String> {
    let window = cursor_window(&app)?;
    window
        .emit("cursor:release", ())
        .map_err(|error| format!("Failed to release cursor: {error}"))
}

// Arm the context watcher when a teaching target is revealed. `baseline` is the
// app the guidance points at; a later frontmost/scroll/click change clears the box.
#[tauri::command]
fn arm_context_watch(
    watch: State<'_, ContextWatch>,
    baseline: ContextBaseline,
) -> Result<(), String> {
    *watch
        .baseline
        .lock()
        .map_err(|_| "Failed to lock context baseline.".to_string())? = Some((
        baseline.bundle_id.unwrap_or_default(),
        baseline.window_title.unwrap_or_default(),
    ));
    *watch
        .armed_at
        .lock()
        .map_err(|_| "Failed to lock context arm time.".to_string())? = Some(Instant::now());
    watch.armed.store(true, Ordering::SeqCst);
    Ok(())
}

// Stop watching (box cleared, notch closed, or a new turn started).
#[tauri::command]
fn disarm_context_watch(watch: State<'_, ContextWatch>) {
    watch.armed.store(false, Ordering::SeqCst);
}

// macOS caches Screen Recording (and accessibility) authorization per process,
// so a grant made while running is only observed after a relaunch. Restarting
// is the reliable way to re-read permissions during onboarding.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
fn show_notch(
    app: tauri::AppHandle,
    state: State<'_, NotchState>,
    payload: Option<NotchPayload>,
) -> Result<(), String> {
    show_notch_with_payload(&app, state.inner(), payload)
}

#[tauri::command]
fn get_current_notch_payload(state: State<'_, NotchState>) -> Result<Option<NotchPayload>, String> {
    state
        .current_payload
        .lock()
        .map(|payload| payload.clone())
        .map_err(|_| "Failed to lock notch payload state.".to_string())
}

#[tauri::command]
fn hide_notch(state: State<'_, NotchState>) -> Result<(), String> {
    store_notch_payload(&state, None)?;
    let panel = state
        .panel
        .lock()
        .map_err(|_| "Failed to lock notch panel state.".to_string())?
        .clone();
    if let Some(panel) = panel {
        panel.hide();
    }
    Ok(())
}

fn log_window_startup(window: &tauri::WebviewWindow) {
    let visible = window.is_visible().unwrap_or(false);
    let position = window
        .outer_position()
        .map(|position| format!("{},{}", position.x, position.y))
        .unwrap_or_else(|error| format!("unknown ({error})"));
    let size = window
        .outer_size()
        .map(|size| format!("{}x{}", size.width, size.height))
        .unwrap_or_else(|error| format!("unknown ({error})"));
    klog!(app, info, visible = visible, position = %position, size = %size, "startup: main window found");
}

// Reveal the companion cursor panel on the main thread. Idempotent: safe to call
// from both the `cursor:ready` listener and the fallback timer.
fn reveal_cursor_panel(app: &tauri::AppHandle) {
    if let Ok(panel) = ensure_cursor_panel(app) {
        let _ = app.run_on_main_thread(move || {
            panel.show();
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First thing: stand up the universal logger so every subsystem below logs
    // into ~/Library/Logs/Kairo/. Never panics.
    klog::init();

    let pen_shortcut: Shortcut = KAIRO_PEN_SHORTCUT
        .parse()
        .expect("failed to parse Kairo pen shortcut");
    let activation_shortcut: Shortcut = KAIRO_ACTIVATION_SHORTCUT
        .parse()
        .expect("failed to parse Kairo activation shortcut");
    let global_shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcuts([activation_shortcut, pen_shortcut.clone()])
        .expect("failed to register Kairo shortcuts")
        .with_handler(move |app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }

            // ⌥⇧P toggles the pen directly (no notch trip).
            if shortcut == &pen_shortcut {
                let _ = app.emit("pen:toggle", ());
                return;
            }

            // ⌘⇧Space opens the notch for typing (voice is push-to-talk via ⌥⌃).
            let notch_state = app.state::<NotchState>();
            if let Err(error) =
                show_notch_with_payload(app, notch_state.inner(), Some(typing_notch_payload()))
            {
                klog!(activation, error, "shortcut failed to show notch: {error}");
            }

            let _ = app.emit("activation:shortcut", ());
        })
        .build();

    tauri::Builder::default()
        .manage(OverlayState::default())
        .manage(NotchState::default())
        .manage(CursorState::default())
        .manage(ContextWatch::default())
        .manage(AudioCapture::default())
        .plugin(global_shortcut_plugin)
        .plugin(tauri_nspanel::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                log_window_startup(&window);
                let _ = window.set_size(LogicalSize::new(1180.0, 820.0));
                let _ = window.center();
                if should_show_setup_window(&get_permission_status()) {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                } else {
                    let _ = window.hide();
                }
            } else {
                klog!(app, warn, "startup: main window was not created");
            }
            // Pre-create the notch panel + webview at startup so the first
            // shortcut press shows it instantly instead of building it lazily.
            if let Err(error) = ensure_notch_panel(app.handle()) {
                klog!(app, error, "failed to pre-create notch panel: {error}");
            }
            // Same for the annotation overlay panel.
            if let Err(error) = ensure_overlay_panel(app.handle()) {
                klog!(app, error, "failed to pre-create overlay panel: {error}");
            }
            // Companion cursor: create it, then reveal it only AFTER its webview has
            // painted (it emits `cursor:ready`). The cursor window spans the whole
            // display, so showing it before the transparent webview loads flashes the
            // entire screen white for ~1-2s. A fallback timer reveals it if the event
            // is ever missed; both paths call show(), which is idempotent.
            match ensure_cursor_panel(app.handle()) {
                Ok(_) => {
                    spawn_mouse_tracker(app.handle());
                    let ready_handle = app.handle().clone();
                    app.listen_any("cursor:ready", move |_| {
                        reveal_cursor_panel(&ready_handle);
                    });
                    let fallback_handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(3000));
                        reveal_cursor_panel(&fallback_handle);
                    });
                }
                Err(error) => {
                    klog!(app, error, "failed to pre-create cursor panel: {error}");
                }
            }
            // Context watcher: detect app/tab switches + scroll/click so stale
            // guidance is cleared when the user moves on. Threads idle-cheap until armed.
            let context_watch = app.state::<ContextWatch>().inner().clone();
            spawn_context_poll(app.handle(), context_watch.clone());
            spawn_context_input_tap(app.handle(), context_watch.clone());
            // Native mic capture for push-to-talk: spawn the audio thread and hand
            // its command sender to the managed AudioCapture state.
            {
                let capturing;
                let level;
                {
                    let audio = app.state::<AudioCapture>();
                    capturing = audio.capturing.clone();
                    level = audio.level.clone();
                }
                let tx = spawn_audio_capture(app.handle(), capturing, level);
                // Warm the mic path at launch (build the armed stream) so the first
                // push-to-talk press is instant, not cold.
                let _ = tx.send(AudioCommand::Warm);
                if let Ok(mut guard) = app.state::<AudioCapture>().tx.lock() {
                    *guard = Some(tx);
                }
            }
            // Push-to-talk runs on its own tap so its (possibly Input-Monitoring-gated)
            // keyboard access can't disturb the mouse/scroll reset tap above. Request
            // the grant first so Kairo shows up in the Input Monitoring settings list.
            ensure_input_monitoring_access();
            spawn_ptt_tap(app.handle(), context_watch);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_active_app,
            get_permission_status,
            request_required_permissions,
            open_permission_settings,
            restart_app,
            debug_log,
            debug_log_batch,
            get_display_bounds,
            capture_screen,
            show_overlay,
            update_overlay,
            get_current_overlay_payload,
            hide_overlay,
            cursor_point,
            cursor_release,
            arm_context_watch,
            disarm_context_watch,
            show_notch,
            get_current_notch_payload,
            hide_notch,
            run_tutor_turn,
            run_gate_turn,
            transcribe_audio,
            synthesize_speech
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kairo Tutor");
}

#[cfg(test)]
mod tests {
    use super::DEFAULT_OPENROUTER_VISION_MODEL;
    use crate::env::{parse_local_env, provider_timeout_ms};
    use crate::grounding::{apply_box_targets, ground_visual_targets};
    use crate::panels::notch_window_size;
    use crate::prompts::box_locator_prompt;
    use crate::speech::{audio_filename, decode_audio_base64};
    use crate::tutor::{
        build_openrouter_messages, build_openrouter_request_body, select_openrouter_request_model,
    };
    use crate::types::{
        DetectedBox, OcrElement, OverlayDisplayBounds, ScreenRegion, SynthesizeSpeechInput,
        TranscribeAudioInput, TutorActiveAppContext, TutorAnnotation, TutorScreenInput,
        TutorSkillPack, TutorTurnInput,
    };
    use serde_json::json;

    #[test]
    fn parses_local_env_values() {
        let values = parse_local_env(
            r#"
            # local provider values
            KAIRO_AI_PROVIDER=openrouter
            OPENROUTER_MODEL="qwen/qwen3.6-flash"
            export OPENROUTER_APP_TITLE='Kairo Tutor'
            MALFORMED_LINE
            "#,
        );

        assert_eq!(
            values.get("KAIRO_AI_PROVIDER").map(String::as_str),
            Some("openrouter")
        );
        assert_eq!(
            values.get("OPENROUTER_MODEL").map(String::as_str),
            Some("qwen/qwen3.6-flash")
        );
        assert_eq!(
            values.get("OPENROUTER_APP_TITLE").map(String::as_str),
            Some("Kairo Tutor")
        );
        assert!(!values.contains_key("MALFORMED_LINE"));
    }

    #[test]
    fn ignores_blank_and_comment_lines() {
        let values = parse_local_env(
            r#"

            # one comment
            # another comment

            "#,
        );

        assert!(values.is_empty());
    }

    #[test]
    fn provider_timeout_ms_uses_positive_values_or_default() {
        assert_eq!(provider_timeout_ms(Some("12000".to_string())), 12000);
        assert_eq!(provider_timeout_ms(Some("0".to_string())), 30000);
        assert_eq!(provider_timeout_ms(Some("not-a-number".to_string())), 30000);
        assert_eq!(provider_timeout_ms(None), 30000);
    }

    #[test]
    fn openrouter_messages_use_openrouter_image_url_shape() {
        let input = sample_tutor_turn_input();

        let messages = build_openrouter_messages(&input, true, &[]).expect("messages should build");
        let image_part = &messages[1]["content"][1];

        assert_eq!(image_part["type"], "image_url");
        assert_eq!(
            image_part["image_url"]["url"],
            "data:image/png;base64,abc123"
        );
        assert!(image_part.get("imageUrl").is_none());
    }

    #[test]
    fn openrouter_request_body_requests_json_object_output() {
        let input = sample_tutor_turn_input();
        let body = build_openrouter_request_body(&input, "qwen/qwen3.6-flash", true, &[])
            .expect("body should build");

        assert_eq!(body["model"], "qwen/qwen3.6-flash");
        assert_eq!(body["response_format"]["type"], "json_object");
    }

    #[test]
    fn openrouter_request_body_can_omit_screenshot_for_text_fallback() {
        let input = sample_tutor_turn_input();
        let body = build_openrouter_request_body(&input, "qwen/qwen3.6-flash", false, &[])
            .expect("body should build");
        let user_message = &body["messages"][1];

        assert!(user_message["content"].is_string());
        assert!(!user_message["content"].to_string().contains("image_url"));
    }

    #[test]
    fn openrouter_request_model_uses_default_vision_model_for_screenshots() {
        let input = sample_tutor_turn_input();
        let (model, include_screenshot) = select_openrouter_request_model(
            &input,
            "qwen/qwen3.6-flash",
            DEFAULT_OPENROUTER_VISION_MODEL,
        );

        assert_eq!(model, DEFAULT_OPENROUTER_VISION_MODEL);
        assert!(include_screenshot);
    }

    #[test]
    fn openrouter_request_model_uses_text_model_without_screenshot() {
        let mut input = sample_tutor_turn_input();
        input.screen.captured = false;
        input.screen.image_base64 = None;
        let (model, include_screenshot) = select_openrouter_request_model(
            &input,
            "qwen/qwen3.6-flash",
            DEFAULT_OPENROUTER_VISION_MODEL,
        );

        assert_eq!(model, "qwen/qwen3.6-flash");
        assert!(!include_screenshot);
    }

    #[test]
    fn audio_upload_helpers_decode_and_name_voice_recordings() {
        let input = TranscribeAudioInput {
            audio_base64: "UklGRg==".to_string(),
            mime_type: "audio/webm".to_string(),
            filename: None,
        };

        assert_eq!(
            decode_audio_base64(&input).expect("audio should decode"),
            b"RIFF"
        );
        assert_eq!(audio_filename(&input), "kairo-voice.webm");
    }

    #[test]
    fn openrouter_prompt_allows_general_questions() {
        let input = sample_tutor_turn_input();
        let body = build_openrouter_request_body(&input, "qwen/qwen3.6-flash", false, &[])
            .expect("body should build");
        let system_prompt = body["messages"][0]["content"]
            .as_str()
            .expect("system prompt should be string");

        assert!(system_prompt.contains("Answer general questions directly"));
        assert!(system_prompt.contains("Selected skill, when relevant: Blender"));
        assert!(system_prompt.contains("WHERE/HOW/SHOW"));
        assert!(system_prompt.contains("Infer icon-only tools from shape"));
        assert!(system_prompt.contains("Only name a specific app, tool, or course"));
        assert!(system_prompt.contains("mention internal IDs like screen-annotation-1"));
        assert!(system_prompt.contains("arrowheads"));
        assert!(system_prompt.contains("answer what screen content it highlights"));
        assert!(!system_prompt.contains("Skill: Blender"));
    }

    #[test]
    fn openrouter_prompt_includes_exact_annotation_summary() {
        let mut input = sample_tutor_turn_input();
        input.annotations = vec![TutorAnnotation {
            id: "screen-annotation-1".to_string(),
            annotation_type: "pen".to_string(),
            screen_region: ScreenRegion {
                x: 120.0,
                y: 140.0,
                width: 180.0,
                height: 90.0,
            },
            points: None,
        }];
        let body = build_openrouter_request_body(&input, "qwen/qwen3.6-flash", false, &[])
            .expect("body should build");
        let user_prompt = body["messages"][1]["content"]
            .as_str()
            .expect("user prompt should be string");

        assert!(user_prompt.contains("\"annotationSummary\""));
        assert!(user_prompt.contains("Kairo user markup"));
        assert!(user_prompt.contains("Interpret arrows by their heads"));
        assert!(user_prompt.contains("visual attention guidance"));
        assert!(!user_prompt.contains("User annotations: exactly 1"));
        assert!(!user_prompt.contains("screen-annotation-1"));
    }

    #[test]
    fn preserves_direct_screen_region_targets_when_no_ocr_element_matches() {
        let raw = serde_json::to_string(&json!({
            "mode": "stuck_help",
            "skillSlug": "general",
            "voiceText": "The rectangle tool is here.",
            "screenText": "The rectangle tool is here.",
            "visualTargets": [{
                "kind": "pointer",
                "targetId": "rectangle-tool",
                "label": "Rectangle",
                "confidence": 0.9,
                "screenRegion": { "x": 820.0, "y": 940.0, "width": 44.0, "height": 44.0 }
            }],
            "expectedNextState": "user_clicks_rectangle"
        }))
        .expect("raw target JSON should serialize");

        let grounded = ground_visual_targets(raw, &[], None);
        let parsed: serde_json::Value =
            serde_json::from_str(&grounded).expect("grounded response should stay JSON");

        assert_eq!(parsed["visualTargets"][0]["kind"], "pointer");
        assert_eq!(parsed["visualTargets"][0]["targetId"], "rectangle-tool");
        assert_eq!(parsed["visualTargets"][0]["screenRegion"]["x"], 820.0);
    }

    #[test]
    fn box_locator_prompt_uses_generic_pixel_grounding() {
        let prompt = box_locator_prompt(
            "where can I click in order to change the url?",
            1568,
            982,
            "OCR/TEXT HINTS:\n1: \"github.com\" @ 18%,10% size 140x32px",
        );

        assert!(prompt.contains("pixel grounding model"));
        assert!(prompt.contains("All visible UI counts"));
        assert!(prompt.contains("app/browser chrome"));
        assert!(prompt.contains("Ignore Kairo's own notch"));
        assert!(prompt.contains("OCR/TEXT HINTS"));
        assert!(prompt.contains("\"github.com\""));
        assert!(prompt.contains("the editable field holding that value"));
        assert!(prompt.contains("not a search box, unless they asked to search"));
        assert!(prompt.contains("ABSOLUTE PIXELS of this 1568x982 image"));
    }

    #[test]
    fn box_locator_context_includes_ocr_position_hints() {
        let context = crate::ocr::build_box_locator_context(&[OcrElement {
            id: 7,
            text: "github.com".to_string(),
            region: ScreenRegion {
                x: 420.0,
                y: 256.0,
                width: 180.0,
                height: 36.0,
            },
            center_x_pct: 24.0,
            center_y_pct: 9.0,
        }]);

        assert!(context.contains("visible text boxes"));
        assert!(context.contains("7: \"github.com\" @ 24%,9% size 180x36px"));
        assert!(context.contains("still return the final tight pixel box from the image"));
    }

    #[test]
    fn apply_box_targets_places_pointer_at_detected_box_center() {
        let raw = serde_json::to_string(&json!({
            "mode": "stuck_help",
            "skillSlug": "general",
            "voiceText": "Click the address field.",
            "screenText": "Click the address field.",
            "visualTargets": [],
            "expectedNextState": "user_clicks_address_field"
        }))
        .expect("raw response should serialize");
        let bounds = OverlayDisplayBounds {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 700.0,
            scale_factor: 2.0,
        };
        let boxes = vec![DetectedBox {
            norm_x1: 0.10,
            norm_y1: 0.20,
            norm_x2: 0.20,
            norm_y2: 0.30,
            label: "Address field".to_string(),
            color: "#a78bfa".to_string(),
        }];

        let grounded = apply_box_targets(raw, &boxes, &bounds);
        let parsed: serde_json::Value =
            serde_json::from_str(&grounded).expect("grounded response should stay JSON");

        let pointer = &parsed["visualTargets"][0];
        assert_eq!(pointer["kind"], "pointer");
        assert_eq!(pointer["label"], "Address field");
        assert_eq!(pointer["screenRegion"]["width"], 88.0);
        assert_eq!(pointer["screenRegion"]["height"], 88.0);
        // Raw detected center is (150, 175) logical px => (300, 350) physical px.
        // The 88px cursor marker is centered there.
        assert_eq!(pointer["screenRegion"]["x"], 256.0);
        assert_eq!(pointer["screenRegion"]["y"], 306.0);

        let highlight = &parsed["visualTargets"][1];
        assert_eq!(highlight["kind"], "highlight_box");
        assert_eq!(highlight["label"], "Address field");
    }

    #[test]
    fn ground_visual_targets_pads_ocr_highlights() {
        let raw = serde_json::to_string(&json!({
            "mode": "stuck_help",
            "skillSlug": "general",
            "voiceText": "Use the repository search.",
            "screenText": "Use the repository search.",
            "visualTargets": [{
                "kind": "highlight_box",
                "targetId": "repo-search",
                "label": "Repository search",
                "confidence": 0.9,
                "elementId": 4
            }],
            "expectedNextState": "user_searches_repo"
        }))
        .expect("raw target JSON should serialize");
        let bounds = OverlayDisplayBounds {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 700.0,
            scale_factor: 2.0,
        };
        let elements = vec![OcrElement {
            id: 4,
            text: "Find a repository...".to_string(),
            region: ScreenRegion {
                x: 80.0,
                y: 500.0,
                width: 240.0,
                height: 32.0,
            },
            center_x_pct: 20.0,
            center_y_pct: 36.0,
        }];

        let grounded = ground_visual_targets(raw, &elements, Some(&bounds));
        let parsed: serde_json::Value =
            serde_json::from_str(&grounded).expect("grounded response should stay JSON");
        let region = &parsed["visualTargets"][0]["screenRegion"];

        // Padding is 30% of each side, min 14 logical px (×2 scale = 28 physical).
        // pad_x = max(0.30·240, 28) = 72; pad_y = max(0.30·32, 28) = 28.
        assert_eq!(region["x"], 8.0);
        assert_eq!(region["y"], 472.0);
        assert_eq!(region["width"], 384.0);
        assert_eq!(region["height"], 88.0);
    }

    #[test]
    fn mock_speech_synthesis_returns_silent_audio_result() {
        std::env::set_var("KAIRO_TTS_PROVIDER", "mock");

        let result =
            tauri::async_runtime::block_on(crate::speech::synthesize_speech(SynthesizeSpeechInput {
                text: "Hello from Kairo.".to_string(),
            }))
            .expect("mock synthesis should not fail");

        assert_eq!(result.audio_base64, "");
        assert_eq!(result.mime_type, "audio/mpeg");
        assert_eq!(result.provider, "mock");

        std::env::remove_var("KAIRO_TTS_PROVIDER");
    }

    #[test]
    fn notch_window_size_uses_stable_assistant_frame() {
        assert_eq!(
            notch_window_size(Some("prompt"), Some("captured")),
            (760.0, 236.0)
        );
        assert_eq!(
            notch_window_size(Some("answer"), Some("showing_step")),
            (760.0, 236.0)
        );
        assert_eq!(notch_window_size(None, Some("captured")), (760.0, 236.0));
        assert_eq!(notch_window_size(None, Some("thinking")), (760.0, 236.0));
        assert_eq!(
            notch_window_size(Some("compact"), Some("thinking")),
            (760.0, 236.0)
        );
        assert_eq!(notch_window_size(None, None), (760.0, 236.0));
    }

    fn sample_tutor_turn_input() -> TutorTurnInput {
        TutorTurnInput {
            user_query: "What should I click?".to_string(),
            active_app: TutorActiveAppContext {
                active_app: "Blender".to_string(),
                bundle_id: Some("org.blenderfoundation.blender".to_string()),
                window_title: Some("Blender".to_string()),
                url: None,
            },
            annotations: vec![],
            screen: TutorScreenInput {
                captured: true,
                reason: None,
                image_mime_type: Some("image/png".to_string()),
                image_base64: Some("abc123".to_string()),
                byte_length: Some(6),
                display_bounds: Some(OverlayDisplayBounds {
                    x: 0.0,
                    y: 0.0,
                    width: 900.0,
                    height: 600.0,
                    scale_factor: 2.0,
                }),
            },
            skill: TutorSkillPack {
                slug: "blender".to_string(),
                display_name: "Blender".to_string(),
                app_identifiers: vec!["org.blenderfoundation.blender".to_string()],
                landmarks: json!({}),
            },
            constraints: vec!["Return one short tutor step.".to_string()],
        }
    }
}
