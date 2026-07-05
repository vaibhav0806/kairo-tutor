//! Plain serde data structs and simple enums shared across the crate.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveApp {
    pub(crate) active_app: String,
    pub(crate) bundle_id: Option<String>,
    pub(crate) window_title: Option<String>,
    pub(crate) source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionStatus {
    pub(crate) screen_recording: PermissionState,
    pub(crate) accessibility: PermissionState,
    pub(crate) microphone: PermissionState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PermissionState {
    Granted,
    Denied,
    NotDetermined,
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisplayBounds {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) scale_factor: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenCaptureResult {
    pub(crate) captured: bool,
    pub(crate) reason: Option<String>,
    pub(crate) blocked_sensitive_app: bool,
    pub(crate) active_app: Option<ActiveApp>,
    pub(crate) image_mime_type: Option<String>,
    pub(crate) image_base64: Option<String>,
    pub(crate) byte_length: Option<usize>,
    pub(crate) display_bounds: Option<DisplayBounds>,
    pub(crate) image_geometry: Option<CaptureImageGeometry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureImageGeometry {
    pub(crate) raw_width: u32,
    pub(crate) raw_height: u32,
    pub(crate) encoded_width: u32,
    pub(crate) encoded_height: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenRegion {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayDisplayBounds {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) scale_factor: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayTarget {
    pub(crate) kind: String,
    pub(crate) target_id: String,
    pub(crate) label: String,
    pub(crate) confidence: f64,
    pub(crate) screen_region: ScreenRegion,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayPayload {
    pub(crate) mode: Option<String>,
    pub(crate) display_bounds: OverlayDisplayBounds,
    pub(crate) targets: Vec<OverlayTarget>,
    pub(crate) annotations: Option<Vec<TutorAnnotation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) initial_tool: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotchPayload {
    pub(crate) state: String,
    pub(crate) layout: Option<String>,
    pub(crate) title: String,
    pub(crate) detail: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextBaseline {
    #[serde(default)]
    pub(crate) bundle_id: Option<String>,
    #[serde(default)]
    pub(crate) window_title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MousePoint {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

// Sent to the cursor window to make it fly to (and rest near) an AI target.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CursorPointPayload {
    pub(crate) screen_region: ScreenRegion,
    pub(crate) display_bounds: OverlayDisplayBounds,
    #[serde(default)]
    pub(crate) color: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TutorActiveAppContext {
    pub(crate) active_app: String,
    pub(crate) bundle_id: Option<String>,
    pub(crate) window_title: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TutorScreenPoint {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TutorAnnotation {
    pub(crate) id: String,
    #[serde(rename = "type")]
    pub(crate) annotation_type: String,
    pub(crate) screen_region: ScreenRegion,
    pub(crate) points: Option<Vec<TutorScreenPoint>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TutorScreenInput {
    pub(crate) captured: bool,
    pub(crate) reason: Option<String>,
    pub(crate) image_mime_type: Option<String>,
    pub(crate) image_base64: Option<String>,
    pub(crate) byte_length: Option<usize>,
    pub(crate) display_bounds: Option<OverlayDisplayBounds>,
    pub(crate) image_geometry: Option<CaptureImageGeometry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TutorSkillPack {
    pub(crate) slug: String,
    pub(crate) display_name: String,
    pub(crate) app_identifiers: Vec<String>,
    pub(crate) landmarks: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TutorTurnInput {
    pub(crate) user_query: String,
    pub(crate) active_app: TutorActiveAppContext,
    pub(crate) annotations: Vec<TutorAnnotation>,
    pub(crate) screen: TutorScreenInput,
    pub(crate) skill: TutorSkillPack,
    pub(crate) constraints: Vec<String>,
    // Preformatted recent conversation (last N turns, incl. any interrupted
    // walkthrough) for continuity. Built on the frontend; injected into the prompt.
    #[serde(default)]
    pub(crate) recent_context: Option<String>,
}

// The notch capsule's bounding rect in CSS px (viewport-relative), reported by the
// frontend so the hit-tracker can make the area around it click-through.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HitRect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscribeAudioInput {
    pub(crate) audio_base64: String,
    pub(crate) mime_type: String,
    pub(crate) filename: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptionResult {
    pub(crate) text: String,
    pub(crate) provider: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SynthesizeSpeechInput {
    pub(crate) text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechSynthesisResult {
    pub(crate) audio_base64: String,
    pub(crate) mime_type: String,
    pub(crate) provider: String,
}

// A text element detected on the user's screen by OCR, with its real on-screen
// region. The LLM picks elements by `id` (Set-of-Mark grounding) instead of
// guessing pixel coordinates, which vision models do unreliably.
#[derive(Debug, Clone)]
pub(crate) struct OcrElement {
    pub(crate) id: u32,
    pub(crate) text: String,
    // Display-point region. Final UI targets, overlay windows, and cursor windows
    // all use the same logical coordinate space.
    pub(crate) region: ScreenRegion,
    pub(crate) center_x_pct: f64,
    pub(crate) center_y_pct: f64,
}

// A bounding box on the user's screen, normalized [0,1] with a top-left origin.
// `color` is a vibrant accent hex derived from the pixels behind the box.
#[derive(Debug, Clone)]
pub(crate) struct DetectedBox {
    pub(crate) norm_x1: f64,
    pub(crate) norm_y1: f64,
    pub(crate) norm_x2: f64,
    pub(crate) norm_y2: f64,
    pub(crate) label: String,
    pub(crate) color: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GateInput {
    pub(crate) user_query: String,
    #[serde(default)]
    pub(crate) active_app: Option<String>,
    #[serde(default)]
    pub(crate) window_title: Option<String>,
}
