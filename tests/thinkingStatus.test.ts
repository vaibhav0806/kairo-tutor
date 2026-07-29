import { describe, expect, it } from 'vitest';
import {
  msUntilNextTier,
  thinkingLabel,
  THINKING_TIERS,
  THINKING_TIERS_OFFSCREEN
} from '../src/notch/thinkingStatus';

describe('thinkingLabel', () => {
  it('keeps the playful gerund for a normal-length turn', () => {
    expect(thinkingLabel('Percolating', 0)).toBe('Percolating');
    expect(thinkingLabel('Percolating', 2999)).toBe('Percolating');
  });

  it('acknowledges the wait once the turn outlives the first tier', () => {
    expect(thinkingLabel('Percolating', 3000)).toBe('Reading the screen');
    expect(thinkingLabel('Percolating', 7000)).toBe('Still going — this one is dense');
    expect(thinkingLabel('Percolating', 30000)).toBe('Almost there');
  });

  it('never regresses to an earlier tier as time passes', () => {
    const seen = [0, 1000, 3000, 6999, 7000, 13000, 60000].map((ms) => thinkingLabel('Brewing', ms));
    expect(new Set(seen).size).toBe(THINKING_TIERS.length);
  });
});

describe('thinkingLabel · off-screen turns', () => {
  // The onboarding say-hi drill never captures the screen (demoController.runTalkTurn), so the
  // escalation must not claim it is reading one.
  it('never claims to read the screen', () => {
    const labels = [0, 3000, 7000, 13000, 40000].map((ms) => thinkingLabel('Brewing', ms, false));
    expect(labels.join(' ')).not.toMatch(/screen/i);
  });

  it('still escalates, so a long wait is still acknowledged', () => {
    expect(thinkingLabel('Brewing', 0, false)).toBe('Brewing');
    expect(thinkingLabel('Brewing', 3000, false)).toBe('Still with you');
    expect(thinkingLabel('Brewing', 13000, false)).toBe('Almost there');
  });

  it('keeps both tier sets aligned, so timings never drift apart', () => {
    expect(THINKING_TIERS_OFFSCREEN.map((t) => t.fromMs)).toEqual(THINKING_TIERS.map((t) => t.fromMs));
  });
});

describe('msUntilNextTier', () => {
  it('reports the wait to the next escalation so the notch can schedule one timeout', () => {
    expect(msUntilNextTier(0)).toBe(3000);
    expect(msUntilNextTier(2500)).toBe(500);
    expect(msUntilNextTier(3000)).toBe(4000);
  });

  it('returns null at the last tier, so nothing keeps ticking', () => {
    expect(msUntilNextTier(13000)).toBeNull();
    expect(msUntilNextTier(120000)).toBeNull();
  });
});
