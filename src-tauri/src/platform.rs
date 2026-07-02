//! Frontmost-app introspection (name, bundle id, window title, browser URL) and
//! the sensitive-app guard, plus the `get_active_app` command.

use crate::types::ActiveApp;
use std::process::Command;

#[cfg(target_os = "macos")]
pub(crate) fn run_osascript(script: &str) -> Option<String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn frontmost_app_name() -> Option<String> {
    run_osascript(
        r#"tell application "System Events" to get name of first process whose frontmost is true"#,
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn frontmost_bundle_id() -> Option<String> {
    run_osascript(
        r#"tell application "System Events" to get bundle identifier of first process whose frontmost is true"#,
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn frontmost_window_title() -> Option<String> {
    run_osascript(
        r#"tell application "System Events" to tell (first process whose frontmost is true) to get name of front window"#,
    )
}

// Best-effort active-tab URL for known browsers via AppleScript. Needs macOS
// Automation permission (prompts once per browser); returns None if denied or the
// app is unknown, so callers fall back to the window title. Firefox exposes no
// scripting access to tab URLs, so it's intentionally absent.
#[cfg(target_os = "macos")]
pub(crate) fn frontmost_browser_url(bundle_id: Option<&str>) -> Option<String> {
    let script = match bundle_id? {
        "com.google.Chrome" | "com.google.Chrome.canary" => {
            r#"tell application "Google Chrome" to get URL of active tab of front window"#
        }
        "com.brave.Browser" => {
            r#"tell application "Brave Browser" to get URL of active tab of front window"#
        }
        "com.microsoft.edgemac" => {
            r#"tell application "Microsoft Edge" to get URL of active tab of front window"#
        }
        "com.operasoftware.Opera" => {
            r#"tell application "Opera" to get URL of active tab of front window"#
        }
        "com.vivaldi.Vivaldi" => {
            r#"tell application "Vivaldi" to get URL of active tab of front window"#
        }
        "company.thebrowser.Browser" => {
            r#"tell application "Arc" to get URL of active tab of front window"#
        }
        "com.apple.Safari" => r#"tell application "Safari" to get URL of front document"#,
        _ => return None,
    };
    run_osascript(script)
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
}
#[cfg(not(target_os = "macos"))]
pub(crate) fn frontmost_browser_url(_bundle_id: Option<&str>) -> Option<String> {
    None
}

#[tauri::command]
pub(crate) fn get_active_app() -> ActiveApp {
    #[cfg(target_os = "macos")]
    {
        let bundle_id = frontmost_bundle_id();
        let url = frontmost_browser_url(bundle_id.as_deref());
        return ActiveApp {
            active_app: frontmost_app_name().unwrap_or_else(|| "Unknown App".to_string()),
            bundle_id,
            window_title: frontmost_window_title(),
            url,
            source: "native".to_string(),
        };
    }

    #[cfg(not(target_os = "macos"))]
    {
        ActiveApp {
            active_app: "Unsupported Platform".to_string(),
            bundle_id: None,
            window_title: None,
            url: None,
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
