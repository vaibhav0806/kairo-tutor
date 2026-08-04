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
  // The "front door": hero → colour → sign-in, three panels of ONE card. Sign-in lives inside it
  // rather than as an act of its own, so those beats read as a single first impression instead of
  // a credential screen dropped into the middle of the flow. First-impression only, and never a
  // resume target — a relaunch must not replay it.
  WELCOME: 0,
  HEARING: 1,
  PERMISSIONS: 2,
  PRACTICE: 3, // legacy STEPS wizard, now just point + circle
  SOURCE: 4,
  ENDING: 5
} as const;
const ACT_COUNT = 6;

// index = act (WELCOME:0 … ENDING:6); value = chapter (0..3). Chapters (internal names; the notch dots
// show NO text): Welcome / Set up / Try it / Wrap up. Drives the notch progress dots (Phase D).
const actToChapter = [0, 1, 1, 2, 3, 3] as const;
const CHAPTER_TOTAL = 4;

// Whether the window must catch clicks for that act (front door / sign-in / chips), or stay
// click-through so the desktop + pet + System Settings receive input. Hearing and practice are
// notch + chord driven, so they stay click-through — the user acts on the REAL screen.
const INTERACTIVE = [true, false, false, false, true, false];


/**
 * Disk marker per resumable act. Named, never numbered: this string is persisted, so renumbering
 * the acts must never be able to silently point a resume at the wrong place.
 */
const ACT_MARKERS: Record<number, string | undefined> = {
  [ACT.HEARING]: 'hearing',
  [ACT.PERMISSIONS]: 'permissions',
  [ACT.PRACTICE]: 'practice',
  [ACT.SOURCE]: 'source',
  [ACT.ENDING]: 'ending'
};

/** Which act a saved marker resumes to, or null to start from the front door. */
function resumeIndex(saved: string): number | null {
  // 'act3' is the legacy spelling of the permissions marker, written by earlier builds. Kept so an
  // onboarding already in flight resumes instead of restarting.
  if (saved === 'permissions' || saved === 'act3') return ACT.PERMISSIONS;
  if (saved === 'hearing') return ACT.HEARING;
  if (saved === 'source') return ACT.SOURCE;
  if (saved === 'ending') return ACT.ENDING;
  // The practice wizard keeps its own STEPS id as the marker and resumes itself from there.
  if (saved === 'practice' || STEPS.some((step) => step.id === saved)) return ACT.PRACTICE;
  return null;
}

/**
 * One read of the marker for the whole page, shared by every mount.
 *
 * The onboarding webview mounts more than once on a relaunch. A per-mount read let a later mount
 * start at WELCOME and race its own request, discarding the resolved target — the front door
 * reappearing after granting Screen Recording. Resolving once, at module scope, removes the race
 * rather than trying to win it.
 */
let resumeRead: Promise<string> | null = null;
function resumeTarget(): Promise<string> {
  resumeRead ??= invoke<string>('get_onboarding_step').catch(() => '');
  return resumeRead;
}

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

  // Persist the furthest act reached, so ANY relaunch resumes in the right place — not just the
  // Screen-Recording one. Previously only the permissions act wrote a marker, so a restart anywhere
  // else replayed the front door. WELCOME is deliberately never written: it is the first impression,
  // and replaying it after a relaunch is exactly the bug this guards against.
  useEffect(() => {
    if (!hasNativeBridge || !resolved) return;
    const marker = ACT_MARKERS[actIndex];
    if (!marker) return;
    void invoke('set_onboarding_step', { step: marker }).catch(() => {});
  }, [actIndex, resolved]);

  // Resume after a relaunch. Resolve the target act BEFORE rendering anything.
  //
  // The read is a MODULE-level promise, not a per-mount one. The onboarding webview mounts more
  // than once during a relaunch, and a per-mount read meant the second mount started at WELCOME
  // with its own in-flight request — so the resume result was resolved correctly and then thrown
  // away, which is precisely why the front door reappeared after granting Screen Recording.
  useEffect(() => {
    if (!hasNativeBridge) return;
    let alive = true;
    void resumeTarget()
      .then((saved) => {
        if (!alive) return;
        const target = resumeIndex(saved);
        klog('onboarding', 'info', 'resume', { saved, target });
        if (target !== null) setActIndex(target);
      })
      .catch(() => {})
      .finally(() => alive && setResolved(true));
    return () => {
      alive = false;
    };
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
      body = (
        <FrontDoor
          onComplete={(name: string) => {
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
