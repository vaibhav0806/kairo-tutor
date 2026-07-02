use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::{channel, Sender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, State};
use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelHandle, StyleMask, WebviewWindowExt};
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

mod prompts;
use prompts::{box_locator_prompt, build_tutor_system_prompt, gate_system_prompt};

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

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use core_foundation::{
    base::TCFType,
    boolean::CFBoolean,
    dictionary::{CFDictionary, CFDictionaryRef},
    string::{CFString, CFStringRef},
};
#[cfg(target_os = "macos")]
use core_graphics::display::CGDisplay;
#[cfg(target_os = "macos")]
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveApp {
    active_app: String,
    bundle_id: Option<String>,
    window_title: Option<String>,
    /// Active-tab URL when the frontmost app is a supported browser (else None).
    url: Option<String>,
    source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionStatus {
    screen_recording: PermissionState,
    accessibility: PermissionState,
    microphone: PermissionState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum PermissionState {
    Granted,
    Denied,
    NotDetermined,
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenCaptureResult {
    captured: bool,
    reason: Option<String>,
    blocked_sensitive_app: bool,
    active_app: Option<ActiveApp>,
    image_mime_type: Option<String>,
    image_base64: Option<String>,
    byte_length: Option<usize>,
    display_bounds: Option<DisplayBounds>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayDisplayBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayTarget {
    kind: String,
    target_id: String,
    label: String,
    confidence: f64,
    screen_region: ScreenRegion,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayPayload {
    mode: Option<String>,
    display_bounds: OverlayDisplayBounds,
    targets: Vec<OverlayTarget>,
    annotations: Option<Vec<TutorAnnotation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    initial_tool: Option<String>,
}

#[derive(Default)]
struct OverlayState {
    current_payload: Mutex<Option<OverlayPayload>>,
    panel: Mutex<Option<PanelHandle<tauri::Wry>>>,
    window: Mutex<Option<tauri::WebviewWindow>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotchPayload {
    state: String,
    layout: Option<String>,
    title: String,
    detail: String,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextBaseline {
    #[serde(default)]
    bundle_id: Option<String>,
    #[serde(default)]
    window_title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MousePoint {
    x: f64,
    y: f64,
}

// Sent to the cursor window to make it fly to (and rest near) an AI target.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorPointPayload {
    screen_region: ScreenRegion,
    display_bounds: OverlayDisplayBounds,
    #[serde(default)]
    color: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TutorActiveAppContext {
    active_app: String,
    bundle_id: Option<String>,
    window_title: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TutorScreenPoint {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TutorAnnotation {
    id: String,
    #[serde(rename = "type")]
    annotation_type: String,
    screen_region: ScreenRegion,
    points: Option<Vec<TutorScreenPoint>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TutorScreenInput {
    captured: bool,
    reason: Option<String>,
    image_mime_type: Option<String>,
    image_base64: Option<String>,
    byte_length: Option<usize>,
    display_bounds: Option<OverlayDisplayBounds>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TutorSkillPack {
    slug: String,
    display_name: String,
    app_identifiers: Vec<String>,
    landmarks: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TutorTurnInput {
    user_query: String,
    active_app: TutorActiveAppContext,
    annotations: Vec<TutorAnnotation>,
    screen: TutorScreenInput,
    skill: TutorSkillPack,
    constraints: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeAudioInput {
    audio_base64: String,
    mime_type: String,
    filename: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptionResult {
    text: String,
    provider: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SynthesizeSpeechInput {
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeechSynthesisResult {
    audio_base64: String,
    mime_type: String,
    provider: String,
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

#[cfg(target_os = "macos")]
fn run_osascript(script: &str) -> Option<String> {
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
fn frontmost_app_name() -> Option<String> {
    run_osascript(
        r#"tell application "System Events" to get name of first process whose frontmost is true"#,
    )
}

#[cfg(target_os = "macos")]
fn frontmost_bundle_id() -> Option<String> {
    run_osascript(
        r#"tell application "System Events" to get bundle identifier of first process whose frontmost is true"#,
    )
}

#[cfg(target_os = "macos")]
fn frontmost_window_title() -> Option<String> {
    run_osascript(
        r#"tell application "System Events" to tell (first process whose frontmost is true) to get name of front window"#,
    )
}

// Best-effort active-tab URL for known browsers via AppleScript. Needs macOS
// Automation permission (prompts once per browser); returns None if denied or the
// app is unknown, so callers fall back to the window title. Firefox exposes no
// scripting access to tab URLs, so it's intentionally absent.
#[cfg(target_os = "macos")]
fn frontmost_browser_url(bundle_id: Option<&str>) -> Option<String> {
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
fn frontmost_browser_url(_bundle_id: Option<&str>) -> Option<String> {
    None
}

#[tauri::command]
fn get_active_app() -> ActiveApp {
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

fn is_sensitive_app(active_app: &ActiveApp) -> bool {
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

#[tauri::command]
fn get_permission_status() -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        let screen_recording = if unsafe { CGPreflightScreenCaptureAccess() } {
            PermissionState::Granted
        } else {
            PermissionState::NotDetermined
        };
        let accessibility = if unsafe { AXIsProcessTrusted() } {
            PermissionState::Granted
        } else {
            PermissionState::NotDetermined
        };

        return PermissionStatus {
            screen_recording,
            accessibility,
            microphone: microphone_permission_status(),
        };
    }

    #[cfg(not(target_os = "macos"))]
    {
        PermissionStatus {
            screen_recording: PermissionState::Unknown,
            accessibility: PermissionState::Unknown,
            microphone: PermissionState::Unknown,
        }
    }
}

#[cfg(target_os = "macos")]
fn microphone_state_from_av_status(status: AVAuthorizationStatus) -> PermissionState {
    match status {
        AVAuthorizationStatus::Authorized => PermissionState::Granted,
        AVAuthorizationStatus::Denied | AVAuthorizationStatus::Restricted => {
            PermissionState::Denied
        }
        AVAuthorizationStatus::NotDetermined => PermissionState::NotDetermined,
        _ => PermissionState::Unknown,
    }
}

#[cfg(target_os = "macos")]
fn microphone_permission_status() -> PermissionState {
    let Some(media_type) = (unsafe { AVMediaTypeAudio }) else {
        return PermissionState::Unknown;
    };

    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
    microphone_state_from_av_status(status)
}

#[cfg(target_os = "macos")]
fn request_screen_recording_permission() -> PermissionState {
    if unsafe { CGPreflightScreenCaptureAccess() } || unsafe { CGRequestScreenCaptureAccess() } {
        PermissionState::Granted
    } else {
        PermissionState::NotDetermined
    }
}

#[cfg(target_os = "macos")]
fn request_accessibility_permission() -> PermissionState {
    if unsafe { AXIsProcessTrusted() } {
        return PermissionState::Granted;
    }

    let prompt_key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let prompt_value = CFBoolean::true_value();
    let options = CFDictionary::from_CFType_pairs(&[(prompt_key, prompt_value)]);

    if unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) } {
        PermissionState::Granted
    } else {
        PermissionState::NotDetermined
    }
}

#[cfg(target_os = "macos")]
fn request_microphone_permission(app: tauri::AppHandle) -> PermissionState {
    let Some(media_type) = (unsafe { AVMediaTypeAudio }) else {
        return PermissionState::Unknown;
    };

    let current_status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
    if current_status != AVAuthorizationStatus::NotDetermined {
        return microphone_state_from_av_status(current_status);
    }

    let (sender, receiver) = std::sync::mpsc::channel();
    let run_result = app.run_on_main_thread(move || {
        let Some(media_type) = (unsafe { AVMediaTypeAudio }) else {
            let _ = sender.send(false);
            return;
        };
        let handler = RcBlock::new(move |granted: objc2::runtime::Bool| {
            let _ = sender.send(granted.as_bool());
        });

        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &handler);
        }
    });

    if run_result.is_err() {
        return PermissionState::Unknown;
    }

    match receiver.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(true) => PermissionState::Granted,
        Ok(false) => PermissionState::Denied,
        Err(_) => microphone_permission_status(),
    }
}

#[tauri::command]
fn request_required_permissions(app: tauri::AppHandle) -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        return PermissionStatus {
            screen_recording: request_screen_recording_permission(),
            accessibility: request_accessibility_permission(),
            microphone: request_microphone_permission(app),
        };
    }

    #[cfg(not(target_os = "macos"))]
    {
        PermissionStatus {
            screen_recording: PermissionState::Unknown,
            accessibility: PermissionState::Unknown,
            microphone: PermissionState::Unknown,
        }
    }
}

#[tauri::command]
fn open_permission_settings(permission: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let pane = match permission.as_str() {
            "screenRecording" | "screen_recording" | "screen" => "Privacy_ScreenCapture",
            "accessibility" => "Privacy_Accessibility",
            "microphone" | "mic" => "Privacy_Microphone",
            _ => {
                return Err(format!(
                    "Unsupported permission settings pane: {permission}"
                ))
            }
        };
        let url = format!("x-apple.systempreferences:com.apple.preference.security?{pane}");
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Failed to open macOS System Settings: {error}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = permission;
        Err("Permission settings are only implemented for macOS.".to_string())
    }
}

#[cfg(target_os = "macos")]
fn capture_screen_with_screencapture() -> Result<Vec<u8>, String> {
    // Unique path per capture so concurrent activations don't clobber the same
    // temp file (which could hang or corrupt a capture).
    use std::sync::atomic::{AtomicU64, Ordering};
    static CAPTURE_SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = CAPTURE_SEQ.fetch_add(1, Ordering::Relaxed);
    let output_path = std::env::temp_dir().join(format!(
        "kairo-screen-capture-{}-{}.png",
        std::process::id(),
        seq
    ));

    let output = Command::new("screencapture")
        .arg("-x")
        .arg("-t")
        .arg("png")
        .arg(&output_path)
        .output()
        .map_err(|error| format!("Failed to run macOS screencapture: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "macOS screencapture failed without an error message.".to_string()
        } else {
            stderr
        });
    }

    let bytes = fs::read(&output_path)
        .map_err(|error| format!("Failed to read captured screenshot: {error}"))?;
    let _ = fs::remove_file(output_path);
    Ok(bytes)
}

#[cfg(target_os = "macos")]
fn main_display_bounds() -> DisplayBounds {
    let display = CGDisplay::main();
    let bounds = display.bounds();
    let pixels_wide = display.pixels_wide() as f64;
    let scale_factor = if bounds.size.width > 0.0 {
        pixels_wide / bounds.size.width
    } else {
        1.0
    };

    DisplayBounds {
        x: bounds.origin.x,
        y: bounds.origin.y,
        width: bounds.size.width,
        height: bounds.size.height,
        scale_factor,
    }
}

// Downscale the full-res (Retina) screenshot before it goes to the vision model:
// fewer pixels + JPEG = much smaller upload and faster inference, with no
// meaningful loss for reading on-screen UI. Falls back to the original PNG on any
// decode/encode failure.
const SCREENSHOT_MAX_EDGE: u32 = 1280;

fn downscale_screenshot(png_bytes: Vec<u8>) -> (Vec<u8>, &'static str) {
    let Ok(image) = image::load_from_memory(&png_bytes) else {
        return (png_bytes, "image/png");
    };
    let scaled = if image.width().max(image.height()) > SCREENSHOT_MAX_EDGE {
        image.resize(
            SCREENSHOT_MAX_EDGE,
            SCREENSHOT_MAX_EDGE,
            image::imageops::FilterType::Triangle,
        )
    } else {
        image
    };
    let mut out = std::io::Cursor::new(Vec::new());
    match scaled
        .to_rgb8()
        .write_to(&mut out, image::ImageFormat::Jpeg)
    {
        Ok(()) => (out.into_inner(), "image/jpeg"),
        Err(_) => (png_bytes, "image/png"),
    }
}

#[tauri::command]
fn capture_screen() -> ScreenCaptureResult {
    #[cfg(target_os = "macos")]
    {
        let active_app = get_active_app();
        if is_sensitive_app(&active_app) {
            return ScreenCaptureResult {
                captured: false,
                reason: Some(
                    "Screen tutoring is paused because this app may contain sensitive information."
                        .to_string(),
                ),
                blocked_sensitive_app: true,
                active_app: Some(active_app),
                image_mime_type: None,
                image_base64: None,
                byte_length: None,
                display_bounds: Some(main_display_bounds()),
            };
        }

        match capture_screen_with_screencapture() {
            Ok(bytes) => {
                use base64::Engine;
                let (image_bytes, mime) = downscale_screenshot(bytes);
                let byte_length = image_bytes.len();
                let image_base64 = base64::engine::general_purpose::STANDARD.encode(image_bytes);
                return ScreenCaptureResult {
                    captured: true,
                    reason: None,
                    blocked_sensitive_app: false,
                    active_app: Some(active_app),
                    image_mime_type: Some(mime.to_string()),
                    image_base64: Some(image_base64),
                    byte_length: Some(byte_length),
                    display_bounds: Some(main_display_bounds()),
                };
            }
            Err(error) => {
                return ScreenCaptureResult {
                    captured: false,
                    reason: Some(error),
                    blocked_sensitive_app: false,
                    active_app: Some(active_app),
                    image_mime_type: None,
                    image_base64: None,
                    byte_length: None,
                    display_bounds: Some(main_display_bounds()),
                };
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        ScreenCaptureResult {
            captured: false,
            reason: Some("Screen capture is only implemented for macOS.".to_string()),
            blocked_sensitive_app: false,
            active_app: None,
            image_mime_type: None,
            image_base64: None,
            byte_length: None,
            display_bounds: None,
        }
    }
}

fn ensure_configured_window(
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
fn exclude_window_from_screen_capture(window: &tauri::WebviewWindow) {
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
fn exclude_window_from_screen_capture(_window: &tauri::WebviewWindow) {}

// Make a window appear in screen capture again (ReadOnly = the default). Used so the
// user's pen marks are visible to the tutor's own screenshot even while other Kairo
// UI stays hidden.
#[cfg(target_os = "macos")]
fn include_window_in_screen_capture(window: &tauri::WebviewWindow) {
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
fn include_window_in_screen_capture(_window: &tauri::WebviewWindow) {}

// Lazily create the notch window, convert it to a non-activating NSPanel, and
// apply the level / style / collection behavior that let it float over
// full-screen Spaces. Idempotent: returns the existing panel once converted.
fn ensure_notch_panel(app: &tauri::AppHandle) -> Result<PanelHandle<tauri::Wry>, String> {
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
    // own screenshot) unless KAIRO_SHOW_IN_CAPTURE is set (e.g. for a demo).
    if !env_flag("KAIRO_SHOW_IN_CAPTURE") {
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

fn ensure_overlay_panel(app: &tauri::AppHandle) -> Result<PanelHandle<tauri::Wry>, String> {
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
    // exclusion doesn't affect display). KAIRO_SHOW_IN_CAPTURE makes it captured —
    // which also lets the tutor's own screenshot include the user's pen marks.
    if !env_flag("KAIRO_SHOW_IN_CAPTURE") {
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

fn overlay_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
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
fn ensure_cursor_panel(app: &tauri::AppHandle) -> Result<PanelHandle<tauri::Wry>, String> {
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

    if !env_flag("KAIRO_SHOW_IN_CAPTURE") {
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

fn cursor_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    ensure_cursor_panel(app)?;
    app.state::<CursorState>()
        .window
        .lock()
        .map_err(|_| "Failed to lock cursor window state.".to_string())?
        .clone()
        .ok_or_else(|| "Cursor panel has no backing window".to_string())
}

// Poll the global cursor position at ~60 Hz and push moves to the cursor window.
// Uses Tauri's cross-platform `cursor_position` (physical px, global top-left);
// we convert to logical points so the webview (which works in CSS px = points)
// can place the pet. Only emits on actual movement, so an idle mouse costs almost
// nothing.
fn spawn_mouse_tracker(app: &tauri::AppHandle) {
    let window = match app.state::<CursorState>().window.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => None,
    };
    let Some(window) = window else {
        eprintln!("Kairo Tutor: cursor window missing; mouse tracker not started");
        return;
    };
    let app = app.clone();

    std::thread::spawn(move || {
        let mut last: Option<(f64, f64)> = None;
        let mut idle_ticks: u32 = 0;
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
            std::thread::sleep(Duration::from_millis(16));
        }
    });
}

const KAIRO_BUNDLE_ID: &str = "com.kairo.tutor";
// Ignore activity for the first moment after arming so the reveal itself (or the
// click/key that triggered the ask) never counts as "the user moved on".
const CONTEXT_SETTLE_MS: u64 = 500;

// True only when armed AND past the settle window — the single gate every watcher
// checks before firing.
fn context_watch_settled(watch: &ContextWatch) -> bool {
    if !watch.armed.load(Ordering::SeqCst) {
        return false;
    }
    watch
        .armed_at
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .map(|at| at.elapsed() >= Duration::from_millis(CONTEXT_SETTLE_MS))
        .unwrap_or(false)
}

// Disarm and tell the notch exactly once per armed session. `swap` makes it
// one-shot even if the poll and the input tap fire in the same instant.
fn fire_context_reset(app: &tauri::AppHandle, watch: &ContextWatch, reason: &str) {
    if watch.armed.swap(false, Ordering::SeqCst) {
        let _ = app.emit("context:changed", reason.to_string());
    }
}

// Low-frequency poll (only costs anything while armed) that catches app switches
// and tab/page changes: the frontmost bundle id changing, or the front window
// title changing within the same app. Covers keyboard-driven switches (Cmd+Tab,
// Cmd+number) that the input tap deliberately doesn't listen for.
fn spawn_context_poll(app: &tauri::AppHandle, watch: ContextWatch) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(450));
        if !context_watch_settled(&watch) {
            continue;
        }
        let Some((base_bundle, base_title)) =
            watch.baseline.lock().ok().and_then(|guard| guard.clone())
        else {
            continue;
        };
        let cur_bundle = frontmost_bundle_id().unwrap_or_default();
        // Our own non-activating panels shouldn't take frontmost, but never let
        // Kairo's own UI count as the user switching away.
        if cur_bundle == KAIRO_BUNDLE_ID {
            continue;
        }
        let switched_app =
            !base_bundle.is_empty() && !cur_bundle.is_empty() && cur_bundle != base_bundle;
        if switched_app {
            fire_context_reset(&app, &watch, "app-switch");
            continue;
        }
        let cur_title = frontmost_window_title().unwrap_or_default();
        let changed_title =
            !base_title.is_empty() && !cur_title.is_empty() && cur_title != base_title;
        if changed_title {
            fire_context_reset(&app, &watch, "window-change");
        }
    });
}

// Listen-only global event tap for scroll + mouse-down (NOT mouse-moved, so
// moving toward the target is never a reset, and NOT keyDown, so this needs only
// the Accessibility grant Kairo already has — no Input Monitoring prompt). If the
// tap can't be created it degrades gracefully; the poll above still covers
// app/tab switches.
fn spawn_context_input_tap(app: &tauri::AppHandle, watch: ContextWatch) {
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        CallbackResult,
    };

    let app = app.clone();
    std::thread::spawn(move || {
        let tap = CGEventTap::new(
            CGEventTapLocation::Session,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![
                CGEventType::ScrollWheel,
                CGEventType::LeftMouseDown,
                CGEventType::RightMouseDown,
                CGEventType::OtherMouseDown,
            ],
            move |_proxy, _event_type, _event| {
                if context_watch_settled(&watch) {
                    fire_context_reset(&app, &watch, "input");
                }
                // Listen-only: never modify the event stream, always keep the event.
                CallbackResult::Keep
            },
        );
        let Ok(tap) = tap else {
            eprintln!(
                "Kairo Tutor: input event tap unavailable; scroll/click reset disabled (app/tab switch reset still works)"
            );
            return;
        };
        // Standard CGEventTap → CFRunLoop wiring. run_current() blocks this
        // dedicated thread for the process lifetime, keeping the tap alive.
        unsafe {
            let Ok(source) = tap.mach_port().create_runloop_source(0) else {
                eprintln!("Kairo Tutor: failed to create event-tap runloop source");
                return;
            };
            CFRunLoop::get_current().add_source(&source, kCFRunLoopCommonModes);
            tap.enable();
            CFRunLoop::run_current();
        }
    });
}

// Input Monitoring (kTCCServiceListenEvent) is a SEPARATE grant from Accessibility
// and is what a keyboard-class event tap needs. These CoreGraphics C APIs (macOS
// 10.15+) let us check it and trigger the system prompt — which also registers
// Kairo in System Settings > Privacy & Security > Input Monitoring so the user can
// find and enable it. CoreGraphics is already linked via the core-graphics crate.
#[cfg(target_os = "macos")]
extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}

// Ask for Input Monitoring so the ⌥⌃ push-to-talk tap can receive modifier events.
// No-op (returns true) once granted; otherwise prompts + lists the app in Settings.
#[cfg(target_os = "macos")]
fn ensure_input_monitoring_access() {
    unsafe {
        if !CGPreflightListenEventAccess() {
            let _ = CGRequestListenEventAccess();
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

// Pick the real built-in microphone. The OS *default* input on this machine is a
// silent virtual device (BlackHole), so `default_input_device()` would capture
// silence — mirror the WebView fix and skip known virtual/loopback devices.
fn pick_input_device(host: &cpal::Host) -> Option<cpal::Device> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let is_virtual = |name: &str| {
        let n = name.to_lowercase();
        n.contains("blackhole")
            || n.contains("soundflower")
            || n.contains("loopback")
            || n.contains("aggregate")
            || n.contains("multi-output")
            || n.contains("virtual")
            || n.contains("vb-audio")
            || n.contains("ishowu")
    };
    let devices: Vec<cpal::Device> = host
        .input_devices()
        .map(|iter| iter.collect())
        .unwrap_or_default();
    // 1) an explicitly built-in mic
    for device in &devices {
        if let Ok(name) = device.name() {
            let n = name.to_lowercase();
            if !is_virtual(&n)
                && (n.contains("macbook")
                    || n.contains("built-in")
                    || n.contains("built in")
                    || n.contains("internal")
                    || n.contains("microphone"))
            {
                return Some(device.clone());
            }
        }
    }
    // 2) any non-virtual input
    for device in &devices {
        if let Ok(name) = device.name() {
            if !is_virtual(&name.to_lowercase()) {
                return Some(device.clone());
            }
        }
    }
    // 3) last resort: whatever the OS default is
    host.default_input_device()
}

#[derive(Default)]
struct AudioCapture {
    tx: Mutex<Option<Sender<AudioCommand>>>,
    // True while the mic stream is running; drives the level emitter.
    capturing: Arc<AtomicBool>,
    // Latest normalized mic level (0..1) as f32 bits, for the cursor listening halo.
    level: Arc<AtomicU32>,
}

fn audio_stream_error(err: cpal::StreamError) {
    eprintln!("Kairo Tutor: audio stream error: {err}");
}

// Append captured frames as mono to the shared buffer and update the live level.
fn append_mono(
    samples: &Arc<Mutex<Vec<f32>>>,
    level: &Arc<AtomicU32>,
    data: &[f32],
    channels: usize,
) {
    let mut sum_sq = 0.0f32;
    let mut count = 0usize;
    if let Ok(mut buf) = samples.lock() {
        if channels <= 1 {
            buf.extend_from_slice(data);
            for &s in data {
                sum_sq += s * s;
            }
            count = data.len();
        } else {
            for frame in data.chunks(channels) {
                let mixed = frame.iter().sum::<f32>() / channels as f32;
                buf.push(mixed);
                sum_sq += mixed * mixed;
                count += 1;
            }
        }
    }
    if count > 0 {
        let rms = (sum_sq / count as f32).sqrt();
        let norm = (rms / 0.15).min(1.0);
        level.store(norm.to_bits(), Ordering::SeqCst);
    }
}

// Minimal mono 16-bit PCM WAV encoder (no extra dependency).
fn encode_wav_mono(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let byte_rate = sample_rate * 2;
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits/sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

// Build the input stream in an ARMED (not playing) state. The device is opened /
// AudioUnit initialized here, but no I/O runs until play(), so the mic indicator
// stays OFF until recording actually starts. Returns the stream + its sample rate.
fn build_armed_input(
    host: &cpal::Host,
    samples: &Arc<Mutex<Vec<f32>>>,
    level: &Arc<AtomicU32>,
) -> Option<(cpal::Stream, u32)> {
    use cpal::traits::DeviceTrait;
    let device = pick_input_device(host)?;
    let config = device.default_input_config().ok()?;
    let sample_format = config.sample_format();
    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let stream_config: cpal::StreamConfig = config.into();
    let (s1, l1) = (samples.clone(), level.clone());
    let (s2, l2) = (samples.clone(), level.clone());
    let (s3, l3) = (samples.clone(), level.clone());
    let built = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |d: &[f32], _: &_| append_mono(&s1, &l1, d, channels),
            audio_stream_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |d: &[i16], _: &_| {
                let f: Vec<f32> = d.iter().map(|s| *s as f32 / 32768.0).collect();
                append_mono(&s2, &l2, &f, channels);
            },
            audio_stream_error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &stream_config,
            move |d: &[u16], _: &_| {
                let f: Vec<f32> = d.iter().map(|s| (*s as f32 - 32768.0) / 32768.0).collect();
                append_mono(&s3, &l3, &f, channels);
            },
            audio_stream_error,
            None,
        ),
        other => {
            eprintln!("Kairo Tutor: unsupported input sample format {other:?}");
            return None;
        }
    };
    match built {
        Ok(stream) => Some((stream, rate)),
        Err(err) => {
            eprintln!("Kairo Tutor: failed to build mic stream: {err}");
            None
        }
    }
}

// Owns the cpal stream (which is !Send) on a dedicated thread and reacts to
// Start/Stop. On Stop it encodes the buffer to WAV and emits `ptt:audio` to the
// notch, which transcribes + runs the tutor turn. Also spawns a level emitter that
// feeds the cursor halo while capturing. Returns the command sender.
fn spawn_audio_capture(
    app: &tauri::AppHandle,
    capturing: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
) -> Sender<AudioCommand> {
    let (tx, rx) = channel::<AudioCommand>();

    // Level emitter → cursor:level (throttled), only while capturing.
    let app_level = app.clone();
    let capturing_level = capturing.clone();
    let level_read = level.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(66));
        if capturing_level.load(Ordering::SeqCst) {
            let lvl = f32::from_bits(level_read.load(Ordering::SeqCst));
            // Global so BOTH the cursor halo and the status capsule react to voice.
            let _ = app_level.emit("cursor:level", json!({ "level": lvl }));
        }
    });

    let app = app.clone();
    let capturing_worker = capturing;
    let level_worker = level;
    std::thread::spawn(move || {
        use cpal::traits::StreamTrait;
        let host = cpal::default_host();
        let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        // Build-per-press: build + play the stream on Start, DROP it on Stop. Dropping
        // closes the input device, so the mic (and its indicator) is on ONLY while
        // recording. Trade-off: the first press pays the ~200ms cold build.
        let mut current: Option<cpal::Stream> = None;
        let mut current_rate: u32 = 16_000;

        while let Ok(cmd) = rx.recv() {
            match cmd {
                // Nothing to warm — build-per-press keeps the mic closed when idle.
                AudioCommand::Warm => {}
                AudioCommand::Start(chord_down) => {
                    if let Ok(mut buf) = samples.lock() {
                        buf.clear();
                    }
                    match build_armed_input(&host, &samples, &level_worker) {
                        Some((stream, rate)) => {
                            current_rate = rate;
                            match stream.play() {
                                Ok(()) => {
                                    eprintln!(
                                        "[ptt-timing] recording started {} ms after ⌥⌃ down @ {} Hz",
                                        chord_down.elapsed().as_millis(),
                                        current_rate
                                    );
                                    current = Some(stream);
                                    capturing_worker.store(true, Ordering::SeqCst);
                                }
                                Err(err) => {
                                    eprintln!("Kairo Tutor: failed to start mic stream: {err}");
                                }
                            }
                        }
                        None => {}
                    }
                }
                AudioCommand::Stop => {
                    capturing_worker.store(false, Ordering::SeqCst);
                    level_worker.store(0, Ordering::SeqCst);
                    // Drop the stream → I/O stops AND the device closes, so the mic
                    // indicator turns off between presses.
                    current.take();
                    let captured: Vec<f32> =
                        samples.lock().map(|buf| buf.clone()).unwrap_or_default();
                    eprintln!(
                        "[ptt-timing] captured {} samples @ {} Hz",
                        captured.len(),
                        current_rate
                    );
                    if captured.is_empty() {
                        continue;
                    }
                    let wav = encode_wav_mono(&captured, current_rate);
                    use base64::Engine;
                    let audio_base64 = base64::engine::general_purpose::STANDARD.encode(&wav);
                    if let Some(window) = app.get_webview_window("notch") {
                        let _ = window.emit(
                            "ptt:audio",
                            json!({ "audioBase64": audio_base64, "mimeType": "audio/wav" }),
                        );
                    }
                }
            }
        }
    });

    tx
}

fn send_audio_command(app: &tauri::AppHandle, command: AudioCommand) {
    let sender = app
        .state::<AudioCapture>()
        .tx
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    if let Some(tx) = sender {
        let _ = tx.send(command);
    }
}

// Separate listen-only tap for the ⌥⌃ push-to-talk chord (FlagsChanged). Kept apart
// from the mouse/scroll tap on purpose: keyboard-class taps can require the separate
// macOS "Input Monitoring" grant, so if THIS tap can't be created, PTT is simply
// disabled while the mouse/scroll reset tap keeps working untouched.
fn spawn_ptt_tap(app: &tauri::AppHandle, watch: ContextWatch) {
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventType, CallbackResult,
    };

    let app = app.clone();
    std::thread::spawn(move || {
        let tap = CGEventTap::new(
            CGEventTapLocation::Session,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![CGEventType::FlagsChanged],
            move |_proxy, _event_type, event| {
                // ⌥⌃ (Option+Control) both held → start recording; released → send.
                // Pure modifiers can't be a normal global shortcut, so we watch the
                // held state on this tap instead.
                let flags = event.get_flags();
                let both = flags.contains(CGEventFlags::CGEventFlagAlternate)
                    && flags.contains(CGEventFlags::CGEventFlagControl);
                let was = watch.ptt_active.load(Ordering::SeqCst);
                if both && !was {
                    watch.ptt_active.store(true, Ordering::SeqCst);
                    // Start native mic capture immediately (instant; indicator on now).
                    eprintln!("[ptt-timing] ⌥⌃ chord down");
                    send_audio_command(&app, AudioCommand::Start(Instant::now()));
                    // Cursor shows the listening halo (global emit so it lands).
                    let _ = app.emit("cursor:listening", ());
                    // Show the notch (listening UI) on the MAIN thread — this also
                    // wakes its otherwise-suspended webview so it can receive the
                    // captured audio on release.
                    let app2 = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        let notch_state = app2.state::<NotchState>();
                        if let Err(error) = show_notch_with_payload(
                            &app2,
                            notch_state.inner(),
                            Some(listening_notch_payload()),
                        ) {
                            eprintln!("Kairo Tutor: ptt failed to show notch: {error}");
                        }
                    });
                } else if !both && was {
                    watch.ptt_active.store(false, Ordering::SeqCst);
                    // Stop capture → the audio thread encodes WAV + emits `ptt:audio`
                    // to the (now awake) notch, which transcribes + runs the turn.
                    send_audio_command(&app, AudioCommand::Stop);
                    let _ = app.emit("cursor:thinking", ());
                }
                CallbackResult::Keep
            },
        );
        let Ok(tap) = tap else {
            eprintln!(
                "Kairo Tutor: push-to-talk tap unavailable; grant Input Monitoring + relaunch to enable ⌥⌃"
            );
            return;
        };
        unsafe {
            let Ok(source) = tap.mach_port().create_runloop_source(0) else {
                eprintln!("Kairo Tutor: failed to create PTT runloop source");
                return;
            };
            CFRunLoop::get_current().add_source(&source, kCFRunLoopCommonModes);
            tap.enable();
            CFRunLoop::run_current();
        }
    });
}

fn configure_overlay_window(
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
    // captures. With KAIRO_SHOW_IN_CAPTURE=true, always include (demo mode).
    let shows_user_marks = matches!(
        payload.mode.as_deref(),
        Some("annotate") | Some("annotation_preview")
    );
    if shows_user_marks || env_flag("KAIRO_SHOW_IN_CAPTURE") {
        include_window_in_screen_capture(window);
    } else {
        exclude_window_from_screen_capture(window);
    }

    Ok(())
}

fn emit_overlay_payload(
    window: &tauri::WebviewWindow,
    payload: OverlayPayload,
) -> Result<(), String> {
    window
        .emit("overlay:update", payload)
        .map_err(|error| format!("Failed to update overlay targets: {error}"))
}

fn configure_notch_window(
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

fn notch_window_size(layout: Option<&str>, state: Option<&str>) -> (f64, f64) {
    let _ = layout;
    let _ = state;
    (760.0, 236.0)
}

fn store_overlay_payload(
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

fn emit_notch_payload(window: &tauri::WebviewWindow, payload: NotchPayload) -> Result<(), String> {
    window
        .emit("notch:update", payload)
        .map_err(|error| format!("Failed to update notch state: {error}"))
}

fn store_notch_payload(
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

fn store_notch_payload_inner(
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

fn show_notch_with_payload(
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

fn listening_notch_payload() -> NotchPayload {
    NotchPayload {
        state: "listening".to_string(),
        layout: Some("compact".to_string()),
        title: "Kairo is listening".to_string(),
        detail: "Capturing the current screen".to_string(),
    }
}

// ⌘⇧Space now just opens the notch for TYPING (voice is push-to-talk via ⌥⌃).
fn typing_notch_payload() -> NotchPayload {
    NotchPayload {
        state: "captured".to_string(),
        layout: Some("prompt".to_string()),
        title: "Ask Kairo".to_string(),
        detail: "Type a question, or hold ⌥⌃ to talk".to_string(),
    }
}

fn parse_local_env(text: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        if key.is_empty() {
            continue;
        }

        let value = raw_value.trim();
        let value = if value.len() >= 2 {
            let first = value.as_bytes()[0] as char;
            let last = value.as_bytes()[value.len() - 1] as char;
            if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
                &value[1..value.len() - 1]
            } else {
                value
            }
        } else {
            value
        };

        values.insert(key.to_string(), value.to_string());
    }

    values
}

fn push_env_file_candidates_from(start: &Path, candidates: &mut Vec<PathBuf>) {
    let mut current = if start.is_file() {
        start.parent()
    } else {
        Some(start)
    };

    while let Some(dir) = current {
        candidates.push(dir.join(".env.local"));
        candidates.push(dir.join(".env"));
        current = dir.parent();
    }
}

fn local_env_file_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(current_dir) = std::env::current_dir() {
        push_env_file_candidates_from(&current_dir, &mut candidates);
    }

    if let Ok(current_exe) = std::env::current_exe() {
        push_env_file_candidates_from(&current_exe, &mut candidates);
    }

    candidates.dedup();
    candidates
}

fn read_local_env_value(name: &str) -> Option<String> {
    for candidate in local_env_file_candidates() {
        let Ok(text) = fs::read_to_string(candidate) else {
            continue;
        };
        if let Some(value) = parse_local_env(&text).remove(name) {
            return Some(value);
        }
    }

    None
}

fn provider_env_optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .or_else(|| read_local_env_value(name))
}

fn provider_env(name: &str, fallback: &str) -> String {
    provider_env_optional(name).unwrap_or_else(|| fallback.to_string())
}

// True when an env var is set to a truthy value (1/true/yes/on). Read at runtime
// from the process env or the project .env, so a relaunch (no rebuild) applies it.
fn env_flag(name: &str) -> bool {
    provider_env_optional(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn provider_timeout_ms(raw_value: Option<String>) -> u64 {
    raw_value
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(30_000)
}

// A text element detected on the user's screen by OCR, with its real on-screen
// region. The LLM picks elements by `id` (Set-of-Mark grounding) instead of
// guessing pixel coordinates, which vision models do unreliably.
#[derive(Debug, Clone)]
struct OcrElement {
    id: u32,
    text: String,
    // Physical-pixel region, matching the displayBounds.scaleFactor convention the
    // overlay uses (it divides by scaleFactor to get logical points).
    region: ScreenRegion,
    center_x_pct: f64,
    center_y_pct: f64,
}

// Run Apple's Vision OCR on the screenshot bytes and return on-screen text
// elements with accurate regions. Synchronous (Vision's performRequests blocks).
#[cfg(target_os = "macos")]
fn ocr_screenshot(image_bytes: &[u8], bounds: &OverlayDisplayBounds) -> Vec<OcrElement> {
    use objc2::runtime::AnyObject;
    use objc2::AllocAnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };

    let data = NSData::with_bytes(image_bytes);
    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    request.setUsesLanguageCorrection(true);

    let options: objc2::rc::Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &options,
    );

    let request_ref: &VNRequest = &request;
    let requests = NSArray::from_slice(&[request_ref]);
    if handler.performRequests_error(&requests).is_err() {
        return Vec::new();
    }

    let Some(results) = request.results() else {
        return Vec::new();
    };

    let scale_factor = if bounds.scale_factor > 0.0 {
        bounds.scale_factor
    } else {
        1.0
    };
    let mut elements: Vec<OcrElement> = Vec::new();
    for observation in results.iter() {
        if (unsafe { observation.confidence() } as f64) < 0.3 {
            continue;
        }
        let candidates = observation.topCandidates(1);
        let Some(top) = candidates.firstObject() else {
            continue;
        };
        let text = top.string().to_string();
        let text = text.trim().to_string();
        if text.is_empty() {
            continue;
        }

        // Vision boundingBox: normalized [0,1], origin BOTTOM-left of the image.
        let bbox = unsafe { observation.boundingBox() };
        let (min_x, min_y) = (bbox.origin.x, bbox.origin.y);
        let (bw, bh) = (bbox.size.width, bbox.size.height);
        if bw <= 0.0 || bh <= 0.0 {
            continue;
        }
        let left_logical = bounds.x + min_x * bounds.width;
        // Flip Y: bottom-left normalized -> top-left logical.
        let top_logical = bounds.y + (1.0 - (min_y + bh)) * bounds.height;
        elements.push(OcrElement {
            id: elements.len() as u32 + 1,
            text,
            region: ScreenRegion {
                x: left_logical * scale_factor,
                y: top_logical * scale_factor,
                width: bw * bounds.width * scale_factor,
                height: bh * bounds.height * scale_factor,
            },
            center_x_pct: (min_x + bw / 2.0) * 100.0,
            center_y_pct: (1.0 - (min_y + bh / 2.0)) * 100.0,
        });
        if elements.len() >= 200 {
            break;
        }
    }
    elements
}

#[cfg(not(target_os = "macos"))]
fn ocr_screenshot(_image_bytes: &[u8], _bounds: &OverlayDisplayBounds) -> Vec<OcrElement> {
    Vec::new()
}

// OCR the tutor turn's screenshot (the same image the model sees). Empty when no
// screenshot is available — pointing is then disabled rather than hallucinated.
fn ocr_tutor_screenshot(input: &TutorTurnInput) -> Vec<OcrElement> {
    if !input.screen.captured {
        return Vec::new();
    }
    let (Some(image_base64), Some(bounds)) =
        (&input.screen.image_base64, &input.screen.display_bounds)
    else {
        return Vec::new();
    };
    use base64::Engine;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(image_base64) else {
        return Vec::new();
    };
    ocr_screenshot(&bytes, bounds)
}

// A bounding box on the user's screen, normalized [0,1] with a top-left origin.
// `color` is a vibrant accent hex derived from the pixels behind the box.
#[derive(Debug, Clone)]
struct DetectedBox {
    norm_x1: f64,
    norm_y1: f64,
    norm_x2: f64,
    norm_y2: f64,
    label: String,
    color: String,
}

// Vibrant candidate hues (deg): cyan, violet, magenta, lime, orange, yellow.
const ACCENT_HUES: [f64; 6] = [190.0, 275.0, 320.0, 95.0, 30.0, 55.0];

fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d < 1e-9 {
        return (0.0, 0.0, l);
    }
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let mut h = if (max - r).abs() < 1e-9 {
        ((g - b) / d).rem_euclid(6.0)
    } else if (max - g).abs() < 1e-9 {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    } * 60.0;
    if h < 0.0 {
        h += 360.0;
    }
    (h, s, l)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (h.rem_euclid(360.0)) / 60.0;
    let x = c * (1.0 - ((hp.rem_euclid(2.0)) - 1.0).abs());
    let (r1, g1, b1) = if hp < 1.0 {
        (c, x, 0.0)
    } else if hp < 2.0 {
        (x, c, 0.0)
    } else if hp < 3.0 {
        (0.0, c, x)
    } else if hp < 4.0 {
        (0.0, x, c)
    } else if hp < 5.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    let m = l - c / 2.0;
    (
        ((r1 + m) * 255.0).round() as u8,
        ((g1 + m) * 255.0).round() as u8,
        ((b1 + m) * 255.0).round() as u8,
    )
}

fn hue_dist(a: f64, b: f64) -> f64 {
    let d = (a - b).abs().rem_euclid(360.0);
    d.min(360.0 - d)
}

// Pick a vibrant, high-contrast accent: the candidate hue farthest from the
// background hue, saturated, with lightness opposite the background's so it
// always pops and stays readable.
fn vibrant_accent(bg_r: f64, bg_g: f64, bg_b: f64) -> String {
    let (bg_h, _s, bg_l) = rgb_to_hsl(bg_r, bg_g, bg_b);
    let hue = ACCENT_HUES
        .iter()
        .copied()
        .max_by(|a, b| {
            hue_dist(*a, bg_h)
                .partial_cmp(&hue_dist(*b, bg_h))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(190.0);
    let lightness = if bg_l > 0.5 { 0.44 } else { 0.62 };
    let (r, g, b) = hsl_to_rgb(hue, 0.85, lightness);
    format!("#{r:02x}{g:02x}{b:02x}")
}

// Average colour of the ring just OUTSIDE the box (its background), stride-sampled
// so it stays cheap regardless of box size. Falls back to a neutral dark grey.
fn sample_background(rgb: &image::RgbImage, x1: u32, y1: u32, x2: u32, y2: u32) -> (f64, f64, f64) {
    let (w, h) = (rgb.width(), rgb.height());
    if w == 0 || h == 0 {
        return (30.0, 30.0, 30.0);
    }
    let margin = ((x2.saturating_sub(x1)).max(y2.saturating_sub(y1)) / 3).clamp(8, 80);
    let ox1 = x1.saturating_sub(margin);
    let oy1 = y1.saturating_sub(margin);
    let ox2 = (x2 + margin).min(w - 1);
    let oy2 = (y2 + margin).min(h - 1);
    let area = (ox2.saturating_sub(ox1) + 1) as u64 * (oy2.saturating_sub(oy1) + 1) as u64;
    let stride = (area / 1500).max(1);
    let (mut sr, mut sg, mut sb, mut n, mut i) = (0u64, 0u64, 0u64, 0u64, 0u64);
    for yy in oy1..=oy2 {
        for xx in ox1..=ox2 {
            if xx >= x1 && xx <= x2 && yy >= y1 && yy <= y2 {
                continue; // skip the element itself; sample only its surroundings
            }
            i += 1;
            if i % stride != 0 {
                continue;
            }
            let p = rgb.get_pixel(xx, yy);
            sr += p[0] as u64;
            sg += p[1] as u64;
            sb += p[2] as u64;
            n += 1;
        }
    }
    if n == 0 {
        return (30.0, 30.0, 30.0);
    }
    (
        sr as f64 / n as f64,
        sg as f64 / n as f64,
        sb as f64 / n as f64,
    )
}

// Longest edge (px) we downscale the screenshot to before sending it to Claude
// vision. Aspect ratio is preserved so returned pixel boxes map back cleanly.
// Tunable at runtime via KAIRO_VISION_MAX_EDGE (no rebuild) — raise toward 2576
// for tiny pro-app icons, browser chrome, and dense professional toolbars.
const DEFAULT_VISION_MAX_EDGE: u32 = 1568;

fn build_box_locator_context(elements: &[OcrElement]) -> String {
    if elements.is_empty() {
        return "OCR/TEXT HINTS: none available.".to_string();
    }

    let mut lines = Vec::with_capacity(elements.len().min(80) + 1);
    lines.push(
        "OCR/TEXT HINTS: visible text boxes from the same screenshot. Use these as anchors, but still return the final tight pixel box from the image."
            .to_string(),
    );
    for element in elements.iter().take(80) {
        lines.push(format!(
            "{}: \"{}\" @ {:.0}%,{:.0}% size {:.0}x{:.0}px",
            element.id,
            element.text.replace('"', "'").replace('\n', " "),
            element.center_x_pct,
            element.center_y_pct,
            element.region.width,
            element.region.height
        ));
    }
    lines.join("\n")
}

// Ask the grounding provider for the target boxes as raw JSON text. Both providers
// receive the SAME prompt + resized JPEG and return the same {"elements":[...]}
// shape, so the caller parses one format regardless of which provider ran.
async fn anthropic_vision_text(prompt: &str, image_jpeg_base64: &str) -> Option<String> {
    let api_key = provider_env_optional("ANTHROPIC_API_KEY")?;
    if api_key.trim().is_empty() {
        return None;
    }
    let model = provider_env("ANTHROPIC_VISION_MODEL", "claude-opus-4-8");
    let base_url = provider_env("ANTHROPIC_BASE_URL", "https://api.anthropic.com");
    let body = json!({
        "model": model,
        "max_tokens": 1024,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": image_jpeg_base64 } },
                { "type": "text", "text": prompt },
            ],
        }],
    });
    let response = shared_http_client()
        .post(format!("{}/v1/messages", base_url.trim_end_matches('/')))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .timeout(Duration::from_secs(25))
        .json(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        eprintln!(
            "[boxes-diag] anthropic vision {status}: {}",
            text.chars().take(220).collect::<String>()
        );
        return None;
    }
    let payload = response.json::<Value>().await.ok()?;
    // Text block(s) hold the JSON — concatenate them.
    let text = payload
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default();
    Some(text)
}

// Any OpenAI-compatible chat/completions vision endpoint (OpenRouter, Alibaba
// DashScope, etc.). The caller resolves base_url/key/model per provider; here we
// just POST the image + prompt and return the model's raw text. Used for the
// cheap Qwen grounding path (qwen3.7-plus etc.) via the user's existing key.
async fn openai_compatible_vision_text(
    base_url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    image_jpeg_base64: &str,
) -> Option<String> {
    let data_url = format!("data:image/jpeg;base64,{image_jpeg_base64}");
    let body = json!({
        "model": model,
        "max_tokens": 1024,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": data_url } },
                { "type": "text", "text": prompt },
            ],
        }],
    });
    let response = shared_http_client()
        .post(format!("{}/chat/completions", base_url.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {api_key}"))
        // OpenRouter attribution headers; harmlessly ignored by other hosts.
        .header("HTTP-Referer", "https://kairo.tutor")
        .header("X-Title", "Kairo Tutor")
        .timeout(Duration::from_secs(25))
        .json(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        eprintln!(
            "[boxes-diag] grounding {status}: {}",
            text.chars().take(220).collect::<String>()
        );
        return None;
    }
    let payload = response.json::<Value>().await.ok()?;
    let text = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(text)
}

// Locate the on-screen elements the user is asking about by asking a vision model
// for bounding boxes. This is a normal messages request (NOT the computer tool):
// Claude vision returns multiple [x1,y1,x2,y2] pixel boxes + captions in one
// call, which we draw as labeled rectangles. Works on ANY app/OS (icons,
// Blender, diagrams). Returns the most relevant element first; empty when
// nothing is relevant / no key.
async fn detect_element_boxes(
    image_base64: &str,
    bounds: &OverlayDisplayBounds,
    user_query: &str,
    ocr_elements: &[OcrElement],
) -> Vec<DetectedBox> {
    // Swappable at runtime (no rebuild) via KAIRO_GROUNDING_PROVIDER: `anthropic`
    // (Opus, default), `openrouter` (qwen3.7-plus via the user's OpenRouter key,
    // ~12x cheaper), or `qwen` (direct DashScope). All share this prompt + image.
    let provider = provider_env("KAIRO_GROUNDING_PROVIDER", "anthropic").to_lowercase();
    let max_edge = provider_env_optional("KAIRO_VISION_MAX_EDGE")
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|v| *v >= 256)
        .unwrap_or(DEFAULT_VISION_MAX_EDGE);
    let _ = bounds; // display bounds are applied later when mapping boxes to px

    // Downscale aspect-preserving so the longest edge <= max_edge. Claude returns
    // pixel boxes in THIS resized space; we normalize by (rw, rh) and map back.
    use base64::Engine;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(image_base64) else {
        return Vec::new();
    };
    let Ok(image) = image::load_from_memory(&bytes) else {
        return Vec::new();
    };
    let (ow, oh) = (image.width(), image.height());
    if ow == 0 || oh == 0 {
        return Vec::new();
    }
    let long = ow.max(oh);
    let scale = if long > max_edge {
        max_edge as f64 / long as f64
    } else {
        1.0
    };
    let rw = ((ow as f64 * scale).round() as u32).max(1);
    let rh = ((oh as f64 * scale).round() as u32).max(1);
    let resized = image.resize_exact(rw, rh, image::imageops::FilterType::Triangle);
    // Keep the RGB buffer around to sample box backgrounds for the accent colour.
    let rgb = resized.to_rgb8();
    let mut out = std::io::Cursor::new(Vec::new());
    if rgb.write_to(&mut out, image::ImageFormat::Jpeg).is_err() {
        return Vec::new();
    }
    let resized_base64 = base64::engine::general_purpose::STANDARD.encode(out.into_inner());

    let prompt = box_locator_prompt(user_query, rw, rh, &build_box_locator_context(ocr_elements));

    let text = match provider.as_str() {
        // Cheap Qwen grounding via the user's existing OpenRouter key.
        "openrouter" | "open-router" => {
            match provider_env_optional("OPENROUTER_API_KEY") {
                Some(key) if !key.trim().is_empty() => {
                    let base = provider_env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
                    let model = provider_env("KAIRO_GROUNDING_MODEL", "qwen/qwen3.7-plus");
                    openai_compatible_vision_text(&base, &key, &model, &prompt, &resized_base64)
                        .await
                }
                _ => None,
            }
        }
        // Direct Alibaba DashScope (needs a DashScope key, which some regions can't get).
        "qwen" | "qwen3" | "dashscope" | "alibaba" => {
            match provider_env_optional("DASHSCOPE_API_KEY")
                .or_else(|| provider_env_optional("QWEN_API_KEY"))
            {
                Some(key) if !key.trim().is_empty() => {
                    let base = provider_env(
                        "QWEN_BASE_URL",
                        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
                    );
                    let model = provider_env("QWEN_VISION_MODEL", "qwen3.7-plus");
                    openai_compatible_vision_text(&base, &key, &model, &prompt, &resized_base64)
                        .await
                }
                _ => None,
            }
        }
        _ => anthropic_vision_text(&prompt, &resized_base64).await,
    };
    let Some(text) = text else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(json_body(&text)) else {
        return Vec::new();
    };
    let Some(elements) = parsed.get("elements").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut boxes = Vec::new();
    for element in elements {
        let label = element
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let Some(coords) = element.get("box").and_then(Value::as_array) else {
            continue;
        };
        let nums: Vec<f64> = coords.iter().filter_map(Value::as_f64).collect();
        if nums.len() != 4 {
            continue;
        }
        let (mut x1, mut y1, mut x2, mut y2) = (nums[0], nums[1], nums[2], nums[3]);
        if x2 < x1 {
            std::mem::swap(&mut x1, &mut x2);
        }
        if y2 < y1 {
            std::mem::swap(&mut y1, &mut y2);
        }
        let nx1 = (x1 / rw as f64).clamp(0.0, 1.0);
        let ny1 = (y1 / rh as f64).clamp(0.0, 1.0);
        let nx2 = (x2 / rw as f64).clamp(0.0, 1.0);
        let ny2 = (y2 / rh as f64).clamp(0.0, 1.0);
        if nx2 <= nx1 || ny2 <= ny1 {
            continue;
        }
        // Derive a vibrant accent from the pixels surrounding the box (in resized
        // space) so the highlight pops against whatever is behind it.
        let bx1 = (nx1 * rw as f64) as u32;
        let by1 = (ny1 * rh as f64) as u32;
        let bx2 = (nx2 * rw as f64) as u32;
        let by2 = (ny2 * rh as f64) as u32;
        let (ar, ag, ab) = sample_background(&rgb, bx1, by1, bx2, by2);
        let color = vibrant_accent(ar, ag, ab);
        boxes.push(DetectedBox {
            norm_x1: nx1,
            norm_y1: ny1,
            norm_x2: nx2,
            norm_y2: ny2,
            label,
            color,
        });
        // We draw exactly one box (the single most relevant element).
        if boxes.len() >= 1 {
            break;
        }
    }

    let summary: Vec<String> = boxes
        .iter()
        .map(|b| {
            format!(
                "\"{}\" [{:.3},{:.3},{:.3},{:.3}]",
                b.label, b.norm_x1, b.norm_y1, b.norm_x2, b.norm_y2
            )
        })
        .collect();
    eprintln!("[boxes] {} element(s): {}", boxes.len(), summary.join(", "));

    boxes
}

// Strip a leading/trailing ```json ... ``` markdown fence if the model wrapped
// its JSON in one (it sometimes does despite response_format json_object). Without
// this the native parse bails and ungrounded targets leak to the frontend.
fn json_body(content: &str) -> &str {
    let trimmed = content.trim();
    if !trimmed.starts_with("```") {
        return trimmed;
    }
    let inner = trimmed.trim_start_matches('`');
    let inner = inner.strip_prefix("json").unwrap_or(inner);
    inner.trim_matches(|c: char| c == '`' || c.is_whitespace())
}

fn display_physical_bounds(bounds: &OverlayDisplayBounds) -> (f64, f64, f64, f64, f64) {
    let scale_factor = if bounds.scale_factor > 0.0 {
        bounds.scale_factor
    } else {
        1.0
    };
    (
        bounds.x * scale_factor,
        bounds.y * scale_factor,
        (bounds.x + bounds.width) * scale_factor,
        (bounds.y + bounds.height) * scale_factor,
        scale_factor,
    )
}

fn padded_screen_region(
    region: &ScreenRegion,
    bounds: Option<&OverlayDisplayBounds>,
    pad_pct: f64,
    pad_min_px: f64,
) -> ScreenRegion {
    let x1 = region.x;
    let y1 = region.y;
    let x2 = region.x + region.width.max(0.0);
    let y2 = region.y + region.height.max(0.0);
    let scale_factor = bounds
        .map(|b| {
            if b.scale_factor > 0.0 {
                b.scale_factor
            } else {
                1.0
            }
        })
        .unwrap_or(1.0);
    let pad_min_px = pad_min_px * scale_factor;
    let pad_x = (pad_pct * (x2 - x1)).max(pad_min_px);
    let pad_y = (pad_pct * (y2 - y1)).max(pad_min_px);

    let (min_x, min_y, max_x, max_y) = bounds
        .map(|b| {
            let (min_x, min_y, max_x, max_y, _) = display_physical_bounds(b);
            (min_x, min_y, max_x, max_y)
        })
        .unwrap_or((0.0, 0.0, f64::INFINITY, f64::INFINITY));

    let px1 = (x1 - pad_x).max(min_x);
    let py1 = (y1 - pad_y).max(min_y);
    let px2 = (x2 + pad_x).min(max_x);
    let py2 = (y2 + pad_y).min(max_y);

    ScreenRegion {
        x: px1,
        y: py1,
        width: (px2 - px1).max(0.0),
        height: (py2 - py1).max(0.0),
    }
}

// Replace the model's visualTargets with the grounded boxes: one labeled
// `highlight_box` rectangle per detected element, plus a single `pointer` placed
// at the center of the primary (first) detected element so the companion cursor
// flies to Claude's actual pixel target. The boxes are the ground truth; the
// model's own targets (OCR elementIds) are discarded.
fn apply_box_targets(
    content: String,
    boxes: &[DetectedBox],
    bounds: &OverlayDisplayBounds,
) -> String {
    let Ok(mut parsed) = serde_json::from_str::<Value>(json_body(&content)) else {
        return content;
    };

    // Display extent in physical px — used to clamp padded boxes to the screen.
    let (min_x, min_y, max_x, max_y, scale_factor) = display_physical_bounds(bounds);

    // Padding: grow each side by max(min_px, pct * size) so the box has breathing
    // room instead of hugging the element exactly. Tunable at runtime (no rebuild).
    let pad_pct = provider_env_optional("KAIRO_BOX_PAD_PCT")
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| *v >= 0.0)
        .unwrap_or(0.30);
    let pad_min_px = provider_env_optional("KAIRO_BOX_PAD_MIN_PX")
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| *v >= 0.0)
        .unwrap_or(14.0)
        * scale_factor;

    // A detected box → raw (x, y, width, height) in physical px, clamped to the
    // display. The companion pointer uses this exact center so padding never
    // introduces a visual offset from the model's selected element.
    let raw_rect = |b: &DetectedBox| -> (f64, f64, f64, f64) {
        let x1 = ((bounds.x + b.norm_x1 * bounds.width) * scale_factor).clamp(min_x, max_x);
        let y1 = ((bounds.y + b.norm_y1 * bounds.height) * scale_factor).clamp(min_y, max_y);
        let x2 = ((bounds.x + b.norm_x2 * bounds.width) * scale_factor).clamp(min_x, max_x);
        let y2 = ((bounds.y + b.norm_y2 * bounds.height) * scale_factor).clamp(min_y, max_y);
        (x1, y1, (x2 - x1).max(0.0), (y2 - y1).max(0.0))
    };

    // A detected box → padded (x, y, width, height) in physical px, clamped to
    // the display. This is only for the drawn highlight breathing room.
    let padded_rect = |b: &DetectedBox| -> (f64, f64, f64, f64) {
        let (x1, y1, w, h) = raw_rect(b);
        let x2 = x1 + w;
        let y2 = y1 + h;
        let pad_x = (pad_pct * (x2 - x1)).max(pad_min_px);
        let pad_y = (pad_pct * (y2 - y1)).max(pad_min_px);
        let px1 = (x1 - pad_x).max(min_x);
        let py1 = (y1 - pad_y).max(min_y);
        let px2 = (x2 + pad_x).min(max_x);
        let py2 = (y2 + pad_y).min(max_y);
        (px1, py1, (px2 - px1).max(0.0), (py2 - py1).max(0.0))
    };

    let mut targets: Vec<Value> = Vec::new();

    // Primary box (first = most relevant) → companion cursor at the exact center
    // of Claude's detected element. The highlight may be padded, but the cursor
    // should point at the actual control/object the model selected.
    if let Some(primary) = boxes.first() {
        let (x, y, w, h) = raw_rect(primary);
        let center_x = x + w / 2.0;
        let center_y = y + h / 2.0;
        let marker_px = 44.0 * scale_factor;
        targets.push(json!({
            "kind": "pointer",
            "targetId": "vision-primary",
            "label": primary.label,
            "confidence": 0.95,
            "color": primary.color,
            "screenRegion": {
                "x": center_x - marker_px / 2.0,
                "y": center_y - marker_px / 2.0,
                "width": marker_px,
                "height": marker_px,
            },
        }));
    }

    // Every box → a labeled, padded highlight rectangle drawn in the overlay.
    for (index, b) in boxes.iter().enumerate() {
        let (x, y, w, h) = padded_rect(b);
        targets.push(json!({
            "kind": "highlight_box",
            "targetId": format!("vision-box-{index}"),
            "label": b.label,
            "confidence": 0.9,
            "color": b.color,
            "screenRegion": {
                "x": x,
                "y": y,
                "width": w,
                "height": h,
            },
        }));
    }

    if let Some(object) = parsed.as_object_mut() {
        object.insert("visualTargets".to_string(), Value::Array(targets));
    }
    serde_json::to_string(&parsed).unwrap_or(content)
}

// The on-screen text elements, listed for the model with ids + center positions.
fn build_screen_elements_block(elements: &[OcrElement]) -> String {
    if elements.is_empty() {
        return String::new();
    }
    let mut lines = Vec::with_capacity(elements.len() + 1);
    lines.push(
        "SCREEN ELEMENTS — text currently visible on the user's screen. Each line is `id: \"text\" @ x%,y%`, where x%,y% is the element's center (x from the left edge, y from the top). You may set visualTargets.elementId to one of these ids for text elements. For icon-only controls or visual objects, use the screenshot and return a tight screenRegion instead."
            .to_string(),
    );
    for element in elements {
        lines.push(format!(
            "{}: \"{}\" @ {:.0}%,{:.0}%",
            element.id,
            element.text.replace('"', "'").replace('\n', " "),
            element.center_x_pct,
            element.center_y_pct
        ));
    }
    lines.join("\n")
}

// Replace each model-chosen visualTarget's elementId with the real OCR region for
// that element. Targets whose elementId doesn't match a detected element are
// dropped (we can't ground them), which keeps highlights accurate. The model
// never produces coordinates — they come from OCR.
fn ground_visual_targets(
    content: String,
    elements: &[OcrElement],
    bounds: Option<&OverlayDisplayBounds>,
) -> String {
    let Ok(mut parsed) = serde_json::from_str::<Value>(json_body(&content)) else {
        return content;
    };
    let Some(raw_targets) = parsed
        .get("visualTargets")
        .and_then(Value::as_array)
        .cloned()
    else {
        return content;
    };

    let mut grounded: Vec<Value> = Vec::new();
    for (index, target) in raw_targets.iter().enumerate() {
        let direct_region = target.get("screenRegion").and_then(Value::as_object);
        if let Some(region) = direct_region {
            let coords = (
                region.get("x").and_then(Value::as_f64),
                region.get("y").and_then(Value::as_f64),
                region.get("width").and_then(Value::as_f64),
                region.get("height").and_then(Value::as_f64),
            );
            if let (Some(x), Some(y), Some(width), Some(height)) = coords {
                if width > 0.0 && height > 0.0 {
                    let kind = match target.get("kind").and_then(Value::as_str) {
                        Some(
                            k @ ("pointer" | "highlight_box" | "arrow" | "underline" | "spotlight"
                            | "ghost_cursor"),
                        ) => k,
                        _ => "highlight_box",
                    };
                    let label = target
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or("Suggested target");
                    let target_id = target
                        .get("targetId")
                        .or_else(|| target.get("target_id"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("provider-target-{}", index + 1));
                    let confidence = target
                        .get("confidence")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.7);
                    let color = target.get("color").and_then(Value::as_str);
                    let mut screen_region = ScreenRegion {
                        x,
                        y,
                        width,
                        height,
                    };
                    if matches!(kind, "highlight_box" | "spotlight") {
                        screen_region = padded_screen_region(&screen_region, bounds, 0.25, 14.0);
                    } else if kind == "underline" {
                        screen_region = padded_screen_region(&screen_region, bounds, 0.18, 8.0);
                    }
                    let mut value = json!({
                        "kind": kind,
                        "targetId": target_id,
                        "label": label,
                        "confidence": confidence,
                        "screenRegion": {
                            "x": screen_region.x,
                            "y": screen_region.y,
                            "width": screen_region.width,
                            "height": screen_region.height,
                        },
                    });
                    if let (Some(object), Some(color)) = (value.as_object_mut(), color) {
                        object.insert("color".to_string(), Value::String(color.to_string()));
                    }
                    grounded.push(value);
                    continue;
                }
            }
        }

        let element_id = target
            .get("elementId")
            .or_else(|| target.get("targetElementId"))
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
            });
        let Some(element_id) = element_id else {
            continue;
        };
        let Some(element) = elements.iter().find(|e| e.id as u64 == element_id) else {
            continue;
        };
        let kind = match target.get("kind").and_then(Value::as_str) {
            Some(
                k @ ("pointer" | "highlight_box" | "arrow" | "underline" | "spotlight"
                | "ghost_cursor"),
            ) => k,
            _ => "highlight_box",
        };
        let label = target
            .get("label")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| element.text.clone());
        let confidence = target
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.9);
        let screen_region = if matches!(kind, "highlight_box" | "spotlight") {
            padded_screen_region(&element.region, bounds, 0.30, 14.0)
        } else if kind == "underline" {
            padded_screen_region(&element.region, bounds, 0.22, 10.0)
        } else {
            element.region.clone()
        };
        grounded.push(json!({
            "kind": kind,
            "targetId": format!("element-{element_id}"),
            "label": label,
            "confidence": confidence,
            "screenRegion": {
                "x": screen_region.x,
                "y": screen_region.y,
                "width": screen_region.width,
                "height": screen_region.height,
            },
        }));
    }

    if let Some(object) = parsed.as_object_mut() {
        object.insert("visualTargets".to_string(), Value::Array(grounded));
    }
    serde_json::to_string(&parsed).unwrap_or(content)
}

fn build_annotation_summary(input: &TutorTurnInput) -> String {
    if input.annotations.is_empty() {
        return "No user annotations.".to_string();
    }

    "The screenshot includes Kairo user markup drawn over the screen. Interpret arrows by their heads, loops/circles by what they enclose, boxes by their enclosed region, underlines by the nearby text, and freehand strokes by nearby UI. Use the markup only as visual attention guidance. Do not count the marks or expose internal annotation IDs. Describe the underlying marked content, app UI, or likely user intent instead.".to_string()
}

fn build_tutor_user_prompt(input: &TutorTurnInput) -> Result<String, String> {
    serde_json::to_string_pretty(&json!({
        "userQuery": input.user_query,
        "activeApp": input.active_app,
        "annotationSummary": build_annotation_summary(input),
        "screen": {
            "captured": input.screen.captured,
            "reason": input.screen.reason,
            "imageMimeType": input.screen.image_mime_type,
            "byteLength": input.screen.byte_length,
            "displayBounds": input.screen.display_bounds,
        },
        "skillLandmarks": input.skill.landmarks,
    }))
    .map_err(|error| format!("Failed to build tutor prompt: {error}"))
}

fn build_openrouter_messages(
    input: &TutorTurnInput,
    include_screenshot: bool,
    elements: &[OcrElement],
) -> Result<Value, String> {
    let user_prompt = build_tutor_user_prompt(input)?;
    let system_prompt = build_tutor_system_prompt(input);
    let elements_block = build_screen_elements_block(elements);

    if include_screenshot && input.screen.captured {
        if let (Some(mime_type), Some(image_base64)) =
            (&input.screen.image_mime_type, &input.screen.image_base64)
        {
            let mut user_content = vec![json!({ "type": "text", "text": user_prompt })];
            if !elements_block.is_empty() {
                user_content.push(json!({ "type": "text", "text": elements_block }));
            }
            user_content.push(json!({
                "type": "image_url",
                "image_url": { "url": format!("data:{mime_type};base64,{image_base64}") },
            }));
            return Ok(json!([
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_content },
            ]));
        }
    }

    Ok(json!([
        { "role": "system", "content": system_prompt },
        { "role": "user", "content": user_prompt },
    ]))
}

fn build_openrouter_request_body(
    input: &TutorTurnInput,
    model: &str,
    include_screenshot: bool,
    elements: &[OcrElement],
) -> Result<Value, String> {
    Ok(json!({
        "model": model,
        "messages": build_openrouter_messages(input, include_screenshot, elements)?,
        "response_format": { "type": "json_object" },
        "temperature": 0.2,
        "max_tokens": 700,
    }))
}

fn select_openrouter_request_model(
    input: &TutorTurnInput,
    text_model: &str,
    vision_model: &str,
) -> (String, bool) {
    if input.screen.captured && input.screen.image_base64.is_some() {
        return (vision_model.to_string(), true);
    }

    (text_model.to_string(), false)
}

fn audio_filename(input: &TranscribeAudioInput) -> String {
    if let Some(filename) = input
        .filename
        .as_deref()
        .map(str::trim)
        .filter(|filename| !filename.is_empty())
    {
        return filename.to_string();
    }

    let extension = if input.mime_type.contains("mpeg") || input.mime_type.contains("mp3") {
        "mp3"
    } else if input.mime_type.contains("mp4") {
        "m4a"
    } else if input.mime_type.contains("webm") {
        "webm"
    } else {
        "wav"
    };

    format!("kairo-voice.{extension}")
}

fn decode_audio_base64(input: &TranscribeAudioInput) -> Result<Vec<u8>, String> {
    use base64::Engine;

    base64::engine::general_purpose::STANDARD
        .decode(input.audio_base64.trim())
        .map_err(|error| format!("Voice recording was not valid base64 audio: {error}"))
}

fn parse_provider_json_error(payload: &Value, fallback: &str) -> String {
    payload
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("detail")
                .and_then(|detail| detail.get("message"))
                .and_then(Value::as_str)
        })
        .or_else(|| payload.get("message").and_then(Value::as_str))
        .unwrap_or(fallback)
        .to_string()
}

async fn parse_transcription_response(
    response: reqwest::Response,
    transcript_keys: &[&str],
    missing_message: &str,
) -> Result<String, String> {
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("STT response was not JSON: {error}"))?;

    if !status.is_success() {
        return Err(parse_provider_json_error(
            &payload,
            &format!("STT request failed with {status}"),
        ));
    }

    transcript_keys
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| missing_message.to_string())
}

async fn parse_sarvam_tts_response(response: reqwest::Response) -> Result<String, String> {
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Sarvam TTS response was not JSON: {error}"))?;

    if !status.is_success() {
        return Err(parse_provider_json_error(
            &payload,
            &format!("Sarvam TTS request failed with {status}"),
        ));
    }

    payload
        .get("audios")
        .and_then(Value::as_array)
        .and_then(|audios| audios.first())
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|audio| !audio.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "Sarvam TTS response did not include audio.".to_string())
}

async fn parse_binary_audio_response(
    response: reqwest::Response,
    provider_name: &str,
    default_mime_type: &str,
) -> Result<(String, String), String> {
    use base64::Engine;

    let status = response.status();
    let mime_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or(default_mime_type)
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("{provider_name} TTS response could not be read: {error}"))?;

    if !status.is_success() {
        if let Ok(payload) = serde_json::from_slice::<Value>(&bytes) {
            return Err(parse_provider_json_error(
                &payload,
                &format!("{provider_name} TTS request failed with {status}"),
            ));
        }

        return Err(format!("{provider_name} TTS request failed with {status}"));
    }

    if bytes.is_empty() {
        return Err(format!(
            "{provider_name} TTS response did not include audio."
        ));
    }

    Ok((
        base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type,
    ))
}

#[derive(Debug)]
struct OpenRouterChatError {
    message: String,
    retry_without_screenshot: bool,
}

impl OpenRouterChatError {
    fn new(message: String, retry_without_screenshot: bool) -> Self {
        Self {
            message,
            retry_without_screenshot,
        }
    }
}

// One pooled HTTP client shared across providers, so connections (TLS) stay
// warm instead of a cold handshake on every STT/TTS/LLM call. Per-request
// timeouts are applied at each call site.
fn shared_http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("failed to build shared HTTP client")
    })
}

async fn send_openrouter_chat_request(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    app_title: &str,
    site_url: Option<&str>,
    timeout: Duration,
    body: Value,
) -> Result<String, OpenRouterChatError> {
    let mut request = client
        .post(endpoint)
        .timeout(timeout)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .header("X-OpenRouter-Title", app_title);

    if let Some(site_url) = site_url {
        request = request.header("HTTP-Referer", site_url);
    }

    let response = request.json(&body).send().await.map_err(|error| {
        OpenRouterChatError::new(format!("OpenRouter request failed: {error}"), false)
    })?;
    let status = response.status();
    let payload = response.json::<Value>().await.map_err(|error| {
        OpenRouterChatError::new(format!("OpenRouter response was not JSON: {error}"), false)
    })?;

    if !status.is_success() {
        let message = payload
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .or_else(|| payload.get("message").and_then(Value::as_str))
            .unwrap_or("OpenRouter request failed");
        return Err(OpenRouterChatError::new(message.to_string(), true));
    }

    payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| {
            OpenRouterChatError::new(
                "OpenRouter response did not include assistant content.".to_string(),
                false,
            )
        })
}

#[tauri::command]
async fn run_tutor_turn(input: TutorTurnInput) -> Result<String, String> {
    let provider = provider_env("KAIRO_AI_PROVIDER", "mock");
    if provider != "openrouter" {
        return Err(
            "Native tutor provider is only configured for KAIRO_AI_PROVIDER=openrouter."
                .to_string(),
        );
    }

    let api_key = provider_env_optional("OPENROUTER_API_KEY").ok_or_else(|| {
        "OPENROUTER_API_KEY is required for native OpenRouter tutor turns.".to_string()
    })?;
    let model = provider_env("OPENROUTER_MODEL", "~openai/gpt-latest");
    let vision_model = provider_env_optional("OPENROUTER_VISION_MODEL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_OPENROUTER_VISION_MODEL.to_string());
    let base_url = provider_env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
    let site_url = provider_env_optional("OPENROUTER_SITE_URL");
    let app_title = provider_env("OPENROUTER_APP_TITLE", "Kairo Tutor");
    let timeout = Duration::from_millis(provider_timeout_ms(provider_env_optional(
        "OPENROUTER_REQUEST_TIMEOUT_MS",
    )));
    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    // OCR the screenshot (fast, local) for the Set-of-Mark fallback and for
    // snapping the Computer Use point onto a tight text box.
    let ocr_elements = ocr_tutor_screenshot(&input);

    let client = shared_http_client();
    let site_url_ref = site_url.as_deref();

    // The verbal answer and the Computer Use pointing are independent, so run them
    // together — the (slower) pointing call then adds no wall-clock to the turn.
    let answer_future = async {
        let request_body = {
            let (request_model, include_screenshot) =
                select_openrouter_request_model(&input, &model, &vision_model);
            build_openrouter_request_body(
                &input,
                &request_model,
                include_screenshot,
                &ocr_elements,
            )?
        };
        let first = send_openrouter_chat_request(
            client,
            &endpoint,
            &api_key,
            &app_title,
            site_url_ref,
            timeout,
            request_body,
        )
        .await;
        match first {
            Ok(content) => Ok(content),
            Err(error)
                if error.retry_without_screenshot
                    && input.screen.captured
                    && input.screen.image_base64.is_some() =>
            {
                eprintln!(
                    "Kairo Tutor OpenRouter screenshot request failed; retrying text-only: {}",
                    error.message
                );
                send_openrouter_chat_request(
                    client,
                    &endpoint,
                    &api_key,
                    &app_title,
                    site_url_ref,
                    timeout,
                    build_openrouter_request_body(&input, &model, false, &[])?,
                )
                .await
                .map_err(|retry_error| {
                    format!(
                        "{} Text-only retry after screenshot failure also failed: {}",
                        error.message, retry_error.message
                    )
                })
            }
            Err(error) => Err(error.message),
        }
    };

    let boxes_future = async {
        if !input.screen.captured {
            return Vec::new();
        }
        let (Some(image_base64), Some(bounds)) =
            (&input.screen.image_base64, &input.screen.display_bounds)
        else {
            return Vec::new();
        };
        detect_element_boxes(image_base64, bounds, &input.user_query, &ocr_elements).await
    };

    let (answer_result, detected_boxes) = tokio::join!(answer_future, boxes_future);
    let content = answer_result?;

    // Prefer Claude vision boxes — they ground any element (icons/non-text/any
    // app) and give drawable labeled rectangles. Fall back to OCR Set-of-Mark
    // when none were found (e.g. no ANTHROPIC_API_KEY, or a purely conceptual
    // question with nothing on screen to box).
    match (
        detected_boxes.is_empty(),
        input.screen.display_bounds.as_ref(),
    ) {
        (false, Some(bounds)) => Ok(apply_box_targets(content, &detected_boxes, bounds)),
        _ => Ok(ground_visual_targets(
            content,
            &ocr_elements,
            input.screen.display_bounds.as_ref(),
        )),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GateInput {
    user_query: String,
    #[serde(default)]
    active_app: Option<String>,
    #[serde(default)]
    window_title: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[tauri::command]
async fn run_gate_turn(input: GateInput) -> Result<String, String> {
    // Safe default when no text provider is configured: always look (the full vision
    // turn then runs), so behaviour degrades to the pre-gate flow.
    let look = || json!({ "needsScreen": true, "voiceText": "" }).to_string();

    if provider_env("KAIRO_AI_PROVIDER", "mock") != "openrouter" {
        return Ok(look());
    }
    let Some(api_key) = provider_env_optional("OPENROUTER_API_KEY") else {
        return Ok(look());
    };
    let model = provider_env("OPENROUTER_MODEL", "~openai/gpt-latest");
    let base_url = provider_env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
    let site_url = provider_env_optional("OPENROUTER_SITE_URL");
    let app_title = provider_env("OPENROUTER_APP_TITLE", "Kairo Tutor");
    let timeout = Duration::from_millis(provider_timeout_ms(provider_env_optional(
        "OPENROUTER_REQUEST_TIMEOUT_MS",
    )));
    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let app = input.active_app.unwrap_or_else(|| "unknown".to_string());
    let title = input.window_title.unwrap_or_default();
    let url = input.url.unwrap_or_default();
    let user_message = format!(
        "Active app: {app}\nWindow title: {title}\nPage URL: {url}\nUser question (spoken): \"{}\"",
        input.user_query
    );
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": gate_system_prompt() },
            { "role": "user", "content": user_message },
        ],
        "response_format": { "type": "json_object" },
    });

    match send_openrouter_chat_request(
        shared_http_client(),
        &endpoint,
        &api_key,
        &app_title,
        site_url.as_deref(),
        timeout,
        body,
    )
    .await
    {
        Ok(content) => {
            eprintln!("[gate] {}", content.chars().take(200).collect::<String>());
            Ok(content)
        }
        Err(error) => {
            eprintln!("Kairo Tutor gate turn failed; defaulting to look: {}", error.message);
            Ok(look())
        }
    }
}

#[tauri::command]
async fn transcribe_audio(input: TranscribeAudioInput) -> Result<TranscriptionResult, String> {
    let provider = provider_env("KAIRO_STT_PROVIDER", "mock");
    if provider == "mock" {
        return Ok(TranscriptionResult {
            text: String::new(),
            provider,
        });
    }

    let audio_bytes = decode_audio_base64(&input)?;
    if audio_bytes.is_empty() {
        return Err("Voice recording was empty.".to_string());
    }

    let filename = audio_filename(&input);
    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(filename)
        .mime_str(&input.mime_type)
        .map_err(|error| format!("Unsupported voice recording MIME type: {error}"))?;
    let client = shared_http_client();

    if provider == "sarvam" {
        let api_key = provider_env_optional("SARVAM_API_KEY")
            .ok_or_else(|| "SARVAM_API_KEY is required for Sarvam transcription.".to_string())?;
        let base_url = provider_env("SARVAM_BASE_URL", "https://api.sarvam.ai");
        // Pin the language so Sarvam doesn't auto-detect the wrong one (it
        // guessed gu-IN on a cold first recording and returned an empty
        // transcript). Set SARVAM_STT_LANGUAGE_CODE=unknown to auto-detect.
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", provider_env("SARVAM_STT_MODEL", "saaras:v3"))
            .text("mode", provider_env("SARVAM_STT_MODE", "transcribe"))
            .text(
                "language_code",
                provider_env("SARVAM_STT_LANGUAGE_CODE", "en-IN"),
            );
        let response = client
            .post(format!("{}/speech-to-text", base_url.trim_end_matches('/')))
            .header("api-subscription-key", api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|error| format!("Sarvam STT request failed: {error}"))?;
        let body = response.text().await.unwrap_or_default();
        let value: Value = serde_json::from_str(&body)
            .map_err(|error| format!("Sarvam STT response was not JSON: {error}"))?;
        let text = value
            .get("transcript")
            .or_else(|| value.get("text"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Sarvam STT response did not include transcript text.".to_string())?
            .to_string();

        return Ok(TranscriptionResult { text, provider });
    }

    if provider == "elevenlabs" {
        let api_key = provider_env_optional("ELEVENLABS_API_KEY").ok_or_else(|| {
            "ELEVENLABS_API_KEY is required for ElevenLabs transcription.".to_string()
        })?;
        let base_url = provider_env("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io");
        let form = reqwest::multipart::Form::new().part("file", part).text(
            "model_id",
            provider_env("ELEVENLABS_STT_MODEL", "scribe_v1"),
        );
        let text = parse_transcription_response(
            client
                .post(format!(
                    "{}/v1/speech-to-text",
                    base_url.trim_end_matches('/')
                ))
                .header("xi-api-key", api_key)
                .multipart(form)
                .send()
                .await
                .map_err(|error| format!("ElevenLabs STT request failed: {error}"))?,
            &["text"],
            "ElevenLabs STT response did not include transcript text.",
        )
        .await?;

        return Ok(TranscriptionResult { text, provider });
    }

    Err(format!("Unsupported KAIRO_STT_PROVIDER={provider}."))
}

#[tauri::command]
async fn synthesize_speech(input: SynthesizeSpeechInput) -> Result<SpeechSynthesisResult, String> {
    let provider = provider_env("KAIRO_TTS_PROVIDER", "mock");
    let text = input.text.trim();
    if provider == "mock" || text.is_empty() {
        return Ok(SpeechSynthesisResult {
            audio_base64: String::new(),
            mime_type: "audio/mpeg".to_string(),
            provider,
        });
    }

    let client = shared_http_client();

    if provider == "sarvam" {
        let api_key = provider_env_optional("SARVAM_API_KEY")
            .ok_or_else(|| "SARVAM_API_KEY is required for Sarvam speech synthesis.".to_string())?;
        let base_url = provider_env("SARVAM_BASE_URL", "https://api.sarvam.ai");
        let audio_base64 = parse_sarvam_tts_response(
            client
                .post(format!("{}/text-to-speech", base_url.trim_end_matches('/')))
                .header("api-subscription-key", api_key)
                .header("Content-Type", "application/json")
                .json(&json!({
                    "text": text,
                    "target_language_code": provider_env("SARVAM_TTS_LANGUAGE_CODE", "en-IN"),
                    "speaker": provider_env("SARVAM_TTS_SPEAKER", "anushka"),
                    "model": provider_env("SARVAM_TTS_MODEL", "bulbul:v3"),
                    "output_audio_codec": "wav",
                    "speech_sample_rate": 24000,
                }))
                .send()
                .await
                .map_err(|error| format!("Sarvam TTS request failed: {error}"))?,
        )
        .await?;

        return Ok(SpeechSynthesisResult {
            audio_base64,
            mime_type: "audio/wav".to_string(),
            provider,
        });
    }

    if provider == "elevenlabs" {
        let api_key = provider_env_optional("ELEVENLABS_API_KEY").ok_or_else(|| {
            "ELEVENLABS_API_KEY is required for ElevenLabs speech synthesis.".to_string()
        })?;
        let base_url = provider_env("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io");
        let voice_id = provider_env("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM");
        let (audio_base64, mime_type) = parse_binary_audio_response(
            client
                .post(format!(
                    "{}/v1/text-to-speech/{}",
                    base_url.trim_end_matches('/'),
                    voice_id
                ))
                .header("xi-api-key", api_key)
                .header("Content-Type", "application/json")
                .json(&json!({
                    "text": text,
                    "model_id": provider_env("ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2"),
                }))
                .send()
                .await
                .map_err(|error| format!("ElevenLabs TTS request failed: {error}"))?,
            "ElevenLabs",
            "audio/mpeg",
        )
        .await?;

        return Ok(SpeechSynthesisResult {
            audio_base64,
            mime_type,
            provider,
        });
    }

    Err(format!("Unsupported KAIRO_TTS_PROVIDER={provider}."))
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

#[tauri::command]
fn debug_log(message: String) {
    eprintln!("[fe-diag] {message}");
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

#[allow(dead_code)]
fn _permission_status_fallback() -> PermissionStatus {
    PermissionStatus {
        screen_recording: PermissionState::Unknown,
        accessibility: PermissionState::Unknown,
        microphone: PermissionState::Unknown,
    }
}

fn requires_permission_setup(state: &PermissionState) -> bool {
    matches!(
        state,
        PermissionState::Denied | PermissionState::NotDetermined
    )
}

fn should_show_setup_window(status: &PermissionStatus) -> bool {
    requires_permission_setup(&status.screen_recording)
        || requires_permission_setup(&status.accessibility)
        || requires_permission_setup(&status.microphone)
}

#[cfg(debug_assertions)]
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
    eprintln!(
        "Kairo Tutor startup: found main window; visible={visible}; position={position}; size={size}"
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
                eprintln!("Kairo Tutor activation shortcut failed to show notch: {error}");
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
                #[cfg(debug_assertions)]
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
                #[cfg(debug_assertions)]
                eprintln!("Kairo Tutor startup: main window was not created");
            }
            // Pre-create the notch panel + webview at startup so the first
            // shortcut press shows it instantly instead of building it lazily.
            if let Err(error) = ensure_notch_panel(app.handle()) {
                eprintln!("Kairo Tutor: failed to pre-create notch panel: {error}");
            }
            // Same for the annotation overlay panel.
            if let Err(error) = ensure_overlay_panel(app.handle()) {
                eprintln!("Kairo Tutor: failed to pre-create overlay panel: {error}");
            }
            // Companion cursor: create it, show it always, and start tracking the
            // real mouse so it shadows the cursor from launch.
            match ensure_cursor_panel(app.handle()) {
                Ok(panel) => {
                    panel.show();
                    spawn_mouse_tracker(app.handle());
                }
                Err(error) => {
                    eprintln!("Kairo Tutor: failed to pre-create cursor panel: {error}");
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
    use super::{
        apply_box_targets, audio_filename, box_locator_prompt, build_openrouter_messages,
        build_openrouter_request_body, decode_audio_base64, ground_visual_targets,
        notch_window_size, parse_local_env, provider_timeout_ms, select_openrouter_request_model,
        DetectedBox, OcrElement, OverlayDisplayBounds, ScreenRegion, SynthesizeSpeechInput,
        TranscribeAudioInput, TutorActiveAppContext, TutorAnnotation, TutorScreenInput,
        TutorSkillPack, TutorTurnInput, DEFAULT_OPENROUTER_VISION_MODEL,
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

        assert!(system_prompt.contains("Answer general user questions directly"));
        assert!(system_prompt.contains("Selected skill context, when relevant: Blender"));
        assert!(system_prompt.contains("WHERE/SHOW QUESTIONS"));
        assert!(system_prompt.contains("rectangle/box is usually a square outline icon"));
        assert!(system_prompt.contains("Do not mention a specific app, tool, or course by name"));
        assert!(system_prompt.contains("Annotation IDs are internal coordinate references only"));
        assert!(system_prompt.contains("Infer the intended target from arrow heads"));
        assert!(system_prompt.contains("answer what the annotations appear to highlight"));
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
        assert!(prompt.contains("All visible UI layers count"));
        assert!(prompt.contains("browser or app chrome"));
        assert!(prompt.contains("Do not ignore a control because it is outside the page content"));
        assert!(prompt.contains("Ignore Kairo's own assistant/notch/answer card"));
        assert!(prompt.contains("OCR/TEXT HINTS"));
        assert!(prompt.contains("\"github.com\""));
        assert!(prompt.contains("choose the visible editable field"));
        assert!(prompt.contains("target is usually the enclosing editable address/input field"));
        assert!(prompt.contains("Do not choose a search field unless the user asks to search"));
        assert!(prompt.contains("ABSOLUTE PIXELS of this 1568x982 image"));
    }

    #[test]
    fn box_locator_context_includes_ocr_position_hints() {
        let context = super::build_box_locator_context(&[OcrElement {
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
            tauri::async_runtime::block_on(super::synthesize_speech(SynthesizeSpeechInput {
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
