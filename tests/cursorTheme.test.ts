import { describe, expect, test } from 'vitest';
import { accentTints, applyCursorAccent } from '../src/cursor/cursorTheme';

describe('accentTints', () => {
  test('parses the brand purple into space-separated rgb', () => {
    expect(accentTints('#7c3aed').rgb).toBe('124 58 237');
  });

  test('accepts a hex without the leading hash', () => {
    expect(accentTints('3b82f6').rgb).toBe('59 130 246');
  });

  test('base echoes a normalized #rrggbb; hi/soft/hot are valid hex', () => {
    const t = accentTints('#3b82f6');
    expect(t.base).toBe('#3b82f6');
    for (const v of [t.hi, t.soft, t.hot]) {
      expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test('hi is lighter than the base (higher luminance sum)', () => {
    const sum = (hex: string) =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    const t = accentTints('#7c3aed');
    expect(sum(t.hi)).toBeGreaterThan(sum(t.base));
  });

  test('falls back to brand purple on a malformed hex', () => {
    expect(accentTints('nope').rgb).toBe('124 58 237');
  });
});

describe('applyCursorAccent', () => {
  test('writes the five --cur-accent* custom properties', () => {
    const set: Record<string, string> = {};
    const target = {
      style: {
        setProperty: (n: string, v: string) => {
          set[n] = v;
        }
      }
    };
    applyCursorAccent(target, '#7c3aed');
    expect(set['--cur-accent']).toBe('#7c3aed');
    expect(set['--cur-accent-rgb']).toBe('124 58 237');
    expect(set['--cur-accent-hi']).toMatch(/^#[0-9a-f]{6}$/);
    expect(set['--cur-accent-soft']).toMatch(/^#[0-9a-f]{6}$/);
    expect(set['--cur-accent-hot']).toMatch(/^#[0-9a-f]{6}$/);
  });
});
