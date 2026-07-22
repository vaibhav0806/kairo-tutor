use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{Emitter, LogicalSize, Manager, State};
use tauri_nspanel::{tauri_panel, PanelHandle};

mod prompts;

mod skills;

mod constants;

#[macro_use]
mod klog;

mod types;
use types::*;

mod env;

mod platform;
use platform::get_active_app;

mod permissions;
#[cfg(target_os = "macos")]
use permissions::ensure_input_monitoring_access;
use permissions::{
    get_input_monitoring_status, get_permission_status, open_permission_settings,
    request_accessibility, request_input_monitoring, request_microphone,
    request_required_permissions, request_screen_recording, should_show_setup_window,
};

mod capture;
use capture::capture_screen;
#[cfg(target_os = "macos")]
use capture::main_display_bounds;

mod framehash;

mod color;

mod grounding;

mod tutor;
use tutor::{run_ack_turn, run_gate_turn, run_tutor_turn};

mod speech;
use speech::{synthesize_speech, synthesize_speech_stream, transcribe_audio};

mod audio;
use audio::spawn_audio_capture;

mod panels;
use panels::{
    configure_overlay_window, cursor_window, emit_overlay_payload, ensure_cursor_panel,
    ensure_notch_panel, ensure_overlay_panel, overlay_window, show_notch_with_payload,
    spawn_mouse_tracker, spawn_notch_hit_tracker, store_notch_payload, store_overlay_payload,
    typing_notch_payload,
};

mod input;
mod auth;
mod onboarding;
mod accent;
mod proxy;
use input::{spawn_context_input_tap, spawn_context_poll, spawn_ptt, start_ptt, FollowClickWatch};

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
    // The capsule's bounding rect in CSS px (left, top, width, height) within the
    // notch viewport, reported by the frontend. The notch hit-tracker makes the
    // panel click-through everywhere EXCEPT this rect, so clicks in the empty area
    // around the small capsule reach the app below. None → whole notch clickable.
    hit_rect: Mutex<Option<(f64, f64, f64, f64)>>,
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
}

impl Default for ContextWatch {
    fn default() -> Self {
        Self {
            armed: Arc::new(AtomicBool::new(false)),
            baseline: Arc::new(Mutex::new(None)),
            armed_at: Arc::new(Mutex::new(None)),
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

use crate::audio::{AudioCapture, AudioCommand};

fn region_summary(region: &ScreenRegion) -> String {
    format!(
        "[{:.1},{:.1},{:.1},{:.1}]",
        region.x, region.y, region.width, region.height
    )
}

fn overlay_bounds_summary(bounds: &OverlayDisplayBounds) -> String {
    format!(
        "x={:.1} y={:.1} w={:.1} h={:.1} scale={:.3}",
        bounds.x, bounds.y, bounds.width, bounds.height, bounds.scale_factor
    )
}

fn log_overlay_payload(subsystem: &'static str, payload: &OverlayPayload) {
    let summary = payload
        .targets
        .iter()
        .map(|target| {
            format!(
                "{}:{}:{}",
                target.kind,
                target.label,
                region_summary(&target.screen_region)
            )
        })
        .collect::<Vec<_>>()
        .join(" | ");
    klog!(
        overlay,
        debug,
        source = subsystem,
        mode = payload.mode.as_deref().unwrap_or("none"),
        target_count = payload.targets.len(),
        annotation_count = payload.annotations.as_ref().map_or(0, Vec::len),
        bounds = %overlay_bounds_summary(&payload.display_bounds),
        targets = %summary,
        "overlay payload"
    );
}

#[tauri::command]
fn show_overlay(
    app: tauri::AppHandle,
    state: State<'_, OverlayState>,
    payload: OverlayPayload,
) -> Result<(), String> {
    let panel = ensure_overlay_panel(&app)?;
    let window = overlay_window(&app)?;
    log_overlay_payload("show_overlay", &payload);
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
    log_overlay_payload("update_overlay", &payload);
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
    klog!(
        cursor,
        debug,
        region = %region_summary(&payload.screen_region),
        bounds = %overlay_bounds_summary(&payload.display_bounds),
        color = payload.color.as_deref().unwrap_or("none"),
        "cursor point"
    );
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

// The companion cursor finished flying to a target → tell the notch (which owns the
// unlocked audio context) to play the arrival cue. Broadcast via app.emit so it reaches
// the notch reliably — the rest of this app routes cross-WebView cursor events the same
// way (a direct WebView→WebView emit is not relied on here).
#[tauri::command]
fn cursor_arrived(app: tauri::AppHandle) -> Result<(), String> {
    klog!(cursor, debug, "cursor arrived → notch");
    app.emit("cursor:arrived", ())
        .map_err(|error| format!("Failed to emit cursor arrived: {error}"))
}

// Notch-authoritative "a turn is in progress" flag → the companion cursor never
// auto-hides while true, so the pet stays visible through the entire thinking/gate/vision
// pass, then resumes normal idle-hide when it goes false. Broadcast via app.emit.
#[tauri::command]
fn cursor_active(app: tauri::AppHandle, active: bool) -> Result<(), String> {
    app.emit("cursor:active", active)
        .map_err(|error| format!("Failed to emit cursor active: {error}"))
}

// One-shot "come to life" beat for the companion cursor (onboarding Act 1 wake-up;
// reusable in-product). Broadcast via app.emit so it reaches the cursor WebView reliably.
#[tauri::command]
fn cursor_entrance(app: tauri::AppHandle) -> Result<(), String> {
    klog!(cursor, debug, "entrance beat → cursor");
    app.emit("cursor:entrance", ())
        .map_err(|error| format!("Failed to emit cursor entrance: {error}"))
}

// One-shot celebratory flourish (onboarding Act 4a peak; used sparingly so it stays special).
#[tauri::command]
fn cursor_celebrate(app: tauri::AppHandle) -> Result<(), String> {
    klog!(cursor, debug, "celebrate beat → cursor");
    app.emit("cursor:celebrate", ())
        .map_err(|error| format!("Failed to emit cursor celebrate: {error}"))
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

// Follow-along mode: while armed, the input tap emits `input:click { x, y }` for
// every left mouse-up. Independent of the context watch above.
#[tauri::command]
fn arm_follow_click(watch: State<'_, FollowClickWatch>) {
    watch.armed.store(true, Ordering::SeqCst);
    klog!(follow, debug, "follow-click armed");
}

#[tauri::command]
fn disarm_follow_click(watch: State<'_, FollowClickWatch>) {
    watch.armed.store(false, Ordering::SeqCst);
    klog!(follow, debug, "follow-click disarmed");
}

// macOS caches Screen Recording (and accessibility) authorization per process,
// so a grant made while running is only observed after a relaunch. Restarting
// is the reliable way to re-read permissions during onboarding.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// Create the macOS menu-bar (status-item) icon. Kairo runs as an `Accessory`
/// app (no Dock icon), so this is the only always-visible affordance a user has
/// to quit/restart the app or reopen the notch. Not gated to macOS — the tray is
/// cross-platform, so a future Windows build gets the same menu for free.
/// Bring Kairo to the foreground and steal focus (macOS). Used at first-run launch so the onboarding
/// window opens IN FRONT of whatever the user had focused (a launched app should come forward), not
/// behind it. `activateIgnoringOtherApps` is the reliable way to steal focus; the modern `activate`
/// deliberately won't take focus from another app, which is exactly what we DON'T want here.
#[cfg(target_os = "macos")]
fn activate_frontmost(app: &tauri::AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let mut activated = false;
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            let ns_app = objc2_app_kit::NSApplication::sharedApplication(mtm);
            // Modern (macOS 14+) — the documented replacement; works for the current app.
            ns_app.activate();
            // Legacy — still honored on older macOS; ignored on Sonoma+ (harmless).
            #[allow(deprecated)]
            ns_app.activateIgnoringOtherApps(true);
            activated = true;
        }
        // Also key the onboarding window itself (activation alone can leave it non-key).
        if let Some(win) = app2.get_webview_window("onboarding") {
            let _ = win.show();
            let _ = win.set_focus();
        }
        crate::klog!(app, info, activated = activated, "activate frontmost");
    });
}

fn screen_recording_marker(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("screen_recording_granted"))
}

/// Compare the "was ever granted" marker against the live status. Returns true exactly once per
/// reset: marker present + status now NOT granted → macOS reset Screen Recording (Sequoia does this
/// ~monthly). Keeps the marker in sync otherwise (writes it the first time it's granted; clears it
/// on a reset so we heads-up once and re-arm on the next grant).
fn detect_screen_recording_reset(app: &tauri::AppHandle) -> bool {
    let status = permissions::get_permission_status();
    let granted = matches!(status.screen_recording, crate::types::PermissionState::Granted);
    let Some(marker) = screen_recording_marker(app) else {
        return false;
    };
    let was_granted = marker.exists();
    if granted {
        if !was_granted {
            if let Some(dir) = marker.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&marker, b"1");
        }
        return false;
    }
    if was_granted {
        let _ = std::fs::remove_file(&marker);
        return true;
    }
    false
}

fn create_menu_bar_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let show_item = MenuItem::with_id(app, "tray_show_notch", "Show Notch", true, None::<&str>)?;
    let replay_item =
        MenuItem::with_id(app, "tray_replay_intro", "Replay intro", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray_quit", "Quit Kairo", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &replay_item, &separator, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("kairo-menu-bar")
        .tooltip("Kairo Tutor")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_quit" => {
                klog!(app, info, "menu bar: quit selected");
                app.exit(0);
            }
            "tray_show_notch" => {
                klog!(app, info, "menu bar: show notch selected");
                let state = app.state::<NotchState>();
                if let Err(error) =
                    show_notch_with_payload(app, state.inner(), Some(typing_notch_payload()))
                {
                    klog!(app, error, "menu bar: show notch failed: {error}");
                }
            }
            "tray_replay_intro" => {
                klog!(app, info, "menu bar: replay intro selected");
                crate::onboarding::replay_onboarding(app);
            }
            other => klog!(app, warn, id = other, "menu bar: unknown menu event"),
        });

    // Reuse the app icon for the status item. It is a colored icon (not a
    // monochrome template), so leave `icon_as_template` off — template mode would
    // render a colored icon as a solid blob in the menu bar.
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    klog!(app, info, "menu bar tray icon created");
    Ok(())
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

// Frontend reports the capsule's rect (CSS px within the notch viewport) so the
// hit-tracker can make the empty area around it click-through. `None` (capsule
// hidden) → whole notch clickable (fail-safe; never traps the capsule).
#[tauri::command]
fn set_notch_hit_rect(state: State<'_, NotchState>, rect: Option<HitRect>) -> Result<(), String> {
    if let Ok(mut guard) = state.hit_rect.lock() {
        *guard = rect.map(|r| (r.x, r.y, r.width, r.height));
    }
    Ok(())
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

/// Save a base64 JPEG (the exact image sent to fable) to a debug folder and,
/// on the first call of the session, open the folder in Finder. Debug-only —
/// gated by the frontend gestureConfig.debugImages flag.
#[tauri::command]
fn save_gesture_debug_image(app: tauri::AppHandle, base64: String) -> Result<String, String> {
    use base64::Engine as _;
    use std::io::Write as _;
    // `dirs` isn't a dependency here, so resolve the home dir from $HOME directly.
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let dir = std::path::Path::new(&home).join("Library/Logs/Kairo/gesture-debug");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("gesture-{stamp}.jpg"));
    let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    klog!(gesture, info, path = %path.display(), "saved gesture debug image");
    // Open the folder once per session so the user can watch images land.
    static OPENED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    #[cfg(target_os = "macos")]
    if !OPENED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        let _ = std::process::Command::new("open").arg(&dir).spawn();
    }
    let _ = app; // reserved for future per-window routing
    Ok(path.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First thing: stand up the universal logger so every subsystem below logs
    // into ~/Library/Logs/Kairo/. Never panics.
    klog::init();

    tauri::Builder::default()
        .manage(OverlayState::default())
        .manage(NotchState::default())
        .manage(CursorState::default())
        .manage(ContextWatch::default())
        .manage(FollowClickWatch::default())
        .manage(AudioCapture::default())
        .plugin(tauri_nspanel::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let show_setup = should_show_setup_window(&get_permission_status());
            let need_onboarding = !crate::onboarding::is_onboarded(app.handle());
            // Activation policy. By default a Tauri app is `Regular` (Dock icon), so
            // launching it *activates* the app and macOS yanks the user off any
            // full-screen Space onto the desktop. Kairo is a background notch/cursor
            // utility, so on a normal launch run it as an `Accessory` app instead: no
            // Dock icon, and — crucially — no forced Space switch on launch. The only
            // time we need a real, front-most, focusable window is the first-run setup
            // (permissions) window, so keep the default `Regular` policy for that one
            // launch. (Same idea as clicky's `LSUIElement=true` menu-bar-only design.)
            #[cfg(target_os = "macos")]
            {
                if !show_setup && !need_onboarding {
                    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
                klog!(app, info, setup = show_setup, onboarding = need_onboarding, "activation policy set");
            }
            if let Some(window) = app.get_webview_window("main") {
                log_window_startup(&window);
                let _ = window.set_size(LogicalSize::new(1180.0, 820.0));
                let _ = window.center();
                if show_setup && !need_onboarding {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                } else {
                    let _ = window.hide();
                }
            } else {
                klog!(app, warn, "startup: main window was not created");
            }
            // First run: show the dedicated borderless onboarding window instead of the dashboard,
            // and pull the whole app to the foreground so it doesn't open behind the current window.
            if need_onboarding {
                crate::onboarding::show_onboarding_window(app.handle());
                #[cfg(target_os = "macos")]
                {
                    // Activate now AND again after the launch settles — macOS activation is finicky
                    // during app launch (deprecated activateIgnoringOtherApps can be ignored on
                    // Sonoma until the runloop is up), so re-assert on a short delay.
                    activate_frontmost(app.handle());
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(700));
                        activate_frontmost(&handle);
                    });
                }
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
            // Warm the TLS handshake to each provider host so the first gate/vision/
            // STT/TTS request skips the cold negotiation (shaves first-turn latency).
            crate::tutor::prewarm_http_connections();
            // Load the user's chosen accent into the process-global cache so leaf code
            // (color.rs) and every webview read the right hue from launch.
            crate::accent::init_accent(app.handle());
            // Companion cursor: create it, show it always, and start tracking the
            // real mouse so it shadows the cursor from launch.
            match ensure_cursor_panel(app.handle()) {
                Ok(panel) => {
                    panel.show();
                    spawn_mouse_tracker(app.handle());
                    // Make the notch click-through everywhere except the capsule, so
                    // the empty area around the small card doesn't swallow clicks.
                    spawn_notch_hit_tracker(app.handle());
                }
                Err(error) => {
                    klog!(app, error, "failed to pre-create cursor panel: {error}");
                }
            }
            // Context watcher: detect app/tab switches + scroll/click so stale
            // guidance is cleared when the user moves on. Threads idle-cheap until armed.
            let context_watch = app.state::<ContextWatch>().inner().clone();
            let follow_watch = app.state::<FollowClickWatch>().inner().clone();
            spawn_context_poll(app.handle(), context_watch.clone());
            spawn_context_input_tap(app.handle(), context_watch.clone(), follow_watch);
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
                // No launch warm-up: the mic unit is built lazily on the first ⌥⌃ press
                // so the mic hardware is untouched (indicator off) until the user talks.
                // The first press pays a one-time ~200ms cold build; every later press
                // reuses the same paused unit (instant, and leak-free).
                let _ = tx.send(AudioCommand::Warm);
                if let Ok(mut guard) = app.state::<AudioCapture>().tx.lock() {
                    *guard = Some(tx);
                }
            }
            // Push-to-talk runs on its own tap so its (possibly Input-Monitoring-gated)
            // keyboard access can't disturb the mouse/scroll reset tap above. For a FIRST-RUN user
            // we do NOT create the tap at launch — creating the CGEventTap is what triggers the
            // macOS "Keystroke Receiving" (Input Monitoring) prompt, and that belongs in Act 2 (with
            // the mic), not before any value. Act 2 calls `start_ptt` after its primer; the tap then
            // retries until the grant lands. Already-onboarded users get it (+ the grant) at launch.
            if crate::onboarding::is_onboarded(app.handle()) {
                ensure_input_monitoring_access();
                spawn_ptt(app.handle());
            }
            // Menu-bar status item: the only always-visible way to quit/restart
            // Kairo or reopen the notch, since we run Dock-less (Accessory).
            if let Err(error) = create_menu_bar_tray(app) {
                klog!(app, error, "failed to create menu bar tray: {error}");
            }
            // Sequoia periodically resets Screen Recording. Only heads-up when already onboarded
            // (during onboarding, Act 3 owns Screen Recording); the notch shows a friendly line.
            if crate::onboarding::is_onboarded(app.handle())
                && detect_screen_recording_reset(app.handle())
            {
                klog!(app, warn, "screen recording was reset by macOS since last run");
                let _ = app.handle().emit("permissions:screen-recording-reset", ());
            }
            // Deep link: after Google sign-in the browser redirects to
            // kairo://auth-callback?code=…; exchange the one-time code for a session token.
            // First front the onboarding window (if we're onboarding) so the browser's
            // "Return to Kairo" hand-off actually focuses the app — even a re-fired,
            // already-used code still fronts the window (the exchange just 400s harmlessly).
            // Outside onboarding there is no window to focus, so normal re-auth keeps the
            // Accessory / no-Space-switch design and never yanks the user's focus.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if url.scheme() != "kairo" {
                            continue;
                        }
                        crate::onboarding::focus_onboarding_window(&handle);
                        let code = url
                            .query_pairs()
                            .find(|(k, _)| k == "code")
                            .map(|(_, v)| v.into_owned());
                        if let Some(code) = code {
                            let handle = handle.clone();
                            tauri::async_runtime::spawn(async move {
                                crate::auth::exchange_code(&handle, &code).await;
                            });
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_active_app,
            get_permission_status,
            request_required_permissions,
            request_screen_recording,
            request_accessibility,
            open_permission_settings,
            request_microphone,
            request_input_monitoring,
            get_input_monitoring_status,
            restart_app,
            debug_log,
            debug_log_batch,
            get_display_bounds,
            capture_screen,
            framehash::capture_frame_hash,
            show_overlay,
            update_overlay,
            get_current_overlay_payload,
            hide_overlay,
            cursor_point,
            cursor_entrance,
            cursor_celebrate,
            cursor_release,
            cursor_arrived,
            cursor_active,
            arm_context_watch,
            disarm_context_watch,
            arm_follow_click,
            disarm_follow_click,
            show_notch,
            get_current_notch_payload,
            set_notch_hit_rect,
            hide_notch,
            run_tutor_turn,
            run_gate_turn,
            run_ack_turn,
            transcribe_audio,
            synthesize_speech,
            synthesize_speech_stream,
            save_gesture_debug_image,
            proxy::check_paywalled,
            onboarding::finish_onboarding,
            onboarding::replay_onboarding_cmd,
            onboarding::set_onboarding_step,
            onboarding::get_onboarding_step,
            onboarding::set_onboarding_ptt,
            onboarding::set_onboarding_click_through,
            start_ptt,
            onboarding::set_user_name,
            onboarding::get_user_name,
            accent::get_accent,
            accent::set_accent,
            auth::start_google_auth,
            auth::get_auth_status,
            auth::get_backend_jwt,
            auth::sign_out
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kairo Tutor");
}

#[cfg(test)]
mod tests {
    use crate::constants;
    use crate::env::{parse_local_env, provider_timeout_ms};
    use crate::grounding::ground_visual_targets;
    use crate::panels::notch_window_size;
    use crate::speech::{audio_filename, decode_audio_base64};
    use crate::tutor::{
        build_openrouter_messages, build_openrouter_request_body, select_openrouter_request_model,
    };
    use crate::types::{
        OverlayDisplayBounds, SynthesizeSpeechInput, TranscribeAudioInput, TutorActiveAppContext,
        TutorScreenInput, TutorTurnInput,
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
        assert_eq!(
            provider_timeout_ms(Some("0".to_string())),
            constants::OPENROUTER_REQUEST_TIMEOUT_MS
        );
        assert_eq!(
            provider_timeout_ms(Some("not-a-number".to_string())),
            constants::OPENROUTER_REQUEST_TIMEOUT_MS
        );
        assert_eq!(
            provider_timeout_ms(None),
            constants::OPENROUTER_REQUEST_TIMEOUT_MS
        );
    }

    #[test]
    fn openrouter_messages_use_openrouter_image_url_shape() {
        let input = sample_tutor_turn_input();

        let messages = build_openrouter_messages(&input, true).expect("messages should build");
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
        let body = build_openrouter_request_body(&input, "qwen/qwen3.6-flash", true)
            .expect("body should build");

        assert_eq!(body["model"], "qwen/qwen3.6-flash");
        assert_eq!(body["response_format"]["type"], "json_object");
    }

    #[test]
    fn openrouter_request_body_can_omit_screenshot_for_text_fallback() {
        let input = sample_tutor_turn_input();
        let body = build_openrouter_request_body(&input, "qwen/qwen3.6-flash", false)
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
            constants::OPENROUTER_VISION_MODEL,
        );

        assert_eq!(model, constants::OPENROUTER_VISION_MODEL);
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
            constants::OPENROUTER_VISION_MODEL,
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

        let grounded = ground_visual_targets(raw, None);
        let parsed: serde_json::Value =
            serde_json::from_str(&grounded).expect("grounded response should stay JSON");

        assert_eq!(parsed["visualTargets"][0]["kind"], "pointer");
        assert_eq!(parsed["visualTargets"][0]["targetId"], "rectangle-tool");
        assert_eq!(parsed["visualTargets"][0]["screenRegion"]["x"], 820.0);
    }

    #[test]
    fn mock_speech_synthesis_returns_silent_audio_result() {
        std::env::set_var("KAIRO_TTS_PROVIDER", "mock");

        let result = tauri::async_runtime::block_on(crate::speech::synthesize_speech(
            SynthesizeSpeechInput {
                text: "Hello from Kairo.".to_string(),
                timeout_ms: None,
            },
        ))
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
                image_geometry: None,
            },
            skill_slug: "figma-first-animation".to_string(),
            constraints: vec!["Return one short tutor step.".to_string()],
            recent_context: None,
            spoken_intro: None,
            user_name: None,
        }
    }
}
