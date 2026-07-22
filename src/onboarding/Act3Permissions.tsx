import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { klog } from '../core/logger';
import type { NativeBridge } from '../native/nativeBridge';
import { useCoach } from './useCoach';
import {
  act3ScreenLine,
  act3ScreenRestartLine,
  act3AccessLine,
  act3AccessFillerLine,
  act3AccessFallbackLine
} from './copy';
import { nextPermissionStep, type Act3SubStep } from './act3SubStep';
import { findAccessibilityToggle } from './demoController';
import { releaseVisualTargets } from '../overlay/targetRouting';
import type { ActProps } from './acts/actTypes';

const SETTINGS_BUNDLE = 'com.apple.systempreferences';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wait for System Settings to be frontmost (+ a short settle for the pane to render) so the
// screenshot the vision-point captures actually shows the Accessibility list.
async function waitForSettings(bridge: NativeBridge, timeoutMs = 4000): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const app = await bridge.getActiveApp();
    if (app.bundleId === SETTINGS_BUNDLE) {
      await delay(600);
      return true;
    }
    await delay(300);
  }
  return false;
}

// Act 3 — "Earn the Eyes". Two separate permission moments (Screen Recording, then the signature
// Accessibility vision-point). Status-driven so it survives the Screen-Recording quit+reopen. Every
// spoken line goes through `say`, so the notch caption always matches Kairo's voice; the silent
// `guide` caption only appears while the user flips the actual switch. One thing at a time.
export function Act3Permissions({ name, onAdvance }: ActProps) {
  const { say, bridge } = useCoach(name);
  const [sub, setSub] = useState<Act3SubStep | null>(null);
  const spoke = useRef<Record<string, boolean>>({});
  const advanced = useRef(false);

  // Persist the resume marker on entry: granting Screen Recording forces a macOS quit+reopen, and
  // the orchestrator resumes to whatever the step marker says (mapped in OnboardingApp).
  useEffect(() => {
    void invoke('set_onboarding_step', { step: 'act3' }).catch(() => {});
  }, []);

  // Live status is the source of truth (idempotent across the relaunch). Poll → pick the sub-step.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const status = await bridge.getPermissionStatus();
      if (cancelled) return;
      const next = nextPermissionStep(status);
      if (next === 'done') {
        if (!advanced.current) {
          advanced.current = true;
          klog('onboarding', 'info', 'act3 done');
          onAdvance();
        }
        return;
      }
      setSub((prev) => (prev === next ? prev : next));
    };
    void tick();
    const iv = setInterval(tick, 1500);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [bridge, onAdvance]);

  // Drive the current sub-step, top to bottom (runs once per sub-step). Read it as a script.
  useEffect(() => {
    if (!sub) return;
    let cancelled = false;
    const stop = () => cancelled;

    void (async () => {
      if (sub === 'screen') {
        if (spoke.current.screen) return; // already ran this sub-step's script
        spoke.current.screen = true;

        // 1. Say WHY (caption in sync with the voice) — this is the "to point things out…" line.
        await say(act3ScreenLine);
        if (stop()) return;
        // 2. THEN the OS consent dialog (main-thread — also registers Kairo in the list) + the pane.
        await bridge.requestScreenRecording();
        await bridge.openPermissionSettings('screenRecording');
        if (stop()) return;
        // 3. Speak the do-it-now + reopen heads-up. This line itself carries the instruction, so the
        //    caption that stays up while they toggle was actually SAID (never silent text).
        await say(act3ScreenRestartLine);
        return;
      }

      // sub === 'accessibility'
      if (spoke.current.access) return;
      spoke.current.access = true;

      // 1. Register Kairo in the AX list (so a toggle exists) + open the pane — THIS step's window.
      await bridge.requestAccessibility();
      await bridge.openPermissionSettings('accessibility');
      const settled = await waitForSettings(bridge);
      if (stop()) return;
      if (!settled) {
        await say(act3AccessFallbackLine); // spoken instruction (caption == voice)
        return;
      }

      // 2. Kick off the (slow) vision call in the BACKGROUND, and cover it with a spoken filler so
      //    the pet's point lands at the perfect moment, not after an awkward silence (§Act 3b).
      const finding = findAccessibilityToggle(bridge);
      await say(act3AccessFillerLine); // "Alright, let me find that switch — one sec."
      const { located, reveal } = await finding;
      if (stop()) return;
      await delay(600); // a small beat so the point doesn't collide with the filler line

      if (located) {
        // 3. Say the reveal line (which itself ends "…flip it on") THEN fly the pet to the switch.
        await say(act3AccessLine);
        if (stop()) return;
        await reveal();
      } else {
        // Couldn't place a box on the small system toggle → the spoken guided fallback line.
        await say(act3AccessFallbackLine);
      }
    })().catch((e) =>
      klog('onboarding', 'error', 'act3 sub-step failed', { sub, error: String(e) })
    );

    return () => {
      cancelled = true;
    };
  }, [sub, bridge, say]);

  // Clear any pet highlight when we leave a sub-step / unmount.
  useEffect(() => () => void releaseVisualTargets(bridge), [bridge]);

  return null; // all guidance is the notch caption; the real desktop / System Settings shows through
}
