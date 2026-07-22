import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { klog } from '../core/logger';
import { pickSeededPrompt, STEPS, type StepId } from './copy';
import { runCircleTurn, runPointTurn, type DemoResult } from './demoController';
import { playRecordingCue } from '../core/sound';
import { createNativeBridge } from '../native/nativeBridge';
import type { TimedPoint } from '../notch/gestureSegmenter';
import { useVoice } from './useVoice';
import { KairoOrb } from './OnboardingComponents';
import '@fontsource/instrument-serif';
import './onboarding.css';

// Act 4 — the two practice beats, and ONLY those. Each runs the REAL Kairo pipeline (demoController):
//   • point  — the user asks Kairo to point at something (gate → vision → pet points at it)
//   • circle — the user draws around something (gesture → vision → Kairo describes it)
// The ⌥⌃ chord is the only Next; a beat auto-advances when Kairo lands the answer, and retries on a
// miss. Everything else in first-run (color / hearing / permissions / sign-in / source / ending) is
// its own Act in OnboardingApp — none of it lives here.
type DemoMode = 'point' | 'circle';
const DEMO_MODE: Partial<Record<StepId, DemoMode>> = { learn_point: 'point', circle: 'circle' };

export function OnboardingFlow({ onComplete }: { onComplete: () => void }) {
  const [index, setIndex] = useState(0);
  const step = STEPS[index];
  const mode = DEMO_MODE[step.id] as DemoMode; // STEPS only ever holds the two practice beats
  const voice = useVoice();
  const bridge = useMemo(() => createNativeBridge(), []);

  // Live status of the current practice turn (drives the orb + the status line).
  const [demoState, setDemoState] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const [demoDone, setDemoDone] = useState(false);
  const [demoLevel, setDemoLevel] = useState(0);
  const [demoRetry, setDemoRetry] = useState<null | 'empty' | 'no_target'>(null);

  const promptSeedRef = useRef(0);
  const indexRef = useRef(index);
  indexRef.current = index;
  const gestureBufferRef = useRef<TimedPoint[]>([]);
  const recordingRef = useRef(false);
  const demoDoneRef = useRef(false);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 0 on the first beat, full on the last.
  const progress = STEPS.length > 1 ? index / (STEPS.length - 1) : 1;

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

  // Speak this beat's instruction line when it opens.
  useEffect(() => {
    void voice.speak(step.speech, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Practice steps hide the onboarding window so the real overlay + companion cursor own the screen
  // (and the screenshot is clean), then bring it back to advance.
  const hideSelf = useCallback(async () => {
    try {
      await getCurrentWebviewWindow().hide();
    } catch {
      /* ignore */
    }
  }, []);
  const showSelf = useCallback(async () => {
    try {
      const w = getCurrentWebviewWindow();
      await w.show();
      await w.setFocus();
    } catch {
      /* ignore */
    }
  }, []);

  // Run one practice turn on the recorded audio, then auto-advance (or retry on a miss).
  const runDemoTurn = useCallback(
    async (m: DemoMode, audioBase64: string) => {
      if (demoDoneRef.current) return; // stop once the beat is satisfied
      setDemoLevel(0);
      setDemoRetry(null);
      const cb = {
        onThinking: () => setDemoState('thinking'),
        onSpeaking: () => setDemoState('speaking'),
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
        setDemoState('idle');
        await bridge.hideOverlay();
        await showSelf();
        if (result.ok) {
          demoDoneRef.current = true;
          setDemoDone(true);
          setDemoRetry(null);
          if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
          advanceTimerRef.current = setTimeout(() => {
            // Last beat → hand back to the orchestrator (Act 5); else the next beat.
            if (indexRef.current >= STEPS.length - 1) onComplete();
            else go(1);
          }, 1200);
        } else {
          setDemoRetry(result.reason ?? 'empty'); // keep the beat open so the next ⌥⌃ hold retries
        }
      }
    },
    [bridge, go, showSelf, onComplete],
  );

  // Wire the beat: claim push-to-talk, listen for the ⌥⌃ hold + recorded audio (+ cursor points for
  // circle), and run the turn on release.
  useEffect(() => {
    promptSeedRef.current += 1; // rotate the seeded chip once per mount
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    setDemoState('idle');
    setDemoDone(false);
    setDemoRetry(null);
    setDemoLevel(0);
    demoDoneRef.current = false;
    gestureBufferRef.current = [];
    recordingRef.current = false;
    void invoke('set_onboarding_ptt', { active: true }).catch(() => {});

    const push = (u: () => void) => (disposed ? u() : unlisteners.push(u));

    // ⌥⌃ hold confirmed / released (recording-truth for onboarding). On press we hide our window so
    // the real screen is clean for the capture; circle also arms the gesture overlay.
    void listen<{ active?: boolean }>('onboarding:ptt', (e) => {
      const active = Boolean(e.payload?.active);
      recordingRef.current = active;
      playRecordingCue(active); // same "boop"/"toing" cues as the real product
      if (active) {
        setDemoState('listening');
        gestureBufferRef.current = [];
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

    // Mic level → orb.
    void listen<{ level?: number }>('cursor:level', (e) => {
      if (recordingRef.current) setDemoLevel(Math.min(1, Number(e.payload?.level ?? 0)));
    }).then(push);

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

  const action = mode === 'point' ? 'hold & ask' : 'hold & circle';
  const status =
    demoState === 'listening'
      ? 'listening…'
      : demoState === 'thinking'
        ? 'thinking…'
        : demoState === 'speaking'
          ? 'speaking…'
          : demoDone
            ? 'nice — you’ve got it!'
            : demoRetry === 'no_target'
              ? 'hmm, I couldn’t find that — try again'
              : demoRetry === 'empty'
                ? 'didn’t quite catch that — try again'
                : 'ready when you are';

  return (
    <div className="ob">
      <div className="ob-surface">
        <div className="ob-aurora" aria-hidden />
        <div className="ob-grain" aria-hidden />

        <header className="ob-head">
          {index > 0 ? (
            <button type="button" className="ob-back" onClick={() => go(-1)} aria-label="Back">
              ←
            </button>
          ) : (
            <span />
          )}
        </header>

        <KairoOrb mode={demoState} level={demoLevel} progress={progress} />

        <div className="ob-stage" key={step.id}>
          <h1 className="ob-title">{step.title('')}</h1>
          <div className="ob-field">
            <div className="ob-demo">
              <div className="ob-demo-keys">
                <kbd>⌥</kbd>
                <span className="ob-demo-plus">+</span>
                <kbd>⌃</kbd>
                <span className="ob-demo-action">{action}</span>
              </div>
              <div className="ob-demo-hint">try: “{pickSeededPrompt(mode, promptSeedRef.current)}”</div>
              <div className={`ob-demo-status is-${demoState}`}>{status}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
