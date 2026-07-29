// src/notch/gestureSegmenter.ts
import type { GestureConfig } from '../config/gesture';

export type TimedPoint = { x: number; y: number; t: number }; // physical px, ms
export type GestureStroke = { points: TimedPoint[]; confident: boolean };

function dist(a: TimedPoint, b: TimedPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Absolute turn angle (radians) at b, between segment a→b and b→c.
function turn(a: TimedPoint, b: TimedPoint, c: TimedPoint): number {
  const v1x = b.x - a.x, v1y = b.y - a.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const cross = v1x * v2y - v1y * v2x;
  const dot = v1x * v2x + v1y * v2y;
  const ang = Math.atan2(cross, dot);
  return Math.abs(ang);
}

// First index of the window within `windowMs` ending at index i.
function windowStartFor(points: TimedPoint[], i: number, windowMs: number): number {
  const endT = points[i].t;
  let start = i;
  while (start > 0 && endT - points[start - 1].t <= windowMs) start--;
  return start;
}

/**
 * Classify points[start..=end] in place.
 *
 * Index-based rather than slice-based on purpose: the cosmetic trail re-segments the whole buffer
 * every animation frame, and the old version allocated one array per point per frame — at 125Hz
 * sampling that is a few hundred short-lived arrays a second feeding the GC while the user is
 * mid-gesture, which is exactly when a pause is most visible. Same maths, no allocation.
 */
function classifyRange(
  points: TimedPoint[],
  start: number,
  end: number,
  cfg: GestureConfig
): 'rest' | 'gesture' | 'travel' {
  if (end - start < 1) return 'rest';
  let path = 0;
  for (let i = start + 1; i <= end; i++) path += dist(points[i - 1], points[i]);
  if (path < cfg.minPathPx) return 'rest';
  let turning = 0;
  for (let i = start + 2; i <= end; i++) turning += turn(points[i - 2], points[i - 1], points[i]);
  const net = dist(points[start], points[end]);
  const directness = net / path;
  if (directness < cfg.directnessMax || turning > cfg.turningMin) return 'gesture';
  return 'travel';
}

/** Public wrapper, kept for the tests and any caller holding a standalone window. */
export function classifyWindow(win: TimedPoint[], cfg: GestureConfig): 'rest' | 'gesture' | 'travel' {
  return classifyRange(win, 0, win.length - 1, cfg);
}

function finalize(points: TimedPoint[], out: GestureStroke[], cfg: GestureConfig): void {
  if (points.length < cfg.minStrokePts) return;
  let path = 0;
  for (let i = 1; i < points.length; i++) path += dist(points[i - 1], points[i]);
  if (path < cfg.minStrokePathPx) return;
  const duration = points[points.length - 1].t - points[0].t;
  out.push({ points, confident: duration >= cfg.confidentDwellMs });
}

// Segment a full point stream into gesture bursts. Travel/rest windows break
// the current stroke, so "circle → travel → circle" yields two strokes with no
// connecting line. Pure + deterministic — also re-runnable each frame for the
// live cosmetic render.
export function segmentGesturePath(points: TimedPoint[], cfg: GestureConfig): GestureStroke[] {
  const strokes: GestureStroke[] = [];
  let cur: TimedPoint[] | null = null;
  for (let i = 0; i < points.length; i++) {
    const cls = classifyRange(points, windowStartFor(points, i, cfg.windowMs), i, cfg);
    if (cls === 'gesture') {
      if (!cur) cur = [];
      cur.push(points[i]);
    } else if (cur) {
      finalize(cur, strokes, cfg);
      cur = null;
    }
  }
  if (cur) finalize(cur, strokes, cfg);
  return strokes;
}
