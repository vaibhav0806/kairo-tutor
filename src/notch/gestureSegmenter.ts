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

// The slice of points within `windowMs` ending at index i.
function windowEndingAt(points: TimedPoint[], i: number, windowMs: number): TimedPoint[] {
  const endT = points[i].t;
  let start = i;
  while (start > 0 && endT - points[start - 1].t <= windowMs) start--;
  return points.slice(start, i + 1);
}

export function classifyWindow(win: TimedPoint[], cfg: GestureConfig): 'rest' | 'gesture' | 'travel' {
  if (win.length < 2) return 'rest';
  let path = 0;
  for (let i = 1; i < win.length; i++) path += dist(win[i - 1], win[i]);
  if (path < cfg.minPathPx) return 'rest';
  let turning = 0;
  for (let i = 2; i < win.length; i++) turning += turn(win[i - 2], win[i - 1], win[i]);
  const net = dist(win[0], win[win.length - 1]);
  const directness = net / path;
  if (directness < cfg.directnessMax || turning > cfg.turningMin) return 'gesture';
  return 'travel';
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
    const cls = classifyWindow(windowEndingAt(points, i, cfg.windowMs), cfg);
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
