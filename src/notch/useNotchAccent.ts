import { useEffect } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getAccent, onAccentChanged } from '../core/accent';
import { hexToRgbTriple } from '../core/colorHex';
import { klog } from '../core/logger';

// Write the user's accent (from Phase 0's accent pref) onto <html> as --accent /
// --accent-rgb so every notch CSS rule threads it, and keep it live on accent:changed.
// Phase 0's accent API is async (native invoke + event listener), so we resolve the
// promises and guard against a unit that unmounts before they settle.
export function useNotchAccent(): void {
  useEffect(() => {
    const apply = (hex: string) => {
      const triple = hexToRgbTriple(hex);
      if (!triple) {
        klog('notch', 'warn', 'ignored malformed accent', { hex });
        return;
      }
      const root = document.documentElement;
      root.style.setProperty('--accent', hex);
      root.style.setProperty('--accent-rgb', triple);
      klog('notch', 'debug', 'accent applied', { hex });
    };
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void getAccent().then((hex) => {
      if (!cancelled) apply(hex);
    });
    void onAccentChanged(apply).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
