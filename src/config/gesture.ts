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

  // Cosmetic render — soft translucent red marker (NOT a laser) ----------
  baseOpacity: 0.7, // translucent red while drawn, see-through
  holdMs: 250, // holds this long after its last point, then fades
  fadeMs: 350, // fade-out duration after holdMs (gone by ≈0.6s), eased
  strokeColor: '#f87171', // soft red
  strokeWidthCssPx: 6, // on-screen stroke width (CSS px)

  // Composite (image sent to fable) --------------------------------------
  compositeWidthPx: 8, // stroke width in physical px (~2x css for retina), scaled to encoded
  alphaConfident: 0.45, // translucent so fable sees THROUGH the marks (not opaque)
  alphaBorderline: 0.3,
  labelRadiusPx: 7, // multi-mark number badge radius in encoded px — small but readable by fable
  labelAlpha: 0.7, // badge fill translucency
  jpegQuality: 0.9,

  // Debug ----------------------------------------------------------------
  debugImages: true // true = save each composited image + open the folder once
} as const;

export type GestureConfig = typeof gestureConfig;
