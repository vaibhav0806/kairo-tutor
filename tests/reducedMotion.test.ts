import { describe, it, expect } from 'vitest';
import { prefersReducedMotion, onReducedMotionChange } from '../src/core/reducedMotion';
import { musicEnabled } from '../src/core/music';

describe('reducedMotion (no matchMedia in node env)', () => {
  it('defaults to not-reduced when matchMedia is unavailable', () => {
    expect(prefersReducedMotion()).toBe(false);
  });
  it('returns a no-op unlisten when matchMedia is unavailable', () => {
    const unlisten = onReducedMotionChange(() => {});
    expect(() => unlisten()).not.toThrow();
  });
});

describe('music', () => {
  it('music defaults OFF', () => {
    expect(musicEnabled()).toBe(false);
  });
});
