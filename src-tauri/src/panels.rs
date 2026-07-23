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
                    // Broadcast app-wide so the cursor pet, the overlay (cosmetic gesture
                    // render) and the notch (truth buffer) all receive it. Payload is
                    // physical px, global top-left; each webview scales as needed.
                    let _ = app.emit("cursor:mouse", MousePoint { x, y });
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

/// Should the notch trap the click at `cursor`? True ONLY when a capsule rect is
/// reported AND the cursor is inside it (+ a small margin for unit rounding). No rect
/// means the notch is showing nothing interactive (idle / the follow-along "waiting
/// for your click" state), so it must be click-THROUGH — otherwise its big transparent
/// frame swallows clicks meant for a highlighted target sitting under it.
/// `window_pos` + `rect` are in physical pixels / CSS px respectively; `scale` maps
/// the CSS-px rect into the physical-pixel cursor space.
fn notch_hit_wants_clickable(
    rect: Option<(f64, f64, f64, f64)>,
    cursor: (f64, f64),
    window_pos: (f64, f64),
    scale: f64,
) -> bool {
    let Some((left, top, w, h)) = rect else {
        return false;
    };
    let margin = 6.0 * scale;
    let x0 = window_pos.0 + left * scale - margin;
    let y0 = window_pos.1 + top * scale - margin;
    let x1 = x0 + w * scale + 2.0 * margin;
    let y1 = y0 + h * scale + 2.0 * margin;
    cursor.0 >= x0 && cursor.0 <= x1 && cursor.1 >= y0 && cursor.1 <= y1
}

// Make the notch panel click-through everywhere EXCEPT the visible capsule. The notch
// window covers a large frame (760x236) but the visible capsule is small (or absent),
// so without this the transparent area around it swallows every click. The frontend
// reports the capsule's rect (CSS px, viewport-relative) into NotchState.hit_rect, or
// null when nothing interactive is shown; here we poll the global cursor and flip
// ignore-cursor-events via `notch_hit_wants_clickable`. No rect → click-through so a
// highlighted target under the notch still receives the click.
pub(crate) fn spawn_notch_hit_tracker(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // Log only on a state flip (24ms polling would otherwise flood). We do NOT cache
        // "already applied" to skip the set: `configure_notch_window` and others change
        // ignore_cursor_events behind our back, so a cache would desync and leave the
        // transparent frame swallowing clicks. Re-applying every tick is idempotent + cheap.
        let mut last_logged: Option<bool> = None;
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
                continue; // hidden window receives no clicks — nothing to guard
            }
            let rect = notch_state.hit_rect.lock().ok().and_then(|guard| *guard);
            let scale = window.scale_factor().unwrap_or(1.0);
            // Trap the click ONLY over the visible capsule. No rect (idle / guidance
            // wait) OR an unknown window position → click-through, so a highlighted
            // target under the notch's big transparent frame still gets the click.
            let want_clickable = match window.outer_position() {
                Ok(pos) => notch_hit_wants_clickable(
                    rect,
                    (cursor.x, cursor.y),
                    (pos.x as f64, pos.y as f64),
                    scale,
                ),
                Err(_) => false,
            };
            // ALWAYS re-apply — the only reliable defense against a desynced actual state.
            let _ = window.set_ignore_cursor_events(!want_clickable);
            if last_logged != Some(want_clickable) {
                crate::klog!(notch, debug, clickable = want_clickable, "notch hit state");
                last_logged = Some(want_clickable);
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
    let is_gesture = payload.mode.as_deref() == Some("gesture");
    let shows_user_marks = matches!(
        payload.mode.as_deref(),
        Some("annotate") | Some("annotation_preview")
    );
    if is_gesture {
        // The cosmetic gesture layer is on-screen only — the notch composites the
        // truth marks in code. Never let it enter the tutor capture, regardless of
        // the SHOW_IN_CAPTURE dev toggle.
        exclude_window_from_screen_capture(window);
    } else if shows_user_marks || constants::SHOW_IN_CAPTURE {
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
    // Default to click-THROUGH: the notch is a big transparent frame, so it must not
    // swallow clicks. The hit-tracker re-enables clicks precisely over the visible
    // capsule each tick. (Was `false`/clickable here, which — combined with the
    // tracker's old cache — left the whole frame catching clicks after every show.)
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| format!("Failed to make notch click-through: {error}"))?;
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
    // The morph happens INSIDE this fixed frame; the capsule sizes itself via the measured
    // --capsule-w/-h (see NotchCapsule/useCapsuleMorph). 760×236 clears the widest state
    // (typing ≈680px, coach caption ≤520px) and the 44px notch-clearing top padding.
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
    // The typing prompt (state "captured") is the ONLY notch state that needs the
    // keyboard — so it's the only one allowed to take the key window. Every other
    // state (thinking / listening / answer / guide step) just DISPLAYS a card, so it
    // shows non-key. Taking key elsewhere would steal focus from the user's app and
    // dismiss any open context menu / dropdown / popover (in ANY app) — see the
    // right-click guide flow, where the answer card's key-grab killed the menu.
    let is_prompt_mode = payload
        .as_ref()
        .map(|payload| payload.state == "captured")
        .unwrap_or(false);
    let log_state = payload
        .as_ref()
        .map(|payload| payload.state.clone())
        .unwrap_or_default();
    configure_notch_window(&window, payload.as_ref())?;
    if let Some(payload) = payload {
        store_notch_payload_inner(state, Some(payload.clone()))?;
        emit_notch_payload(&window, payload)?;
    }
    if is_prompt_mode {
        // Typing box → take key so keystrokes land in the input.
        panel.show_and_make_key();
    } else {
        // Display card → orderFrontRegardless: visible, on top, but NEVER key, so it
        // can't steal focus or dismiss the user's menus. Same call the pointer overlay
        // uses for click-through guidance.
        panel.show();
    }
    crate::klog!(notch, debug, state = %log_state, key = is_prompt_mode, "notch show");

    Ok(())
}

pub(crate) fn listening_notch_payload() -> NotchPayload {
    NotchPayload {
        state: "listening".to_string(),
        layout: Some("compact".to_string()),
        title: "Kairo is listening".to_string(),
        detail: "Capturing the current screen".to_string(),
        chip: None,
        meter: None,
    }
}

// ⌘⇧Space now just opens the notch for TYPING (voice is push-to-talk via ⌥⌃).
pub(crate) fn typing_notch_payload() -> NotchPayload {
    NotchPayload {
        state: "captured".to_string(),
        layout: Some("prompt".to_string()),
        title: "Ask Kairo".to_string(),
        detail: "Type a question, or hold ⌥⌃ to talk".to_string(),
        chip: None,
        meter: None,
    }
}

#[cfg(test)]
mod notch_hit_tests {
    use super::notch_hit_wants_clickable;

    // Regression: the follow-along "waiting for your click" state reports NO capsule
    // rect. The notch must be click-through then, or it swallows the click meant for a
    // highlighted target under its frame (e.g. Figma's Design button at 1129,147).
    #[test]
    fn no_capsule_rect_is_click_through() {
        assert!(!notch_hit_wants_clickable(None, (1129.0, 147.0), (475.0, 12.0), 1.0));
    }

    #[test]
    fn cursor_inside_capsule_traps_the_click() {
        // Capsule at window-local (330,10) size 100x40; window at (475,12); scale 1.
        let rect = Some((330.0, 10.0, 100.0, 40.0));
        assert!(notch_hit_wants_clickable(rect, (855.0, 30.0), (475.0, 12.0), 1.0));
    }

    #[test]
    fn cursor_outside_capsule_is_click_through() {
        let rect = Some((330.0, 10.0, 100.0, 40.0));
        // The Design target at (1129,147) is far outside the small capsule → pass through.
        assert!(!notch_hit_wants_clickable(rect, (1129.0, 147.0), (475.0, 12.0), 1.0));
    }
}
