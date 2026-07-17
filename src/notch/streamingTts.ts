// Streaming text-to-speech playback for the notch.
//
// The native `synthesize_speech_stream` command streams raw PCM (linear16) from
// Sarvam and forwards it over a Tauri Channel as it arrives. This module schedules
// those chunks through a shared Web Audio context so speech begins at first byte
// (~200-400ms) instead of after the whole clip is synthesized. If streaming yields
// no audio (unsupported provider, network error, no Web Audio), each clip
// transparently falls back to the buffered `synthesizeSpeech` + <audio> path, so
// there is never a regression versus the old behavior.
//
// A clip exposes the tiny subset of HTMLAudioElement the notch playback code relies
// on (onplay/onended/onpause/onerror + play()/pause()/src) so it is a drop-in for
// `new Audio(url)` and the surrounding epoch/prefetch/gap logic stays untouched.

import { Channel } from '@tauri-apps/api/core';
import { klog } from '../core/logger';
import { buildAudioDataUrl } from './audioPlayback';
import type { NativeBridge, NativeTtsStreamMsg } from '../native/nativeBridge';

// HTMLAudioElement-shaped surface used by NotchApp's playback functions.
export interface SpeechClip {
  play(): Promise<void>;
  pause(): void;
  src: string;
  onplay: (() => void) | null;
  onended: (() => void) | null;
  onpause: (() => void) | null;
  onerror: (() => void) | null;
}

// One AudioContext for the whole notch — creating one per clip is wasteful and can
// hit the browser's context limit. Resumed lazily (PTT is the user gesture). Exported
// so UI sound cues (core/sound.ts) share this SAME unlocked context — a second
// AudioContext hits WebKit's limit and silently produces no sound.
let sharedCtx: AudioContext | null = null;
export function getAudioContext(): AudioContext | null {
  try {
    if (!sharedCtx) {
      const Ctor: typeof AudioContext | undefined =
        globalThis.AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        return null;
      }
      sharedCtx = new Ctor();
    }
    if (sharedCtx.state === 'suspended') {
      void sharedCtx.resume();
    }
    return sharedCtx;
  } catch {
    return null;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

// Progressive PCM player with a buffered fallback. Streaming starts immediately on
// construction (so callers can "prefetch" a clip and play it later with the network
// already warm); no audio is scheduled until play().
class StreamingClip implements SpeechClip {
  public onplay: (() => void) | null = null;
  public onended: (() => void) | null = null;
  public onpause: (() => void) | null = null;
  public onerror: (() => void) | null = null;

  private readonly channel: Channel<NativeTtsStreamMsg>;
  private sampleRate = 24000;
  private readonly pcmQueue: Float32Array[] = [];
  private leftover: Uint8Array | null = null;
  private headerChecked = false;
  private gotChunk = false;
  private streamEnded = false;

  private started = false;
  private stopped = false;
  private terminated = false;
  private playFired = false;

  private ctx: AudioContext | null = null;
  private nextTime = 0;
  private readonly sources: AudioBufferSourceNode[] = [];
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackAudio: HTMLAudioElement | null = null;

  // Resolves as soon as the first chunk arrives ('audio') or the stream fails before
  // any audio ('fail'); play() waits on this to choose streaming vs buffered fallback.
  private readonly firstSignal: Promise<'audio' | 'fail'>;
  private resolveFirst: ((v: 'audio' | 'fail') => void) | null = null;
  private readonly endPromise: Promise<void>;
  private resolveEnd: (() => void) | null = null;

  constructor(
    private readonly nativeBridge: NativeBridge,
    private readonly text: string,
    private readonly timeoutMs?: number
  ) {
    this.firstSignal = new Promise((resolve) => {
      this.resolveFirst = resolve;
    });
    this.endPromise = new Promise((resolve) => {
      this.resolveEnd = resolve;
    });
    this.channel = new Channel<NativeTtsStreamMsg>();
    this.channel.onmessage = (msg) => this.onMessage(msg);
    // Fire-and-forget: chunks arrive over the channel; a rejection means the stream
    // never started, so signal fail (play() will fall back to buffered).
    void this.nativeBridge
      .synthesizeSpeechStream({ text: this.text, timeoutMs: this.timeoutMs }, this.channel)
      .catch((error) => {
        klog('notch', 'debug', 'tts stream invoke rejected', { error: String(error) });
        if (!this.gotChunk) {
          this.signalFirst('fail');
        }
      });
  }

  private signalFirst(v: 'audio' | 'fail') {
    if (this.resolveFirst) {
      const resolve = this.resolveFirst;
      this.resolveFirst = null;
      resolve(v);
    }
  }

  private onMessage(msg: NativeTtsStreamMsg) {
    if (this.stopped) {
      return;
    }
    switch (msg.type) {
      case 'start':
        if (msg.sampleRate) {
          this.sampleRate = msg.sampleRate;
        }
        break;
      case 'chunk':
        this.gotChunk = true;
        this.decodeAndBuffer(msg.data);
        this.signalFirst('audio');
        if (this.started) {
          this.flushQueue();
        }
        break;
      case 'end':
        this.streamEnded = true;
        if (!this.gotChunk) {
          this.signalFirst('fail');
        } else if (this.started) {
          this.scheduleEnd();
        }
        break;
      case 'error':
        klog('notch', 'debug', 'tts stream error', { message: msg.message });
        this.streamEnded = true;
        if (!this.gotChunk) {
          this.signalFirst('fail');
        } else if (this.started) {
          this.scheduleEnd();
        }
        break;
    }
  }

  // Decode a base64 PCM chunk (s16le mono) into Float32, carrying an odd trailing
  // byte to the next chunk and defensively skipping a leading RIFF/WAV header.
  private decodeAndBuffer(b64: string) {
    let bytes = base64ToBytes(b64);
    if (this.leftover && this.leftover.length > 0) {
      const merged = new Uint8Array(this.leftover.length + bytes.length);
      merged.set(this.leftover, 0);
      merged.set(bytes, this.leftover.length);
      bytes = merged;
      this.leftover = null;
    }
    if (!this.headerChecked) {
      this.headerChecked = true;
      if (
        bytes.length >= 44 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46
      ) {
        bytes = bytes.subarray(44);
      }
    }
    const evenLen = bytes.length - (bytes.length % 2);
    if (evenLen < bytes.length) {
      this.leftover = bytes.subarray(evenLen).slice();
    }
    if (evenLen === 0) {
      return;
    }
    // Copy to a fresh, aligned buffer so the Int16Array view is valid. macOS is
    // little-endian, which matches Sarvam's s16le, so no byte swapping is needed.
    const aligned = bytes.subarray(0, evenLen).slice();
    const int16 = new Int16Array(aligned.buffer, aligned.byteOffset, evenLen / 2);
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i += 1) {
      f32[i] = int16[i] / 32768;
    }
    this.pcmQueue.push(f32);
  }

  private flushQueue() {
    if (!this.ctx) {
      return;
    }
    while (this.pcmQueue.length > 0) {
      const f32 = this.pcmQueue.shift();
      if (f32 && f32.length > 0) {
        this.scheduleBuffer(f32);
      }
    }
  }

  private scheduleBuffer(f32: Float32Array) {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const buffer = ctx.createBuffer(1, f32.length, this.sampleRate);
    buffer.getChannelData(0).set(f32);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(this.nextTime, ctx.currentTime + 0.02);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.sources.push(source);
  }

  private scheduleEnd() {
    if (this.terminated || !this.started || !this.ctx) {
      return;
    }
    this.flushQueue();
    const remainingMs = Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000);
    if (this.endTimer) {
      clearTimeout(this.endTimer);
    }
    this.endTimer = setTimeout(() => this.fireEnded(), remainingMs + 80);
  }

  private firePlay() {
    if (this.playFired) {
      return;
    }
    this.playFired = true;
    this.onplay?.();
  }

  private fireEnded() {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.stopped = true;
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    this.onended?.();
    this.resolveEnd?.();
  }

  private stopSources() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // already stopped / not started — ignore
      }
    }
    this.sources.length = 0;
  }

  async play(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const outcome = await this.firstSignal;
    if (this.stopped) {
      return;
    }
    if (outcome === 'fail') {
      await this.fallback();
      return;
    }
    const ctx = getAudioContext();
    if (!ctx) {
      await this.fallback();
      return;
    }
    this.ctx = ctx;
    this.started = true;
    this.nextTime = ctx.currentTime + 0.03;
    this.firePlay();
    this.flushQueue();
    if (this.streamEnded) {
      this.scheduleEnd();
    }
    await this.endPromise;
  }

  // Buffered fallback: synthesize the whole clip and play a plain <audio>. Mirrors
  // the pre-streaming behavior so a failed stream is never silent.
  private async fallback(): Promise<void> {
    if (this.stopped && this.terminated) {
      return;
    }
    klog('notch', 'debug', 'tts stream fell back to buffered', {});
    try {
      const result = await this.nativeBridge.synthesizeSpeech({
        text: this.text,
        timeoutMs: this.timeoutMs
      });
      if (this.stopped) {
        return;
      }
      const url = buildAudioDataUrl(result);
      if (!url) {
        this.firePlay();
        this.fireEnded();
        return;
      }
      const audio = new Audio(url);
      this.fallbackAudio = audio;
      audio.onplay = () => this.firePlay();
      audio.onended = () => this.fireEnded();
      audio.onerror = () => this.fireEnded();
      // A barge-in pause() pauses this element, which fires 'pause' → treat as a
      // terminal stop (onpause), not a natural end.
      audio.onpause = () => {
        if (!this.terminated) {
          this.terminated = true;
          this.stopped = true;
          this.onpause?.();
          this.resolveEnd?.();
        }
      };
      await audio.play();
    } catch {
      this.firePlay();
      this.fireEnded();
    }
  }

  pause(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.stopped = true;
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    this.stopSources();
    if (this.fallbackAudio) {
      try {
        this.fallbackAudio.pause();
      } catch {
        // ignore
      }
    }
    this.onpause?.();
    this.resolveEnd?.();
  }

  get src(): string {
    return '';
  }

  // stopAnswerPlayback assigns `.src = ''` to release the element; treat as a stop.
  set src(value: string) {
    if (value === '') {
      this.pause();
    }
  }
}

// Wraps a ready data-URL (e.g. a pre-synthesized cached filler) in the SpeechClip
// shape so all notch playback goes through one type.
class BufferedClip implements SpeechClip {
  public onplay: (() => void) | null = null;
  public onended: (() => void) | null = null;
  public onpause: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  private readonly audio: HTMLAudioElement;

  constructor(url: string) {
    this.audio = new Audio(url);
    this.audio.onplay = () => this.onplay?.();
    this.audio.onended = () => this.onended?.();
    this.audio.onpause = () => this.onpause?.();
    this.audio.onerror = () => this.onerror?.();
  }

  play(): Promise<void> {
    return this.audio.play();
  }

  pause(): void {
    try {
      this.audio.pause();
    } catch {
      // ignore
    }
  }

  get src(): string {
    return this.audio.src;
  }

  set src(value: string) {
    this.audio.src = value;
    if (value === '') {
      this.pause();
    }
  }
}

export function createStreamingClip(
  nativeBridge: NativeBridge,
  text: string,
  timeoutMs?: number
): SpeechClip {
  return new StreamingClip(nativeBridge, text, timeoutMs);
}

export function createBufferedClip(url: string): SpeechClip {
  return new BufferedClip(url);
}
