use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::Duration,
};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, State};
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelHandle, PanelLevel, StyleMask,
    WebviewWindowExt,
};
use tauri_plugin_global_shortcut::ShortcutState;

const KAIRO_ACTIVATION_SHORTCUT: &str = "CommandOrControl+Shift+Space";
const DEFAULT_OPENROUTER_VISION_MODEL: &str = "google/gemini-2.5-flash";

// Non-activating NSPanel for the notch. A non-activating panel can receive
// input without activating the app, so showing it does not pull the user out
// of another app's full-screen Space (a plain NSWindow cannot do this).
tauri_panel! {
    panel!(NotchPanel {
        config: {
            can_become_key_window: true,
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
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TutorActiveAppContext {
    active_app: String,
    bundle_id: Option<String>,
    window_title: Option<String>,
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

#[tauri::command]
fn get_active_app() -> ActiveApp {
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
    let output_path =
        std::env::temp_dir().join(format!("kairo-screen-capture-{}.png", std::process::id()));

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
                let byte_length = bytes.len();
                let image_base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                return ScreenCaptureResult {
                    captured: true,
                    reason: None,
                    blocked_sensitive_app: false,
                    active_app: Some(active_app),
                    image_mime_type: Some("image/png".to_string()),
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

fn ensure_overlay_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    ensure_configured_window(app, "overlay")
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

// Tauri/tao's visibleOnAllWorkspaces only sets CanJoinAllSpaces, which is not
// enough to draw over a macOS full-screen app's dedicated Space. Adding
// FullScreenAuxiliary lets a non-activating window composite into the active
// full-screen Space, and a raised window level keeps it above the full-screen
// content (tao's always-on-top only uses NSFloatingWindowLevel, which is too low).
#[cfg(target_os = "macos")]
fn elevate_window_over_fullscreen(window: &tauri::WebviewWindow) {
    let ns_window_ptr = match window.ns_window() {
        Ok(ptr) => ptr,
        Err(error) => {
            eprintln!("[fs-diag] {} ns_window() error: {error}", window.label());
            return;
        }
    };
    if ns_window_ptr.is_null() {
        eprintln!("[fs-diag] {} ns_window() returned null", window.label());
        return;
    }
    eprintln!("[fs-diag] {} elevating (ptr ok)", window.label());
    let ns_window: &objc2_app_kit::NSWindow =
        unsafe { &*(ns_window_ptr as *const objc2_app_kit::NSWindow) };
    let behavior = objc2_app_kit::NSWindowCollectionBehavior::CanJoinAllSpaces
        | objc2_app_kit::NSWindowCollectionBehavior::FullScreenAuxiliary
        | objc2_app_kit::NSWindowCollectionBehavior::Stationary;
    ns_window.setCollectionBehavior(behavior);
    // NSStatusWindowLevel (25) floats over normal windows but not over a
    // full-screen app's content. NSScreenSaverWindowLevel (1000) sits above it.
    ns_window.setLevel(1000);
}

#[cfg(not(target_os = "macos"))]
fn elevate_window_over_fullscreen(_window: &tauri::WebviewWindow) {}

// Lazily create the notch window, convert it to a non-activating NSPanel, and
// apply the level / style / collection behavior that let it float over
// full-screen Spaces. Idempotent: returns the existing panel once converted.
fn ensure_notch_panel(app: &tauri::AppHandle) -> Result<PanelHandle<tauri::Wry>, String> {
    if let Ok(panel) = app.get_webview_panel("notch") {
        return Ok(panel);
    }

    let window = ensure_configured_window(app, "notch")?;
    let panel = window
        .to_panel::<NotchPanel>()
        .map_err(|error| format!("Failed to convert notch window to panel: {error}"))?;

    panel.set_level(PanelLevel::Floating.value());
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

    Ok(panel)
}

fn configure_overlay_window(
    window: &tauri::WebviewWindow,
    payload: &OverlayPayload,
) -> Result<(), String> {
    let is_annotation_mode = payload.mode.as_deref() == Some("annotate");
    window
        .set_focusable(is_annotation_mode)
        .map_err(|error| format!("Failed to keep overlay non-focusable: {error}"))?;
    window
        .set_always_on_top(true)
        .map_err(|error| format!("Failed to keep overlay above other windows: {error}"))?;
    window
        .set_skip_taskbar(true)
        .map_err(|error| format!("Failed to keep overlay out of the taskbar: {error}"))?;
    window
        .set_ignore_cursor_events(!is_annotation_mode)
        .map_err(|error| format!("Failed to keep overlay click-through: {error}"))?;
    let _ = window.set_shadow(false);
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

    elevate_window_over_fullscreen(window);

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
    let window = panel
        .to_window()
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

fn provider_timeout_ms(raw_value: Option<String>) -> u64 {
    raw_value
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(30_000)
}

fn build_tutor_system_prompt(input: &TutorTurnInput) -> String {
    [
        "You are Kairo Tutor, a screen-native software tutor.".to_string(),
        "Return only JSON that matches this TypeScript shape:".to_string(),
        "{ mode: \"idle\" | \"stuck_help\" | \"guided_lesson\", skillSlug: string, voiceText: string, screenText: string, visualTargets: VisualTarget[], expectedNextState: string }".to_string(),
        "Never return null for string fields. Use an empty string when a string field has no value.".to_string(),
        "VisualTarget kind must be one of highlight_box, ghost_cursor, arrow, underline, spotlight.".to_string(),
        "Use screenRegion pixel coordinates only for visible UI areas you are confident about.".to_string(),
        "Give exactly one short next step. Do not invent app state.".to_string(),
        "Answer general user questions directly. Do not refuse just because the question is outside the selected skill pack.".to_string(),
        "Use the selected skill pack only when it is relevant to the active app or user question.".to_string(),
        "When responding to a user question, prefer mode \"stuck_help\" or \"guided_lesson\"; reserve mode \"idle\" for no-op readiness.".to_string(),
        "If annotations are present, use them as user-marked screen areas and inspect the screenshot to infer what those marked areas point to.".to_string(),
        "Annotation IDs are internal coordinate references only. Never call them labels and never mention IDs like screen-annotation-1 in voiceText or screenText.".to_string(),
        "Treat orange drawings, arrows, circles, and doodles as visual attention guides. Infer the intended target from arrow heads, enclosed areas, nearby labels, and stroke direction.".to_string(),
        "Do not count, name, or describe the marks themselves unless the user explicitly asks about the drawing marks.".to_string(),
        "If the user asks whether you see annotations, answer what the annotations appear to highlight on the screen, not just that marks exist.".to_string(),
        "If the user asks about a marked area, answer what underlying screen content or UI element appears to be marked. If the drawing is ambiguous, say what it may be pointing to and ask a brief clarification.".to_string(),
        "Do not invent image labels or extra annotation objects.".to_string(),
        format!("Selected skill context, when relevant: {} ({}).", input.skill.display_name, input.skill.slug),
        format!("Constraints: {}", input.constraints.join(" ")),
    ]
    .join("\n")
}

fn build_annotation_summary(input: &TutorTurnInput) -> String {
    if input.annotations.is_empty() {
        return "No user annotations.".to_string();
    }

    "The screenshot includes orange user markup drawn over the screen. Interpret arrows by their heads, loops/circles by what they enclose, boxes by their enclosed region, underlines by the nearby text, and freehand strokes by nearby UI. Use the markup only as visual attention guidance. Do not count the marks or expose internal annotation IDs. Describe the underlying marked content, app UI, or likely user intent instead.".to_string()
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
) -> Result<Value, String> {
    let user_prompt = build_tutor_user_prompt(input)?;
    let system_prompt = build_tutor_system_prompt(input);

    if include_screenshot && input.screen.captured {
        if let (Some(mime_type), Some(image_base64)) =
            (&input.screen.image_mime_type, &input.screen.image_base64)
        {
            return Ok(json!([
                {
                    "role": "system",
                    "content": system_prompt,
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": user_prompt,
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:{mime_type};base64,{image_base64}"),
                            },
                        },
                    ],
                },
            ]));
        }
    }

    Ok(json!([
        {
            "role": "system",
            "content": system_prompt,
        },
        {
            "role": "user",
            "content": user_prompt,
        },
    ]))
}

fn build_openrouter_request_body(
    input: &TutorTurnInput,
    model: &str,
    include_screenshot: bool,
) -> Result<Value, String> {
    Ok(json!({
        "model": model,
        "messages": build_openrouter_messages(input, include_screenshot)?,
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

async fn send_openrouter_chat_request(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    app_title: &str,
    site_url: Option<&str>,
    body: Value,
) -> Result<String, OpenRouterChatError> {
    let mut request = client
        .post(endpoint)
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

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("Failed to build OpenRouter client: {error}"))?;
    let site_url_ref = site_url.as_deref();
    let first_result =
        send_openrouter_chat_request(&client, &endpoint, &api_key, &app_title, site_url_ref, {
            let (request_model, include_screenshot) =
                select_openrouter_request_model(&input, &model, &vision_model);
            build_openrouter_request_body(&input, &request_model, include_screenshot)?
        })
        .await;

    match first_result {
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
                &client,
                &endpoint,
                &api_key,
                &app_title,
                site_url_ref,
                build_openrouter_request_body(&input, &model, false)?,
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
    let timeout = Duration::from_millis(provider_timeout_ms(provider_env_optional(
        "KAIRO_STT_TIMEOUT_MS",
    )));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("Failed to build STT client: {error}"))?;

    if provider == "sarvam" {
        let api_key = provider_env_optional("SARVAM_API_KEY")
            .ok_or_else(|| "SARVAM_API_KEY is required for Sarvam transcription.".to_string())?;
        let base_url = provider_env("SARVAM_BASE_URL", "https://api.sarvam.ai");
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", provider_env("SARVAM_STT_MODEL", "saaras:v3"))
            .text("mode", provider_env("SARVAM_STT_MODE", "transcribe"));
        let text = parse_transcription_response(
            client
                .post(format!("{}/speech-to-text", base_url.trim_end_matches('/')))
                .header("api-subscription-key", api_key)
                .multipart(form)
                .send()
                .await
                .map_err(|error| format!("Sarvam STT request failed: {error}"))?,
            &["transcript", "text"],
            "Sarvam STT response did not include transcript text.",
        )
        .await?;

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

    let timeout = Duration::from_millis(provider_timeout_ms(provider_env_optional(
        "KAIRO_TTS_TIMEOUT_MS",
    )));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("Failed to build TTS client: {error}"))?;

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
    let window = ensure_overlay_window(&app)?;
    configure_overlay_window(&window, &payload)?;
    store_overlay_payload(&state, Some(payload.clone()))?;
    window
        .show()
        .map_err(|error| format!("Failed to show overlay: {error}"))?;
    if payload.mode.as_deref() == Some("annotate") {
        let _ = window.set_focus();
    }
    emit_overlay_payload(&window, payload)
}

#[tauri::command]
fn update_overlay(
    app: tauri::AppHandle,
    state: State<'_, OverlayState>,
    payload: OverlayPayload,
) -> Result<(), String> {
    let window = ensure_overlay_window(&app)?;
    configure_overlay_window(&window, &payload)?;
    store_overlay_payload(&state, Some(payload.clone()))?;
    emit_overlay_payload(&window, payload)
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
fn hide_overlay(app: tauri::AppHandle, state: State<'_, OverlayState>) -> Result<(), String> {
    store_overlay_payload(&state, None)?;
    if let Some(window) = app.get_webview_window("overlay") {
        window
            .hide()
            .map_err(|error| format!("Failed to hide overlay: {error}"))?;
    }
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

#[tauri::command]
fn hide_notch(app: tauri::AppHandle, state: State<'_, NotchState>) -> Result<(), String> {
    store_notch_payload(&state, None)?;
    if let Ok(panel) = app.get_webview_panel("notch") {
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
    let global_shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcut(KAIRO_ACTIVATION_SHORTCUT)
        .expect("failed to parse Kairo activation shortcut")
        .with_handler(|app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }

            let notch_state = app.state::<NotchState>();
            if let Err(error) =
                show_notch_with_payload(app, notch_state.inner(), Some(listening_notch_payload()))
            {
                eprintln!("Kairo Tutor activation shortcut failed to show notch: {error}");
            }

            let _ = app.emit("activation:shortcut", ());
        })
        .build();

    tauri::Builder::default()
        .manage(OverlayState::default())
        .manage(NotchState::default())
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_active_app,
            get_permission_status,
            request_required_permissions,
            open_permission_settings,
            capture_screen,
            show_overlay,
            update_overlay,
            get_current_overlay_payload,
            hide_overlay,
            show_notch,
            get_current_notch_payload,
            hide_notch,
            run_tutor_turn,
            transcribe_audio,
            synthesize_speech
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kairo Tutor");
}

#[cfg(test)]
mod tests {
    use super::{
        audio_filename, build_openrouter_messages, build_openrouter_request_body,
        decode_audio_base64, notch_window_size, parse_local_env, provider_timeout_ms,
        select_openrouter_request_model, OverlayDisplayBounds, ScreenRegion, SynthesizeSpeechInput,
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
        let body = build_openrouter_request_body(&input, "qwen/qwen3.6-flash", false)
            .expect("body should build");
        let system_prompt = body["messages"][0]["content"]
            .as_str()
            .expect("system prompt should be string");

        assert!(system_prompt.contains("Answer general user questions directly"));
        assert!(system_prompt.contains("Selected skill context, when relevant: Blender"));
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
        let body = build_openrouter_request_body(&input, "qwen/qwen3.6-flash", false)
            .expect("body should build");
        let user_prompt = body["messages"][1]["content"]
            .as_str()
            .expect("user prompt should be string");

        assert!(user_prompt.contains("\"annotationSummary\""));
        assert!(user_prompt.contains("orange user markup"));
        assert!(user_prompt.contains("Interpret arrows by their heads"));
        assert!(user_prompt.contains("visual attention guidance"));
        assert!(!user_prompt.contains("User annotations: exactly 1"));
        assert!(!user_prompt.contains("screen-annotation-1"));
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
