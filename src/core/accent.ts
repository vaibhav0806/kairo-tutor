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
