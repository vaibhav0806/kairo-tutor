import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { klog } from '../../core/logger';
import { playRecordingCue } from '../../core/sound';
import { useCoach } from '../useCoach';
import { ACT_LINES, ACT2_CHIP } from '../copy';
import { runTalkTurn } from '../demoController';
import type { ActProps } from './actTypes';

// Act 2 — "Can you hear me?" (master spec §4). Primes the mic (Screen Recording + Input Monitoring
// are NOT needed here — the ⌥⌃ tap watches modifier keys only, which are exempt), then the
// hold-⌥⌃-say-hi drill: the chord is the ONLY Next. Renders null — the notch caption + the live pet
// halo are the whole UI.
export function Act2Hearing({ name, onAdvance }: ActProps) {
  const { say, thinking, caption, guide, clear, voice, bridge } = useCoach(name);
  const [phase, setPhase] = useState<'primer' | 'drill'>('primer');
  const recordingRef = useRef(false);
  const doneRef = useRef(false);

  const handleAudio = useCallback(
    async (audioBase64: string) => {
      // Empty audio / too-short tap: nudge, stay on the drill (never blocks).
      if (!audioBase64) {
        await say([ACT_LINES.act2_short], { chip: ACT2_CHIP });
        return;
      }
      // Loading pulse while we transcribe + think — no unspoken "Thinking…" text.
      await thinking();
      let transcriptLen = 0;
      try {
        ({ transcriptLen } = await runTalkTurn(bridge, audioBase64, name, {
          onThinking: () => void thinking(),
          onSpeaking: () => void emit('cursor:speaking'),
          // Show Kairo's reply in the notch, in sync with its voice.
          onReply: (reply) => void caption(reply)
        }));
      } catch (error) {
        klog('onboarding', 'error', 'act2 talk turn failed', { error: String(error) });
      }
      if (transcriptLen === 0) {
        // heard nothing — retry
        await say([ACT_LINES.act2_empty], { chip: ACT2_CHIP });
        return;
      }
      doneRef.current = true; // one successful reply → advance
      void emit('cursor:celebrate'); // Phase 2 subtle celebration
      klog('onboarding', 'info', 'act2 first wow');
      await new Promise((r) => setTimeout(r, 900));
      await clear();
      onAdvance();
    },
    [bridge, say, thinking, caption, clear, onAdvance]
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

    void (async () => {
      // STEP 1 — microphone only. Ask, then WAIT until it's genuinely granted before moving on.
      if (!(await micGranted())) {
        await say([ACT_LINES.act2_mic]);
        if (isCancelled()) return;
        await bridge.requestMicrophone(); // mic-only OS prompt
        // Leave the SPOKEN mic line up while we wait (no unspoken "waiting…" text — mandate §).
        await waitUntil(micGranted);
        if (isCancelled()) return;
        klog('onboarding', 'info', 'act2 mic granted');
      }

      // STEP 2 — start the ⌥⌃ tap and go. The push-to-talk tap only watches MODIFIER keys
      // (FlagsChanged), which are EXEMPT from Input Monitoring — the tap goes live without that
      // grant (verified in the logs). So we do NOT ask for Input Monitoring here: no extra prompt,
      // no "flip me on" dead-end, no blocking on a permission the drill doesn't need.
      await bridge.startPtt();
      if (isCancelled()) return;
      klog('onboarding', 'info', 'act2 → drill (ptt tap started; input monitoring not required)');
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
    void say([ACT_LINES.act2_drill], { chip: ACT2_CHIP });

    const uns: Array<() => void> = [];
    // ⌥⌃ hold edge (recording-truth). Native already drives the pet halo (cursor:listening/level).
    void listen<{ active?: boolean }>('onboarding:ptt', (e) => {
      const active = Boolean(e.payload?.active);
      recordingRef.current = active;
      playRecordingCue(active);
      if (active) {
        voice.stop(); // grabbed the chord mid-line → cut Kairo off so it isn't talking over them
        // Silent sticky nudge while they hold — no spoken line, so `guide` (not `say`).
        void guide('Listening…', 'Say hi — I hear you.', ACT2_CHIP);
      }
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
