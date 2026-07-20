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

  // Cosmetic render — soft translucent marker, canvas-drawn ------------
  baseOpacity: 0.28, // almost transparent while drawn, see-through
  holdMs: 250, // holds this long after its last point, then fades
  fadeMs: 350, // fade-out duration after holdMs (gone by ≈0.6s), eased
  strokeColor: '#8b5cf6', // same blue/violet as fable's target boxes (--box-rgb 139 92 246)
  strokeWidthCssPx: 9, // on-screen stroke width (CSS px)

  // Composite (image sent to the vision model) ---------------------------
  // Bolder + more opaque than the cosmetic on-screen stroke: gpt-5.6-sol was MISSING
  // faint circles (returning no box → "you didn't circle anything"). Still translucent
  // enough to read the content underneath, but now unmistakable to the model.
  compositeWidthPx: 12, // stroke width in physical px (~2x css for retina), scaled to encoded
  alphaConfident: 0.62, // opaque enough for the model to reliably see the mark
  alphaBorderline: 0.45,
  labelRadiusPx: 7, // multi-mark number badge radius in encoded px — small but readable by fable
  labelAlpha: 0.7, // badge fill translucency
  jpegQuality: 0.9,

  // Debug ----------------------------------------------------------------
  debugImages: false // true = save each composited image + open the folder once
} as const;

export type GestureConfig = typeof gestureConfig;
