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

export type SoundName = 'stt-start' | 'stt-end' | 'arrive' | 'error' | 'morph' | 'settle';

const URLS: Record<SoundName, string> = {
  'stt-start': echoPop, // feeble "boop" when a hold starts recording
  'stt-end': toingLoud, // the "toing" on release / recording end
  arrive: bubblePop, // the cursor lands on a pointed-at target
  error: errorBlip, // no speech heard / STT failure
  // Onboarding v2 (Phase C). PLACEHOLDER cues — swap these two lines when the real morph/settle WAVs
  // land (one-file change, mirrors heroDemo.ts). `morph` = hero→color whoosh (fires on Get-started,
  // which also unlocks the shared AudioContext); `settle` = the soft landing as the card collapses
  // into the pet.
  morph: echoPop,
  settle: bubblePop,
};

// Per-cue loudness (0..1). Kept low on purpose — these are subtle. Easy to retune.
const VOLUME: Record<SoundName, number> = {
  'stt-start': 0.2,
  'stt-end': 0.28,
  arrive: 0.3, // plays under TTS, so needs presence to be heard; still subtle. Tunable.
  error: 0.35,
  morph: 0.22,
  settle: 0.26,
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

// Render a short sine chime to a 16-bit PCM WAV data-URI. Played via an <audio> element (below) so
// it shares the SAME autoplay path as the onboarding TTS — that path is what's unlocked during
// onboarding (the Web Audio context is a different one that stays suspended pre-gesture, which is
// why the earlier oscillator version was silent).
function chimeWavDataUri(notes: number[], noteDur: number, gap: number, peak: number): string {
  const rate = 44100;
  const total = Math.ceil((notes.length * gap + noteDur) * rate) + 1;
  const samples = new Float32Array(total);
  notes.forEach((freq, i) => {
    const start = Math.floor(i * gap * rate);
    const len = Math.floor(noteDur * rate);
    for (let s = 0; s < len; s += 1) {
      const t = s / rate;
      const env = Math.min(1, t / 0.012) * Math.exp(-t * 6); // quick attack, exp decay
      const idx = start + s;
      if (idx < total) samples[idx] += Math.sin(2 * Math.PI * freq * t) * env * peak;
    }
  });
  const buf = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buf);
  const wr = (o: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(o + i, str.charCodeAt(i));
  };
  wr(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  wr(8, 'WAVE');
  wr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  wr(36, 'data');
  view.setUint32(40, total * 2, true);
  let o = 44;
  for (let i = 0; i < total; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, v * 32767, true);
    o += 2;
  }
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

const chimeCache: Partial<Record<'confirm' | 'entrance', string>> = {};

/**
 * Procedural chimes for the onboarding cinematic beats. `confirm` = a satisfying two-note rise
 * (color lock-in); `entrance` = a warm single tone (Kairo coming to life). Sound *design*, not a
 * music loop — subtle, premium. Gated by the same `soundsEnabled()` flag.
 */
export function playChime(kind: 'confirm' | 'entrance'): void {
  if (!soundsEnabled()) {
    return;
  }
  try {
    if (!chimeCache[kind]) {
      chimeCache[kind] =
        kind === 'confirm'
          ? chimeWavDataUri([523.25, 783.99], 0.3, 0.1, 0.55) // C5 → G5
          : chimeWavDataUri([329.63], 0.6, 0, 0.5); // E4 warm
    }
    const el = new Audio(chimeCache[kind]);
    el.volume = kind === 'confirm' ? 0.7 : 0.55;
    void el.play().catch(() => {});
    klog('notch', 'debug', 'chime played', { kind });
  } catch (err) {
    klog('notch', 'warn', 'chime failed', { kind, err: String(err) });
  }
}
