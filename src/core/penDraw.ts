import type { ScreenRegion } from './types';

// Shared timing + easing for the pen-drag box reveal and the multi-step glide.
//
// The companion cursor (its own webview) and the highlight box (the overlay
// webview) animate independently but must LOOK welded: the pet drags the box's
// far corner out along the diagonal. They stay in lockstep only because both run
// the SAME easing over the SAME duration, started at the same instant. So these
// constants are the single source of truth — the overlay CSS mirrors them
// literally (see styles.css @keyframes kairo-box-draw and the .highlight_box
// transition). If you change a number here, change the matching CSS literal too.

// Pet flies to the box's top-left corner (anticipation) before the drag starts.
export const DRAW_APPROACH_MS = 200;
// The diagonal drag: top-left → bottom-right, box "inks" itself over this window.
// Deliberately slow + graceful. NOTE: the CSS box animation runs longer (900ms) —
// this value is only the DRAW portion; the glow + dimming ignite in the tail *after*
// the outline lands (see styles.css @keyframes kairo-box-draw, clip completes at 72%).
export const DRAW_DURATION_MS = 650;
// Cubic-bezier control points. MUST equal the cubic-bezier() literals in
// styles.css for the cursor tip to track the box's growing corner.
export const DRAW_EASE = [0.22, 1, 0.36, 1] as const; // draw diagonal (ease-out, smooth settle)
export const APPROACH_EASE = [0.22, 1, 0.36, 1] as const; // graceful arrival at TL

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

// A CSS-equivalent cubic-bezier easing sampler. Newton–Raphson inverts x(t) for a
// given progress x, then evaluates y(t). Matches the browser's cubic-bezier()
// closely, so the JS-driven cursor and the CSS-driven box share one curve.
export function cubicBezier(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number
): (x: number) => number {
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  const solveT = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const xError = sampleX(t) - x;
      if (Math.abs(xError) < 1e-5) break;
      const dx = sampleDX(t);
      if (Math.abs(dx) < 1e-6) break;
      t -= xError / dx;
    }
    return t;
  };

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solveT(x));
  };
}

export const evalDrawEase = cubicBezier(...DRAW_EASE);
export const evalApproachEase = cubicBezier(...APPROACH_EASE);

// The two corners the pet drags between: top-left → bottom-right of the box, as
// zero-size regions so the cursor's pointingTip() lands its tip on each corner.
export function boxCornerRegions(region: ScreenRegion): {
  fromRegion: ScreenRegion;
  toRegion: ScreenRegion;
} {
  return {
    fromRegion: { x: region.x, y: region.y, width: 0, height: 0 },
    toRegion: { x: region.x + region.width, y: region.y + region.height, width: 0, height: 0 }
  };
}
