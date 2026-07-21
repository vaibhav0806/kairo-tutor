//! User accent preference: the chosen highlight hue (`#rrggbb`). Persisted as a plain file in the
//! app config dir (same pattern as auth's session.token / onboarding markers) and mirrored into a
//! process-global cache so leaf utilities (color.rs) can read it with no plumbing. `set_accent`
//! also emits the app-global `accent:changed { hex }` event so every webview recolors live.

use std::sync::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::constants;

// Process-global current accent. None until init/first set → callers fall back to DEFAULT_ACCENT.
static CURRENT_ACCENT: RwLock<Option<String>> = RwLock::new(None);

/// True for a `#rrggbb` string (leading `#`, exactly 6 hex digits). Everything else is rejected.
pub(crate) fn valid_hex(hex: &str) -> bool {
    let bytes = hex.as_bytes();
    bytes.len() == 7
        && bytes[0] == b'#'
        && bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
}

fn accent_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("accent"))
}

fn read_stored(app: &AppHandle) -> Option<String> {
    let raw = std::fs::read_to_string(accent_path(app)?).ok()?;
    let hex = raw.trim().to_string();
    if valid_hex(&hex) { Some(hex) } else { None }
}

fn set_cache(hex: &str) {
    if let Ok(mut guard) = CURRENT_ACCENT.write() {
        *guard = Some(hex.to_string());
    }
}

/// The current accent for native leaf code (color.rs). Cache first, then DEFAULT_ACCENT.
pub(crate) fn current() -> String {
    CURRENT_ACCENT
        .read()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(|| constants::DEFAULT_ACCENT.to_string())
}

/// Load the persisted accent into the cache at startup (call once from `setup`).
pub(crate) fn init_accent(app: &AppHandle) {
    if let Some(hex) = read_stored(app) {
        set_cache(&hex);
        crate::klog!(app, info, accent = %hex, "accent loaded from disk");
    } else {
        crate::klog!(app, info, accent = %constants::DEFAULT_ACCENT, "accent default (none stored)");
    }
}

#[derive(Serialize, Clone)]
struct AccentChanged {
    hex: String,
}

/// The user's chosen accent (or the brand default). `#rrggbb`.
#[tauri::command]
pub(crate) fn get_accent(app: AppHandle) -> String {
    read_stored(&app).unwrap_or_else(|| constants::DEFAULT_ACCENT.to_string())
}

/// Persist a new accent (app config file), refresh the cache, and broadcast `accent:changed`.
/// (The account copy is written at sign-in — Phase 6 — not here.)
#[tauri::command]
pub(crate) fn set_accent(app: AppHandle, hex: String) -> Result<(), String> {
    if !valid_hex(&hex) {
        crate::klog!(app, warn, accent = %hex, "rejected invalid accent");
        return Err("accent must be #rrggbb".to_string());
    }
    let path = accent_path(&app).ok_or("no config dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir: {e}"))?;
    }
    std::fs::write(&path, hex.as_bytes()).map_err(|e| format!("write: {e}"))?;
    set_cache(&hex);
    let _ = app.emit("accent:changed", AccentChanged { hex: hex.clone() });
    crate::klog!(app, info, accent = %hex, "accent set");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::valid_hex;

    #[test]
    fn accepts_six_digit_hex() {
        assert!(valid_hex("#7c3aed"));
        assert!(valid_hex("#FFFFFF"));
    }

    #[test]
    fn rejects_bad_hex() {
        assert!(!valid_hex("7c3aed")); // no #
        assert!(!valid_hex("#fff")); // too short
        assert!(!valid_hex("#zzzzzz")); // non-hex
        assert!(!valid_hex("#7c3aed0")); // too long
    }
}
