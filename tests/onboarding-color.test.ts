import { describe, it, expect } from 'vitest';
import { hsvToHex, hexToHsv } from '../src/onboarding/color';

describe('color utils', () => {
  it('round-trips the brand accent', () => {
    const { h, s, v } = hexToHsv('#7c3aed');
    expect(hsvToHex(h, s, v)).toBe('#7c3aed');
  });
  it('maps pure primaries', () => {
    expect(hsvToHex(0, 1, 1)).toBe('#ff0000');
    expect(hsvToHex(120, 1, 1)).toBe('#00ff00');
    expect(hsvToHex(240, 1, 1)).toBe('#0000ff');
  });
});
