import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { createNativeBridge } from '../../native/nativeBridge';
import { DEFAULT_ACCENT, applyAccent, clampAccent, getAccent } from '../../core/accent'; // Phase 0 + 7
import { klog } from '../../core/logger';
import { playChime } from '../../core/sound';
import { useVoice } from '../useVoice';
import { ACT_LINES } from '../copy';
import { clearCoachCaption, coachSay } from '../coachSurface';
import { TempPanel } from './TempPanel';
import { ColorWheel } from './ColorWheel';
import type { ActProps } from './actTypes';

// Act 1 — Arrival + Color (master spec §4). The pet wakes (Phase 2 entrance), then the user picks
// Kairo's color on a full HSV wheel with LIVE theming across every surface.
export function Act1Arrival({ name, onAdvance }: ActProps) {
  const bridge = useMemo(() => createNativeBridge(), []);
  const voice = useVoice();
  const [phase, setPhase] = useState<'wake' | 'color'>('wake');
  // The wheel panel appears only when the color line's audio starts — so panel + caption + voice
  // all land at the same instant (perfectly synced), never text-then-voice.
  const [colorReady, setColorReady] = useState(false);
  const [hex, setHex] = useState<string>(DEFAULT_ACCENT);

  // Load the current accent as the wheel's starting value (getAccent is async in Phase 0).
  useEffect(() => {
    void getAccent().then(setHex);
  }, []);

  // 1a — the wake-up: pet entrance (Phase 2) + coach caption, then auto-advance to color.
  useEffect(() => {
    klog('onboarding', 'info', 'act1 wake');
    void emit('cursor:entrance'); // Phase 2 signature entrance (pet)
    void coachSay(bridge, voice.speak, [ACT_LINES.act1_wake], name, {
      title: 'Kairo',
      onReady: () => playChime('entrance') // warm tone in sync with the wake voice (audio unlocked)
    }).then(() => setPhase('color'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1b — give me a color: the wheel panel reveals in sync with the caption + voice (onReady).
  useEffect(() => {
    if (phase !== 'color') return;
    void coachSay(bridge, voice.speak, [ACT_LINES.act1_color], name, {
      title: 'Kairo',
      onReady: () => setColorReady(true)
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Live recolor: applyAccent paints THIS window's --kairo-accent vars instantly, and the emitted
  // accent:changed reaches the other webviews (pet glow / notch caption) so everything recolors
  // together in real time (Phase 0 + §5). No file write per move — set_accent persists on confirm.
  const onWheel = useCallback((next: string) => {
    setHex(next);
    applyAccent(next);
    void emit('accent:changed', { hex: next });
  }, []);

  const confirm = useCallback(async () => {
    // Clamp the picked hue into a legible band so an extreme pick can never vanish (§5).
    const clamped = clampAccent(hex);
    klog('onboarding', 'info', 'act1 color confirmed', { picked: hex, clamped });
    playChime('confirm'); // satisfying two-note rise on lock-in
    applyAccent(clamped);
    void emit('accent:changed', { hex: clamped });
    await invoke('set_accent', { hex: clamped }).catch(() => {}); // Phase 0: persist natively
    await clearCoachCaption(bridge);
    onAdvance();
  }, [hex, bridge, onAdvance]);

  return (
    <>
      <div className="ob-vignette" aria-hidden />
      {phase === 'color' && colorReady && (
        <TempPanel>
          <div className="ob-color">
            {/* The spoken notch caption carries the instruction — the card stays minimal (just a
                live swatch + a small kicker) so the words aren't said twice. */}
            <div className="ob-color-head">
              <span className="ob-color-dot" style={{ background: hex }} aria-hidden />
              <span className="ob-color-kicker">your color</span>
            </div>
            <ColorWheel value={hex} onChange={onWheel} />
            <button type="button" className="ob-color-confirm" onClick={() => void confirm()}>
              That&apos;s the one
            </button>
          </div>
        </TempPanel>
      )}
    </>
  );
}
