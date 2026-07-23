import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { OnboardingFlow } from './OnboardingFlow';
import { hasNativeBridge } from './config';
import { klog } from '../core/logger';
import { STEPS } from './copy';
import { FrontDoor } from './acts/FrontDoor';
import { Act2Hearing } from './acts/Act2Hearing';
import { Act3Permissions } from './acts/Act3Permissions';
import { Act5SignIn } from './acts/Act5SignIn';
import { Act5Source } from './acts/Act5Source';
import { Act6Ending } from './acts/Act6Ending';
import './onboarding.css';

// The redesigned first-run is a sequence of "acts" over the full-screen transparent orchestrator
// (Phase 0). Value-first ordering (spec §4): color → hearing → permissions → the real-screen
// practice (point + circle) → sign-in → source → warm ending. Sign-in is LAST-but-one, so the first
// "whoa" always precedes any account ask.
const ACT = {
  WELCOME: 0, // the "front door" (hero → color in one card) — first-impression only, NEVER a resume target
  HEARING: 1,
  PERMISSIONS: 2,
  PRACTICE: 3, // legacy STEPS wizard, now just point + circle
  SIGNIN: 4,
  SOURCE: 5,
  ENDING: 6
} as const;
const ACT_COUNT = 7;

// index = act (WELCOME:0 … ENDING:6); value = chapter (0..3). Chapters (internal names; the notch dots
// show NO text): Welcome / Set up / Try it / Wrap up. Drives the notch progress dots (Phase D).
const actToChapter = [0, 1, 1, 2, 3, 3, 3] as const;
const CHAPTER_TOTAL = 4;

// Whether the window must catch clicks for that act (front door / sign-in / chips), or stay
// click-through so the desktop + pet + System Settings receive input. Hearing and practice are
// notch + chord driven, so they stay click-through — the user acts on the REAL screen.
const INTERACTIVE = [true, false, false, false, true, true, false];

/** Root of the full-screen, transparent, click-through onboarding orchestrator (#/onboarding). */
export function OnboardingApp() {
  const [actIndex, setActIndex] = useState(0);
  const [obName, setObName] = useState('');
  const [obSource, setObSource] = useState('');
  // Hold ALL rendering until we've read the resume marker. Otherwise a relaunch (Screen Recording
  // forces quit+reopen) flashes Act 1 — firing its "Hey, I'm Kairo…" wake line — before the async
  // resume switches to Act 3. Gate on this so the intro never replays on a mid-onboarding reopen.
  const [resolved, setResolved] = useState(!hasNativeBridge);

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

  // Stable identity so acts' effects (e.g. Act 3's status poll keyed on onAdvance) don't re-run
  // every render.
  const advance = useCallback(() => {
    setActIndex((i) => Math.min(ACT_COUNT - 1, i + 1));
  }, []);

  // The window catches clicks only when the current surface needs them.
  useEffect(() => {
    if (!hasNativeBridge) return;
    const interactive = INTERACTIVE[actIndex] ?? true;
    void invoke('set_onboarding_click_through', { clickThrough: !interactive }).catch(() => {});
  }, [actIndex]);

  // Drive the notch progress dots (Phase D): one dot per chapter, no text. Separate from the coach
  // caption (which is cleared between acts) — the dots ride their own event + state in the notch, so a
  // caption clear can't wipe them. Fires on mount (act 0 → chapter 0) and after every advance/resume.
  useEffect(() => {
    if (!hasNativeBridge) return;
    const chapter = actToChapter[actIndex] ?? 0;
    klog('onboarding', 'info', 'progress emit', { act: actIndex, chapter, total: CHAPTER_TOTAL });
    void emit('onboarding:progress', { chapter, total: CHAPTER_TOTAL }).catch(() => {});
  }, [actIndex]);

  // Resume after a permission-triggered relaunch (Screen Recording forces quit+reopen). Land on the
  // right macro-step BEFORE rendering anything; the live status drives Act 3's sub-step and
  // OnboardingFlow's own resume.
  useEffect(() => {
    if (!hasNativeBridge) return;
    void invoke<string>('get_onboarding_step')
      .then((saved) => {
        klog('onboarding', 'info', 'resume', { saved });
        // Resume only ever lands on PERMISSIONS ('act3') or PRACTICE (a STEPS id). WELCOME(0) is a
        // first-impression-only act and is intentionally NEVER a resume target, so a Screen-Recording
        // quit+reopen never replays the front door. A fresh run (no marker) keeps useState(0) = WELCOME.
        if (saved === 'act3') setActIndex(ACT.PERMISSIONS);
        else if (saved && STEPS.some((s) => s.id === saved)) setActIndex(ACT.PRACTICE);
      })
      .catch(() => {})
      .finally(() => setResolved(true));
  }, []);

  const finish = () => {
    // Clear the notch dots so they never show in normal product use (chapter < 0 = clear sentinel).
    void emit('onboarding:progress', { chapter: -1, total: CHAPTER_TOTAL }).catch(() => {});
    klog('onboarding', 'info', 'progress cleared (finish)');
    if (hasNativeBridge) void invoke('finish_onboarding').catch(() => {});
  };

  // Nothing until the resume marker is read (prevents the Act 1 flash on reopen).
  if (!resolved) return <div className="ob-orchestrator" />;

  let body: React.ReactNode;
  switch (actIndex) {
    case ACT.WELCOME:
      body = <FrontDoor onComplete={advance} />;
      break;
    case ACT.HEARING:
      body = <Act2Hearing name="" onAdvance={advance} />;
      break;
    case ACT.PERMISSIONS:
      body = <Act3Permissions name="" onAdvance={advance} />;
      break;
    case ACT.PRACTICE:
      // Notch + chord driven (renders null); the caption + pet are the UI, like Act 2's drill.
      body = <OnboardingFlow onComplete={advance} />;
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
