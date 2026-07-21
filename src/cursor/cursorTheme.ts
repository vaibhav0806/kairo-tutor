//! Pure accent → tint math for the companion cursor. The user's accent (from Phase 0's
//! `src/core/accent.ts`) is threaded through a small set of CSS custom properties
//! (`--cur-accent*`) that BOTH the cursor CSS and the engine's inline style writes read,
//! so one `accent:changed` recolors the whole pet with no per-frame cost. Kept DOM-free
//! (accepts a minimal `{ style: { setProperty } }` target) so it's unit-testable in node.

// Brand-default accent, used when a hex can't be parsed. Matches the CSS var defaults.
const BRAND: readonly [number, number, number] = [124, 58, 237]; // #7c3aed

export type AccentTints = {
  base: string; // '#rrggbb'
  hi: string; // lighter — SVG gradient top stop / ring core / entrance bloom
  soft: string; // slightly lighter — pings / soft borders
  hot: string; // vivid + saturated — recording fill (accent-derived, not a fixed red)
  rgb: string; // 'r g b' — for rgb(var(--cur-accent-rgb) / <alpha>)
};

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseHex(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    return [...BRAND];
  }
  const int = Number.parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => clampByte(n).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) {
    return [0, 0, l];
  }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) {
    h = (gn - bn) / d + (gn < bn ? 6 : 0);
  } else if (max === gn) {
    h = (bn - rn) / d + 2;
  } else {
    h = (rn - gn) / d + 4;
  }
  return [(h / 6) * 360, s, l];
}

function hslToHex(hDeg: number, s: number, l: number): string {
  const hue = (((hDeg % 360) + 360) % 360) / 360;
  const sat = Math.max(0, Math.min(1, s));
  const lit = Math.max(0, Math.min(1, l));
  if (sat === 0) {
    const v = clampByte(lit * 255);
    return toHex(v, v, v);
  }
  const q = lit < 0.5 ? lit * (1 + sat) : lit + sat - lit * sat;
  const p = 2 * lit - q;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return toHex(channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255);
}

export function accentTints(hex: string): AccentTints {
  const [r, g, b] = parseHex(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return {
    base: toHex(r, g, b),
    hi: hslToHex(h, s, Math.min(0.92, l + 0.2)),
    soft: hslToHex(h, s, Math.min(0.9, l + 0.12)),
    // "Hot" = clearly-activated version of the accent for the recording state: push
    // saturation up and land lightness in a vivid mid band, so it reads as "live"
    // regardless of hue (replaces the old fixed #ff4d6d red per §11B).
    hot: hslToHex(h, Math.max(s, 0.85), Math.min(0.66, Math.max(0.52, l + 0.06))),
    rgb: `${r} ${g} ${b}`
  };
}

// A minimal style target — an HTMLElement satisfies this, but so does a test stub, so
// this stays node-testable without a DOM library.
export type AccentStyleTarget = { style: { setProperty(name: string, value: string): void } };

export function applyCursorAccent(target: AccentStyleTarget, hex: string): void {
  const t = accentTints(hex);
  target.style.setProperty('--cur-accent', t.base);
  target.style.setProperty('--cur-accent-hi', t.hi);
  target.style.setProperty('--cur-accent-soft', t.soft);
  target.style.setProperty('--cur-accent-hot', t.hot);
  target.style.setProperty('--cur-accent-rgb', t.rgb);
}
