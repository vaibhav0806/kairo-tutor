import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ONBOARDING_SOURCES } from '@kairo/shared';
import { klog } from '../core/logger';
import { permissionSpeech, pickSeededPrompt, STEPS, type StepId } from './copy';
import { getAuthStatus, getBackendJwt, onAuthChanged, startGoogleAuth } from './authClient';
import { extractField, onboardingStt, saveOnboarding } from './backendClient';
import { runCircleTurn, runPointTurn, type DemoResult } from './demoController';
import { playRecordingCue } from '../core/sound';
import { createNativeBridge } from '../native/nativeBridge';
import type { TimedPoint } from '../notch/gestureSegmenter';
import { useVoice } from './useVoice';
import { KairoOrb, VoiceInput, type OrbMode } from './OnboardingComponents';
import '@fontsource/instrument-serif';
import './onboarding.css';

type Perms = { screenRecording: string; accessibility: string };

// The interactive practice steps that run the real Kairo pipeline (see demoController).
type DemoMode = 'talk' | 'point' | 'circle';
const DEMO_MODES: Partial<Record<StepId, DemoMode>> = {
  learn_point: 'point',
  circle: 'circle',
};

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase())
    .trim();
}


export function OnboardingFlow({ onComplete }: { onComplete: () => void }) {
  const [index, setIndex] = useState(0);
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [typed, setTyped] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [perms, setPerms] = useState<Perms | null>(null);
  const [processing, setProcessing] = useState(false);
  // Interactive practice-step state (learn_talk / learn_point / circle).
  const [demoState, setDemoState] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const [demoDone, setDemoDone] = useState(false);
  const [demoLevel, setDemoLevel] = useState(0);
  const [demoRetry, setDemoRetry] = useState<null | 'empty' | 'no_target'>(null);
  const promptSeedRef = useRef(0);
  const voice = useVoice();
  const step = STEPS[index];
  const nameRef = useRef(name);
  nameRef.current = name;
  const autoOpenedRef = useRef(false);
  const nativeBridge = useMemo(() => createNativeBridge(), []);
  const gestureBufferRef = useRef<TimedPoint[]>([]);
  const recordingRef = useRef(false);
  const demoDoneRef = useRef(false);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const demoMode = DEMO_MODES[step.id];

  const orbMode: OrbMode = demoMode
    ? demoState
    : processing
      ? 'thinking'
      : voice.isListening
        ? 'listening'
        : voice.isSpeaking
          ? 'speaking'
          : 'idle';
  const orbLevel = demoMode ? demoLevel : voice.level;
  // 0 on the very first step, full on the last (not 1/N on step one).
  const progress = STEPS.length > 1 ? index / (STEPS.length - 1) : 1;
  const permsOk = !!perms && perms.screenRecording === 'granted' && perms.accessibility === 'granted';

  const go = useCallback((delta: number) => {
    setIndex((i) => Math.max(0, Math.min(STEPS.length - 1, i + delta)));
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('onboarding-document');
    document.body.classList.add('onboarding-document');
    return () => {
      document.documentElement.classList.remove('onboarding-document');
      document.body.classList.remove('onboarding-document');
    };
  }, []);

  useEffect(() => {
    let un = () => {};
    void getAuthStatus().then((s) => setSignedIn(s.signed_in));
    void onAuthChanged((s) => setSignedIn(s)).then((u) => {
      un = u;
    });
    return () => un();
  }, []);

  // Resume where onboarding left off. Granting Screen Recording forces macOS to quit +
  // reopen the app, which would otherwise restart onboarding at the welcome screen. The
  // native marker records the furthest step so we jump back to it. Runs once, on mount.
  useEffect(() => {
    void invoke<string>('get_onboarding_step')
      .then((saved) => {
        const i = STEPS.findIndex((s) => s.id === saved);
        // Never resume onto the final 'done' screen — re-run the last practice instead.
        if (i > 0 && STEPS[i].id !== 'done') setIndex(i);
      })
      .catch(() => {});
  }, []);

  // Persist the current step so a permission-triggered relaunch resumes here.
  useEffect(() => {
    void invoke('set_onboarding_step', { step: step.id }).catch(() => {});
  }, [step.id]);

  useEffect(() => {
    // permissions speaks a dynamic line from its own effect below; every other step
    // (including the practice steps' instructions) speaks its scripted line here.
    if (step.id === 'permissions') return;
    let cancelled = false;
    void voice.speak(step.speech, nameRef.current).then(() => {
      // Once Kairo finishes the sign-in line, open Google automatically (no extra click).
      if (!cancelled && step.id === 'signin' && !signedIn && !autoOpenedRef.current) {
        autoOpenedRef.current = true;
        void startGoogleAuth();
      }
    });
    setTyped('');
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => {
    if (step.id === 'signin' && signedIn) {
      const t = setTimeout(() => go(1), 900);
      return () => clearTimeout(t);
    }
  }, [signedIn, step.id, go]);

  // The `auth:changed` event (above) is the primary signal. As a belt-and-suspenders that's still
  // event-driven (not a poll), re-check once when the window regains focus — i.e. the moment the
  // user tabs back from the browser after signing in.
  useEffect(() => {
    if (step.id !== 'signin' || signedIn) return;
    const recheck = () => void getAuthStatus().then((s) => s.signed_in && setSignedIn(true));
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, [step.id, signedIn]);

  // Permissions step: poll status, speak a dynamic line that only mentions what's still
  // missing, and auto-advance once BOTH are granted (e.g. after the Screen-Recording
  // quit+reopen resumes us here with everything already granted).
  useEffect(() => {
    if (step.id !== 'permissions') return;
    let advanced = false;
    let spoke = false;
    const check = async () => {
      let p: Perms;
      try {
        p = await invoke<Perms>('get_permission_status');
      } catch {
        return;
      }
      setPerms({ screenRecording: p.screenRecording, accessibility: p.accessibility });
      const screenOk = p.screenRecording === 'granted';
      const accessOk = p.accessibility === 'granted';
      if (screenOk && accessOk) {
        if (!advanced) {
          advanced = true;
          setTimeout(() => go(1), 600);
        }
        return;
      }
      if (!spoke) {
        spoke = true;
        const seg = permissionSpeech(screenOk, accessOk);
        if (seg) void voice.speak(seg, nameRef.current);
      }
    };
    void check();
    const iv = setInterval(check, 1500);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id]);

  const handleVoiceResult = useCallback(
    async (blob: Blob | null) => {
      if (!blob) return;
      setProcessing(true); // orb goes "thinking" while we transcribe + extract
      const transcript = await onboardingStt(blob);
      if (transcript) {
        if (step.id === 'name') {
          const value = await extractField(transcript, 'name');
          setTyped(titleCase(value || transcript));
        } else {
          setTyped(transcript.trim());
        }
      }
      setProcessing(false);
    },
    [step.id],
  );

  const toggleMic = useCallback(() => {
    if (voice.isListening) voice.stopListening();
    else void voice.startListening(handleVoiceResult);
  }, [voice, handleVoiceResult]);

  // Practice steps hide the onboarding window so the real overlay + companion cursor own
  // the screen (and the screenshot is clean), then bring it back to advance.
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

  // Run one practice turn on the recorded audio, then auto-advance. `talk` stays in-window
  // (voice chat); `point`/`circle` drew on the real screen, so restore the window first.
  const runDemoTurn = useCallback(
    async (mode: DemoMode, audioBase64: string) => {
      if (demoDoneRef.current) return; // stop once the step is satisfied
      setDemoLevel(0);
      setDemoRetry(null);
      const cb = {
        onThinking: () => setDemoState('thinking'),
        onSpeaking: () => setDemoState('speaking'),
      };
      // Only point/circle reach here (talk is Act 2 now). Both report success so the flow can
      // retry a miss instead of advancing — the chord stays the only Next.
      let result: DemoResult = { ok: false, reason: 'empty' };
      try {
        if (mode === 'point') result = await runPointTurn(nativeBridge, audioBase64, cb);
        else result = await runCircleTurn(nativeBridge, audioBase64, gestureBufferRef.current, cb);
      } catch (error) {
        klog('onboarding', 'error', 'demo turn failed', { mode, error: String(error) });
      } finally {
        setDemoState('idle');
        await nativeBridge.hideOverlay();
        await showSelf();
        if (result.ok) {
          demoDoneRef.current = true;
          setDemoDone(true);
          setDemoRetry(null);
          if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
          advanceTimerRef.current = setTimeout(() => go(1), 1200);
        } else {
          // Not satisfied — keep the step open so the next ⌥⌃ hold retries.
          setDemoRetry(result.reason ?? 'empty');
        }
      }
    },
    [nativeBridge, go, showSelf],
  );

  // Wire the interactive practice steps: claim push-to-talk, listen for the ⌥⌃ hold +
  // recorded audio (+ cursor points for the circle step), and run the turn on release.
  useEffect(() => {
    const mode = DEMO_MODES[step.id];
    if (!mode) return;
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

    // ⌥⌃ hold confirmed / released (recording-truth for onboarding).
    void listen<{ active?: boolean }>('onboarding:ptt', (e) => {
      const active = Boolean(e.payload?.active);
      recordingRef.current = active;
      // Same "boop"/"toing" cues as the real product (shared helper).
      playRecordingCue(active);
      if (active) {
        setDemoState('listening');
        gestureBufferRef.current = [];
        if (mode !== 'talk') {
          void hideSelf();
          if (mode === 'circle') void nativeBridge.getDisplayBounds().then((b) => nativeBridge.showGestureOverlay(b));
        }
      }
    }).then(push);

    // Circle step: buffer the native cursor stream (physical px) during the hold.
    if (mode === 'circle') {
      void listen<{ x: number; y: number }>('cursor:mouse', (e) => {
        if (!recordingRef.current) return;
        gestureBufferRef.current.push({ x: e.payload.x, y: e.payload.y, t: performance.now() });
      }).then(push);
    }

    // Mic level → orb (visible during the in-window talk step).
    void listen<{ level?: number }>('cursor:level', (e) => {
      if (recordingRef.current) setDemoLevel(Math.min(1, Number(e.payload?.level ?? 0)));
    }).then(push);

    // The recorded WAV on release → run the practice turn. Dedicated event (NOT the
    // notch's `ptt:audio`, which broadcasts app-wide) so only onboarding reacts — the
    // notch stays inert instead of firing its own product turn on the same press.
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

  const openGoogle = useCallback(() => {
    autoOpenedRef.current = true;
    void startGoogleAuth();
  }, []);

  const finish = useCallback(async () => {
    setSaving(true);
    const jwt = await getBackendJwt();
    if (jwt) {
      const ok = await saveOnboarding(jwt, name || 'there', source || 'unknown');
      klog('onboarding', 'info', 'onboarding saved', { ok });
    }
    onComplete();
  }, [name, source, onComplete]);

  const commitName = () => {
    if (typed.trim()) {
      setName(titleCase(typed));
      go(1);
    }
  };

  // Shared UI for the interactive practice steps: the ⌥⌃ key hint + a live status.
  const renderDemo = (mode: DemoMode) => {
    const action = mode === 'talk' ? 'hold & talk' : mode === 'point' ? 'hold & ask' : 'hold & circle';
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
    );
  };

  // The interactive content that sits directly under the title.
  const renderField = () => {
    switch (step.id) {
      case 'name':
        return (
          <VoiceInput value={typed} onChange={setTyped} placeholder="your name" listening={voice.isListening} processing={processing} onMic={toggleMic} onSubmit={commitName} />
        );
      case 'signin':
        return signedIn ? (
          <div className="ob-signed">
            <span className="ob-check">✓</span> signed in
          </div>
        ) : null;
      case 'source':
        return (
          <div className="ob-field-col">
            <div className="ob-chips">
              {ONBOARDING_SOURCES.map((s) => (
                <button key={s} type="button" className={`ob-chip${source === s ? ' is-sel' : ''}`} onClick={() => setSource(s)}>
                  {s}
                </button>
              ))}
            </div>
            {source === 'Other' && (
              <VoiceInput value={typed} onChange={setTyped} placeholder="tell me where" listening={voice.isListening} processing={processing} onMic={toggleMic} onSubmit={() => go(1)} />
            )}
          </div>
        );
      case 'permissions':
        return (
          <div className="ob-perms">
            {/* Accessibility first — it doesn't force a relaunch. Screen Recording last,
                since granting it makes macOS quit + reopen the app. */}
            {(['accessibility', 'screenRecording'] as const).map((k) => {
              const ok = perms?.[k] === 'granted';
              return (
                <div key={k} className={`ob-perm${ok ? ' is-ok' : ''}`}>
                  <span>{k === 'screenRecording' ? 'Screen Recording' : 'Accessibility'}</span>
                  {ok ? (
                    <em className="ob-perm-ok">✓</em>
                  ) : (
                    <button
                      type="button"
                      className="ob-perm-open"
                      onClick={() => void invoke('open_permission_settings', { permission: k }).catch(() => {})}
                      aria-label={`Open ${k} settings`}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Open
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        );
      case 'learn_point':
        return renderDemo('point');
      case 'circle':
        return renderDemo('circle');
      default:
        return null;
    }
  };

  const renderPrimary = () => {
    switch (step.id) {
      case 'name':
        return (
          <button type="button" className="ob-cta" disabled={!typed.trim()} onClick={commitName}>
            Continue
          </button>
        );
      case 'signin':
        return signedIn ? null : (
          <button type="button" className="ob-cta" onClick={openGoogle}>
            Continue with Google
          </button>
        );
      case 'source':
        return (
          <button
            type="button"
            className="ob-cta"
            disabled={!source}
            onClick={() => {
              if (source === 'Other' && typed.trim()) setSource(typed.trim());
              go(1);
            }}
          >
            Continue
          </button>
        );
      case 'permissions':
        return (
          <button type="button" className="ob-cta" onClick={() => go(1)}>
            {permsOk ? 'Continue' : 'Continue anyway'}
          </button>
        );
      case 'learn_point':
      case 'circle':
        // No button — the user must actually do the practice; it auto-advances when Kairo
        // finishes. (The back arrow in the header is still there as an escape hatch.)
        return null;
      case 'done':
        return (
          <button type="button" className="ob-cta" disabled={saving} onClick={() => void finish()}>
            {saving ? 'Setting up…' : 'Start using Kairo'}
          </button>
        );
    }
  };

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

        <KairoOrb mode={orbMode} level={orbLevel} progress={progress} />

        <div className="ob-stage" key={step.id}>
          <h1 className="ob-title">{step.title(name)}</h1>
          <div className="ob-field">{renderField()}</div>
          <div className="ob-controls">{renderPrimary()}</div>
        </div>
      </div>
    </div>
  );
}
