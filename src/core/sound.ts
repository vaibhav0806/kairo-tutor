// Tiny UI sound-cue player, shared by every WebView (notch plays STT/error cues, the
// cursor plays the arrival pop). Files are bundled via Vite (import → hashed URL) and
// played on a cached, reusable <audio> element per cue so playback is instant and never
// stacks. Everything is best-effort: a blocked autoplay or a missing element is silently
// swallowed — a cue is never allowed to throw into a caller's hot path.
//
// Cues are intentionally FEEBLE. Tune per-cue loudness in VOLUME below (0..1). Gated by a
// single localStorage flag (default ON) shared across WebViews (same origin).

import echoPop from '../assets/sounds/echo-pop.mp3';
import toingLoud from '../assets/sounds/toing-loud.mp3';
import bubblePop from '../assets/sounds/bubble-pop.mp3';
import errorBlip from '../assets/sounds/error-blip.mp3';

export type SoundName = 'stt-start' | 'stt-end' | 'arrive' | 'error';

const URLS: Record<SoundName, string> = {
  'stt-start': echoPop, // feeble "boop" when a hold starts recording
  'stt-end': toingLoud, // the "toing" on release / recording end
  arrive: bubblePop, // the cursor lands on a pointed-at target
  error: errorBlip, // no speech heard / STT failure
};

// Per-cue loudness (0..1). Kept low on purpose — these are subtle. Easy to retune.
const VOLUME: Record<SoundName, number> = {
  'stt-start': 0.2,
  'stt-end': 0.28,
  arrive: 0.3,
  error: 0.35,
};

const STORAGE_KEY = 'kairo.sounds.enabled';

/** Sounds on? Default ON — only an explicit "false" disables them. */
export function soundsEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** Persist the on/off preference (shared across WebViews via same-origin localStorage). */
export function setSoundsEnabled(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'true' : 'false');
  } catch {
    // no storage (tests / preview) → ignore
  }
}

// One reusable element per cue: preloaded, rewound on each play so rapid re-fires work.
const cache = new Map<SoundName, HTMLAudioElement>();
function element(name: SoundName): HTMLAudioElement | null {
  try {
    let audio = cache.get(name);
    if (!audio) {
      audio = new Audio(URLS[name]);
      audio.preload = 'auto';
      audio.volume = VOLUME[name];
      cache.set(name, audio);
    }
    return audio;
  } catch {
    return null;
  }
}

/** Play a UI cue. No-op when sounds are off or audio is unavailable. Never throws. */
export function playSound(name: SoundName): void {
  if (!soundsEnabled()) {
    return;
  }
  const audio = element(name);
  if (!audio) {
    return;
  }
  try {
    audio.currentTime = 0;
    audio.volume = VOLUME[name];
    // Autoplay may be blocked before the first user gesture — best-effort, swallow.
    void audio.play().catch(() => {});
  } catch {
    // ignore
  }
}
