//! NSPanel lifecycle + window plumbing for the notch, annotation overlay, and
//! companion cursor surfaces, plus payload store/emit helpers.

#[cfg(target_os = "macos")]
use crate::capture::main_display_bounds;
use crate::constants;
use crate::types::{CursorVisible, MousePoint, NotchPayload, OverlayPayload};
use crate::{CursorPanel, CursorState, NotchPanel, NotchState, OverlayPanel, OverlayState};
use std::time::Duration;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, State};
use tauri_nspanel::{CollectionBehavior, PanelHandle, StyleMask, WebviewWindowExt};

pub(crate) fn ensure_configured_window(
    app: &tauri::AppHandle,
    label: &str,
) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(label) {
        return Ok(window);
    }

    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window_config| window_config.label == label)
        .ok_or_else(|| format!("Kairo {label} window config was not found."))?;

    tauri::WebviewWindowBuilder::from_config(app, window_config)
        .map_err(|error| format!("Failed to read {label} window config: {error}"))?
        .build()
        .map_err(|error| format!("Failed to create {label} window: {error}"))
}

// Hide a Kairo window from screen capture/recording — including our own
// screenshot of the user's screen — so the tutor never sees Kairo's own UI
// (the notch/overlay). This is the same NSWindowSharingNone trick Loom/CleanShot
// use to keep themselves out of captures.
#[cfg(target_os = "macos")]
pub(crate) fn exclude_window_from_screen_capture(window: &tauri::WebviewWindow) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    if ns_window_ptr.is_null() {
        return;
    }
    let ns_window: &objc2_app_kit::NSWindow =
        unsafe { &*(ns_window_ptr as *const objc2_app_kit::NSWindow) };
    #[allow(deprecated)]
    ns_window.setSharingType(objc2_app_kit::NSWindowSharingType::None);
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn exclude_window_from_screen_capture(_window: &tauri::WebviewWindow) {}

// Make a window appear in screen capture again (ReadOnly = the default). Used so the
// user's pen marks are visible to the tutor's own screenshot even while other Kairo
// UI stays hidden.
#[cfg(target_os = "macos")]
pub(crate) fn include_window_in_screen_capture(window: &tauri::WebviewWindow) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    if ns_window_ptr.is_null() {
        return;
    }
    let ns_window: &objc2_app_kit::NSWindow =
        unsafe { &*(ns_window_ptr as *const objc2_app_kit::NSWindow) };
    #[allow(deprecated)]
    ns_window.setSharingType(objc2_app_kit::NSWindowSharingType::ReadOnly);
}
#[cfg(not(target_os = "macos"))]
pub(crate) fn include_window_in_screen_capture(_window: &tauri::WebviewWindow) {}

// Lazily create the notch window, convert it to a non-activating NSPanel, and
// apply the level / style / collection behavior that let it float over
// full-screen Spaces. Idempotent: returns the existing panel once converted.
pub(crate) fn ensure_notch_panel(
    app: &tauri::AppHandle,
) -> Result<PanelHandle<tauri::Wry>, String> {
    let notch_state = app.state::<NotchState>();
    if let Some(panel) = notch_state
        .panel
        .lock()
        .map_err(|_| "Failed to lock notch panel state.".to_string())?
        .clone()
    {
        return Ok(panel);
    }

    let window = ensure_configured_window(app, "notch")?;
    let panel = window
        .to_panel::<NotchPanel>()
        .map_err(|error| format!("Failed to convert notch window to panel: {error}"))?;

    // Sit above the annotation overlay (level 1000) so the notch's annotation
    // toolbar (pen/done/undo/clear) stays reachable while the user draws.
    panel.set_level(1001);
    // Non-activating: take key/input without activating the app (no Space switch).
    panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .full_screen_auxiliary()
            .can_join_all_spaces()
            .stationary()
            .into(),
    );
    // No macOS window drop shadow — the rounded card draws its own depth.
    panel.set_has_shadow(false);
    // Deliver mouse-moved events so CSS :hover works while the panel is shown
    // over another (possibly full-screen) app without activating it.
    panel.set_accepts_mouse_moved_events(true);
    // Keep the panel alive across hide/show so the shortcut can reopen it.
    panel.set_released_when_closed(false);
    // Hide the notch from all screen capture (screenshots/recordings + the tutor's
    // own screenshot) unless SHOW_IN_CAPTURE is set (e.g. for a demo).
    if !constants::SHOW_IN_CAPTURE {
        exclude_window_from_screen_capture(&window);
    }

    *notch_state
        .window
        .lock()
        .map_err(|_| "Failed to lock notch window state.".to_string())? = Some(window);
    *notch_state
        .panel
        .lock()
        .map_err(|_| "Failed to lock notch panel state.".to_string())? = Some(panel.clone());

    Ok(panel)
}

pub(crate) fn ensure_overlay_panel(
    app: &tauri::AppHandle,
) -> Result<PanelHandle<tauri::Wry>, String> {
    let overlay_state = app.state::<OverlayState>();
    if let Some(panel) = overlay_state
        .panel
        .lock()
        .map_err(|_| "Failed to lock overlay panel state.".to_string())?
        .clone()
    {
        return Ok(panel);
    }

    let window = ensure_configured_window(app, "overlay")?;
    let panel = window
        .to_panel::<OverlayPanel>()
        .map_err(|error| format!("Failed to convert overlay window to panel: {error}"))?;

    // Below the notch (1001) so its toolbar stays reachable, above app content.
    panel.set_level(1000);
    // Non-activating + can-become-key: the user can draw without activating Kairo
    // (no Space switch). A plain borderless window can't become key, so it can't
    // catch draw clicks at all.
    panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .full_screen_auxiliary()
            .can_join_all_spaces()
            .stationary()
            .into(),
    );
    panel.set_has_shadow(false);
    // Needed so pen drags (pointermove) fire while the panel is key over another app.
    panel.set_accepts_mouse_moved_events(true);
    panel.set_released_when_closed(false);
    // Hide the overlay (annotations + AI pointer) from screen capture by default, so
    // screenshots/recordings stay clean. The user still SEES it on screen (capture
    // exclusion doesn't affect display). SHOW_IN_CAPTURE makes it captured —
    // which also lets the tutor's own screenshot include the user's pen marks.
    if !constants::SHOW_IN_CAPTURE {
        exclude_window_from_screen_capture(&window);
    }

    *overlay_state
        .window
        .lock()
        .map_err(|_| "Failed to lock overlay window state.".to_string())? = Some(window);
    *overlay_state
        .panel
        .lock()
        .map_err(|_| "Failed to lock overlay panel state.".to_string())? = Some(panel.clone());

    Ok(panel)
}

pub(crate) fn overlay_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    ensure_overlay_panel(app)?;
    app.state::<OverlayState>()
        .window
        .lock()
        .map_err(|_| "Failed to lock overlay window state.".to_string())?
        .clone()
        .ok_or_else(|| "Overlay panel has no backing window".to_string())
}

// Lazily create the companion cursor panel: an always-on, full-display,
// permanently click-through NSPanel that floats above everything (including the
// notch) and never intercepts input. Capture-excluded like the other Kairo
// surfaces so the pet never lands in the tutor's own grounding screenshots.
pub(crate) fn ensure_cursor_panel(
    app: &tauri::AppHandle,
) -> Result<PanelHandle<tauri::Wry>, String> {
    let cursor_state = app.state::<CursorState>();
    if let Some(panel) = cursor_state
        .panel
        .lock()
        .map_err(|_| "Failed to lock cursor panel state.".to_string())?
        .clone()
    {
        return Ok(panel);
    }

    let window = ensure_configured_window(app, "cursor")?;
    let panel = window
        .to_panel::<CursorPanel>()
        .map_err(|error| format!("Failed to convert cursor window to panel: {error}"))?;

    // Above the notch (1001) and overlay (1000) so the pet is always visible;
    // safe because it is click-through, so z-order is purely visual.
    panel.set_level(1002);
    panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .full_screen_auxiliary()
            .can_join_all_spaces()
            .stationary()
            .into(),
    );
    panel.set_has_shadow(false);
    panel.set_released_when_closed(false);
    // Permanently click-through: the pet must never catch the user's clicks.
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| format!("Failed to make cursor click-through: {error}"))?;

    #[cfg(target_os = "macos")]
    {
        let bounds = main_display_bounds();
        window
            .set_position(LogicalPosition::new(bounds.x, bounds.y))
            .map_err(|error| format!("Failed to position cursor window: {error}"))?;
        window
            .set_size(LogicalSize::new(bounds.width, bounds.height))
            .map_err(|error| format!("Failed to size cursor window: {error}"))?;
    }

    if !constants::SHOW_IN_CAPTURE {
        exclude_window_from_screen_capture(&window);
    }

    *cursor_state
        .window
        .lock()
        .map_err(|_| "Failed to lock cursor window state.".to_string())? = Some(window);
    *cursor_state
        .panel
        .lock()
        .map_err(|_| "Failed to lock cursor panel state.".to_string())? = Some(panel.clone());

    Ok(panel)
}

pub(crate) fn cursor_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    ensure_cursor_panel(app)?;
    app.state::<CursorState>()
        .window
        .lock()
        .map_err(|_| "Failed to lock cursor window state.".to_string())?
        .clone()
        .ok_or_else(|| "Cursor panel has no backing window".to_string())
}

// Whether the SYSTEM mouse cursor is currently visible. macOS hides the real
// cursor while the user types (each app calls `NSCursor setHiddenUntilMouseMoves`)
// and in a few other cases (e.g. fullscreen video); we mirror that state onto the
// companion pet so it vanishes in exact lockstep with the real cursor. Uses the
// deprecated-but-still-functional CGCursorIsVisible — there is no modern
// replacement, and reading it is the whole point (it reflects Quartz's hide
// counter, i.e. "the exact logic macOS uses").
#[cfg(target_os = "macos")]
fn system_cursor_visible() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGCursorIsVisible() -> std::os::raw::c_int;
    }
    // SAFETY: CGCursorIsVisible takes no arguments and returns a boolean_t; the
    // call has no preconditions and no side effects.
    unsafe { CGCursorIsVisible() != 0 }
}

#[cfg(not(target_os = "macos"))]
fn system_cursor_visible() -> bool {
    true
}

// Poll the global cursor position at ~60 Hz and push moves to the cursor window.
// Uses Tauri's cross-platform `cursor_position` (physical px, global top-left);
// we convert to logical points so the webview (which works in CSS px = points)
// can place the pet. Only emits on actual movement, so an idle mouse costs almost
// nothing. The same loop mirrors the system cursor's visibility onto the pet
// (item 1: hide while typing) via `cursor:visible`; frontend layers idle-hide on top.
pub(crate) fn spawn_mouse_tracker(app: &tauri::AppHandle) {
    let window = match app.state::<CursorState>().window.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => None,
    };
    let Some(window) = window else {
        crate::klog!(
            cursor,
            warn,
            "cursor window missing; mouse tracker not started"
        );
        return;
    };
    let app = app.clone();

    std::thread::spawn(move || {
        let mut last: Option<(f64, f64)> = None;
        let mut idle_ticks: u32 = 0;
        let mut last_sys_visible: Option<bool> = None;
        loop {
            // cursor_position is in PHYSICAL pixels (global, top-left). We emit it
            // raw; the cursor webview divides by its own devicePixelRatio to get
            // CSS px. The CGDisplay-derived scale factor is unreliable in macOS
            // scaled-HiDPI modes (reports 1 even on a 2x backing scale), so the
            // webview's devicePixelRatio is the authoritative conversion.
            if let Ok(position) = app.cursor_position() {
                let (x, y) = (position.x, position.y);
                let moved = match last {
                    Some((px, py)) => (x - px).abs() > 0.4 || (y - py).abs() > 0.4,
                    None => true,
                };
                // Re-emit at least every ~300ms even when still, so a freshly
                // loaded cursor webview always gets a position (it can't replay
                // events emitted before its listener attached).
                if moved || idle_ticks >= 18 {
                    last = Some((x, y));
                    idle_ticks = 0;
                    let _ = window.emit("cursor:mouse", MousePoint { x, y });
                } else {
                    idle_ticks += 1;
                }
            }

            // Mirror the system cursor's visibility onto the pet (item 1: hide while
            // typing). Emit only on change; the first tick always emits so a freshly
            // loaded webview learns the initial state.
            let sys_visible = system_cursor_visible();
            if last_sys_visible != Some(sys_visible) {
                last_sys_visible = Some(sys_visible);
                let _ = window.emit(
                    "cursor:visible",
                    CursorVisible {
                        visible: sys_visible,
                    },
                );
                crate::klog!(
                    cursor,
                    debug,
                    visible = sys_visible,
                    "system cursor visibility changed"
                );
            }

            std::thread::sleep(Duration::from_millis(16));
        }
    });
}

// Make the notch panel click-through everywhere EXCEPT the capsule. The notch
// window covers a large frame (760x236) but the visible capsule is small, so
// without this the transparent area around it swallows every click. The frontend
// reports the capsule's rect (CSS px, viewport-relative) into NotchState.hit_rect;
// here we poll the global cursor and flip ignore-cursor-events when it crosses the
// capsule boundary. Fail-safe: when no rect is reported (or the notch is hidden)
// the notch stays fully clickable rather than trapping the capsule.
pub(crate) fn spawn_notch_hit_tracker(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // None = unknown (force the first toggle); Some(bool) = last applied state.
        let mut applied: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(24));
            let Ok(cursor) = app.cursor_position() else {
                continue;
            };
            let notch_state = app.state::<NotchState>();
            let window = match notch_state.window.lock() {
                Ok(guard) => guard.clone(),
                Err(_) => None,
            };
            let Some(window) = window else { continue };
            if !window.is_visible().unwrap_or(false) {
                // Hidden: nothing to click; leave it clickable so the next show is ready.
                if applied != Some(true) {
                    let _ = window.set_ignore_cursor_events(false);
                    applied = Some(true);
                }
                continue;
            }
            let rect = notch_state.hit_rect.lock().ok().and_then(|guard| *guard);
            let want_clickable = match rect {
                // Capsule rect known → clickable only when the cursor is over it (+ a
                // small margin for unit rounding). Everywhere else → click-through.
                Some((left, top, w, h)) => {
                    let scale = window.scale_factor().unwrap_or(1.0);
                    match window.outer_position() {
                        Ok(pos) => {
                            let margin = 6.0 * scale;
                            let x0 = pos.x as f64 + left * scale - margin;
                            let y0 = pos.y as f64 + top * scale - margin;
                            let x1 = x0 + w * scale + 2.0 * margin;
                            let y1 = y0 + h * scale + 2.0 * margin;
                            cursor.x >= x0 && cursor.x <= x1 && cursor.y >= y0 && cursor.y <= y1
                        }
                        Err(_) => true,
                    }
                }
                // No rect reported → fail safe to fully clickable (old behavior).
                None => true,
            };
            if applied != Some(want_clickable) {
                let _ = window.set_ignore_cursor_events(!want_clickable);
                applied = Some(want_clickable);
            }
        }
    });
}

pub(crate) fn configure_overlay_window(
    window: &tauri::WebviewWindow,
    payload: &OverlayPayload,
) -> Result<(), String> {
    let is_annotation_mode = payload.mode.as_deref() == Some("annotate");
    // Annotate mode: catch clicks/drags so the user can draw. Visual-guidance
    // mode: click-through so the user keeps interacting with their app. Level,
    // key-ability, collection behaviour and shadow are owned by the panel.
    window
        .set_ignore_cursor_events(!is_annotation_mode)
        .map_err(|error| format!("Failed to set overlay click-through: {error}"))?;
    window
        .set_position(LogicalPosition::new(
            payload.display_bounds.x,
            payload.display_bounds.y,
        ))
        .map_err(|error| format!("Failed to position overlay: {error}"))?;
    window
        .set_size(LogicalSize::new(
            payload.display_bounds.width,
            payload.display_bounds.height,
        ))
        .map_err(|error| format!("Failed to size overlay: {error}"))?;

    // Capture exclusion is MODE-BASED so the AI can see the user's pen marks even
    // with KAIRO_SHOW_IN_CAPTURE=false: INCLUDE the overlay while it shows the user's
    // drawing (annotate / preview) so the marks land in the tutor's screenshot, but
    // EXCLUDE it while it shows Kairo's own box (visual) so guidance stays out of
    // captures. With SHOW_IN_CAPTURE=true, always include (demo mode).
    let shows_user_marks = matches!(
        payload.mode.as_deref(),
        Some("annotate") | Some("annotation_preview")
    );
    if shows_user_marks || constants::SHOW_IN_CAPTURE {
        include_window_in_screen_capture(window);
    } else {
        exclude_window_from_screen_capture(window);
    }

    Ok(())
}

pub(crate) fn emit_overlay_payload(
    window: &tauri::WebviewWindow,
    payload: OverlayPayload,
) -> Result<(), String> {
    window
        .emit("overlay:update", payload)
        .map_err(|error| format!("Failed to update overlay targets: {error}"))
}

pub(crate) fn configure_notch_window(
    window: &tauri::WebviewWindow,
    payload: Option<&NotchPayload>,
) -> Result<(), String> {
    let (width, height) = notch_window_size(
        payload.and_then(|payload| payload.layout.as_deref()),
        payload.map(|payload| payload.state.as_str()),
    );
    window
        .set_skip_taskbar(true)
        .map_err(|error| format!("Failed to keep notch out of the taskbar: {error}"))?;
    window
        .set_ignore_cursor_events(false)
        .map_err(|error| format!("Failed to make notch clickable: {error}"))?;
    let _ = window.set_shadow(false);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| format!("Failed to size notch: {error}"))?;

    #[cfg(target_os = "macos")]
    {
        let display_bounds = main_display_bounds();
        window
            .set_position(LogicalPosition::new(
                display_bounds.x + (display_bounds.width - width) / 2.0,
                display_bounds.y + 12.0,
            ))
            .map_err(|error| format!("Failed to position notch: {error}"))?;
    }

    Ok(())
}

pub(crate) fn notch_window_size(layout: Option<&str>, state: Option<&str>) -> (f64, f64) {
    let _ = layout;
    let _ = state;
    (760.0, 236.0)
}

pub(crate) fn store_overlay_payload(
    state: &State<'_, OverlayState>,
    payload: Option<OverlayPayload>,
) -> Result<(), String> {
    let mut current_payload = state
        .current_payload
        .lock()
        .map_err(|_| "Failed to lock overlay payload state.".to_string())?;
    *current_payload = payload;
    Ok(())
}

pub(crate) fn emit_notch_payload(
    window: &tauri::WebviewWindow,
    payload: NotchPayload,
) -> Result<(), String> {
    window
        .emit("notch:update", payload)
        .map_err(|error| format!("Failed to update notch state: {error}"))
}

pub(crate) fn store_notch_payload(
    state: &State<'_, NotchState>,
    payload: Option<NotchPayload>,
) -> Result<(), String> {
    let mut current_payload = state
        .current_payload
        .lock()
        .map_err(|_| "Failed to lock notch payload state.".to_string())?;
    *current_payload = payload;
    Ok(())
}

pub(crate) fn store_notch_payload_inner(
    state: &NotchState,
    payload: Option<NotchPayload>,
) -> Result<(), String> {
    let mut current_payload = state
        .current_payload
        .lock()
        .map_err(|_| "Failed to lock notch payload state.".to_string())?;
    *current_payload = payload;
    Ok(())
}

pub(crate) fn show_notch_with_payload(
    app: &tauri::AppHandle,
    state: &NotchState,
    payload: Option<NotchPayload>,
) -> Result<(), String> {
    let panel = ensure_notch_panel(app)?;
    let window = state
        .window
        .lock()
        .map_err(|_| "Failed to lock notch window state.".to_string())?
        .clone()
        .ok_or_else(|| "Notch panel has no backing window.".to_string())?;
    let is_prompt_mode = payload
        .as_ref()
        .map(|payload| payload.state == "captured")
        .unwrap_or(false);
    configure_notch_window(&window, payload.as_ref())?;
    if let Some(payload) = payload {
        store_notch_payload_inner(state, Some(payload.clone()))?;
        emit_notch_payload(&window, payload)?;
    }
    // Always make the non-activating panel key: it can take keyboard focus and
    // deliver hover/mouse-move events for the UI without activating the app, so
    // it stays on the user's current (possibly full-screen) Space.
    let _ = is_prompt_mode;
    panel.show_and_make_key();

    Ok(())
}

pub(crate) fn listening_notch_payload() -> NotchPayload {
    NotchPayload {
        state: "listening".to_string(),
        layout: Some("compact".to_string()),
        title: "Kairo is listening".to_string(),
        detail: "Capturing the current screen".to_string(),
    }
}

// ⌘⇧Space now just opens the notch for TYPING (voice is push-to-talk via ⌥⌃).
pub(crate) fn typing_notch_payload() -> NotchPayload {
    NotchPayload {
        state: "captured".to_string(),
        layout: Some("prompt".to_string()),
        title: "Ask Kairo".to_string(),
        detail: "Type a question, or hold ⌥⌃ to talk".to_string(),
    }
}
