import { describe, expect, test } from 'vitest';
import { applyAccent, DEFAULT_ACCENT, hexToRgb } from '../src/core/accent';

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
