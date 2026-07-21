import { describe, it, expect } from 'vitest';
import { SEEDED_PROMPTS, pickSeededPrompt } from '../src/onboarding/copy';

describe('pickSeededPrompt', () => {
  it("rotates deterministically through a mode's list", () => {
    const list = SEEDED_PROMPTS.point;
    expect(pickSeededPrompt('point', 0)).toBe(list[0]);
    expect(pickSeededPrompt('point', 1)).toBe(list[1 % list.length]);
    expect(pickSeededPrompt('point', list.length)).toBe(list[0]); // wraps
  });

  it('point prompts only reference always-present targets', () => {
    for (const p of SEEDED_PROMPTS.point) {
      expect(/wifi|battery|apple menu/i.test(p)).toBe(true);
    }
  });

  it('never returns empty for any mode', () => {
    for (const mode of ['talk', 'point', 'circle'] as const) {
      expect(pickSeededPrompt(mode, 7).trim().length).toBeGreaterThan(0);
    }
  });
});
