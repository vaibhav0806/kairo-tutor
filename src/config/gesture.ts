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
  fadeMs: 900, // on-screen stroke fades to nothing over this (competitor look)
  strokeColor: '#a78bfa', // Kairo accent
  strokeWidthCssPx: 5, // on-screen stroke width (CSS px)

  // Composite (image sent to fable) --------------------------------------
  compositeWidthPx: 6, // stroke width in physical px, scaled to the encoded image
  alphaConfident: 0.85,
  alphaBorderline: 0.5,
  jpegQuality: 0.9,

  // Debug ----------------------------------------------------------------
  debugImages: false // true = save each composited image + open the folder once
} as const;

export type GestureConfig = typeof gestureConfig;
