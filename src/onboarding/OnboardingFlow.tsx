import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { klog } from '../core/logger';
import { pickSeededPrompt, PRACTICE_RETRY, STEPS, type StepId } from './copy';
import { runCircleTurn, runPointTurn, type DemoResult } from './demoController';
import { playRecordingCue } from '../core/sound';
import type { TimedPoint } from '../notch/gestureSegmenter';
import { useCoach } from './useCoach';

// Act 4 — the two practice beats, and ONLY those. Each runs the REAL Kairo pipeline (demoController):
//   • point  — the user asks Kairo to point at something (gate → vision → pet points at it)
//   • circle — the user draws around something (gesture → vision → Kairo describes it)
// Notch-driven, exactly like Act 2's say-hi drill: this renders nothing. The notch caption + the
// live pet ARE the UI. The ⌥⌃ chord is the only Next; a beat auto-advances when Kairo lands the
// answer, and speaks a retry on a miss. The notch caption tracks every spoken line, so it is never
// stale — the whole reason this act moved onto useCoach.
type DemoMode = 'point' | 'circle';
const DEMO_MODE: Partial<Record<StepId, DemoMode>> = { learn_point: 'point', circle: 'circle' };

// The silent "I'm listening" nudge shown WHILE the user holds ⌥⌃ (audio is impossible then — Kairo's
// voice would land in the recording), per mode.
const LISTEN_HINT: Record<DemoMode, string> = {
  point: 'Ask me to point something out.',
  circle: 'Draw a circle around anything.'
};

export function OnboardingFlow({ onComplete }: { onComplete: () => void }) {
  const { say, thinking, caption, guide, voice, bridge } = useCoach('');
  const [index, setIndex] = useState(0);
  const step = STEPS[index];
  const mode = DEMO_MODE[step.id] as DemoMode; // STEPS only ever holds the two practice beats

  const indexRef = useRef(index);
  indexRef.current = index;
  const gestureBufferRef = useRef<TimedPoint[]>([]);
  const recordingRef = useRef(false);
  const demoDoneRef = useRef(false);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const go = useCallback((delta: number) => {
    setIndex((i) => Math.max(0, Math.min(STEPS.length - 1, i + delta)));
  }, []);

  // Resume onto the right practice beat after any relaunch (harmless if we never left).
  useEffect(() => {
    void invoke<string>('get_onboarding_step')
      .then((saved) => {
        const i = STEPS.findIndex((s) => s.id === saved);
        if (i > 0) setIndex(i);
      })
      .catch(() => {});
  }, []);

  // Persist the current beat so a relaunch resumes here.
  useEffect(() => {
    void invoke('set_onboarding_step', { step: step.id }).catch(() => {});
  }, [step.id]);

  // Speak this beat's instruction when it opens — notch caption == the voice, with a seeded chip.
  useEffect(() => {
    void say(step.speech, { chip: `try: “${pickSeededPrompt(mode, index)}”` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Hide the onboarding window during a turn so the real overlay + companion cursor own the screen
  // (and the screenshot is clean), then bring it back.
  const hideSelf = useCallback(async () => {
    try {
      await getCurrentWebviewWindow().hide();
    } catch {
      /* ignore */
    }
  }, []);
  const showSelf = useCallback(async () => {
    try {
      await getCurrentWebviewWindow().show();
    } catch {
      /* ignore */
    }
  }, []);

  // Run one practice turn on the recorded audio, then auto-advance (or speak a retry on a miss).
  const runDemoTurn = useCallback(
    async (m: DemoMode, audioBase64: string) => {
      if (demoDoneRef.current) return; // stop once the beat is satisfied
      await thinking(); // loading pulse while we transcribe + look
      const cb = {
        onThinking: () => void thinking(),
        onSpeaking: () => void emit('cursor:speaking'),
        // Mirror every spoken line into the notch, in sync — the caption never goes stale.
        onCaption: (text: string) => void caption(text)
      };
      let result: DemoResult = { ok: false, reason: 'empty' };
      try {
        result =
          m === 'point'
            ? await runPointTurn(bridge, audioBase64, cb)
            : await runCircleTurn(bridge, audioBase64, gestureBufferRef.current, cb);
      } catch (error) {
        klog('onboarding', 'error', 'demo turn failed', { mode: m, error: String(error) });
      } finally {
        await bridge.hideOverlay();
        await showSelf();
        if (result.ok) {
          demoDoneRef.current = true;
          void emit('cursor:celebrate');
          klog('onboarding', 'info', 'practice beat done', { mode: m });
          if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
          advanceTimerRef.current = setTimeout(() => {
            // Last beat → hand back to the orchestrator (Act 5); else the next beat.
            if (indexRef.current >= STEPS.length - 1) onComplete();
            else go(1);
          }, 1400);
        } else {
          // Not satisfied — speak a nudge and keep the beat open so the next ⌥⌃ hold retries.
          void say(PRACTICE_RETRY[result.reason ?? 'empty'], {
            chip: `try: “${pickSeededPrompt(m, indexRef.current + 1)}”`
          });
        }
      }
    },
    [bridge, thinking, caption, say, go, showSelf, onComplete]
  );

  // Wire the beat: claim push-to-talk, listen for the ⌥⌃ hold + recorded audio (+ cursor points for
  // circle), and run the turn on release.
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    demoDoneRef.current = false;
    gestureBufferRef.current = [];
    recordingRef.current = false;
    // Ensure the ⌥⌃ tap is live. Act 2's primer normally starts it, but a relaunch can resume STRAIGHT
    // to this act (Screen-Recording grant → quit+reopen), skipping Act 2 — then the tap was never
    // spawned and holding the chord does nothing. startPtt is idempotent, so this is safe either way.
    void bridge.startPtt().catch(() => {});
    void invoke('set_onboarding_ptt', { active: true }).catch(() => {});

    const push = (u: () => void) => (disposed ? u() : unlisteners.push(u));

    // ⌥⌃ hold confirmed / released. On press: hide our window so the capture is clean, show the
    // silent "listening" nudge (audio is impossible while the user talks), and arm the gesture
    // overlay for circle.
    void listen<{ active?: boolean }>('onboarding:ptt', (e) => {
      const active = Boolean(e.payload?.active);
      recordingRef.current = active;
      playRecordingCue(active); // same "boop"/"toing" cues as the real product
      if (active) {
        voice.stop(); // the user grabbed the chord mid-instruction → cut Kairo off, don't talk over them
        gestureBufferRef.current = [];
        void guide('Listening…', LISTEN_HINT[mode]);
        void hideSelf();
        if (mode === 'circle') {
          void bridge.getDisplayBounds().then((b) => bridge.showGestureOverlay(b));
        }
      }
    }).then(push);

    // Circle: buffer the native cursor stream (physical px) during the hold.
    if (mode === 'circle') {
      void listen<{ x: number; y: number }>('cursor:mouse', (e) => {
        if (!recordingRef.current) return;
        gestureBufferRef.current.push({ x: e.payload.x, y: e.payload.y, t: performance.now() });
      }).then(push);
    }

    // The recorded WAV on release → run the practice turn. Dedicated event (NOT the notch's
    // `ptt:audio`, which broadcasts app-wide) so only onboarding reacts.
    void listen<{ audioBase64: string; mimeType: string }>('onboarding:audio', (e) => {
      void runDemoTurn(mode, e.payload.audioBase64);
    }).then(push);

    return () => {
      disposed = true;
      if (advanceTimerRef.current) {
        clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
      void invoke('set_onboarding_ptt', { active: false }).catch(() => {});
      unlisteners.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id]);

  return null; // notch caption + the live pet are the whole UI (like Act 2's drill)
}
