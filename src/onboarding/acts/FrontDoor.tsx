import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { DEFAULT_ACCENT, applyAccent, clampAccent, getAccent } from '../../core/accent';
import { klog } from '../../core/logger';
import { playChime, playSound } from '../../core/sound';
import { useCoach } from '../useCoach';
import { ACT_LINES, HERO_COPY } from '../copy';
import { ColorWheel } from './ColorWheel';
import { heroDemoSrc } from '../heroDemo';

// The "front door" — the split card that greets the user (v2 Phase C, framer-motion revision). ONE
// persistent card frame + right-hand demo; only the LEFT panel morphs from the hero pitch → the color
// picker (so the card never reshapes between steps — founder feedback). On color-confirm the whole card
// COLLAPSES into the pet (a real framer-motion implosion, not a CSS hard-cut) as the seam into the
// windowless flow. Merges the old Act0Hero + Act1Arrival into one component so the frame can persist.
//
// AUDIO-UNLOCK GOTCHA: the hero is the first screen, before any gesture, so it's SILENT. The first cue
// (playSound('morph')) rides the "Get started" CLICK, which also unlocks the shared AudioContext.
export function FrontDoor({ onComplete }: { onComplete: () => void }) {
  const { say, clear } = useCoach('');
  const [phase, setPhase] = useState<'hero' | 'color'>('hero');
  const [hex, setHex] = useState<string>(DEFAULT_ACCENT);
  // Non-null once the card is imploding toward the pet; holds the translate delta (card center → pet).
  const [collapse, setCollapse] = useState<{ dx: number; dy: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    void getAccent().then(setHex);
    klog('onboarding', 'info', 'front door: hero shown');
  }, []);

  // Speak the color line when we enter the color phase (caption == voice via useCoach.say).
  useEffect(() => {
    if (phase !== 'color') return;
    void say([ACT_LINES.act1_color]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const goColor = () => {
    if (phase !== 'hero') return;
    klog('onboarding', 'info', 'hero get-started');
    playSound('morph'); // user gesture → unlocks the shared AudioContext + whoosh cue
    setPhase('color');
  };

  // Live recolor on every wheel move: paints this window instantly + the emitted accent:changed reaches
  // the pet glow / notch caption / progress dots + the highlight box.
  const onWheel = useCallback((next: string) => {
    setHex(next);
    applyAccent(next);
    void emit('accent:changed', { hex: next });
  }, []);

  const confirm = useCallback(
    async (e: MouseEvent<HTMLButtonElement>) => {
      // Capture the click point synchronously (before any await) — the pet shadows the mouse, so it's
      // on the button; the full-monitor window means clientX/Y are screen coords.
      const point = { x: e.clientX, y: e.clientY };
      const clamped = clampAccent(hex);
      klog('onboarding', 'info', 'front door: color confirmed', { picked: hex, clamped });
      applyAccent(clamped);
      void emit('accent:changed', { hex: clamped });
      await invoke('set_accent', { hex: clamped }).catch(() => {}); // persist natively
      playChime('confirm'); // satisfying two-note rise on lock-in
      // Kick off the collapse: the pet wakes to "catch" the card, and framer-motion implodes it toward
      // the click point. onCollapseDone (onAnimationComplete) drives the rest.
      const rect = cardRef.current?.getBoundingClientRect();
      const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      void emit('cursor:entrance');
      setCollapse({ dx: point.x - cx, dy: point.y - cy });
    },
    [hex]
  );

  // Fired when the framer-motion card animation finishes. Only acts on the COLLAPSE (not the entrance):
  // settle cue, the pet-is-alive wake line on the real desktop, then advance to Act 2.
  const onCardAnimationComplete = useCallback(async () => {
    if (!collapse) return;
    playSound('settle');
    await say([ACT_LINES.act1_wake], { onStart: () => void emit('cursor:celebrate') });
    await clear();
    onComplete();
  }, [collapse, say, clear, onComplete]);

  return (
    <>
      <div className="ob-vignette" aria-hidden />
      <motion.div
        ref={cardRef}
        className="ob-card ob-card--hero"
        initial={reduce ? false : { opacity: 0, y: 10, scale: 0.97 }}
        animate={
          collapse
            ? { x: collapse.dx, y: collapse.dy, scale: 0.02, opacity: 0 }
            : { x: 0, y: 0, scale: 1, opacity: 1 }
        }
        transition={
          collapse
            ? { type: 'tween', ease: [0.4, 0, 1, 1], duration: reduce ? 0 : 0.5 }
            : { type: 'spring', stiffness: 260, damping: 26 }
        }
        onAnimationComplete={() => void onCardAnimationComplete()}
      >
        <div className="ob-hero-left">
          <AnimatePresence mode="wait" initial={false}>
            {phase === 'hero' ? (
              <motion.div
                key="hero"
                className="ob-front-hero"
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduce ? undefined : { opacity: 0, x: -14, filter: 'blur(4px)' }}
                transition={{ duration: 0.2 }}
              >
                {/* LOGO SLOT — the real Kairo logo drops in here (an <img>/inline SVG) beside or in
                    place of the wordmark once the team ships it. */}
                <div className="ob-hero-mark">{HERO_COPY.wordmark}</div>
                <h1 className="ob-hero-h1">{HERO_COPY.h1}</h1>
                <p className="ob-hero-sub">{HERO_COPY.sub}</p>
                <button type="button" className="ob-hero-cta" onClick={goColor}>
                  {HERO_COPY.cta}
                </button>
                <p className="ob-hero-legal">{HERO_COPY.legal}</p>
              </motion.div>
            ) : (
              <motion.div
                key="color"
                className="ob-front-color"
                initial={reduce ? false : { opacity: 0, x: 14, filter: 'blur(4px)' }}
                animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                transition={{ duration: 0.28 }}
              >
                <div className="ob-color-head">
                  <span className="ob-color-dot" style={{ background: hex }} aria-hidden />
                  <span className="ob-color-kicker">your color</span>
                </div>
                <ColorWheel value={hex} onChange={onWheel} size={236} />
                <button type="button" className="ob-color-confirm" onClick={(e) => void confirm(e)}>
                  {HERO_COPY.confirm}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="ob-hero-right">
          {/* Depth layer: the same demo frame, blurred + scaled up, behind the crisp one. */}
          <div className="ob-hero-backdrop" aria-hidden>
            <HeroDemoInner />
          </div>
          <div className="ob-hero-demo">
            <HeroDemoInner />
            <div className="ob-hero-value">{HERO_COPY.value}</div>
          </div>
        </div>
      </motion.div>
    </>
  );
}

// The looping demo: the real curated GIF once it lands (heroDemoSrc), else the pure-CSS mock so the
// layout is fully testable with zero image asset. Both the crisp foreground and the blurred backdrop
// render this, so swapping in the GIF fills both.
function HeroDemoInner() {
  return heroDemoSrc ? (
    <img className="ob-hero-demo-media" src={heroDemoSrc} alt="" />
  ) : (
    <HeroDemoMock />
  );
}

// Pure-CSS stand-in for the hero demo: a faux app window with an accent "pet" glyph that drifts to a
// target on a loop. Decorative only; the real GIF replaces it via heroDemo.ts.
function HeroDemoMock() {
  return (
    <div className="ob-hero-mock" aria-hidden>
      <div className="ob-hero-mock-window">
        <div className="ob-hero-mock-bar">
          <span />
          <span />
          <span />
        </div>
        <div className="ob-hero-mock-body">
          <div className="ob-hero-mock-target" />
          <div className="ob-hero-mock-pet" />
        </div>
      </div>
    </div>
  );
}
