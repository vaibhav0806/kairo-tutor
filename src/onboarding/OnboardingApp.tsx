import { createElement, useEffect, useState, type ComponentType } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { OnboardingFlow } from './OnboardingFlow';
import { hasNativeBridge } from './config';
import { klog } from '../core/logger';
import { STEPS } from './copy';
import { Act1Arrival } from './acts/Act1Arrival';
import { Act2Hearing } from './acts/Act2Hearing';
import { Act3Permissions } from './Act3Permissions';
import type { ActProps } from './acts/actTypes';

// The redesigned first-run is a sequence of "acts" rendered over the full-screen transparent
// orchestrator window (Phase 0). Acts 1-2 (arrival + color, then hearing) run first; then the
// flow hands off to the remaining legacy card flow (name → sign-in → source → permissions →
// point → circle → done), which Phases 4-6 replace act-by-act. Each act declares whether the
// window must catch clicks (`interactive`) or stay click-through so the desktop + pet own the
// screen (the say-hi drill / future real-screen practice).
const ACTS: { Comp: ComponentType<ActProps>; interactive: boolean }[] = [
  { Comp: Act1Arrival, interactive: true }, // the color wheel needs clicks
  { Comp: Act2Hearing, interactive: false }, // notch-only drill on the real desktop
  { Comp: Act3Permissions, interactive: false } // System Settings must stay clickable underneath
];
// Act 3 persists this marker before the Screen-Recording quit+reopen; resume maps it back to Act 3.
const ACT3_INDEX = 2;

/** Root of the full-screen, transparent, click-through onboarding orchestrator (#/onboarding). */
export function OnboardingApp() {
  const [actIndex, setActIndex] = useState(0);
  const inActs = actIndex < ACTS.length;

  // Resume after a permission-triggered relaunch (Screen Recording forces quit+reopen). The live
  // status drives the sub-step inside Act 3, so we only need to land back on the right macro-step:
  // 'act3' → Act 3; a legacy step id → the legacy tail (which resumes to it internally).
  useEffect(() => {
    if (!hasNativeBridge) return;
    void invoke<string>('get_onboarding_step')
      .then((saved) => {
        if (saved === 'act3') setActIndex(ACT3_INDEX);
        else if (saved && saved !== 'done' && STEPS.some((s) => s.id === saved))
          setActIndex(ACTS.length); // legacy tail
      })
      .catch(() => {});
  }, []);

  // The window catches clicks only when the current surface needs them (color wheel / legacy card);
  // otherwise it stays click-through so the desktop + pet + notch receive input.
  useEffect(() => {
    if (!hasNativeBridge) return;
    const interactive = inActs ? ACTS[actIndex].interactive : true; // legacy card needs clicks
    void invoke('set_onboarding_click_through', { clickThrough: !interactive }).catch(() => {});
  }, [actIndex, inActs]);

  const advance = () => {
    klog('onboarding', 'info', 'act advance', { from: actIndex });
    setActIndex((i) => i + 1);
  };

  if (inActs) {
    const { Comp } = ACTS[actIndex];
    return (
      <div className="ob-orchestrator">{createElement(Comp, { name: '', onAdvance: advance })}</div>
    );
  }

  // Legacy tail: the remaining card flow, hosted in the bounded temp panel.
  return (
    <div className="ob-orchestrator">
      <div className="ob-temp-panel">
        <OnboardingFlow
          onComplete={() => {
            if (hasNativeBridge) void invoke('finish_onboarding').catch(() => {});
          }}
        />
      </div>
    </div>
  );
}
