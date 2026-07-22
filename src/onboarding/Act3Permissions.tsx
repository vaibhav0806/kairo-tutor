import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { klog } from '../core/logger';
import { createNativeBridge } from '../native/nativeBridge';
import { useVoice } from './useVoice';
import type { Segment } from './copy';
import {
  ACT3_COACH,
  act3ScreenLine,
  act3ScreenRestartLine,
  act3AccessLine,
  act3AccessFillerLine
} from './copy';
import { setCoachCaption } from './coachSurface';
import { nextPermissionStep, type Act3SubStep } from './act3SubStep';
import { findAccessibilityToggle } from './demoController';
import { releaseVisualTargets } from '../overlay/targetRouting';
import type { ActProps } from './acts/actTypes';

const SETTINGS_BUNDLE = 'com.apple.systempreferences';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wait for System Settings to be frontmost (+ a short settle for the pane to render) so the
// screenshot the vision-point captures actually shows the Accessibility list.
async function waitForSettings(
  bridge: ReturnType<typeof createNativeBridge>,
  timeoutMs = 4000
): Promise<boolean> {
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

// Act 3 — "Earn the Eyes". Two separate, in-voice permission moments (Screen Recording, then the
// signature Accessibility vision-point), status-driven so it's idempotent across the
// Screen-Recording quit+reopen. Chord-free; the coach caption lives in the notch.
export function Act3Permissions({ name, onAdvance }: ActProps) {
  const bridge = useMemo(() => createNativeBridge(), []);
  const voice = useVoice();
  // Depend on voice.speak (stable useCallback), NOT the whole voice object (new every render) —
  // otherwise the sub-step effect below re-runs on every render and the guidance flickers.
  const speak = useCallback((segs: Segment[]) => voice.speak(segs, name), [voice.speak, name]);

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

  // Drive the current sub-step's priming + prompt + vision-point (runs once per sub-step). All
  // guidance lives in the STICKY notch caption — no floating card (that overlapped System Settings
  // and flickered). The caption sits in the notch at the very top, clear of the Settings window.
  useEffect(() => {
    if (!sub || sub === 'done') return;
    let cancelled = false;
    void (async () => {
      if (sub === 'screen') {
        if (!spoke.current.screen) {
          spoke.current.screen = true;
          await speak(act3ScreenLine);
        }
        await bridge.requestScreenRecording(); // OS consent (also registers Kairo in the list)
        await bridge.openPermissionSettings('screenRecording');
        if (cancelled) return;
        void speak(act3ScreenRestartLine);
        // Sticky guidance while they toggle it (stays until the reopen / grant).
        await setCoachCaption(bridge, {
          title: 'Screen Recording',
          detail: 'Flip Kairo Tutor on in the list — macOS will pop up to reopen me, that’s normal.'
        });
      } else {
        // Register Kairo in the AX list (so a toggle exists) + open the pane.
        await bridge.requestAccessibility();
        await bridge.openPermissionSettings('accessibility');
        const settled = await waitForSettings(bridge);
        if (cancelled) return;
        if (!settled) {
          await setCoachCaption(bridge, {
            title: 'Accessibility',
            detail: 'Flip Kairo Tutor on so I can steer the pointer.'
          });
          return;
        }
        // Buy time + hold attention: play a short filler line WHILE the vision call finds the
        // toggle in the background, then reveal the point after a beat (§Act 3b). This masks the
        // ~2-4s vision latency so the pet's point feels instant + intentional.
        await setCoachCaption(bridge, { title: 'Kairo', detail: '' }); // loading pulse
        const finding = findAccessibilityToggle(bridge); // background — do NOT await yet
        if (!spoke.current.access) {
          spoke.current.access = true;
          await speak(act3AccessFillerLine); // "Alright, let me find that switch — one sec."
        }
        const { located, reveal } = await finding;
        if (cancelled) return;
        await delay(1000); // a beat, so the point doesn't collide with the filler line
        if (located) {
          void speak(act3AccessLine); // "One more — Accessibility… watch, I'll point right at it."
          await reveal(); // NOW the pet flies to + points at the real toggle
          await setCoachCaption(bridge, ACT3_COACH.accessibility);
        } else {
          await setCoachCaption(bridge, {
            title: 'Accessibility',
            detail: "Flip Kairo Tutor on — it's the switch right next to my name."
          });
        }
      }
    })().catch((e) =>
      klog('onboarding', 'error', 'act3 sub-step failed', { sub, error: String(e) })
    );
    return () => {
      cancelled = true;
    };
  }, [sub, bridge, speak]);

  // Clear any pet highlight when we leave a sub-step / unmount.
  useEffect(() => () => void releaseVisualTargets(bridge), [bridge]);

  return null; // all guidance is the sticky notch caption; System Settings shows through
  return null; // caption lives in the notch; the real desktop / System Settings shows through
}
