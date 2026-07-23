import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { klog } from '../../core/logger';
import { useCoach } from '../useCoach';
import { act3ScreenLine, act3AccessLine } from '../copy';
import { nextPermissionStep, type Act3SubStep } from './act3SubStep';
import type { ActProps } from './actTypes';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// How far into the spoken line to fire the OS pop-up. The instruction is front-loaded in the copy, so
// the box appears while the user is still hearing the why — they can act immediately, not after ~15s.
const BOX_DELAY_MS = 2500;

// Act 3 — "Earn the Eyes". Two permission moments (Screen Recording, then Accessibility). Each: start
// the spoken line, then fire the ONE native OS prompt ~2.5s in. The prompt does double duty — it
// registers Kairo in the Settings list AND is the gateway to the toggle (its own "Open System
// Settings" button). We deliberately do NOT open System Settings ourselves. Status-driven, so it's
// idempotent across the Screen-Recording quit+reopen.
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
        // Start the line (caption paints now, while Kairo is foreground → no stale notch), then fire
        // the OS pop-up ~2.5s in — the instruction is front-loaded, so the user can start acting
        // without sitting through the whole line. Prompt-only: the pop-up's own "Open System
        // Settings" button is the single path; we never open System Settings ourselves.
        void say(act3ScreenLine);
        await delay(BOX_DELAY_MS);
        if (stop()) return;
        await bridge.requestScreenRecording(); // the OS pop-up (the only window)
        return;
      }

      // sub === 'accessibility' — same shape: start the line, pop the box 2.5s in.
      if (spoke.current.access) return;
      spoke.current.access = true;
      void say(act3AccessLine);
      await delay(BOX_DELAY_MS);
      if (stop()) return;
      await bridge.requestAccessibility(); // the OS pop-up (the only window)
    })().catch((e) =>
      klog('onboarding', 'error', 'act3 sub-step failed', { sub, error: String(e) })
    );

    return () => {
      cancelled = true;
    };
  }, [sub, bridge, say]);

  return null; // guidance is the notch caption; the OS prompt + System Settings show through
}
