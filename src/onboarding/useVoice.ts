import { useCallback, useEffect, useRef, useState } from 'react';
import { onboardingTts } from './backendClient';

/**
 * Onboarding voice: Kairo speaks each line (Sarvam TTS) and the user can answer by voice
 * (mic → webm → STT) or by typing. `level` (0..1) drives the live waveform while listening.
 */
export function useVoice() {
  const [isSpeaking, setSpeaking] = useState(false);
  const [isListening, setListening] = useState(false);
  const [level, setLevel] = useState(0);

  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const teardownAudioGraph = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setLevel(0);
  }, []);

  const speak = useCallback(async (text: string) => {
    try {
      const b64 = await onboardingTts(text);
      if (!b64) return;
      const el = audioElRef.current ?? new Audio();
      audioElRef.current = el;
      el.src = `data:audio/wav;base64,${b64}`;
      setSpeaking(true);
      el.onended = () => setSpeaking(false);
      await el.play().catch(() => setSpeaking(false));
    } catch {
      setSpeaking(false);
    }
  }, []);

  const startListening = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const rec = new MediaRecorder(stream);
      recorderRef.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.start();

      // Live level for the waveform, off the same stream.
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) {
          const c = (v - 128) / 128;
          sum += c * c;
        }
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3.2));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      setListening(true);
      return true;
    } catch {
      setListening(false);
      return false;
    }
  }, []);

  const stopListening = useCallback(async (): Promise<Blob | null> => {
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') {
      teardownAudioGraph();
      setListening(false);
      return null;
    }
    return new Promise<Blob | null>((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        teardownAudioGraph();
        setListening(false);
        resolve(blob.size > 0 ? blob : null);
      };
      rec.stop();
    });
  }, [teardownAudioGraph]);

  useEffect(
    () => () => {
      teardownAudioGraph();
      audioElRef.current?.pause();
    },
    [teardownAudioGraph],
  );

  return { speak, isSpeaking, startListening, stopListening, isListening, level };
}
