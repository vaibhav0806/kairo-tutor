import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ONBOARDING_SOURCES } from '@kairo/shared';
import { klog } from '../core/logger';
import { STEPS } from './copy';
import { getAuthStatus, getBackendJwt, onAuthChanged, startGoogleAuth } from './authClient';
import { extractField, onboardingStt, saveOnboarding } from './backendClient';
import { useVoice } from './useVoice';
import '@fontsource/instrument-serif';
import './onboarding.css';

type OrbMode = 'idle' | 'speaking' | 'listening';
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
  onMic: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="ob-input">
      <input
        value={props.value}
        placeholder={props.listening ? 'listening…' : props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && props.onSubmit()}
        autoFocus
        spellCheck={false}
      />
      <button type="button" className={`ob-mic${props.listening ? ' is-live' : ''}`} onClick={props.onMic} aria-label={props.listening ? 'Stop' : 'Talk'}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
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
  const voice = useVoice();
  const step = STEPS[index];
  const nameRef = useRef(name);
  nameRef.current = name;

  const orbMode: OrbMode = voice.isListening ? 'listening' : voice.isSpeaking ? 'speaking' : 'idle';
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
    void voice.speak(step.speech, nameRef.current);
    setTyped('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => {
    if (step.id === 'signin' && signedIn) {
      const t = setTimeout(() => go(1), 900);
      return () => clearTimeout(t);
    }
  }, [signedIn, step.id, go]);

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
      const transcript = await onboardingStt(blob);
      if (!transcript) return;
      if (step.id === 'name') {
        const value = await extractField(transcript, 'name');
        setTyped(titleCase(value || transcript));
      } else {
        setTyped(transcript.trim());
      }
    },
    [step.id],
  );

  const toggleMic = useCallback(() => {
    if (voice.isListening) voice.stopListening();
    else void voice.startListening(handleVoiceResult);
  }, [voice, handleVoiceResult]);

  const grantPerms = useCallback(() => {
    void invoke('request_required_permissions').catch(() => {});
    if (perms && perms.screenRecording !== 'granted') void invoke('open_permission_settings', { permission: 'screenRecording' }).catch(() => {});
    else if (perms && perms.accessibility !== 'granted') void invoke('open_permission_settings', { permission: 'accessibility' }).catch(() => {});
  }, [perms]);

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
        return <VoiceInput value={typed} onChange={setTyped} placeholder="your name" listening={voice.isListening} onMic={toggleMic} onSubmit={commitName} />;
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
            {source === 'Other' && <VoiceInput value={typed} onChange={setTyped} placeholder="tell me where" listening={voice.isListening} onMic={toggleMic} onSubmit={() => go(1)} />}
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
                  <em>{ok ? '✓' : 'needed'}</em>
                </div>
              );
            })}
            {!permsOk && (
              <button type="button" className="ob-ghost" onClick={grantPerms}>
                Open Settings to grant
              </button>
            )}
          </div>
        );
      case 'learn_talk':
        return (
          <div className="ob-keys">
            <kbd>⌥</kbd>
            <kbd>⌃</kbd>
            <span>hold to talk · tap to type</span>
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
          <button type="button" className="ob-cta" onClick={() => void startGoogleAuth()}>
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
          <button type="button" className="ob-cta" onClick={() => go(1)}>
            Got it
          </button>
        );
      case 'learn_point':
        return (
          <button type="button" className="ob-cta" onClick={() => go(1)}>
            Makes sense
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
