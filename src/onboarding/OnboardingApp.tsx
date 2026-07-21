import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { OnboardingFlow } from './OnboardingFlow';
import { hasNativeBridge } from './config';
import { klog } from '../core/logger';
import { STEPS } from './copy';
import { Act1Arrival } from './acts/Act1Arrival';
import { Act2Hearing } from './acts/Act2Hearing';
import { Act3Permissions } from './Act3Permissions';
import { Act5SignIn } from './acts/Act5SignIn';
import { Act5Source } from './acts/Act5Source';
import { Act6Ending } from './acts/Act6Ending';

// The redesigned first-run is a sequence of "acts" over the full-screen transparent orchestrator
// (Phase 0). Value-first ordering (spec §4): color → hearing → permissions → the real-screen
// practice (point + circle) → sign-in → source → warm ending. Sign-in is LAST-but-one, so the first
// "whoa" always precedes any account ask.
const ACT = {
  ARRIVAL: 0,
  HEARING: 1,
  PERMISSIONS: 2,
  PRACTICE: 3, // legacy STEPS wizard, now just point + circle
  SIGNIN: 4,
  SOURCE: 5,
  ENDING: 6
} as const;
const ACT_COUNT = 7;

// Whether the window must catch clicks for that act (color wheel / practice card / sign-in / chips),
// or stay click-through so the desktop + pet + System Settings receive input.
const INTERACTIVE = [true, false, false, true, true, true, false];

/** Root of the full-screen, transparent, click-through onboarding orchestrator (#/onboarding). */
export function OnboardingApp() {
  const [actIndex, setActIndex] = useState(0);
  const [obName, setObName] = useState('');
  const [obSource, setObSource] = useState('');

  // Make the webview transparent for the WHOLE onboarding (Acts 1-3/5-6 don't mount OnboardingFlow,
  // which used to add this) — otherwise the body keeps its default light background and the
  // full-screen window paints white over the real desktop.
  useEffect(() => {
    document.documentElement.classList.add('onboarding-document');
    document.body.classList.add('onboarding-document');
    return () => {
      document.documentElement.classList.remove('onboarding-document');
      document.body.classList.remove('onboarding-document');
    };
  }, []);

  const advance = () => {
    klog('onboarding', 'info', 'act advance', { from: actIndex });
    setActIndex((i) => Math.min(ACT_COUNT - 1, i + 1));
  };

  // The window catches clicks only when the current surface needs them.
  useEffect(() => {
    if (!hasNativeBridge) return;
    const interactive = INTERACTIVE[actIndex] ?? true;
    void invoke('set_onboarding_click_through', { clickThrough: !interactive }).catch(() => {});
  }, [actIndex]);

  // Resume after a permission-triggered relaunch (Screen Recording forces quit+reopen). Land on the
  // right macro-step; the live status drives Act 3's sub-step and OnboardingFlow's own resume.
  useEffect(() => {
    if (!hasNativeBridge) return;
    void invoke<string>('get_onboarding_step')
      .then((saved) => {
        if (saved === 'act3') setActIndex(ACT.PERMISSIONS);
        else if (saved && STEPS.some((s) => s.id === saved)) setActIndex(ACT.PRACTICE);
      })
      .catch(() => {});
  }, []);

  const finish = () => {
    if (hasNativeBridge) void invoke('finish_onboarding').catch(() => {});
  };

  let body: React.ReactNode;
  switch (actIndex) {
    case ACT.ARRIVAL:
      body = <Act1Arrival name="" onAdvance={advance} />;
      break;
    case ACT.HEARING:
      body = <Act2Hearing name="" onAdvance={advance} />;
      break;
    case ACT.PERMISSIONS:
      body = <Act3Permissions name="" onAdvance={advance} />;
      break;
    case ACT.PRACTICE:
      // The legacy card (point + circle only) lives in the bounded temp panel.
      body = (
        <div className="ob-temp-panel">
          <OnboardingFlow onComplete={advance} />
        </div>
      );
      break;
    case ACT.SIGNIN:
      body = (
        <Act5SignIn
          onSignedIn={(name) => {
            setObName(name);
            advance();
          }}
        />
      );
      break;
    case ACT.SOURCE:
      body = (
        <Act5Source
          onPick={(source) => {
            setObSource(source);
            advance();
          }}
        />
      );
      break;
    default:
      body = <Act6Ending name={obName} source={obSource} onComplete={finish} />;
  }

  return <div className="ob-orchestrator">{body}</div>;
}
