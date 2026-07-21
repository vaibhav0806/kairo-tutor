import { useCallback, useEffect, useRef, useState } from 'react';
import { onboardingTts } from './backendClient';
import type { Segment } from './copy';
import {
  acquireMicrophoneStream,
  createVoiceRecorder,
  rmsFromTimeDomainData
} from '../notch/voiceRecorder';

// Shipped static lines, keyed by cacheKey (Vite turns each import into a URL).
const CACHED: Record<string, string> = {};
const mods = import.meta.glob('./audio/*.wav', { eager: true, query: '?url', import: 'default' });
for (const [path, url] of Object.entries(mods)) {
  const key = (path.split('/').pop() ?? '').replace('.wav', '');
  CACHED[key] = url as string;
}

// VAD tuning.
const SPEAK_LEVEL = 0.06;
const SILENCE_LEVEL = 0.035;
const SILENCE_HANG_MS = 1100;

export function useVoice() {
  const [isSpeaking, setSpeaking] = useState(false);
  const [isListening, setListening] = useState(false);
  const [level, setLevel] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const genRef = useRef(0); // a new speak() cancels the previous sequence
  const unlockedRef = useRef(false);
  const pendingRef = useRef<null | (() => void)>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const onEndRef = useRef<(b: Blob | null) => void>(() => {});
  const endedRef = useRef(false);

  const audioEl = () => (audioRef.current ??= new Audio());

  const playUrl = (url: string, onStart?: () => void) =>
    new Promise<boolean>((resolve) => {
      const el = audioEl();
      el.src = url;
      // Fires the instant real audio begins — the caller reveals the caption text HERE so words
      // never precede the voice.
      el.onplaying = onStart ? () => onStart() : null;
      el.onended = () => resolve(true);
      el.onerror = () => resolve(true);
      el.play().catch(() => resolve(false)); // rejected => autoplay blocked
    });

  // `onStart` fires once, when the FIRST segment's audio actually starts playing.
  const speak = useCallback(
    async (segments: Segment[], name: string, onStart?: () => void) => {
      const gen = ++genRef.current;
      audioEl().pause();
      setSpeaking(true);
      let started = false;
      const fireStart = () => {
        if (started) return;
        started = true;
        onStart?.();
      };
      for (const seg of segments) {
        if (genRef.current !== gen) return;
        const text = seg.text(name).trim();
        if (!text) continue;
        let url: string | null = seg.cacheKey ? CACHED[seg.cacheKey] ?? null : null;
        if (!url) {
          const b64 = await onboardingTts(text);
          url = b64 ? `data:audio/wav;base64,${b64}` : null;
        }
        if (!url || genRef.current !== gen) continue;
        const played = await playUrl(url, fireStart);
        if (!played && !unlockedRef.current) {
          // Autoplay blocked — replay this whole line after the first user gesture.
          pendingRef.current = () => void speak(segments, name, onStart);
          setSpeaking(false);
          return;
        }
        unlockedRef.current = true;
      }
      if (genRef.current === gen) setSpeaking(false);
    },
    [],
  );

  // First user gesture unlocks audio + replays any line that was blocked.
  useEffect(() => {
    const unlock = () => {
      unlockedRef.current = true;
      const p = pendingRef.current;
      pendingRef.current = null;
      p?.();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('pointermove', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('focus', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('pointermove', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('focus', unlock);
    };
  }, []);

  const teardown = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setLevel(0);
  }, []);

  const stopInternal = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') {
      rec.stop(); // → onstop delivers the blob
    } else {
      teardown();
      setListening(false);
      const cb = onEndRef.current;
      onEndRef.current = () => {};
      cb(null);
    }
  }, [teardown]);

  /** Start recording. Auto-stops on a trailing silence (VAD); `onEnd` gets the audio blob. */
  const startListening = useCallback(
    async (onEnd: (blob: Blob | null) => void) => {
      onEndRef.current = onEnd;
      endedRef.current = false;
      try {
        // Shared mic acquisition: prefers the real built-in mic over silent virtual
        // devices (BlackHole etc.) — the same fix the notch push-to-talk path uses.
        const stream = await acquireMicrophoneStream();
        streamRef.current = stream;
        chunksRef.current = [];
        const { recorder: rec } = createVoiceRecorder(stream);
        recRef.current = rec;
        rec.ondataavailable = (e) => {
          if (e.data.size) chunksRef.current.push(e.data);
        };
        rec.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
          teardown();
          setListening(false);
          const cb = onEndRef.current;
          onEndRef.current = () => {};
          cb(blob.size > 1200 ? blob : null);
        };
        rec.start();

        const ctx = new AudioContext();
        ctxRef.current = ctx;
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        let spoke = false;
        let silentSince = 0;
        const tick = () => {
          an.getByteTimeDomainData(buf);
          const lvl = Math.min(1, rmsFromTimeDomainData(buf) * 3.2);
          setLevel(lvl);
          const now = performance.now();
          if (lvl > SPEAK_LEVEL) {
            spoke = true;
            silentSince = 0;
          } else if (spoke && lvl < SILENCE_LEVEL) {
            if (!silentSince) silentSince = now;
            else if (now - silentSince > SILENCE_HANG_MS) {
              stopInternal();
              return;
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
        setListening(true);
      } catch {
        setListening(false);
        onEnd(null);
      }
    },
    [teardown, stopInternal],
  );

  const stopListening = useCallback(() => stopInternal(), [stopInternal]);

  useEffect(
    () => () => {
      teardown();
      audioRef.current?.pause();
    },
    [teardown],
  );

  return { speak, isSpeaking, startListening, stopListening, isListening, level };
}
