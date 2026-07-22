//! Frontmost-app introspection (name, bundle id, window title) and the sensitive-app guard, plus the
//! `get_active_app` command.
//!
//! Name + bundle id come from `NSWorkspace.frontmostApplication` (a plain, prompt-free read). We
//! deliberately do NOT use AppleScript against "System Events" — that trips the macOS Automation
//! prompt ("Kairo Tutor wants access to control System Events"), which is a jarring extra permission
//! ask for what should be a silent lookup.

use crate::types::ActiveApp;

// The frontmost application via NSWorkspace — no permission prompt, unlike the old System-Events
// AppleScript. Returns name + bundle id; window title isn't exposed here (see frontmost_window_title).
#[cfg(target_os = "macos")]
fn frontmost_running_app() -> Option<objc2::rc::Retained<objc2_app_kit::NSRunningApplication>> {
    let ws = objc2_app_kit::NSWorkspace::sharedWorkspace();
    ws.frontmostApplication()
}

#[cfg(target_os = "macos")]
pub(crate) fn frontmost_app_name() -> Option<String> {
    let app = frontmost_running_app()?;
    app.localizedName().map(|s| s.to_string())
}

#[cfg(target_os = "macos")]
pub(crate) fn frontmost_bundle_id() -> Option<String> {
    let app = frontmost_running_app()?;
    app.bundleIdentifier().map(|s| s.to_string())
}

#[cfg(target_os = "macos")]
pub(crate) fn frontmost_window_title() -> Option<String> {
    // Dropped on purpose: the only ways to read another app's window title are AppleScript against
    // "System Events" (triggers the Automation prompt — see image the user flagged) or the
    // Accessibility API. Not worth a permission prompt for optional gate context. A future AX-based
    // reader (reusing the Accessibility grant, no prompt) could restore it.
    None
}

#[tauri::command]
pub(crate) fn get_active_app() -> ActiveApp {
    #[cfg(target_os = "macos")]
    {
        return ActiveApp {
            active_app: frontmost_app_name().unwrap_or_else(|| "Unknown App".to_string()),
            bundle_id: frontmost_bundle_id(),
            window_title: frontmost_window_title(),
            source: "native".to_string(),
        };
    }

    #[cfg(not(target_os = "macos"))]
    {
        ActiveApp {
            active_app: "Unsupported Platform".to_string(),
            bundle_id: None,
            window_title: None,
            source: "native".to_string(),
        }
    }
}

pub(crate) fn is_sensitive_app(active_app: &ActiveApp) -> bool {
    let sensitive_bundle_ids = [
        "com.apple.keychainaccess",
        "com.apple.MobileSMS",
        "com.apple.mail",
        "com.apple.Photos",
        "com.apple.Passbook",
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.lastpass.LastPass",
        "com.bitwarden.desktop",
    ];
    let sensitive_name_terms = [
        "bank", "password", "keychain", "wallet", "messages", "mail", "whatsapp", "telegram",
        "photos",
    ];

    if let Some(bundle_id) = &active_app.bundle_id {
        if sensitive_bundle_ids
            .iter()
            .any(|sensitive_bundle_id| bundle_id == sensitive_bundle_id)
        {
            return true;
        }
    }

    let app_name = active_app.active_app.to_lowercase();
    let window_title = active_app
        .window_title
        .as_deref()
        .unwrap_or_default()
        .to_lowercase();

    sensitive_name_terms
        .iter()
        .any(|term| app_name.contains(term) || window_title.contains(term))
}
