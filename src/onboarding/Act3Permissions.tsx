import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { klog } from '../core/logger';
import { createNativeBridge } from '../native/nativeBridge';
import { DEFAULT_ACCENT, getAccent } from '../core/accent';
import { useVoice } from './useVoice';
import type { Segment } from './copy';
import { ACT3_COACH, act3ScreenLine, act3AccessLine } from './copy';
import { setCoachCaption } from './coachSurface';
import { nextPermissionStep, type Act3SubStep } from './act3SubStep';
import { pointAtAccessibilityToggle } from './demoController';
import { releaseVisualTargets } from '../overlay/targetRouting';
import { PermissionBridge } from './PermissionBridge';
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
  const speak = useCallback((segs: Segment[]) => voice.speak(segs, name), [voice, name]);

  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [sub, setSub] = useState<Act3SubStep | null>(null);
  const [showBridge, setShowBridge] = useState<null | 'screen' | 'accessibility'>(null);
  const spoke = useRef<Record<string, boolean>>({});
  const advanced = useRef(false);

  useEffect(() => {
    void getAccent().then(setAccent);
  }, []);

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

  // Drive the current sub-step's priming + prompt + bridge / vision-point (runs once per sub-step).
  useEffect(() => {
    if (!sub || sub === 'done') return;
    let cancelled = false;
    setShowBridge(null);
    void (async () => {
      if (sub === 'screen') {
        await setCoachCaption(bridge, ACT3_COACH.screen);
        if (!spoke.current.screen) {
          spoke.current.screen = true;
          await speak(act3ScreenLine);
        }
        await bridge.requestScreenRecording(); // one OS prompt, screen only
        await bridge.openPermissionSettings('screenRecording');
        if (!cancelled) setShowBridge('screen'); // arrow + Open + Restart
      } else {
        await setCoachCaption(bridge, ACT3_COACH.accessibility);
        await bridge.requestAccessibility(); // registers Kairo → the toggle exists
        await bridge.openPermissionSettings('accessibility');
        const settled = await waitForSettings(bridge);
        if (cancelled) return;
        if (!spoke.current.access) {
          spoke.current.access = true;
          void speak(act3AccessLine);
        }
        if (settled) {
          const { located } = await pointAtAccessibilityToggle(bridge);
          if (!cancelled && !located) setShowBridge('accessibility'); // vision missed → arrow fallback
        } else {
          setShowBridge('accessibility'); // never reached settings → arrow fallback
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

  if (showBridge) {
    return <PermissionBridge permission={showBridge} accent={accent} />;
  }
  return null; // caption lives in the notch; the real desktop / System Settings shows through
}
