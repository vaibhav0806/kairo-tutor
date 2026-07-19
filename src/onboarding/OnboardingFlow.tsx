import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ONBOARDING_SOURCES } from '@kairo/shared';
import { klog } from '../core/logger';
import { STEPS } from './copy';
import { hasNativeBridge } from './config';
import { getAuthStatus, getBackendJwt, onAuthChanged, startGoogleAuth } from './authClient';
import { onboardingStt, saveOnboarding } from './backendClient';
import { useVoice } from './useVoice';
import '@fontsource/instrument-serif';
import './onboarding.css';

type OrbMode = 'idle' | 'speaking' | 'listening';

/** Kairo's presence — a living aura (the same identity as the companion cursor) that breathes when
 *  idle, blooms while speaking, and ripples with your mic level while listening. */
function KairoOrb({ mode, level }: { mode: OrbMode; level: number }) {
  return (
    <div className="ob-orb" data-mode={mode} style={{ '--level': level } as React.CSSProperties}>
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
      <button
        type="button"
        className={`ob-mic${props.listening ? ' is-live' : ''}`}
        onClick={props.onMic}
        aria-label={props.listening ? 'Stop' : 'Talk'}
      >
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
  const voice = useVoice();
  const step = STEPS[index];
  const nameRef = useRef(name);
  nameRef.current = name;

  const orbMode: OrbMode = voice.isListening ? 'listening' : voice.isSpeaking ? 'speaking' : 'idle';

  const go = useCallback((delta: number) => {
    setIndex((i) => Math.max(0, Math.min(STEPS.length - 1, i + delta)));
  }, []);

  // Transparent window: strip the light page background so the rounded surface floats.
  useEffect(() => {
    document.documentElement.classList.add('onboarding-document');
    document.body.classList.add('onboarding-document');
    return () => {
      document.documentElement.classList.remove('onboarding-document');
      document.body.classList.remove('onboarding-document');
    };
  }, []);

  // Auth status + live updates from the deep-link exchange.
  useEffect(() => {
    let un = () => {};
    void getAuthStatus().then((s) => setSignedIn(s.signed_in));
    void onAuthChanged((s) => setSignedIn(s)).then((u) => {
      un = u;
    });
    return () => un();
  }, []);

  // Kairo speaks each step as it appears.
  useEffect(() => {
    void voice.speak(step.say(nameRef.current));
    setTyped('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Auto-advance the sign-in step once signed in.
  useEffect(() => {
    if (step.id === 'signin' && signedIn) {
      const t = setTimeout(() => go(1), 900);
      return () => clearTimeout(t);
    }
  }, [signedIn, step.id, go]);

  const toggleMic = useCallback(async () => {
    if (voice.isListening) {
      const blob = await voice.stopListening();
      if (blob) {
        const text = await onboardingStt(blob);
        if (text) setTyped((t) => (t ? `${t} ${text}` : text));
      }
    } else {
      await voice.startListening();
    }
  }, [voice]);

  const finish = useCallback(async () => {
    setSaving(true);
    const jwt = await getBackendJwt();
    if (jwt) {
      const ok = await saveOnboarding(jwt, name || 'there', source || 'unknown');
      klog('onboarding', 'info', 'onboarding saved', { ok });
    } else {
      klog('onboarding', 'warn', 'onboarding finished but no jwt (not signed in?)');
    }
    onComplete();
  }, [name, source, onComplete]);

  const commitName = () => {
    if (typed.trim()) {
      setName(typed.trim());
      go(1);
    }
  };

  const renderControls = () => {
    switch (step.id) {
      case 'welcome':
        return (
          <button type="button" className="ob-cta" onClick={() => go(1)}>
            Let&apos;s go
          </button>
        );
      case 'name':
        return (
          <>
            <VoiceInput value={typed} onChange={setTyped} placeholder="your name" listening={voice.isListening} onMic={toggleMic} onSubmit={commitName} />
            <button type="button" className="ob-cta" disabled={!typed.trim()} onClick={commitName}>
              Continue
            </button>
          </>
        );
      case 'signin':
        return signedIn ? (
          <div className="ob-signed">
            <span className="ob-check">✓</span> signed in
          </div>
        ) : (
          <button type="button" className="ob-cta" onClick={() => void startGoogleAuth()}>
            <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden style={{ marginRight: 9 }}>
              <path fill="#fff" d="M22.5 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2-1.9 3.2-4.7 3.2-7.9Z" opacity=".95" />
              <path fill="#fff" d="M12 23c2.9 0 5.4-1 7.2-2.6l-3.6-2.7c-1 .7-2.3 1-3.6 1-2.8 0-5.1-1.9-6-4.4H2.3v2.8A11 11 0 0 0 12 23Z" opacity=".8" />
              <path fill="#fff" d="M6 14.3a6.6 6.6 0 0 1 0-4.2V7.3H2.3a11 11 0 0 0 0 9.8L6 14.3Z" opacity=".65" />
              <path fill="#fff" d="M12 5.4c1.6 0 3 .5 4.1 1.6l3.1-3.1A11 11 0 0 0 2.3 7.3L6 10.1c.9-2.6 3.2-4.7 6-4.7Z" opacity=".9" />
            </svg>
            Continue with Google
          </button>
        );
      case 'source':
        return (
          <>
            <div className="ob-chips">
              {ONBOARDING_SOURCES.map((s) => (
                <button key={s} type="button" className={`ob-chip${source === s ? ' is-sel' : ''}`} onClick={() => setSource(s)}>
                  {s}
                </button>
              ))}
            </div>
            {source === 'Other' && (
              <VoiceInput value={typed} onChange={setTyped} placeholder="tell me where" listening={voice.isListening} onMic={toggleMic} onSubmit={() => go(1)} />
            )}
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
          </>
        );
      case 'permissions':
        return (
          <>
            <button type="button" className="ob-ghost" onClick={() => void invoke('request_required_permissions').catch(() => {})}>
              Grant access
            </button>
            <button type="button" className="ob-cta" onClick={() => go(1)}>
              Continue
            </button>
          </>
        );
      case 'learn_talk':
        return (
          <>
            <div className="ob-keys">
              <kbd>⌥</kbd>
              <kbd>⌃</kbd>
              <span>hold to talk · tap to type</span>
            </div>
            <button type="button" className="ob-cta" onClick={() => go(1)}>
              Got it
            </button>
          </>
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
          <span className="ob-count">
            {String(index + 1).padStart(2, '0')} <em>/ {String(STEPS.length).padStart(2, '0')}</em>
          </span>
        </header>

        <KairoOrb mode={orbMode} level={voice.level} />

        <div className="ob-stage" key={step.id}>
          <h1 className="ob-title">{step.title(name)}</h1>
          <p className="ob-say">{step.say(name)}</p>
          <div className="ob-controls">{renderControls()}</div>
        </div>

        <div className="ob-progress" aria-hidden>
          <span style={{ width: `${((index + 1) / STEPS.length) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
