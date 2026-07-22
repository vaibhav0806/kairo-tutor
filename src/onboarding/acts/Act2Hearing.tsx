import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { createNativeBridge } from '../../native/nativeBridge';
import { klog } from '../../core/logger';
import { playRecordingCue } from '../../core/sound';
import { useVoice } from '../useVoice';
import { ACT_LINES, ACT2_CHIP } from '../copy';
import { setCoachCaption, clearCoachCaption, coachSay } from '../coachSurface';
import { runTalkTurn } from '../demoController';
import type { ActProps } from './actTypes';

// Act 2 — "Can you hear me?" (master spec §4). Primes Mic + Input Monitoring (NOT Screen
// Recording), then the hold-⌥⌃-say-hi drill: the chord is the ONLY Next. Renders null — the coach
// caption in the real notch + the live pet halo are the whole UI.
export function Act2Hearing({ name, onAdvance }: ActProps) {
  const bridge = useMemo(() => createNativeBridge(), []);
  const voice = useVoice();
  const [phase, setPhase] = useState<'primer' | 'drill'>('primer');
  const recordingRef = useRef(false);
  const doneRef = useRef(false);

  const handleAudio = useCallback(
    async (audioBase64: string) => {
      // Empty audio / too-short tap: nudge, stay on the drill (never blocks).
      if (!audioBase64) {
        await coachSay(bridge, voice.speak, [ACT_LINES.act2_short], name, {
          title: 'Kairo',
          chip: ACT2_CHIP
        });
        return;
      }
      await setCoachCaption(bridge, { title: 'Thinking…', detail: 'One sec…' });
      let transcriptLen = 0;
      try {
        ({ transcriptLen } = await runTalkTurn(bridge, audioBase64, name, {
          onThinking: () => void setCoachCaption(bridge, { title: 'Thinking…', detail: 'One sec…' }),
          onSpeaking: () => void emit('cursor:speaking')
        }));
      } catch (error) {
        klog('onboarding', 'error', 'act2 talk turn failed', { error: String(error) });
      }
      if (transcriptLen === 0) {
        // heard nothing — retry
        await coachSay(bridge, voice.speak, [ACT_LINES.act2_empty], name, {
          title: 'Kairo',
          chip: ACT2_CHIP
        });
        return;
      }
      doneRef.current = true; // one successful reply → advance
      void emit('cursor:celebrate'); // Phase 2 subtle celebration
      klog('onboarding', 'info', 'act2 first wow');
      await new Promise((r) => setTimeout(r, 900));
      await clearCoachCaption(bridge);
      onAdvance();
    },
    [bridge, name, voice.speak, onAdvance]
  );

  // 2a — primer, ONE permission at a time (spec: mic FIRST, wait until it's actually granted, THEN
  // open Input Monitoring + ask). Reliable step detection = poll the live grant, never advance until
  // it's really on. Never asks for Screen Recording (that's Act 3).
  useEffect(() => {
    if (phase !== 'primer') return;
    let cancelled = false;
    const isCancelled = () => cancelled;

    // Poll a grant predicate until it's true (or we leave the step). ~1s cadence.
    const waitUntil = (check: () => Promise<boolean>) =>
      new Promise<void>((resolve) => {
        const tick = async () => {
          if (cancelled) return resolve();
          if (await check()) return resolve();
          if (!cancelled) setTimeout(() => void tick(), 1000);
        };
        void tick();
      });
    const micGranted = async () => (await bridge.getPermissionStatus()).microphone === 'granted';
    const imGranted = async () => (await bridge.getInputMonitoringStatus()) === 'granted';

    void (async () => {
      // STEP 1 — microphone only. Ask, then WAIT until it's genuinely granted before moving on.
      if (!(await micGranted())) {
        await coachSay(bridge, voice.speak, [ACT_LINES.act2_mic], name, { title: 'Kairo' });
        if (isCancelled()) return;
        await bridge.requestMicrophone(); // mic-only OS prompt
        // Leave the SPOKEN mic line up while we wait (no unspoken "waiting…" text — mandate §).
        await waitUntil(micGranted);
        if (isCancelled()) return;
        klog('onboarding', 'info', 'act2 mic granted');
      }

      // STEP 2 — input monitoring, only AFTER mic is done. Speak, open the pane, request, start the
      // tap, then wait until it's flipped on.
      if (!(await imGranted())) {
        // 'inputMonitoring' isn't a typed NativePermissionKey — raw invoke (native accepts it).
        await invoke('open_permission_settings', { permission: 'inputMonitoring' }).catch(() => {});
        await coachSay(bridge, voice.speak, [ACT_LINES.act2_im], name, { title: 'Kairo' }); // …then explain
        if (isCancelled()) return;
        await bridge.requestInputMonitoring(); // registers Kairo + shows the keystroke prompt
        await bridge.startPtt(); // creates the ⌥⌃ tap (retries until granted)
        // Leave the SPOKEN act2_im line up ("…flip me on in that list") while we wait — no separate
        // unspoken caption (that was the text that "wasn't said").
        await waitUntil(imGranted);
        if (isCancelled()) return;
        klog('onboarding', 'info', 'act2 input-monitoring granted');
      } else {
        await bridge.startPtt();
      }

      if (!cancelled) setPhase('drill');
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // 2b — the say-hi drill (first wow). Chord is the ONLY Next.
  useEffect(() => {
    if (phase !== 'drill') return;
    doneRef.current = false;
    void invoke('set_onboarding_ptt', { active: true }).catch(() => {});
    void coachSay(bridge, voice.speak, [ACT_LINES.act2_drill], name, {
      title: 'Kairo',
      chip: ACT2_CHIP
    });

    const uns: Array<() => void> = [];
    // ⌥⌃ hold edge (recording-truth). Native already drives the pet halo (cursor:listening/level).
    void listen<{ active?: boolean }>('onboarding:ptt', (e) => {
      const active = Boolean(e.payload?.active);
      recordingRef.current = active;
      playRecordingCue(active);
      if (active)
        void setCoachCaption(bridge, {
          title: 'Listening…',
          detail: 'Say hi — I hear you.',
          chip: ACT2_CHIP
        });
    }).then((u) => uns.push(u));

    // Recorded WAV on release → run the real talk turn (reuses demoController).
    void listen<{ audioBase64: string }>('onboarding:audio', (e) => {
      if (doneRef.current) return;
      void handleAudio(e.payload.audioBase64);
    }).then((u) => uns.push(u));

    return () => {
      void invoke('set_onboarding_ptt', { active: false }).catch(() => {});
      uns.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  return null; // out of the card — the coach caption + the pet are the whole UI
}
