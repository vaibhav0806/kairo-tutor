import { describe, expect, test } from 'vitest';
import {
  POINTING_GAP,
  pointingTip,
  regionToLocalRect,
  shadowTip
} from '../src/cursor/geometry';

const display = { x: 0, y: 0, width: 1000, height: 800, scaleFactor: 2 };

describe('regionToLocalRect', () => {
  test('converts retina pixel regions into local points', () => {
    expect(
      regionToLocalRect({ x: 600, y: 400, width: 240, height: 80 }, display)
    ).toEqual({ left: 300, top: 200, width: 120, height: 40 });
  });
});

describe('pointingTip', () => {
  test('rests below-left of an interior object, no flip', () => {
    const tip = pointingTip({ x: 600, y: 400, width: 240, height: 80 }, display);
    expect(tip.flipX).toBe(false);
    expect(tip.flipY).toBe(false);
    // bottom-left corner is (300, 240); tip sits down-left by the gap.
    expect(tip.x).toBe(300 - POINTING_GAP);
    expect(tip.y).toBe(240 + POINTING_GAP);
  });

  test('flips horizontally when the object hugs the left edge', () => {
    // logical left = 10 (px x = 20): no room down-left.
    const tip = pointingTip({ x: 20, y: 400, width: 240, height: 80 }, display);
    expect(tip.flipX).toBe(true);
    expect(tip.flipY).toBe(false);
    // anchors on the bottom-right corner (130, 240); tip sits down-right.
    expect(tip.x).toBe(130 + POINTING_GAP);
    expect(tip.y).toBe(240 + POINTING_GAP);
  });

  test('flips vertically when the object hugs the bottom edge', () => {
    // logical top = 740, bottom = 780: no room below.
    const tip = pointingTip({ x: 600, y: 1480, width: 240, height: 80 }, display);
    expect(tip.flipX).toBe(false);
    expect(tip.flipY).toBe(true);
    // anchors on the top-left corner (300, 740); tip sits up-left.
    expect(tip.x).toBe(300 - POINTING_GAP);
    expect(tip.y).toBe(740 - POINTING_GAP);
  });
});

describe('shadowTip', () => {
  test('parks the tip just below-right of the mouse', () => {
    const tip = shadowTip(400, 300);
    expect(tip.x).toBeGreaterThan(400);
    expect(tip.y).toBeGreaterThan(300);
  });
});
