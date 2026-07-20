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
// WAV, not mp3: WebKit's decodeAudioData yields a near-silent buffer for ID3-tagged
// short mp3s (it "succeeds" but the sound is gone). WAV is raw PCM — decodes reliably.
import echoPop from '../assets/sounds/echo-pop.wav';
import toingLoud from '../assets/sounds/toing-loud.wav';
import bubblePop from '../assets/sounds/bubble-pop.wav';
import errorBlip from '../assets/sounds/error-blip.wav';

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
  arrive: 0.3, // plays under TTS, so needs presence to be heard; still subtle. Tunable.
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

// Decoded on first real play (into the already-healthy shared context), then cached.
// NEVER decoded at import — that would call getAudioContext() at page load, creating a
// dead context that also muted TTS (the shared singleton). See playSound.
const buffers = new Map<SoundName, AudioBuffer>();
async function decodeInto(ctx: AudioContext, name: SoundName): Promise<void> {
  if (buffers.has(name)) {
    return;
  }
  try {
    const res = await fetch(URLS[name]);
    const bytes = await res.arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    // Bake per-cue volume straight into the samples, so playback can connect the source
    // DIRECTLY to ctx.destination — exactly the (proven-audible) path TTS uses.
    const vol = VOLUME[name];
    if (vol !== 1) {
      for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < data.length; i += 1) {
          data[i] *= vol;
        }
      }
    }
    buffers.set(name, buffer);
    klog('notch', 'debug', 'sound decoded', {
      name,
      dur: Number(buffer.duration.toFixed(3)),
      rate: buffer.sampleRate,
      ch: buffer.numberOfChannels
    });
  } catch (err) {
    klog('notch', 'warn', 'sound decode failed', { name, err: String(err) });
  }
}

// Hold playing sources so a short one-shot can't be GC'd mid-play (mirrors TTS keeping
// its sources array); dropped on 'ended'.
const live = new Set<AudioBufferSourceNode>();
function playBuffer(ctx: AudioContext, name: SoundName): void {
  const buffer = buffers.get(name);
  if (!buffer) {
    return;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination); // direct, like TTS — volume is baked into the buffer
  live.add(source);
  source.onended = () => live.delete(source);
  source.start(ctx.currentTime + 0.02); // tiny lookahead, exactly like TTS's scheduler
  klog('notch', 'debug', 'sound played', { name, ctx: ctx.state });
}

let warmed = false;

/** Play a UI cue. No-op when sounds are off or audio is unavailable. Never throws. */
export function playSound(name: SoundName): void {
  if (!soundsEnabled()) {
    return;
  }
  // Obtain the SHARED context ONLY here — created lazily on first real playback (active
  // use), NEVER at import/page-load. A page-load context is dead AND muted TTS (which
  // reuses this same singleton). This mirrors TTS's own lazy creation, which always works.
  const ctx = getAudioContext();
  if (!ctx) {
    return;
  }
  try {
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    // First real play → warm every cue into this now-healthy context (cheap, background).
    if (!warmed) {
      warmed = true;
      void Promise.all((Object.keys(URLS) as SoundName[]).map((n) => decodeInto(ctx, n)));
    }
    if (buffers.has(name)) {
      playBuffer(ctx, name);
    } else {
      // Not decoded yet (first-ever play of this cue) → decode then play.
      void decodeInto(ctx, name).then(() => playBuffer(ctx, name));
    }
  } catch (err) {
    klog('notch', 'warn', 'sound play failed', { name, err: String(err) });
  }
}

/**
 * The two push-to-talk recording cues, in ONE place so the edge→sound mapping isn't
 * duplicated: a feeble "boop" the instant a hold starts recording, a "toing" on release.
 * Shared by the notch (real product) and the onboarding practice steps.
 */
export function playRecordingCue(recording: boolean): void {
  playSound(recording ? 'stt-start' : 'stt-end');
}
