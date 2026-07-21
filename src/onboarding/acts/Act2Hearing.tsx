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

  // 2a — primer: benefit copy in Kairo's voice, then fire Mic + Input-Monitoring (NOT Screen
  // Recording — that's Act 3). Poll both; if already granted (returning user), skip to the drill.
  useEffect(() => {
    if (phase !== 'primer') return;
    let cancelled = false;
    void (async () => {
      await coachSay(bridge, voice.speak, [ACT_LINES.act2_primer], name, { title: 'Kairo' });
      const mic = await bridge.requestMicrophone(); // mic-only OS prompt
      await bridge.requestInputMonitoring(); // input-monitoring prompt + Settings listing
      klog('onboarding', 'info', 'act2 primer', { mic: mic.microphone });
    })();
    const iv = setInterval(() => {
      void (async () => {
        const [status, im] = await Promise.all([
          bridge.getPermissionStatus(),
          bridge.getInputMonitoringStatus()
        ]);
        if (cancelled) return;
        if (status.microphone === 'granted' && im === 'granted') {
          clearInterval(iv);
          setPhase('drill');
        } else if (im !== 'granted') {
          // Input Monitoring usually needs a manual toggle — bridge the user to the pane.
          void invoke('open_permission_settings', { permission: 'inputMonitoring' }).catch(() => {});
        }
      })();
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(iv);
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
