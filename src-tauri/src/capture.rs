//! Screen capture: shells out to macOS `screencapture`, reads main-display bounds,
//! downscales the screenshot for vision, and the `capture_screen` command.

use crate::platform::{get_active_app, is_sensitive_app};
use crate::types::{CaptureImageGeometry, DisplayBounds, ScreenCaptureResult};
#[cfg(target_os = "macos")]
use std::ffi::OsString;
#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(target_os = "macos")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use core_graphics::display::CGDisplay;
#[cfg(target_os = "macos")]
use objc2::{
    rc::Retained,
    runtime::{AnyObject, NSObjectProtocol, ProtocolObject},
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSWorkspace, NSWorkspaceDidActivateApplicationNotification};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSNotification, NSNotificationCenter};

#[cfg(target_os = "macos")]
fn screencapture_arguments(output_path: &Path) -> Vec<OsString> {
    ["-x", "-m", "-t", "png"]
        .into_iter()
        .map(OsString::from)
        .chain(std::iter::once(output_path.as_os_str().to_owned()))
        .collect()
}

#[cfg(target_os = "macos")]
struct TemporaryCaptureFile {
    path: PathBuf,
}

#[cfg(target_os = "macos")]
impl TemporaryCaptureFile {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(target_os = "macos")]
impl Drop for TemporaryCaptureFile {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                crate::klog!(
                    screen,
                    warn,
                    "failed to remove temporary screenshot: {error}"
                );
            }
        }
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
    let capture_file = TemporaryCaptureFile::new(output_path);

    let output = Command::new("screencapture")
        .args(screencapture_arguments(capture_file.path()))
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

    let bytes = fs::read(capture_file.path())
        .map_err(|error| format!("Failed to read captured screenshot: {error}"))?;
    Ok(bytes)
}

/// Raw PNG bytes of the main display. Used by the follow-along frame-hash;
/// not sent to any model. Reuses the same `screencapture` path as `capture_screen`.
pub(crate) fn capture_screen_png_bytes() -> Result<Vec<u8>, String> {
    #[cfg(target_os = "macos")]
    {
        capture_screen_with_screencapture()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Screen capture is only implemented for macOS.".to_string())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn main_display_bounds() -> DisplayBounds {
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

fn display_bounds_summary(bounds: &DisplayBounds) -> String {
    format!(
        "x={:.1} y={:.1} w={:.1} h={:.1} scale={:.3}",
        bounds.x, bounds.y, bounds.width, bounds.height, bounds.scale_factor
    )
}

fn downscale_screenshot(
    png_bytes: Vec<u8>,
) -> (Vec<u8>, &'static str, Option<CaptureImageGeometry>) {
    let Ok(image) = image::load_from_memory(&png_bytes) else {
        return (png_bytes, "image/png", None);
    };
    let original_width = image.width();
    let original_height = image.height();
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
        Ok(()) => {
            let output_width = scaled.width();
            let output_height = scaled.height();
            (
                out.into_inner(),
                "image/jpeg",
                Some(CaptureImageGeometry {
                    raw_width: original_width,
                    raw_height: original_height,
                    encoded_width: output_width,
                    encoded_height: output_height,
                }),
            )
        }
        Err(_) => (
            png_bytes,
            "image/png",
            Some(CaptureImageGeometry {
                raw_width: original_width,
                raw_height: original_height,
                encoded_width: original_width,
                encoded_height: original_height,
            }),
        ),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum CaptureContextValidation {
    Stable,
    Changed,
    Sensitive,
}

fn validate_capture_context(
    before_capture: &crate::types::ActiveApp,
    after_capture: &crate::types::ActiveApp,
) -> CaptureContextValidation {
    if is_sensitive_app(after_capture) {
        return CaptureContextValidation::Sensitive;
    }

    let same_app = match (
        before_capture.bundle_id.as_deref(),
        after_capture.bundle_id.as_deref(),
    ) {
        (Some(before), Some(after)) => before == after,
        (None, None) => before_capture.active_app == after_capture.active_app,
        _ => false,
    };

    if same_app {
        CaptureContextValidation::Stable
    } else {
        CaptureContextValidation::Changed
    }
}

fn validate_capture_context_with_activation(
    before_capture: &crate::types::ActiveApp,
    after_capture: &crate::types::ActiveApp,
    activation_observed: bool,
) -> CaptureContextValidation {
    if is_sensitive_app(after_capture) {
        CaptureContextValidation::Sensitive
    } else if activation_observed {
        CaptureContextValidation::Changed
    } else {
        validate_capture_context(before_capture, after_capture)
    }
}

#[cfg(target_os = "macos")]
struct FrontmostAppActivationObserver {
    notification_center: Retained<NSNotificationCenter>,
    observer: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    activation_observed: Arc<AtomicBool>,
}

#[cfg(target_os = "macos")]
impl FrontmostAppActivationObserver {
    fn new() -> Self {
        let activation_observed = Arc::new(AtomicBool::new(false));
        let observed_in_handler = Arc::clone(&activation_observed);
        let handler = RcBlock::new(move |_notification: std::ptr::NonNull<NSNotification>| {
            observed_in_handler.store(true, Ordering::Release);
        });
        let notification_center = NSWorkspace::sharedWorkspace().notificationCenter();
        // Register before taking the approved-app snapshot. That ordering makes
        // the observer conservative: an activation racing with the snapshot is
        // recorded and causes the eventual frame to be discarded.
        let observer = unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidActivateApplicationNotification),
                None,
                None,
                &handler,
            )
        };

        Self {
            notification_center,
            observer,
            activation_observed,
        }
    }

    fn observed_activation(&self) -> bool {
        self.activation_observed.load(Ordering::Acquire)
    }
}

#[cfg(target_os = "macos")]
impl Drop for FrontmostAppActivationObserver {
    fn drop(&mut self) {
        let protocol_observer: &ProtocolObject<dyn NSObjectProtocol> = &self.observer;
        let observer: &AnyObject = protocol_observer.as_ref();
        unsafe {
            self.notification_center.removeObserver(observer);
        }
    }
}

// Run off the app event loop so NSWorkspace can deliver activation notifications
// while the external screencapture process is blocking this command.
#[tauri::command(async)]
pub(crate) fn capture_screen() -> ScreenCaptureResult {
    let _t = crate::klog::timer("screen", "capture");
    #[cfg(target_os = "macos")]
    {
        let activation_observer = FrontmostAppActivationObserver::new();
        let active_app = get_active_app();
        let bounds = main_display_bounds();
        let bounds_summary = display_bounds_summary(&bounds);
        if is_sensitive_app(&active_app) {
            crate::klog!(
                screen,
                info,
                captured = false,
                sensitive = true,
                active_app = %active_app.active_app,
                bounds = %bounds_summary,
                "capture skipped"
            );
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
                display_bounds: Some(bounds),
                image_geometry: None,
            };
        }

        match capture_screen_with_screencapture() {
            Ok(bytes) => {
                let active_app_after_capture = get_active_app();
                match validate_capture_context_with_activation(
                    &active_app,
                    &active_app_after_capture,
                    activation_observer.observed_activation(),
                ) {
                    CaptureContextValidation::Sensitive => {
                        crate::klog!(
                            screen,
                            info,
                            captured = false,
                            sensitive = true,
                            active_app = %active_app_after_capture.active_app,
                            bounds = %bounds_summary,
                            "capture discarded: sensitive app became frontmost"
                        );
                        return ScreenCaptureResult {
                            captured: false,
                            reason: Some(
                                "Screen tutoring is paused because this app may contain sensitive information."
                                    .to_string(),
                            ),
                            blocked_sensitive_app: true,
                            active_app: Some(active_app_after_capture),
                            image_mime_type: None,
                            image_base64: None,
                            byte_length: None,
                            display_bounds: Some(bounds),
                            image_geometry: None,
                        };
                    }
                    CaptureContextValidation::Changed => {
                        crate::klog!(
                            screen,
                            info,
                            captured = false,
                            active_app_before = %active_app.active_app,
                            active_app_after = %active_app_after_capture.active_app,
                            bounds = %bounds_summary,
                            "capture discarded after app changed"
                        );
                        return ScreenCaptureResult {
                            captured: false,
                            reason: Some(
                                "The active app changed while the screen was being captured. Please try again."
                                    .to_string(),
                            ),
                            blocked_sensitive_app: false,
                            active_app: Some(active_app_after_capture),
                            image_mime_type: None,
                            image_base64: None,
                            byte_length: None,
                            display_bounds: Some(bounds),
                            image_geometry: None,
                        };
                    }
                    CaptureContextValidation::Stable => {}
                }

                use base64::Engine;
                let raw_bytes = bytes.len();
                let (image_bytes, mime, image_geometry) = downscale_screenshot(bytes);
                let byte_length = image_bytes.len();
                let dims = image_geometry
                    .as_ref()
                    .map(|geometry| {
                        format!(
                            "{}x{}->{}x{}",
                            geometry.raw_width,
                            geometry.raw_height,
                            geometry.encoded_width,
                            geometry.encoded_height
                        )
                    })
                    .unwrap_or_else(|| "unknown".to_string());
                let capture_scale = image_geometry.as_ref().map(|geometry| {
                    format!(
                        "{:.3}x{:.3}",
                        geometry.raw_width as f64 / bounds.width.max(1.0),
                        geometry.raw_height as f64 / bounds.height.max(1.0)
                    )
                });
                crate::klog!(
                    screen,
                    debug,
                    captured = true,
                    active_app = %active_app.active_app,
                    mime = mime,
                    raw_bytes = raw_bytes,
                    output_bytes = byte_length,
                    dims = %dims,
                    capture_scale = %capture_scale.as_deref().unwrap_or("unknown"),
                    bounds = %bounds_summary,
                    "capture complete"
                );
                let image_base64 = base64::engine::general_purpose::STANDARD.encode(image_bytes);
                return ScreenCaptureResult {
                    captured: true,
                    reason: None,
                    blocked_sensitive_app: false,
                    active_app: Some(active_app),
                    image_mime_type: Some(mime.to_string()),
                    image_base64: Some(image_base64),
                    byte_length: Some(byte_length),
                    display_bounds: Some(bounds),
                    image_geometry,
                };
            }
            Err(error) => {
                crate::klog!(
                    screen,
                    warn,
                    captured = false,
                    active_app = %active_app.active_app,
                    bounds = %bounds_summary,
                    "capture failed: {error}"
                );
                return ScreenCaptureResult {
                    captured: false,
                    reason: Some(error),
                    blocked_sensitive_app: false,
                    active_app: Some(active_app),
                    image_mime_type: None,
                    image_base64: None,
                    byte_length: None,
                    display_bounds: Some(bounds),
                    image_geometry: None,
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
            image_geometry: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ActiveApp;

    fn active_app(name: &str, bundle_id: Option<&str>) -> ActiveApp {
        ActiveApp {
            active_app: name.to_string(),
            bundle_id: bundle_id.map(str::to_string),
            window_title: None,
            source: "native".to_string(),
        }
    }

    #[test]
    fn rejects_frame_when_frontmost_app_changes_during_capture() {
        let before = active_app("Safari", Some("com.apple.Safari"));
        let after = active_app("Notes", Some("com.apple.Notes"));

        assert_eq!(
            validate_capture_context(&before, &after),
            CaptureContextValidation::Changed
        );
    }

    #[test]
    fn preserves_frame_when_frontmost_app_identity_is_stable() {
        let before = active_app("Safari", Some("com.apple.Safari"));
        let after = active_app("Safari", Some("com.apple.Safari"));

        assert_eq!(
            validate_capture_context(&before, &after),
            CaptureContextValidation::Stable
        );
    }

    #[test]
    fn reports_sensitive_block_when_sensitive_app_becomes_frontmost() {
        let before = active_app("Safari", Some("com.apple.Safari"));
        let after = active_app("1Password", Some("com.1password.1password"));

        assert_eq!(
            validate_capture_context(&before, &after),
            CaptureContextValidation::Sensitive
        );
    }

    #[test]
    fn rejects_frame_when_app_switches_away_and_back_during_capture() {
        let before = active_app("Safari", Some("com.apple.Safari"));
        let after = active_app("Safari", Some("com.apple.Safari"));

        assert_eq!(
            validate_capture_context_with_activation(&before, &after, true),
            CaptureContextValidation::Changed
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_activation_observer_records_activation_notification() {
        let observer = FrontmostAppActivationObserver::new();
        let notification_center = NSWorkspace::sharedWorkspace().notificationCenter();

        unsafe {
            notification_center
                .postNotificationName_object(NSWorkspaceDidActivateApplicationNotification, None);
        }

        assert!(observer.observed_activation());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn screencapture_arguments_limit_capture_to_main_display() {
        let output_path = std::path::Path::new("/tmp/kairo-capture.png");

        assert_eq!(
            screencapture_arguments(output_path),
            vec!["-x", "-m", "-t", "png", "/tmp/kairo-capture.png"]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn temporary_capture_file_removes_output_when_dropped() {
        let output_path = std::env::temp_dir().join(format!(
            "kairo-capture-cleanup-test-{}-{}.png",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&output_path, b"private screenshot bytes").unwrap();

        {
            let _capture_file = TemporaryCaptureFile::new(output_path.clone());
        }

        assert!(!output_path.exists());
    }

    #[test]
    fn falls_back_to_app_name_when_bundle_ids_are_unavailable() {
        let before = active_app("Terminal", None);
        let same_app = active_app("Terminal", None);
        let different_app = active_app("Notes", None);

        assert_eq!(
            validate_capture_context(&before, &same_app),
            CaptureContextValidation::Stable
        );
        assert_eq!(
            validate_capture_context(&before, &different_app),
            CaptureContextValidation::Changed
        );
    }
}
