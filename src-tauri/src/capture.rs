//! Screen capture: shells out to macOS `screencapture`, reads main-display bounds,
//! downscales the screenshot for vision, and the `capture_screen` command.

use crate::platform::{get_active_app, is_sensitive_app};
use crate::types::{DisplayBounds, ScreenCaptureResult};
#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use std::process::Command;

#[cfg(target_os = "macos")]
use core_graphics::display::CGDisplay;

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
pub(crate) fn capture_screen() -> ScreenCaptureResult {
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
