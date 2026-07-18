// src/config/gesture.ts
// Tuning for hold-to-point gestures. All logic runs in the webviews (notch +
// overlay), so config lives here (the frontend analog of src-tauri/constants.rs).
// Distances are in PHYSICAL px (cursor:mouse space). Tune with the debug images
// (GESTURE_DEBUG_IMAGES) then rebuild.

export const gestureConfig = {
  // Detection ------------------------------------------------------------
  windowMs: 350, // sliding window for per-point classification (long enough that a slow circle still curves within one window)
  minPathPx: 45, // below this total movement in the window = rest (ignored)
  directnessMax: 0.5, // net/path below this = localized gesture
  turningMin: 0.8, // radians of accumulated turning in the window = curved gesture (catches big + slow circles)
  minStrokePts: 4, // discard strokes shorter than this on close
  minStrokePathPx: 60, // discard strokes whose total path is below this
  confidentDwellMs: 180, // a stroke lasting at least this long renders/composites as "confident"

  // Cosmetic render ------------------------------------------------------
  baseOpacity: 0.55, // translucent even while being drawn (never fully opaque)
  holdMs: 500, // stroke holds at baseOpacity this long after its last point, then fades
  fadeMs: 300, // fade-out duration after holdMs (gone by holdMs+fadeMs ≈ 0.8s), eased
  strokeColor: '#c4b5fd', // Kairo accent, light
  strokeWidthCssPx: 3, // on-screen stroke width (CSS px)

  // Composite (image sent to fable) --------------------------------------
  compositeWidthPx: 3, // stroke width in physical px, scaled to the encoded image
  alphaConfident: 0.85,
  alphaBorderline: 0.5,
  jpegQuality: 0.9,

  // Debug ----------------------------------------------------------------
  debugImages: true // true = save each composited image + open the folder once
} as const;

export type GestureConfig = typeof gestureConfig;
