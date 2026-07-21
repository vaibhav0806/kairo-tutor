import { createElement, useEffect, useState, type ComponentType } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { OnboardingFlow } from './OnboardingFlow';
import { hasNativeBridge } from './config';
import { klog } from '../core/logger';
import { Act1Arrival } from './acts/Act1Arrival';
import { Act2Hearing } from './acts/Act2Hearing';
import type { ActProps } from './acts/actTypes';

// The redesigned first-run is a sequence of "acts" rendered over the full-screen transparent
// orchestrator window (Phase 0). Acts 1-2 (arrival + color, then hearing) run first; then the
// flow hands off to the remaining legacy card flow (name → sign-in → source → permissions →
// point → circle → done), which Phases 4-6 replace act-by-act. Each act declares whether the
// window must catch clicks (`interactive`) or stay click-through so the desktop + pet own the
// screen (the say-hi drill / future real-screen practice).
const ACTS: { Comp: ComponentType<ActProps>; interactive: boolean }[] = [
  { Comp: Act1Arrival, interactive: true }, // the color wheel needs clicks
  { Comp: Act2Hearing, interactive: false } // notch-only drill on the real desktop
];

/** Root of the full-screen, transparent, click-through onboarding orchestrator (#/onboarding). */
export function OnboardingApp() {
  const [actIndex, setActIndex] = useState(0);
  const inActs = actIndex < ACTS.length;

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
