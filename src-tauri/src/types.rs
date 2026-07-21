//! Plain serde data structs and simple enums shared across the crate.

use serde::{Deserialize, Serialize};

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

#[derive(Debug, Serialize, Clone)]
pub(crate) struct FrameHash {
    /// 8 x u32 = 256-bit dHash. JS-safe as number[].
    pub hash: Vec<u32>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) chip: Option<String>,
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

// Mirrors the SYSTEM cursor's visibility onto the companion pet. macOS hides the
// real cursor while the user types; we forward that so the pet vanishes in lockstep
// (see `system_cursor_visible` in panels.rs). Idle-hide is handled frontend-side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CursorVisible {
    pub(crate) visible: bool,
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
pub(crate) struct TutorTurnInput {
    pub(crate) user_query: String,
    pub(crate) active_app: TutorActiveAppContext,
    pub(crate) annotations: Vec<TutorAnnotation>,
    pub(crate) screen: TutorScreenInput,
    /// Slug of the selected skill pack ("" = none). Resolved/validated in
    /// `run_tutor_turn` against the frontmost app before injection.
    #[serde(default)]
    pub(crate) skill_slug: String,
    pub(crate) constraints: Vec<String>,
    // Preformatted recent conversation (last N turns, incl. any interrupted
    // walkthrough) for continuity. Built on the frontend; injected into the prompt.
    #[serde(default)]
    pub(crate) recent_context: Option<String>,
    // The filler/greeting the gate already spoke aloud THIS turn (needsScreen path),
    // so the tutor continues from it instead of greeting again. Absent otherwise.
    #[serde(default)]
    pub(crate) spoken_intro: Option<String>,
    // The signed-in user's display name (Google profile), appended to the NON-cached user message
    // so the tutor can address them. Empty/absent when unknown. See spec §12.
    #[serde(default)]
    pub(crate) user_name: Option<String>,
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
    // Per-request timeout override (ms). Walkthrough STEP synths pass a tight value
    // (fail fast → retry); the full direct answer omits it and gets the generous
    // default (a long paragraph legitimately takes longer).
    #[serde(default)]
    pub(crate) timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechSynthesisResult {
    pub(crate) audio_base64: String,
    pub(crate) mime_type: String,
    pub(crate) provider: String,
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
    pub(crate) bundle_id: Option<String>,
    #[serde(default)]
    pub(crate) window_title: Option<String>,
    // Unified turn (RU5): the last ~6 rolling turn-triples as text, for continuity.
    #[serde(default)]
    pub(crate) history: Option<String>,
    // True when a guide pointer is currently on screen waiting for a click — biases
    // the gate toward needsScreen=true for continuations ("what next", "ok done").
    #[serde(default)]
    pub(crate) pointer_pending: bool,
    // The signed-in user's display name (Google profile), appended to the NON-cached gate user
    // message so the gate can address them. Empty/absent when unknown. See spec §12.
    #[serde(default)]
    pub(crate) user_name: Option<String>,
}

// The cheap text-only ack: the instruction the user just completed, spoken back
// while the vision model plans the next step. Screen-blind by design.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AckInput {
    pub(crate) completed_step: String,
}
