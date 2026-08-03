import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { OnboardingFlow } from './OnboardingFlow';
import { hasNativeBridge } from './config';
import { klog } from '../core/logger';
import { STEPS } from './copy';
import { FrontDoor } from './acts/FrontDoor';
import { Act3Hearing } from './acts/Act3Hearing';
import { Act4Permissions } from './acts/Act4Permissions';
import { Act2SignIn } from './acts/Act2SignIn';
import { Act6Source } from './acts/Act6Source';
import { Act7Ending } from './acts/Act7Ending';
import './onboarding.css';

// The first-run is a sequence of "acts" over the full-screen transparent orchestrator (Phase 0).
// Order: hero+color → sign-in → hearing → permissions → the real-screen practice (point + circle)
// → source → warm ending.
//
// Sign-in sits second, right after the color step, because that is exactly where the product starts
// spending money. Everything before it is baked audio and a color wheel — no provider call at all —
// so the account ask is the boundary between "free to run" and "costs us per turn", and every paid
// call in the product is authenticated and attributable to a user.
//
// It also fails fast: alpha access is gated on an invited email, and discovering you are not on the
// list AFTER granting Screen Recording, Accessibility and Input Monitoring would be a small
// betrayal. And it leaves the run to the peak uninterrupted — the practice beats now land last
// before the ending, with no credential step between the "whoa" and the close.
const ACT = {
  WELCOME: 0, // the "front door" (hero → color in one card) — first-impression only, NEVER a resume target
  SIGNIN: 1,
  HEARING: 2,
  PERMISSIONS: 3,
  PRACTICE: 4, // legacy STEPS wizard, now just point + circle
  SOURCE: 5,
  ENDING: 6
} as const;
const ACT_COUNT = 7;

// index = act (WELCOME:0 … ENDING:6); value = chapter (0..3). Chapters (internal names; the notch dots
// show NO text): Welcome / Set up / Try it / Wrap up. Drives the notch progress dots (Phase D).
const actToChapter = [0, 0, 1, 1, 2, 3, 3] as const;
const CHAPTER_TOTAL = 4;

// Whether the window must catch clicks for that act (front door / sign-in / chips), or stay
// click-through so the desktop + pet + System Settings receive input. Hearing and practice are
// notch + chord driven, so they stay click-through — the user acts on the REAL screen.
const INTERACTIVE = [true, true, false, false, false, true, false];

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
        // Resume only ever lands on PERMISSIONS or PRACTICE (a STEPS id). WELCOME(0) is a
        // first-impression-only act and is intentionally NEVER a resume target, so a Screen-Recording
        // quit+reopen never replays the front door. A fresh run (no marker) keeps useState(0) = WELCOME.
        // 'act3' is the legacy spelling of this marker, written by builds from before sign-in
        // moved. Accepted so an onboarding already in flight resumes instead of restarting.
        if (saved === 'permissions' || saved === 'act3') setActIndex(ACT.PERMISSIONS);
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
    case ACT.SIGNIN:
      body = (
        <Act2SignIn
          onSignedIn={(name) => {
            setObName(name);
            advance();
          }}
        />
      );
      break;
    case ACT.HEARING:
      body = <Act3Hearing name="" onAdvance={advance} />;
      break;
    case ACT.PERMISSIONS:
      body = <Act4Permissions name="" onAdvance={advance} />;
      break;
    case ACT.PRACTICE:
      // Notch + chord driven (renders null); the caption + pet are the UI, like the hearing drill.
      body = <OnboardingFlow onComplete={advance} />;
      break;
    case ACT.SOURCE:
      body = (
        <Act6Source
          onPick={(source) => {
            setObSource(source);
            advance();
          }}
        />
      );
      break;
    default:
      body = <Act7Ending name={obName} source={obSource} onComplete={finish} />;
  }

  return <div className="ob-orchestrator">{body}</div>;
}
