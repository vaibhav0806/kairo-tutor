import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ONBOARDING_SOURCES } from '@kairo/shared';
import { klog } from '../core/logger';
import { RESPONSES, STEPS } from './copy';
import { getAuthStatus, getBackendJwt, onAuthChanged, startGoogleAuth } from './authClient';
import { extractField, onboardingStt, saveOnboarding } from './backendClient';
import { useVoice } from './useVoice';
import '@fontsource/instrument-serif';
import './onboarding.css';

type OrbMode = 'idle' | 'speaking' | 'listening' | 'thinking';
type Perms = { screenRecording: string; accessibility: string };

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase())
    .trim();
}

function KairoOrb({ mode, level, progress }: { mode: OrbMode; level: number; progress: number }) {
  const r = 63;
  const c = 2 * Math.PI * r;
  return (
    <div className="ob-orb" data-mode={mode} style={{ '--level': level } as React.CSSProperties}>
      <svg className="ob-orb-progress" viewBox="0 0 144 144" width="144" height="144" aria-hidden>
        <circle cx="72" cy="72" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="2.5" />
        <circle cx="72" cy="72" r={r} fill="none" stroke="url(#ob-arc)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} transform="rotate(-90 72 72)" />
        <defs>
          <linearGradient id="ob-arc" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#c4a1ff" />
            <stop offset="1" stopColor="#7c3aed" />
          </linearGradient>
        </defs>
      </svg>
      <span className="ob-orb-field" />
      <span className="ob-orb-sheen" />
      <span className="ob-orb-ring" />
      <span className="ob-orb-core" />
    </div>
  );
}

function VoiceInput(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  listening: boolean;
  processing?: boolean;
  onMic: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className={`ob-input${props.processing ? ' is-processing' : ''}`}>
      <input
        value={props.value}
        placeholder={props.processing ? 'thinking…' : props.listening ? 'listening…' : props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && props.onSubmit()}
        disabled={props.processing}
        autoFocus
        spellCheck={false}
      />
      <button type="button" className={`ob-mic${props.listening ? ' is-live' : ''}`} onClick={props.onMic} disabled={props.processing} aria-label={props.listening ? 'Stop' : 'Talk'}>
        {props.processing ? (
          <span className="ob-mic-spin" />
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
      </button>
    </div>
  );
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
  const [practiceText, setPracticeText] = useState('');
  const [talkDone, setTalkDone] = useState(false);
  const [pointDone, setPointDone] = useState(false);
  const voice = useVoice();
  const step = STEPS[index];
  const nameRef = useRef(name);
  nameRef.current = name;
  const autoOpenedRef = useRef(false);

  const orbMode: OrbMode = processing
    ? 'thinking'
    : voice.isListening
      ? 'listening'
      : voice.isSpeaking
        ? 'speaking'
        : 'idle';
  const progress = (index + 1) / STEPS.length;
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

  useEffect(() => {
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

  // Live permission status while on the permissions step (updates after the user grants).
  useEffect(() => {
    if (step.id !== 'permissions') return;
    const check = () =>
      invoke<Perms>('get_permission_status')
        .then((p) => setPerms({ screenRecording: p.screenRecording, accessibility: p.accessibility }))
        .catch(() => {});
    void check();
    const iv = setInterval(check, 1500);
    return () => clearInterval(iv);
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

  // learn_talk practice: the user actually talks, then Kairo responds.
  const practiceTalk = useCallback(() => {
    if (voice.isListening) {
      voice.stopListening();
      return;
    }
    void voice.startListening(async (blob) => {
      if (!blob) {
        setTalkDone(true); // mic hiccup — don't hard-block onboarding
        return;
      }
      setProcessing(true);
      const t = await onboardingStt(blob);
      setProcessing(false);
      setPracticeText(t || 'heard you loud and clear');
      setTalkDone(true);
      void voice.speak([{ cacheKey: 'talk_done', text: () => RESPONSES.talk_done }], name);
    });
  }, [voice, name]);

  // learn_point practice: Kairo points (a glowing dot); the user clicks it.
  const completePoint = useCallback(() => {
    if (pointDone) return;
    setPointDone(true);
    void voice.speak([{ cacheKey: 'point_done', text: () => RESPONSES.point_done }], name);
  }, [pointDone, voice, name]);

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
            {(['screenRecording', 'accessibility'] as const).map((k) => {
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
      case 'learn_talk':
        return (
          <div className="ob-field-col">
            <button type="button" className={`ob-talk${voice.isListening ? ' is-live' : ''}`} onClick={practiceTalk} disabled={processing}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
                <rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {voice.isListening ? 'Listening… tap to stop' : processing ? 'Thinking…' : talkDone ? 'Say something else' : 'Tap & say anything'}
            </button>
            {practiceText && <div className="ob-practice">“{practiceText}”</div>}
          </div>
        );
      case 'learn_point':
        return pointDone ? (
          <div className="ob-signed">
            <span className="ob-check">✓</span> nice — you got it
          </div>
        ) : (
          <div className="ob-point-zone">
            <button type="button" className="ob-point-target" onClick={completePoint} aria-label="Click the glowing dot">
              <span className="ob-point-ping" />
              <span className="ob-point-core" />
            </button>
          </div>
        );
      default:
        return null;
    }
  };

  const renderPrimary = () => {
    switch (step.id) {
      case 'welcome':
        return (
          <button type="button" className="ob-cta" onClick={() => go(1)}>
            Let&apos;s go
          </button>
        );
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
      case 'learn_talk':
        return (
          <button type="button" className="ob-cta" disabled={!talkDone} onClick={() => go(1)}>
            Continue
          </button>
        );
      case 'learn_point':
        return (
          <button type="button" className="ob-cta" disabled={!pointDone} onClick={() => go(1)}>
            Continue
          </button>
        );
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

        <KairoOrb mode={orbMode} level={voice.level} progress={progress} />

        <div className="ob-stage" key={step.id}>
          <h1 className="ob-title">{step.title(name)}</h1>
          <div className="ob-field">{renderField()}</div>
          <div className="ob-controls">{renderPrimary()}</div>
        </div>
      </div>
    </div>
  );
}
