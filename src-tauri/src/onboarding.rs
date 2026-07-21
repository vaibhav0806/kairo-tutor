//! First-run onboarding: the transparent onboarding window's lifecycle, resume-step
//! persistence (Screen Recording forces a relaunch mid-flow), and the commands the
//! onboarding WebView invokes.

use std::sync::atomic::Ordering;
use tauri::{LogicalPosition, LogicalSize, Manager};

fn onboarded_marker(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("onboarded"))
}

pub(crate) fn is_onboarded(app: &tauri::AppHandle) -> bool {
    onboarded_marker(app).map(|p| p.exists()).unwrap_or(false)
}

fn onboarding_step_marker(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("onboarding_step"))
}

/// Persist the furthest onboarding step reached. Screen Recording forces macOS to
/// quit + reopen the app when granted, so on relaunch we resume onboarding at the
/// saved step instead of restarting from the welcome screen.
#[tauri::command]
pub(crate) fn set_onboarding_step(app: tauri::AppHandle, step: String) {
    if let Some(path) = onboarding_step_marker(&app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, step.as_bytes());
    }
}

fn user_name_marker(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("user_name"))
}

/// Cache the user's display name (from their account) so every WebView can read it at launch
/// and inject it into tutor/gate prompts — no per-turn network round-trip. Written after sign-in
/// and backfilled from `/v1/me` for returning users. An empty name clears the cache.
#[tauri::command]
pub(crate) fn set_user_name(app: tauri::AppHandle, name: String) {
    let Some(path) = user_name_marker(&app) else {
        return;
    };
    let trimmed = name.trim();
    if trimmed.is_empty() {
        let _ = std::fs::remove_file(&path);
        crate::klog!(app, info, "user name cache cleared");
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, trimmed.as_bytes());
    crate::klog!(app, info, name_len = trimmed.len(), "user name cached");
}

/// The cached user display name (empty string if none / cleared).
#[tauri::command]
pub(crate) fn get_user_name(app: tauri::AppHandle) -> String {
    user_name_marker(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// The saved onboarding step id (empty string if none / cleared).
#[tauri::command]
pub(crate) fn get_onboarding_step(app: tauri::AppHandle) -> String {
    onboarding_step_marker(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// While set, the ⌥⌃ push-to-talk press is owned by the onboarding demo (its audio +
/// recording edges route to the onboarding window and the notch stays inert). Toggled
/// by the onboarding flow around each interactive practice step.
#[tauri::command]
pub(crate) fn set_onboarding_ptt(active: bool) {
    crate::input::ONBOARDING_PTT.store(active, Ordering::SeqCst);
    crate::klog!(ptt, info, active = active, "onboarding ptt ownership");
}

/// Bring the onboarding window to the front. Called on the auth-callback deep link so
/// the browser's "Return to Kairo" hand-off actually fronts the app (a plain deep link
/// wakes the process but doesn't focus our window). No-op outside onboarding — the
/// window only exists during first-run, so normal re-auth never steals focus.
pub(crate) fn focus_onboarding_window(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("onboarding") else {
        return;
    };
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        }
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        crate::klog!(auth, info, "focused onboarding window after auth callback");
    });
}

/// Create + show the full-screen, transparent, click-through onboarding orchestrator — it covers the
/// whole monitor and renders nothing most of the time (the desktop / pet / overlay show through). The
/// frontend flips it interactive (native `set_onboarding_click_through`) only while a temporary panel
/// (color wheel in Act 1, Google sign-in in Act 5) is mounted. The caller sets Regular activation
/// policy so it can take keyboard focus.
pub(crate) fn show_onboarding_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("onboarding") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(
        app,
        "onboarding",
        tauri::WebviewUrl::App("index.html#/onboarding".into()),
    )
    .title("Welcome to Kairo")
    .inner_size(1440.0, 900.0) // resized to the monitor below
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false) // full-screen surface: no drop shadow
    .always_on_top(true) // float above the desktop; the pet/overlay NSPanels sit even higher
    .skip_taskbar(true)
    .focused(true)
    .build();
    match built {
        Ok(win) => {
            fit_onboarding_to_screen(&win);
            // Default click-through: the desktop / pet / overlay show through and stay
            // interactive. The frontend flips it interactive while a temp panel is mounted.
            #[cfg(target_os = "macos")]
            let _ = win.set_ignore_cursor_events(true);
            crate::klog!(app, info, "onboarding window created (full-screen transparent)");
        }
        Err(error) => crate::klog!(app, error, "failed to create onboarding window: {error}"),
    }
}

/// Size + position the onboarding window to fully cover its monitor.
fn fit_onboarding_to_screen(win: &tauri::WebviewWindow) {
    match win.current_monitor() {
        Ok(Some(monitor)) => {
            let scale = monitor.scale_factor();
            let size = monitor.size().to_logical::<f64>(scale);
            let pos = monitor.position().to_logical::<f64>(scale);
            let _ = win.set_position(LogicalPosition::new(pos.x, pos.y));
            let _ = win.set_size(LogicalSize::new(size.width, size.height));
        }
        _ => crate::klog!(app, warn, "onboarding: no monitor found for full-screen fit"),
    }
}

/// Toggle whether the full-screen onboarding orchestrator catches clicks. Click-through by default
/// (desktop / pet / overlay stay interactive); the frontend flips it OFF while a temporary panel
/// (color wheel in Act 1, Google sign-in in Act 5) is mounted so that panel's controls are clickable.
#[tauri::command]
pub(crate) fn set_onboarding_click_through(app: tauri::AppHandle, click_through: bool) {
    if let Some(win) = app.get_webview_window("onboarding") {
        #[cfg(target_os = "macos")]
        let _ = win.set_ignore_cursor_events(click_through);
        crate::klog!(app, info, click_through = click_through, "onboarding click-through set");
    }
}

/// Called when the onboarding flow completes: persist the marker (so we never onboard again), close
/// the window, and drop back to the background (Accessory).
#[tauri::command]
pub(crate) fn finish_onboarding(app: tauri::AppHandle) {
    if let Some(path) = onboarded_marker(&app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, b"1");
    }
    // Clean up the resume marker + release any PTT ownership so a re-run (or a stray
    // ⌥⌃ press) behaves normally.
    if let Some(path) = onboarding_step_marker(&app) {
        let _ = std::fs::remove_file(path);
    }
    crate::input::ONBOARDING_PTT.store(false, Ordering::SeqCst);
    // Make sure the ⌥⌃ tap is running for the live product (idempotent — a no-op if Act 2 already
    // started it). Covers the edge where onboarding finished without the Act 2 primer starting it.
    crate::input::spawn_ptt(&app);
    if let Some(win) = app.get_webview_window("onboarding") {
        let _ = win.close();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    crate::klog!(app, info, "onboarding finished");
}

/// Re-run first-run onboarding on demand ("Replay intro" tray item / `replay_onboarding_cmd`).
/// The inverse of `finish_onboarding`: delete the onboarded marker + any stale resume step, drop
/// PTT ownership, flip back to Regular so the window can take keyboard focus, then (re)open the
/// onboarding window. Idempotent — safe to call while already onboarding.
pub(crate) fn replay_onboarding(app: &tauri::AppHandle) {
    if let Some(path) = onboarded_marker(app) {
        let _ = std::fs::remove_file(path);
    }
    if let Some(path) = onboarding_step_marker(app) {
        let _ = std::fs::remove_file(path);
    }
    crate::input::ONBOARDING_PTT.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
    show_onboarding_window(app);
    crate::klog!(app, info, "replay intro: onboarding marker cleared + window reopened");
}

/// Frontend/tray entry point for "Replay intro".
#[tauri::command]
pub(crate) fn replay_onboarding_cmd(app: tauri::AppHandle) {
    replay_onboarding(&app);
}
