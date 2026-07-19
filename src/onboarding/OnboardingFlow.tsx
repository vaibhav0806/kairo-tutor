import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ONBOARDING_SOURCES } from '@kairo/shared';
import { klog } from '../core/logger';
import { STEPS } from './copy';
import { hasNativeBridge } from './config';
import { getAuthStatus, getBackendJwt, onAuthChanged, startGoogleAuth } from './authClient';
import { onboardingStt, saveOnboarding } from './backendClient';
import { useVoice } from './useVoice';
import './onboarding.css';

// Foreground (Regular policy + compact centered focusable window) for onboarding; background on
// finish. Done natively because an Accessory app's window can't front or take keyboard focus.
async function setForeground(active: boolean) {
  if (!hasNativeBridge) return;
  try {
    await invoke('set_onboarding_foreground', { active });
  } catch {
    /* ignore — best effort */
  }
}

function Waveform({ level, active }: { level: number; active: boolean }) {
  const bars = [0.55, 0.85, 1, 0.72, 0.6];
  return (
    <div className={`ob-wave${active ? ' is-active' : ''}`}>
      {bars.map((base, i) => (
        <i key={i} style={{ height: `${6 + base * level * 34}px` }} />
      ))}
    </div>
  );
}

function TextRow(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  listening: boolean;
  level: number;
  onMic: () => void;
}) {
  return (
    <div className="ob-textrow">
      <input
        value={props.value}
        placeholder={props.listening ? 'Listening…' : props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        autoFocus
      />
      <button
        type="button"
        className={`ob-mic${props.listening ? ' is-rec' : ''}`}
        onClick={props.onMic}
        title="Talk"
        style={props.listening ? { boxShadow: `0 0 0 ${4 + props.level * 10}px rgba(124,58,237,0.18)` } : undefined}
      >
        🎙
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

  const go = useCallback((delta: number) => {
    setIndex((i) => Math.max(0, Math.min(STEPS.length - 1, i + delta)));
  }, []);

  // Bring the app forward for onboarding; send it back to the background on unmount.
  useEffect(() => {
    void setForeground(true);
    return () => {
      void setForeground(false);
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

  // Speak each step's line as it appears.
  useEffect(() => {
    void voice.speak(step.say(nameRef.current));
    setTyped('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Auto-advance the sign-in step once signed in.
  useEffect(() => {
    if (step.id === 'signin' && signedIn) {
      const t = setTimeout(() => go(1), 800);
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
    await setForeground(false);
    onComplete();
  }, [name, source, onComplete]);

  const renderControls = () => {
    switch (step.id) {
      case 'welcome':
        return (
          <button type="button" className="ob-primary" onClick={() => go(1)}>
            Let&apos;s go
          </button>
        );
      case 'name':
        return (
          <>
            <TextRow value={typed} onChange={setTyped} placeholder="Your name" listening={voice.isListening} level={voice.level} onMic={toggleMic} />
            <button
              type="button"
              className="ob-primary"
              disabled={!typed.trim()}
              onClick={() => {
                setName(typed.trim());
                go(1);
              }}
            >
              Continue
            </button>
          </>
        );
      case 'signin':
        return signedIn ? (
          <div className="ob-signed">Signed in ✓</div>
        ) : (
          <button type="button" className="ob-primary" onClick={() => void startGoogleAuth()}>
            Sign in with Google
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
              <TextRow value={typed} onChange={setTyped} placeholder="Tell me where" listening={voice.isListening} level={voice.level} onMic={toggleMic} />
            )}
            <button
              type="button"
              className="ob-primary"
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
            <button type="button" className="ob-secondary" onClick={() => void invoke('request_required_permissions').catch(() => {})}>
              Grant permissions
            </button>
            <button type="button" className="ob-primary" onClick={() => go(1)}>
              Continue
            </button>
          </>
        );
      case 'learn_talk':
        return (
          <>
            <div className="ob-keys">
              <kbd>⌥ option</kbd>
              <span>+</span>
              <kbd>⌃ control</kbd>
            </div>
            <button type="button" className="ob-primary" onClick={() => go(1)}>
              Got it
            </button>
          </>
        );
      case 'learn_point':
        return (
          <button type="button" className="ob-primary" onClick={() => go(1)}>
            Makes sense
          </button>
        );
      case 'done':
        return (
          <button type="button" className="ob-primary" disabled={saving} onClick={() => void finish()}>
            {saving ? 'Setting up…' : 'Start using Kairo'}
          </button>
        );
    }
  };

  return (
    <div className="ob-shell">
      <div className="ob-card">
        <header className="ob-top">
          {index > 0 ? (
            <button type="button" className="ob-back" onClick={() => go(-1)}>
              ‹ Back
            </button>
          ) : (
            <span />
          )}
          <div className="ob-dots">
            {STEPS.map((s, i) => (
              <i key={s.id} className={i === index ? 'on' : i < index ? 'done' : ''} />
            ))}
          </div>
          <span />
        </header>

        <div className="ob-body">
          <Waveform level={voice.isListening ? voice.level : voice.isSpeaking ? 0.6 : 0.15} active={voice.isListening || voice.isSpeaking} />
          <h1 className="ob-title">{step.title(name)}</h1>
          <p className="ob-say">{step.say(name)}</p>
          <div className="ob-controls">{renderControls()}</div>
        </div>
      </div>
    </div>
  );
}
