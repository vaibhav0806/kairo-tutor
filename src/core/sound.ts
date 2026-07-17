// Tiny UI sound-cue player. Uses the Web Audio API (decoded AudioBuffer + a fresh
// BufferSourceNode per play) so cues fire with ~zero latency, fully async on the audio
// thread — they never block or interfere with the main thread, TTS, or anything else.
//
// CRITICAL: it shares the SAME AudioContext as TTS (streamingTts.getAudioContext). A
// second AudioContext hits WebKit's context limit and silently produces NO sound — that
// bug is exactly why cues went dead. TTS's context is already unlocked (PTT/TTS gesture),
// so cues inherit a live, running context.
//
// Everything is best-effort: a suspended context, a blocked resume, or a missing buffer
// is silently swallowed — a cue is never allowed to throw into a caller's hot path.
// Cues are intentionally FEEBLE; tune per-cue loudness in VOLUME (0..1). Gated by one
// localStorage flag (default ON), shared across WebViews (same origin).

import { getAudioContext } from '../notch/streamingTts';
import { klog } from './logger';
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
  arrive: 0.12, // fires on every cursor arrival — keep it low + non-intrusive
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

// Decoded once, up front, so a play() is instant.
const buffers = new Map<SoundName, AudioBuffer>();
async function decode(name: SoundName): Promise<void> {
  if (buffers.has(name)) {
    return;
  }
  const ctx = getAudioContext();
  if (!ctx) {
    return;
  }
  try {
    const res = await fetch(URLS[name]);
    const bytes = await res.arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    buffers.set(name, buffer);
  } catch (err) {
    klog('notch', 'warn', 'sound decode failed', { name, err: String(err) });
  }
}

// Kick off decoding of every cue at import time (best-effort, non-blocking).
void Promise.all((Object.keys(URLS) as SoundName[]).map((name) => decode(name)));

/** Play a UI cue. No-op when sounds are off or audio is unavailable. Never throws. */
export function playSound(name: SoundName): void {
  if (!soundsEnabled()) {
    return;
  }
  const ctx = getAudioContext();
  if (!ctx) {
    return;
  }
  const buffer = buffers.get(name);
  if (!buffer) {
    // Not decoded yet (first play raced the preload) → decode then play, once ready.
    void decode(name).then(() => {
      if (buffers.has(name)) {
        playSound(name);
      }
    });
    return;
  }
  try {
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = VOLUME[name];
    source.connect(gain).connect(ctx.destination);
    source.start();
    klog('notch', 'debug', 'sound played', { name, ctx: ctx.state });
  } catch (err) {
    klog('notch', 'warn', 'sound play failed', { name, err: String(err) });
  }
}
