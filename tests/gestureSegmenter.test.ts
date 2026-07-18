// tests/gestureSegmenter.test.ts
import { describe, it, expect } from 'vitest';
import { segmentGesturePath, type TimedPoint } from '../src/notch/gestureSegmenter';
import { gestureConfig } from '../src/config/gesture';

const cfg = gestureConfig;

// Build a point stream at ~60Hz (16ms/step) from an (x,y) generator.
function stream(gen: (i: number) => { x: number; y: number }, n: number, startT = 0): TimedPoint[] {
  return Array.from({ length: n }, (_, i) => ({ ...gen(i), t: startT + i * 16 }));
}

function circle(cx: number, cy: number, r: number, n: number, startT = 0): TimedPoint[] {
  return stream((i) => {
    const a = (i / (n - 1)) * Math.PI * 2;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }, n, startT);
}

function line(x0: number, y0: number, x1: number, y1: number, n: number, startT = 0): TimedPoint[] {
  return stream((i) => {
    const f = i / (n - 1);
    return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f };
  }, n, startT);
}

describe('segmentGesturePath', () => {
  it('ignores a resting cursor (no strokes)', () => {
    const pts = stream(() => ({ x: 500, y: 500 }), 40);
    expect(segmentGesturePath(pts, cfg)).toHaveLength(0);
  });

  it('drops straight travel across the screen', () => {
    const pts = line(100, 100, 1200, 100, 40);
    expect(segmentGesturePath(pts, cfg)).toHaveLength(0);
  });

  it('keeps a small circle as one stroke', () => {
    const pts = circle(400, 400, 40, 40);
    expect(segmentGesturePath(pts, cfg)).toHaveLength(1);
  });

  it('keeps a big circle as one stroke (curvature, not spread)', () => {
    const pts = circle(700, 500, 300, 60);
    expect(segmentGesturePath(pts, cfg)).toHaveLength(1);
  });

  it('keeps a SLOW big circle (speed-invariant)', () => {
    // r=300 over ~2s (0.94 px/ms) and r=150 over ~2.5s
    expect(segmentGesturePath(circle(700, 500, 300, 125), gestureConfig)).toHaveLength(1); // 125 pts * 16ms = 2000ms
    expect(segmentGesturePath(circle(400, 400, 150, 156), gestureConfig)).toHaveLength(1); // ~2500ms
  });

  it('keeps a back-and-forth underline', () => {
    const fwd = line(200, 600, 500, 600, 20);
    const back = line(500, 600, 200, 600, 20, 20 * 16);
    expect(segmentGesturePath([...fwd, ...back], cfg)).toHaveLength(1);
  });

  it('circle → travel → circle yields two strokes, no connector', () => {
    const a = circle(200, 200, 45, 40, 0);
    const travel = line(200, 200, 1100, 200, 30, 40 * 16);
    const b = circle(1100, 200, 45, 40, 70 * 16);
    const strokes = segmentGesturePath([...a, ...travel, ...b], cfg);
    expect(strokes).toHaveLength(2);
  });

  it('marks a sustained stroke confident and a brief one borderline', () => {
    const sustained = circle(400, 400, 60, 40); // ~640ms
    const [s] = segmentGesturePath(sustained, cfg);
    expect(s.confident).toBe(true);
  });
});
