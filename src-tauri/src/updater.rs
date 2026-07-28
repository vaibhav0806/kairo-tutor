//! Self-update over the Tauri updater plugin.
//!
//! Signed with our own minisign keypair, which is independent of Apple codesigning — the alpha
//! ships unnotarized, so this is the only way a fix reaches an installed user without asking them
//! to re-download a DMG and re-run the quarantine command.
//!
//! Deliberately never silent: we check in the background and surface a banner, but the download +
//! install only run when the user asks. Swapping the app bundle under someone mid-lesson is worse
//! than shipping the fix an hour later.

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Wait before the first check so it never competes with launch (permissions, panels, auth).
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
/// Re-check cadence for a long-running session.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    pub(crate) version: String,
    pub(crate) current_version: String,
    pub(crate) notes: Option<String>,
}

/// Ask the update endpoint whether a newer build exists. `None` = already current.
async fn fetch_update(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app
        .updater()
        .map_err(|error| format!("updater unavailable: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("update check failed: {error}"))?;

    Ok(update.map(|update| UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
    }))
}

/// Command: "Check for updates" in Settings, and the launch/interval check.
#[tauri::command]
pub(crate) async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let _t = crate::klog::timer("app", "update_check");
    match fetch_update(&app).await {
        Ok(Some(info)) => {
            crate::klog!(app, info, version = %info.version, current = %info.current_version, "update available");
            Ok(Some(info))
        }
        Ok(None) => {
            crate::klog!(app, debug, "no update available");
            Ok(None)
        }
        Err(message) => {
            // An unreachable endpoint or an unconfigured pubkey (dev builds) must not look like a
            // crash — the caller shows "couldn't check" and moves on.
            crate::klog!(app, warn, error = %message, "update check failed");
            Err(message)
        }
    }
}

/// Command: download + install the pending update, then restart into it.
#[tauri::command]
pub(crate) async fn install_update(app: AppHandle) -> Result<(), String> {
    let _t = crate::klog::timer("app", "update_install");
    let updater = app
        .updater()
        .map_err(|error| format!("updater unavailable: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("update check failed: {error}"))?
        .ok_or_else(|| "No update is available.".to_string())?;

    let version = update.version.clone();
    let mut downloaded = 0usize;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk;
                // Progress is emitted, not logged per chunk — the log would drown in noise.
                let _ = app.emit(
                    "updater:progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            },
            || {
                crate::klog!(app, info, "update download finished; installing");
            },
        )
        .await
        .map_err(|error| {
            crate::klog!(app, error, error = %error.to_string(), "update install failed");
            format!("update install failed: {error}")
        })?;

    crate::klog!(app, info, version = %version, "update installed; restarting");
    // The new bundle is only live after a restart. Signed with the SAME identity as the running
    // build, so macOS keeps the app's TCC grants (Screen Recording, Accessibility, Input
    // Monitoring) — a release signed under a different identity would silently reset them.
    app.restart();
}

/// Background poll: one delayed check at launch, then every `CHECK_INTERVAL`. Emits
/// `updater:available` so any open window can surface it; never installs on its own.
pub(crate) fn spawn_update_watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            match fetch_update(&app).await {
                Ok(Some(info)) => {
                    crate::klog!(app, info, version = %info.version, "background update check found a new version");
                    let _ = app.emit("updater:available", info);
                }
                Ok(None) => {}
                Err(message) => {
                    crate::klog!(app, debug, error = %message, "background update check failed");
                }
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}
