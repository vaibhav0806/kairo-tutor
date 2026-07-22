//! macOS permission checks/requests (screen recording, accessibility, microphone,
//! input monitoring) and the setup-window gating helpers.

use crate::types::{PermissionState, PermissionStatus};
#[cfg(target_os = "macos")]
use std::process::Command;

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
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

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

// IOKit's HID access APIs are the RELIABLE way to register an app in the Input Monitoring list +
// prompt (CGRequestListenEventAccess is known to sometimes prompt without listing the app — Apple
// forums). `kIOHIDRequestTypeListenEvent = 1`. IOHIDCheckAccess returns an IOHIDAccessType:
// 0 = granted, 1 = denied, 2 = unknown/not-determined. IOHIDRequestAccess prompts + registers.
#[cfg(target_os = "macos")]
const K_IOHID_REQUEST_TYPE_LISTEN_EVENT: u32 = 1;
#[cfg(target_os = "macos")]
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOHIDCheckAccess(request: u32) -> u32;
    fn IOHIDRequestAccess(request: u32) -> bool;
}

#[tauri::command]
pub(crate) fn get_permission_status() -> PermissionStatus {
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
pub(crate) fn microphone_state_from_av_status(status: AVAuthorizationStatus) -> PermissionState {
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
pub(crate) fn microphone_permission_status() -> PermissionState {
    let Some(media_type) = (unsafe { AVMediaTypeAudio }) else {
        return PermissionState::Unknown;
    };

    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
    microphone_state_from_av_status(status)
}

#[cfg(target_os = "macos")]
pub(crate) fn request_screen_recording_permission() -> PermissionState {
    if unsafe { CGPreflightScreenCaptureAccess() } || unsafe { CGRequestScreenCaptureAccess() } {
        PermissionState::Granted
    } else {
        PermissionState::NotDetermined
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn request_accessibility_permission() -> PermissionState {
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
pub(crate) fn request_microphone_permission(app: tauri::AppHandle) -> PermissionState {
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
pub(crate) fn request_required_permissions(app: tauri::AppHandle) -> PermissionStatus {
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

/// Fire ONLY the Screen Recording OS prompt (Act 3a). Registers Kairo in the Screen Recording list
/// and shows the system dialog. macOS forces a quit+reopen once granted — the onboarding resume
/// marker lands us back in Act 3 on relaunch. Screen-capture auth is cached per-process, so
/// `get_permission_status` may keep reading NotDetermined in THIS process until that relaunch.
///
/// CRITICAL: `CGRequestScreenCaptureAccess()` MUST run on the main thread. Fired from a Tauri worker
/// thread (the default for a #[command]) it silently no-ops — returns false, shows no dialog, and
/// never registers Kairo in the list. Same main-thread rule the mic + Input-Monitoring prompts obey.
#[tauri::command]
pub(crate) fn request_screen_recording(app: tauri::AppHandle) -> PermissionState {
    #[cfg(target_os = "macos")]
    {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            return PermissionState::Granted; // already granted (e.g. resumed after the relaunch)
        }
        // Prompt + list-registration on the MAIN thread. The call returns immediately (auth is
        // cached per-process, so it reads the OLD value now — the real grant lands after relaunch).
        let (sender, receiver) = std::sync::mpsc::channel();
        let dispatched = app.run_on_main_thread(move || {
            let granted = unsafe { CGRequestScreenCaptureAccess() };
            let _ = sender.send(granted);
        });
        if dispatched.is_err() {
            crate::klog!(app, error, "act3: could not dispatch screen-recording prompt to main thread");
            return PermissionState::Unknown;
        }
        let state = match receiver.recv_timeout(std::time::Duration::from_secs(3)) {
            Ok(true) => PermissionState::Granted,
            _ => PermissionState::NotDetermined, // dialog shown; grant takes effect on relaunch
        };
        crate::klog!(app, info, state = ?state, "act3: requested screen recording (main thread)");
        return state;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        PermissionState::Unknown
    }
}

/// Fire ONLY the Accessibility OS prompt (Act 3b). Crucially this ALSO registers Kairo in the
/// Accessibility list, so there is a toggle for the pet to point at.
#[tauri::command]
pub(crate) fn request_accessibility() -> PermissionState {
    #[cfg(target_os = "macos")]
    {
        let state = request_accessibility_permission();
        crate::klog!(app, info, state = ?state, "act3: requested accessibility");
        return state;
    }
    #[cfg(not(target_os = "macos"))]
    {
        PermissionState::Unknown
    }
}

#[tauri::command]
pub(crate) fn open_permission_settings(permission: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let pane = match permission.as_str() {
            "screenRecording" | "screen_recording" | "screen" => "Privacy_ScreenCapture",
            "accessibility" => "Privacy_Accessibility",
            "microphone" | "mic" => "Privacy_Microphone",
            "inputMonitoring" | "input_monitoring" => "Privacy_ListenEvent",
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

/// Prompt for Microphone ONLY (Act 2). Deliberately does NOT request Screen Recording — that
/// grant forces macOS to quit+reopen the app and belongs to Act 3. Returns the full status with
/// a freshly-requested microphone state.
#[tauri::command]
pub(crate) fn request_microphone(app: tauri::AppHandle) -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        let microphone = request_microphone_permission(app);
        crate::klog!(ptt, info, mic = ?microphone, "onboarding mic primer");
        let base = get_permission_status();
        return PermissionStatus { microphone, ..base };
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        _permission_status_fallback()
    }
}

/// Fire the Input-Monitoring prompt (and register Kairo in the Settings list). The ⌥⌃ tap needs
/// this SEPARATELY from Accessibility. No-op once granted.
#[tauri::command]
pub(crate) fn request_input_monitoring(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        // CGRequestListenEventAccess must run on the MAIN thread to actually show the prompt AND
        // register Kairo in the Input Monitoring list. Off the main thread it silently no-ops — the
        // list stays "No Items" and the user can't grant it. (Mic already dispatches to main, which
        // is why the mic prompt worked but this one didn't.)
        let _ = app.run_on_main_thread(ensure_input_monitoring_access);
        crate::klog!(ptt, info, "onboarding input-monitoring primer (main thread)");
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

/// Raw IOHIDCheckAccess for Input Monitoring: 0=granted, 1=denied, 2=unknown. For diagnostics.
#[cfg(target_os = "macos")]
pub(crate) fn input_monitoring_raw() -> u32 {
    unsafe { IOHIDCheckAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT) }
}

/// "granted" / "not_determined" / "unknown" — lets Act 2 poll the Input-Monitoring grant.
#[tauri::command]
pub(crate) fn get_input_monitoring_status() -> String {
    #[cfg(target_os = "macos")]
    {
        // IOHIDCheckAccess: 0=granted, 1=denied, 2=unknown. Prefer it over CGPreflight (which can
        // read "granted" off a modifier-only tap that never actually needed the grant).
        return match unsafe { IOHIDCheckAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT) } {
            0 => "granted",
            1 => "not_determined", // denied → keep guiding the user to flip it on
            _ => "not_determined",
        }
        .to_string();
    }
    #[cfg(not(target_os = "macos"))]
    {
        "unknown".to_string()
    }
}

// Ask for Input Monitoring so the ⌥⌃ push-to-talk tap can receive modifier events. Uses IOKit's
// IOHIDRequestAccess (the reliable "prompt + LIST the app in Settings" path). Also nudges the
// CoreGraphics variant for good measure. Must run on the MAIN thread.
#[cfg(target_os = "macos")]
pub(crate) fn ensure_input_monitoring_access() {
    unsafe {
        let hid_access = IOHIDCheckAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT); // 0=granted 1=denied 2=unknown
        // Request unconditionally unless already granted — this is what registers Kairo in the list.
        let hid_requested = if hid_access == 0 {
            true
        } else {
            IOHIDRequestAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT)
        };
        // Belt-and-suspenders CG call (some macOS builds only list via one path).
        let cg_pre = CGPreflightListenEventAccess();
        if !cg_pre {
            let _ = CGRequestListenEventAccess();
        }
        crate::klog!(
            ptt,
            info,
            hid_access = hid_access,
            hid_requested = hid_requested,
            cg_pre = cg_pre,
            "ensure IM access (IOKit + CG)"
        );
    }
}

#[allow(dead_code)]
pub(crate) fn _permission_status_fallback() -> PermissionStatus {
    PermissionStatus {
        screen_recording: PermissionState::Unknown,
        accessibility: PermissionState::Unknown,
        microphone: PermissionState::Unknown,
    }
}

pub(crate) fn requires_permission_setup(state: &PermissionState) -> bool {
    matches!(
        state,
        PermissionState::Denied | PermissionState::NotDetermined
    )
}

pub(crate) fn should_show_setup_window(status: &PermissionStatus) -> bool {
    requires_permission_setup(&status.screen_recording)
        || requires_permission_setup(&status.accessibility)
        || requires_permission_setup(&status.microphone)
}
