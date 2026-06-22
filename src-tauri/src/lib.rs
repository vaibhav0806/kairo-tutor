use serde::{Deserialize, Serialize};
use std::{fs, process::Command, sync::Mutex, time::Duration};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, State};
use tauri_plugin_global_shortcut::ShortcutState;

const KAIRO_ACTIVATION_SHORTCUT: &str = "CommandOrControl+Shift+Space";

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
use objc2::runtime::Bool;
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
    display_bounds: OverlayDisplayBounds,
    targets: Vec<OverlayTarget>,
}

#[derive(Default)]
struct OverlayState {
    current_payload: Mutex<Option<OverlayPayload>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotchPayload {
    state: String,
    title: String,
    detail: String,
}

#[derive(Default)]
struct NotchState {
    current_payload: Mutex<Option<NotchPayload>>,
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
        "com.apple.Safari",
        "com.google.Chrome",
        "com.brave.Browser",
        "org.mozilla.firefox",
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
        let handler = RcBlock::new(move |granted: Bool| {
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

fn ensure_notch_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    ensure_configured_window(app, "notch")
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

fn configure_overlay_window(
    window: &tauri::WebviewWindow,
    payload: &OverlayPayload,
) -> Result<(), String> {
    window
        .set_focusable(false)
        .map_err(|error| format!("Failed to keep overlay non-focusable: {error}"))?;
    window
        .set_always_on_top(true)
        .map_err(|error| format!("Failed to keep overlay above other windows: {error}"))?;
    window
        .set_skip_taskbar(true)
        .map_err(|error| format!("Failed to keep overlay out of the taskbar: {error}"))?;
    window
        .set_ignore_cursor_events(true)
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

fn configure_notch_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let width = 380.0;
    let height = 78.0;
    window
        .set_focusable(false)
        .map_err(|error| format!("Failed to keep notch non-focusable: {error}"))?;
    window
        .set_always_on_top(true)
        .map_err(|error| format!("Failed to keep notch above other windows: {error}"))?;
    window
        .set_skip_taskbar(true)
        .map_err(|error| format!("Failed to keep notch out of the taskbar: {error}"))?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| format!("Failed to keep notch click-through: {error}"))?;
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
    let window = ensure_notch_window(app)?;
    configure_notch_window(&window)?;
    if let Some(payload) = payload {
        store_notch_payload_inner(state, Some(payload.clone()))?;
        emit_notch_payload(&window, payload)?;
    }
    window
        .show()
        .map_err(|error| format!("Failed to show notch: {error}"))?;

    let window_to_hide = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(4500));
        let _ = window_to_hide.hide();
    });

    Ok(())
}

fn listening_notch_payload() -> NotchPayload {
    NotchPayload {
        state: "listening".to_string(),
        title: "Kairo is listening".to_string(),
        detail: "Capturing the current screen".to_string(),
    }
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
    if let Some(window) = app.get_webview_window("notch") {
        window
            .hide()
            .map_err(|error| format!("Failed to hide notch: {error}"))?;
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
            hide_notch
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kairo Tutor");
}
