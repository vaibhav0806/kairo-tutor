import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { klog } from '../core/logger';
import { useCoach } from './useCoach';
import {
  act3ScreenLine,
  act3ScreenGrantLine,
  act3AccessIntroLine,
  act3AccessGrantLine
} from './copy';
import { nextPermissionStep, type Act3SubStep } from './act3SubStep';
import type { ActProps } from './acts/actTypes';

// Act 3 — "Earn the Eyes". Two permission moments (Screen Recording, then Accessibility). Each one:
// say the WHY → fire the ONE native OS prompt → say the do-it-now line. The OS prompt is doing double
// duty: it registers Kairo in the Settings list AND is the gateway to the toggle (its own "Open
// System Settings" button opens the exact pane). So we deliberately do NOT open System Settings
// ourselves — that just stacked a second, confusing window on top of the prompt. One prompt per
// permission, no duplicates, no pet-pointing theatre (the toggle is self-evident). Status-driven, so
// it's idempotent across the Screen-Recording quit+reopen.
export function Act3Permissions({ name, onAdvance }: ActProps) {
  const { say, bridge } = useCoach(name);
  const [sub, setSub] = useState<Act3SubStep | null>(null);
  const spoke = useRef<Record<string, boolean>>({});
  const advanced = useRef(false);

  // Persist the resume marker: granting Screen Recording forces a macOS quit+reopen, and the
  // orchestrator resumes to whatever the marker says (mapped in OnboardingApp).
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
          void bridge.closeSettings(); // clean stage: quit System Settings → only desktop + Kairo
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

  // Drive the current sub-step's script (runs once per sub-step). Read it top-to-bottom; the caption
  // always matches the spoken line.
  useEffect(() => {
    if (!sub) return;
    let cancelled = false;
    const stop = () => cancelled;

    void (async () => {
      if (sub === 'screen') {
        if (spoke.current.screen) return;
        spoke.current.screen = true;
        await say(act3ScreenLine); // WHY
        if (stop()) return;
        // Register Kairo in the list (fire-and-forget prompt) THEN open Settings — the reliable path
        // to the toggle, since the OS prompt only ever fires once per install.
        await bridge.requestScreenRecording();
        await bridge.openPermissionSettings('screenRecording');
        if (stop()) return;
        await say(act3ScreenGrantLine); // do-it-now (references the Settings list + the restart)
        return;
      }

      // sub === 'accessibility'
      if (spoke.current.access) return;
      spoke.current.access = true;
      await say(act3AccessIntroLine); // WHY (context first — no surprise)
      if (stop()) return;
      await bridge.requestAccessibility(); // registers Kairo in the AX list
      await bridge.openPermissionSettings('accessibility'); // reliable path to the toggle
      if (stop()) return;
      await say(act3AccessGrantLine); // do-it-now (references the Settings list + the toggle)
    })().catch((e) =>
      klog('onboarding', 'error', 'act3 sub-step failed', { sub, error: String(e) })
    );

    return () => {
      cancelled = true;
    };
  }, [sub, bridge, say]);

  return null; // guidance is the notch caption; the OS prompt + System Settings show through
}
