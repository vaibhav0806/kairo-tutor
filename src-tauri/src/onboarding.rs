//! First-run onboarding: the transparent onboarding window's lifecycle, resume-step
//! persistence (Screen Recording forces a relaunch mid-flow), and the commands the
//! onboarding WebView invokes.

use std::sync::atomic::Ordering;
use tauri::Manager;

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

/// Create + show the borderless, transparent onboarding window — its own floating surface with no
/// title bar and no chrome. The caller sets Regular activation policy so it can take keyboard focus.
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
    .inner_size(480.0, 660.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(true) // macOS casts a clean rounded shadow from the opaque content
    .center()
    .focused(true)
    .build();
    match built {
        Ok(_) => crate::klog!(app, info, "onboarding window created"),
        Err(error) => crate::klog!(app, error, "failed to create onboarding window: {error}"),
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
    if let Some(win) = app.get_webview_window("onboarding") {
        let _ = win.close();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    crate::klog!(app, info, "onboarding finished");
}
