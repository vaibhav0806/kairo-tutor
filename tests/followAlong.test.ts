import { describe, it, expect } from 'vitest';
import {
  hammingDistance,
  stillMoving,
  sameScreen,
  clickInBox,
  waitFloorMs,
  parseFollowStep,
} from '../src/notch/followAlong';

describe('hammingDistance', () => {
  it('is 0 for identical hashes', () => {
    expect(hammingDistance([1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 8])).toBe(0);
  });
  it('counts differing bits across all u32 chunks', () => {
    expect(hammingDistance([1, 0, 0, 0, 0, 0, 0, 0b111], [0, 0, 0, 0, 0, 0, 0, 0])).toBe(4);
  });
});

describe('stillMoving / sameScreen thresholds', () => {
  const a = [0, 0, 0, 0, 0, 0, 0, 0];
  it('stillMoving when distance exceeds the movingBits threshold', () => {
    expect(stillMoving(a, [0, 0, 0, 0, 0, 0, 0, 0b1111111], 6)).toBe(true); // 7 bits > 6
    expect(stillMoving(a, [0, 0, 0, 0, 0, 0, 0, 0b1], 6)).toBe(false);       // 1 bit
  });
  it('sameScreen when distance is within the samescreen threshold', () => {
    expect(sameScreen(a, [0, 0, 0, 0, 0, 0, 0, 0b11], 28)).toBe(true);       // 2 <= 28
    const many = [0xffffffff, 0x3fff, 0, 0, 0, 0, 0, 0]; // 32 + 14 = 46 bits
    expect(sameScreen(a, many, 28)).toBe(false);
  });
});

describe('clickInBox', () => {
  const box = { x: 100, y: 100, width: 50, height: 40 };
  it('true when the click is inside', () => {
    expect(clickInBox({ x: 120, y: 120 }, box, 0)).toBe(true);
  });
  it('false when clearly outside', () => {
    expect(clickInBox({ x: 400, y: 400 }, box, 0)).toBe(false);
  });
  it('respects padding', () => {
    expect(clickInBox({ x: 95, y: 95 }, box, 0)).toBe(false);
    expect(clickInBox({ x: 95, y: 95 }, box, 24)).toBe(true);
  });
});

describe('waitFloorMs', () => {
  const cfg = { instant: 75, uiSettle: 400, pageLoad: 1500, network: 2500 };
  it('maps each bucket', () => {
    expect(waitFloorMs('instant', cfg)).toBe(75);
    expect(waitFloorMs('network', cfg)).toBe(2500);
  });
  it('defaults unknown to uiSettle', () => {
    expect(waitFloorMs('weird' as any, cfg)).toBe(400);
  });
});

describe('parseFollowStep', () => {
  it('parses a valid step', () => {
    const s = parseFollowStep({
      say: 'click this',
      visualTargets: [{ kind: 'highlight_box', screenRegion: { x: 1, y: 2, width: 3, height: 4 } }],
      expect: 'click',
      wait: 'page-load',
      status: 'guiding',
    });
    expect(s.expect).toBe('click');
    expect(s.status).toBe('guiding');
    expect(s.box).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
  it('treats a step with no highlight_box as observe-shaped (box null)', () => {
    const s = parseFollowStep({ say: 'look', visualTargets: [], expect: 'observe', wait: 'instant', status: 'guiding' });
    expect(s.box).toBeNull();
  });
});
