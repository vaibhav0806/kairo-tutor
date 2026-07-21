// Optional low ambient music for the onboarding cinematic beats. OFF by default (unlike the UI
// cues in sound.ts, which default ON). Gated by one localStorage flag, shared across WebViews.
// No asset is bundled yet — the player no-ops until an ambient loop is added (see the TODO), so
// shipping this toggle can never produce sound until we deliberately add the file.
import { klog } from './logger';

const STORAGE_KEY = 'kairo.music.enabled';

/** Music on? Default OFF — only an explicit "true" enables it. */
export function musicEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setMusicEnabled(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'true' : 'false');
  } catch {
    // storage unavailable (tests/preview) — no-op
  }
  klog('onboarding', 'info', 'music toggled', { on });
  if (on) void startMusic();
  else stopMusic();
}

// TODO(deferred): import an ambient loop asset (WAV, per sound.ts's WebKit note) and wire it here.
// Until then these no-op so the toggle is inert-but-present.
let el: HTMLAudioElement | undefined;

export async function startMusic(): Promise<void> {
  if (!musicEnabled()) return;
  // const src = (await import('../assets/sounds/ambient-loop.wav')).default; // <- add asset to enable
  // el = el ?? new Audio(src); el.loop = true; el.volume = 0.12; await el.play().catch(() => {});
  klog('onboarding', 'debug', 'music start requested (no asset bundled — no-op)');
}

export function stopMusic(): void {
  el?.pause();
}
