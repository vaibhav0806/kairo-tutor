import { describe, expect, test } from 'vitest';
import { hexToRgbTriple } from '../src/core/colorHex';

describe('hexToRgbTriple', () => {
  test('parses #rrggbb', () => {
    expect(hexToRgbTriple('#7c3aed')).toBe('124 58 237');
  });

  test('parses a 3-digit hex', () => {
    expect(hexToRgbTriple('#0af')).toBe('0 170 255');
  });

  test('accepts a leading-# -less input', () => {
    expect(hexToRgbTriple('7c3aed')).toBe('124 58 237');
  });

  test('rejects malformed input', () => {
    expect(hexToRgbTriple('#gg00zz')).toBeNull();
    expect(hexToRgbTriple('nope')).toBeNull();
  });
});
