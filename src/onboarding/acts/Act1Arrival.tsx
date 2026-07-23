import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { DEFAULT_ACCENT, applyAccent, clampAccent, getAccent } from '../../core/accent';
import { klog } from '../../core/logger';
import { playChime, playSound } from '../../core/sound';
import { prefersReducedMotion } from '../../core/reducedMotion';
import { useCoach } from '../useCoach';
import { ACT_LINES, HERO_COPY } from '../copy';
import { ColorWheel } from './ColorWheel';
import type { ActProps } from './actTypes';

// Act 1 — Color (v2 Phase C). The hero (Act 0) morphs INTO this card, so it's the light `.ob-card`
// shell (light→light, seamless). The user picks Kairo's color on a full HSV wheel with LIVE theming
// across every surface, then confirms — and the whole card COLLAPSES into the pet as the seam into the
// windowless flow. The old "wake" beat moved to that collapse, where the pet actually comes alive on
// the real desktop (a stronger moment than a pre-color line).
export function Act1Arrival({ name, onAdvance }: ActProps) {
  const { say, clear } = useCoach(name);
  const [hex, setHex] = useState<string>(DEFAULT_ACCENT);
  // Non-null while the card is imploding toward the pet; holds the translate delta (card center → pet).
  const [collapse, setCollapse] = useState<{ dx: number; dy: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Load the current accent as the wheel's starting value (getAccent is async in Phase 0).
  useEffect(() => {
    void getAccent().then(setHex);
  }, []);

  // The color card is the ONLY phase now. Speak the color line as the card morphs in; the panel reveals
  // on MOUNT (not gated on audio-start anymore) so the hero→color morph is continuous with no blank
  // frame. Caption↔voice sync is still guaranteed by useCoach.say (the caption lands with the voice).
  useEffect(() => {
    klog('onboarding', 'info', 'act1 color shown');
    void say([ACT_LINES.act1_color]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live recolor on every wheel move: applyAccent paints this window's vars instantly, and the emitted
  // accent:changed reaches the other webviews (pet glow / notch caption) + the in-card preview.
  const onWheel = useCallback((next: string) => {
    setHex(next);
    applyAccent(next);
    void emit('accent:changed', { hex: next });
  }, []);

  // Collapse the whole card INTO the pet. The pet shadows the mouse, so at confirm it's on the button —
  // we implode toward the click point (the full-monitor onboarding window means clientX/Y ARE screen
  // coords). The pet wakes to "catch" it. Reduced-motion → a plain fade. Resolves when the settle lands.
  const runCollapse = useCallback(
    (pt: { x: number; y: number }) =>
      new Promise<void>((resolve) => {
        void emit('cursor:entrance'); // the pet wakes up to catch the card
        if (prefersReducedMotion()) {
          playSound('settle');
          window.setTimeout(resolve, 160);
          return;
        }
        const rect = cardRef.current?.getBoundingClientRect();
        const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
        const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
        klog('onboarding', 'info', 'window→pet collapse', { x: Math.round(pt.x), y: Math.round(pt.y) });
        setCollapse({ dx: pt.x - cx, dy: pt.y - cy });
        window.setTimeout(() => {
          playSound('settle'); // soft landing as it catches
          resolve();
        }, 360);
      }),
    []
  );

  const confirm = useCallback(
    async (e: MouseEvent<HTMLButtonElement>) => {
      // Capture the click point synchronously (before any await) for the collapse target.
      const point = { x: e.clientX, y: e.clientY };
      // Clamp the picked hue into a legible band so an extreme pick can never vanish (§5).
      const clamped = clampAccent(hex);
      klog('onboarding', 'info', 'act1 color confirmed', { picked: hex, clamped });
      applyAccent(clamped);
      void emit('accent:changed', { hex: clamped });
      await invoke('set_accent', { hex: clamped }).catch(() => {}); // persist natively
      playChime('confirm'); // satisfying two-note rise on lock-in
      await runCollapse(point);
      // The pet is now alive on the real desktop → the wake line, with the celebrate pop welded to its
      // start. "Hey — I'm Kairo. See that notch… that's where I live!"
      await say([ACT_LINES.act1_wake], { onStart: () => void emit('cursor:celebrate') });
      await clear();
      onAdvance();
    },
    [hex, clear, onAdvance, runCollapse, say]
  );

  const collapseStyle: CSSProperties | undefined = collapse
    ? ({ ['--collapse-x']: `${collapse.dx}px`, ['--collapse-y']: `${collapse.dy}px` } as CSSProperties)
    : undefined;

  return (
    <>
      <div className="ob-vignette" aria-hidden />
      <div
        ref={cardRef}
        className={`ob-card ob-card--color ob-morph-in${collapse ? ' ob-collapsing' : ''}`}
        style={collapseStyle}
      >
        {/* The spoken notch caption carries the instruction — the card stays minimal (a live swatch +
            a small kicker) so the words aren't said twice. */}
        <div className="ob-color-head">
          <span className="ob-color-dot" style={{ background: hex }} aria-hidden />
          <span className="ob-color-kicker">your color</span>
        </div>
        <ColorWheel value={hex} onChange={onWheel} size={248} />
        <button type="button" className="ob-color-confirm" onClick={(e) => void confirm(e)}>
          {HERO_COPY.confirm}
        </button>
      </div>
    </>
  );
}
