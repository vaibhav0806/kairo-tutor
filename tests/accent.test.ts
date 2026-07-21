import { describe, expect, test } from 'vitest';
import {
  accentInk,
  applyAccent,
  clampAccent,
  contrastRatio,
  DEFAULT_ACCENT,
  hexToRgb,
  luminance
} from '../src/core/accent';

describe('accent helper', () => {
  test('hexToRgb parses #rrggbb (with or without #)', () => {
    expect(hexToRgb('#7c3aed')).toBe('124 58 237');
    expect(hexToRgb('7c3aed')).toBe('124 58 237');
    expect(hexToRgb('#FFFFFF')).toBe('255 255 255');
  });

  test('hexToRgb rejects malformed input', () => {
    expect(hexToRgb('#fff')).toBeNull();
    expect(hexToRgb('nope')).toBeNull();
  });

  test('applyAccent is a no-op without a DOM (node env)', () => {
    expect(() => applyAccent(DEFAULT_ACCENT)).not.toThrow();
  });
});

describe('accent contrast clamps', () => {
  test('pulls a near-black pick up into the legible band', () => {
    expect(luminance(clampAccent('#010203'))).toBeGreaterThan(luminance('#010203'));
  });
  test('pulls a near-white pick down into the legible band', () => {
    expect(luminance(clampAccent('#fefefe'))).toBeLessThan(luminance('#fefefe'));
  });
  test('leaves an already-vivid mid accent well-formed', () => {
    expect(clampAccent('#7c3aed')).toMatch(/^#[0-9a-f]{6}$/);
  });
  test('contrastRatio is symmetric and white-on-black is ~21', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
  test('accentInk picks readable ink for extremes', () => {
    expect(accentInk('#f5d90a')).toBe('#0a0a0a'); // bright yellow → dark ink
    expect(accentInk('#3a2a8c')).toBe('#ffffff'); // deep indigo → white ink
  });
});
