// Accent preference contract (spec §3B). Reads the user's chosen highlight hue from native,
// subscribes to live changes, and paints it as CSS custom properties every surface consumes.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { klog } from './logger';

// Mirror of src-tauri/src/constants.rs DEFAULT_ACCENT — keep in sync.
export const DEFAULT_ACCENT = '#7c3aed';

/** The user's accent (or the brand default). Never throws — falls back on any native error. */
export async function getAccent(): Promise<string> {
  try {
    const hex = await invoke<string>('get_accent');
    return hex || DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

/** Persist a new accent natively (also broadcasts accent:changed). Used by the color wheel (Phase 3). */
export async function setAccent(hex: string): Promise<void> {
  try {
    await invoke('set_accent', { hex });
  } catch (error) {
    klog('accent', 'warn', 'set_accent failed', { error: String(error) });
  }
}

/** Subscribe to app-global accent changes. Returns an unlisten fn. */
export async function onAccentChanged(cb: (hex: string) => void): Promise<UnlistenFn> {
  return listen<{ hex: string }>('accent:changed', (event) => {
    if (event.payload?.hex) cb(event.payload.hex);
  });
}

/** '#rrggbb' → 'r g b' (for `rgb(var(--x) / a)`); null if malformed. Pure. */
export function hexToRgb(hex: string): string | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** Paint the accent as CSS custom properties on <html>. No-op outside a DOM (vitest node env). */
export function applyAccent(hex: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--kairo-accent', hex);
  const rgb = hexToRgb(hex);
  if (rgb) root.style.setProperty('--kairo-accent-rgb', rgb);
}

// --- Contrast + clamp helpers (Phase 7) --------------------------------------
// All colors are #rrggbb. Kept self-contained (the existing hexToRgb above returns a CSS
// "r g b" string, so these use a private tuple parser).

function rgbTuple(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgbTuple(hex).map((n) => n / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = (
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  ).map((n) => Math.round((n + m) * 255));
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance (0..1). */
export function luminance(hex: string): number {
  const chan = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgbTuple(hex);
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The readable ink color to place ON an accent fill (dark ink on light accents, else white). */
export function accentInk(hex: string): '#0a0a0a' | '#ffffff' {
  return contrastRatio(hex, '#0a0a0a') >= contrastRatio(hex, '#ffffff') ? '#0a0a0a' : '#ffffff';
}

/**
 * Pull a chosen hue into a legible band so an almost-black or almost-white pick can never vanish
 * as a glow/stroke on the notch or the desktop. Preserves hue; lifts saturation to a floor; clamps
 * lightness into a mid band that reads on both dark + light backdrops. Returns #rrggbb.
 */
export function clampAccent(hex: string): string {
  const [h, s, l] = hexToHsl(hex);
  const clampedS = Math.max(s, 0.45);
  const clampedL = Math.min(Math.max(l, 0.45), 0.68);
  return hslToHex(h, clampedS, clampedL);
}
