import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { DEFAULT_ACCENT, applyAccent, clampAccent, getAccent } from '../../core/accent';
import { klog } from '../../core/logger';
import { SignInPanel } from './SignInPanel';
import { playChime, playSound } from '../../core/sound';
import { useCoach } from '../useCoach';
import { ACT_LINES, HERO_COPY } from '../copy';
import { ACCENT_PRESETS } from '../accentPresets';
import blenderShot from '../../assets/onboarding/blender-viewport.webp';
import { KairoLockup, KairoMark } from '../../components/KairoMark';
import { DraggableSurface } from './DraggableSurface';

// The fixed hero violet (landing accent). Act 0 shows BEFORE the color step, so the hero is
// deliberately decoupled from the user's chosen accent — it always reads in this violet.
const HERO_VIOLET = '#665cff';
// The looping demo's reply (mirrors the landing's Blender beat). Kept here so the founder can tweak.
const HERO_REPLY = 'The bevel is fine. Apply the object scale first and the shading artifact should clear.';

// Paint the top-right "corner burst" into the given <svg> once: a soft corner glow + fanned rays +
// concentric arcs (viewBox 520×460, origin = top-right corner). Purely decorative; masked to fade
// toward the tile so it never competes with the demo.
function buildHeroBurst(svg: SVGSVGElement) {
  const NS = 'http://www.w3.org/2000/svg';
  const cx = 520, cy = 0;
  const defs = document.createElementNS(NS, 'defs');
  const rg = document.createElementNS(NS, 'radialGradient');
  rg.id = 'obHeroGlow';
  rg.innerHTML =
    `<stop offset="0%" stop-color="${HERO_VIOLET}" stop-opacity="0.26"/>` +
    `<stop offset="100%" stop-color="${HERO_VIOLET}" stop-opacity="0"/>`;
  defs.appendChild(rg);
  svg.appendChild(defs);
  const glow = document.createElementNS(NS, 'circle');
  glow.setAttribute('cx', String(cx)); glow.setAttribute('cy', String(cy));
  glow.setAttribute('r', '300'); glow.setAttribute('fill', 'url(#obHeroGlow)');
  svg.appendChild(glow);
  const N = 26, L = 760;
  for (let i = 0; i < N; i++) {
    const a = (90 + i * (90 / (N - 1))) * Math.PI / 180;
    const ln = document.createElementNS(NS, 'line');
    ln.setAttribute('x1', String(cx)); ln.setAttribute('y1', String(cy));
    ln.setAttribute('x2', (cx + Math.cos(a) * L).toFixed(1));
    ln.setAttribute('y2', (cy + Math.sin(a) * L).toFixed(1));
    ln.setAttribute('stroke', HERO_VIOLET);
    ln.setAttribute('stroke-width', i % 2 ? '1.1' : '1.5');
    ln.setAttribute('stroke-opacity', i % 2 ? '0.12' : '0.2');
    svg.appendChild(ln);
  }
  [110, 190, 270, 350, 430].forEach((r, i) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy)); c.setAttribute('r', String(r));
    c.setAttribute('fill', 'none'); c.setAttribute('stroke', HERO_VIOLET);
    c.setAttribute('stroke-width', '1.3'); c.setAttribute('stroke-opacity', (0.2 - i * 0.025).toFixed(3));
    svg.appendChild(c);
  });
}

// The "front door" — the split card that greets the user (v2 Phase C, framer-motion revision). ONE
// persistent card frame + right-hand demo; only the LEFT panel morphs from the hero pitch → the color
// picker (so the card never reshapes between steps — founder feedback). On color-confirm the whole card
// COLLAPSES into the pet (a real framer-motion implosion, not a CSS hard-cut) as the seam into the
// windowless flow. Merges the old Act0Hero + Act1Arrival into one component so the frame can persist.
//
// AUDIO-UNLOCK GOTCHA: the hero is the first screen, before any gesture, so it's SILENT. The first cue
// (playSound('morph')) rides the "Get started" CLICK, which also unlocks the shared AudioContext.
export function FrontDoor({ onComplete }: { onComplete: (name: string) => void }) {
  const { say, clear } = useCoach('');
  const [phase, setPhase] = useState<'hero' | 'color' | 'signin'>('hero');
  const [hex, setHex] = useState<string>(DEFAULT_ACCENT);
  // Non-null once the card is imploding toward the pet; holds the translate delta (card center → pet).
  const [collapse, setCollapse] = useState<{ dx: number; dy: number } | null>(null);
  // Where the user last clicked, so the card implodes toward their hand rather than the screen
  // centre. Captured on the colour confirm and reused when sign-in finishes.
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const nameRef = useRef('');
  const cardRef = useRef<HTMLDivElement | null>(null);
  const cursorWakeTimerRef = useRef<number | null>(null);
  // Right-side looping demo (Blender tile → ink connector → "Kairo sees Blender" streaming note).
  const burstRef = useRef<SVGSVGElement | null>(null);
  const inkPathRef = useRef<SVGPathElement | null>(null);
  const inkOriginRef = useRef<SVGCircleElement | null>(null);
  const inkEndRef = useRef<SVGCircleElement | null>(null);
  const noteRef = useRef<HTMLElement | null>(null);
  const replyRef = useRef<HTMLParagraphElement | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    void getAccent().then(setHex);
    // Hide the pet through the hero + color steps — it's revealed at the collapse (cursor:entrance).
    void emit('cursor:suppress', {});
    klog('onboarding', 'info', 'front door: hero shown');
  }, []);

  useEffect(
    () => () => {
      if (cursorWakeTimerRef.current !== null) window.clearTimeout(cursorWakeTimerRef.current);
    },
    []
  );

  // The color step is SILENT (no spoken line) — jumping into speech before any greeting felt abrupt.
  // Kairo introduces itself LATER, at the collapse (the act1_wake line: "Hey — I'm Kairo. See that
  // notch… that's where I live!"), when the pet actually comes alive on the real desktop.
  const goColor = () => {
    if (phase !== 'hero') return;
    const startedAt = performance.now();
    klog('onboarding', 'info', 'hero get-started');
    setPhase('color');
    // Keep the audio unlock in the pointer gesture, but measure the next painted frame so this
    // interaction cannot quietly regress into another noticeable pause.
    playSound('morph');
    window.requestAnimationFrame(() => {
      klog('onboarding', 'debug', 'hero color frame painted', {
        ms: Math.round(performance.now() - startedAt)
      });
    });
  };

  // Live recolor on every wheel move: paints this window instantly + the emitted accent:changed reaches
  // the pet glow / notch caption / progress dots + the highlight box.
  const onWheel = useCallback((next: string) => {
    setHex(next);
    applyAccent(next);
    void emit('accent:changed', { hex: next });
  }, []);

  const confirm = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      // Capture the click point synchronously (before any await) — the pet shadows the mouse, so it's
      // on the button; the full-monitor window means clientX/Y are screen coords.
      const point = { x: e.clientX, y: e.clientY };
      const clamped = clampAccent(hex);
      klog('onboarding', 'info', 'front door: color confirmed', { picked: hex, clamped });
      applyAccent(clamped);
      void emit('accent:changed', { hex: clamped });
      // Persistence is local and independent; never hold the first animation frame behind IPC.
      void invoke('set_accent', { hex: clamped }).catch((error) => {
        klog('onboarding', 'warn', 'accent persistence failed', { error: String(error) });
      });
      playChime('confirm'); // satisfying two-note rise on lock-in
      // The card does NOT collapse here any more. Sign-in is the third panel of this same card, so
      // the hero → colour → sign-in run reads as one continuous first impression, and the collapse
      // (plus Kairo's first spoken line) waits until there is an account behind it.
      lastPointRef.current = point;
      setPhase('signin');
      playSound('morph');
    },
    [hex]
  );

  /**
   * Collapse the card into the pet. Moved off colour-confirm to sign-in-success, so nothing
   * expensive — and nothing spoken — happens before the user has an account.
   */
  const startCollapse = useCallback(() => {
    const point = lastPointRef.current ?? {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2
    };
    const rect = cardRef.current?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    setCollapse({ dx: point.x - cx, dy: point.y - cy });
    // Cross-fade the actual cursor into the card's last small, still-visible frame. This makes the
    // physical hand-off read as one object changing form, not a window disappearing and a pet
    // independently appearing nearby.
    const wake = () => {
      klog('onboarding', 'info', 'card handed off to cursor');
      void emit('cursor:entrance');
    };
    if (reduce) wake();
    else cursorWakeTimerRef.current = window.setTimeout(wake, 430);
  }, [reduce]);

  // Fired when the framer-motion card animation finishes. Only acts on the COLLAPSE (not the entrance):
  // settle cue, the pet-is-alive wake line on the real desktop, then advance to Act 2.
  const onCardAnimationComplete = useCallback(async () => {
    if (!collapse) return;
    playSound('settle');
    await say([ACT_LINES.act1_wake], { onStart: () => void emit('cursor:celebrate') });
    await clear();
    onComplete(nameRef.current);
  }, [collapse, say, clear, onComplete]);

  // The right-side demo: paint the corner burst once, then loop origin→ink-draw→note→type reply.
  // Under reduced motion it snaps to the finished frame (no loop). Cleaned up on unmount/collapse.
  useEffect(() => {
    const burst = burstRef.current;
    if (burst && !burst.childNodes.length) buildHeroBurst(burst);
    const path = inkPathRef.current;
    const origin = inkOriginRef.current;
    const end = inkEndRef.current;
    const note = noteRef.current;
    const reply = replyRef.current;
    const focus = focusRef.current;
    if (!path || !reply) return;

    const len = path.getTotalLength();
    path.style.strokeDasharray = String(len);

    if (reduce) {
      path.style.strokeDashoffset = '0';
      path.style.opacity = '1';
      if (origin) origin.style.opacity = '1';
      if (end) end.style.opacity = '1';
      focus?.classList.add('is-live');
      note?.classList.add('is-live');
      reply.textContent = HERO_REPLY;
      return;
    }

    klog('onboarding', 'debug', 'front door: hero demo loop started');
    let alive = true;
    let timer = 0;
    const wait = (ms: number) => new Promise<void>((r) => { timer = window.setTimeout(r, ms); });
    const typeReply = async (text: string) => {
      reply.textContent = '';
      const caret = document.createElement('span');
      caret.className = 'ob-caret';
      reply.appendChild(caret);
      for (let i = 0; i <= text.length && alive; i++) {
        caret.remove();
        reply.textContent = text.slice(0, i);
        reply.appendChild(caret);
        await wait(1000 / 56);
      }
      await wait(400);
      caret.remove();
    };

    (async function loop() {
      while (alive) {
        path.style.transition = 'none';
        path.style.strokeDashoffset = String(len);
        path.style.opacity = '0';
        if (origin) origin.style.opacity = '0';
        if (end) { end.style.opacity = '0'; end.style.transform = 'scale(.6)'; }
        note?.classList.remove('is-live');
        focus?.classList.remove('is-live');
        reply.textContent = '';
        await wait(550); if (!alive) break;
        focus?.classList.add('is-live');
        await wait(160); if (!alive) break;
        if (origin) { origin.style.transition = 'opacity .2s'; origin.style.opacity = '1'; }
        await wait(210); if (!alive) break;
        void path.getBoundingClientRect();
        path.style.opacity = '1';
        path.style.transition = 'stroke-dashoffset .6s cubic-bezier(.77,0,.175,1)';
        path.style.strokeDashoffset = '0';
        await wait(600); if (!alive) break;
        if (end) {
          end.style.transition = 'opacity .25s, transform .25s cubic-bezier(.2,.8,.2,1)';
          end.style.opacity = '1'; end.style.transform = 'scale(1)';
        }
        note?.classList.add('is-live');
        await wait(220); if (!alive) break;
        await typeReply(HERO_REPLY); if (!alive) break;
        await wait(2400);
      }
    })();

    return () => { alive = false; window.clearTimeout(timer); };
  }, [reduce]);

  return (
    <>
      <div className="ob-vignette" aria-hidden />
      <DraggableSurface label="front-door">
        <motion.div
          ref={cardRef}
          className="ob-card ob-card--hero"
          initial={reduce ? false : { opacity: 0, y: 10, scale: 0.97 }}
          animate={
            collapse
              ? {
                  x: [0, collapse.dx * 0.08, collapse.dx * 0.78, collapse.dx],
                  y: [0, collapse.dy * 0.08, collapse.dy * 0.78, collapse.dy],
                  scale: [1, 0.9, 0.16, 0.025],
                  opacity: [1, 1, 0.82, 0]
                }
              : { x: 0, y: 0, scale: 1, opacity: 1 }
          }
          transition={
            collapse
              ? {
                  type: 'tween',
                  ease: [0.22, 0.7, 0, 1],
                  duration: reduce ? 0 : 0.72,
                  times: [0, 0.2, 0.76, 1]
                }
              : { type: 'spring', stiffness: 260, damping: 26 }
          }
          onAnimationComplete={() => void onCardAnimationComplete()}
        >
        <div className="ob-hero-left">
          <AnimatePresence mode="sync" initial={false}>
            {phase === 'signin' ? (
              <motion.div
                key="signin"
                className="ob-front-signin"
                initial={reduce ? false : { opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                <KairoLockup className="ob-hero-mark" label={HERO_COPY.wordmark} />
                <SignInPanel
                  onSignedIn={(name: string) => {
                    nameRef.current = name;
                    startCollapse();
                  }}
                />
              </motion.div>
            ) : phase === 'hero' ? (
              <motion.div
                key="hero"
                className="ob-front-hero"
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduce ? undefined : { opacity: 0, x: -10 }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
              >
                <KairoLockup className="ob-hero-mark" label={HERO_COPY.wordmark} />
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
                initial={reduce ? false : { opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                <KairoLockup className="ob-hero-mark" label={HERO_COPY.wordmark} />
                <div className="ob-color-head">
                  <span className="ob-color-dot" style={{ background: hex }} aria-hidden />
                  <span className="ob-color-kicker">your color</span>
                </div>
                {/* Curated presets (founder-approved) instead of a free wheel — every one reads well on
                    any background. Clicking a swatch recolors everything live (onWheel → accent:changed). */}
                <div className="ob-swatches" role="radiogroup" aria-label="Pick Kairo's color">
                  {ACCENT_PRESETS.map((p) => {
                    const on = hex.toLowerCase() === p.hex.toLowerCase();
                    return (
                      <button
                        key={p.hex}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={p.name}
                        title={p.name}
                        className={`ob-swatch${on ? ' ob-swatch--on' : ''}`}
                        style={{ background: p.hex }}
                        onClick={() => onWheel(p.hex)}
                      />
                    );
                  })}
                </div>
                <button type="button" className="ob-color-confirm" onClick={confirm}>
                  {HERO_COPY.confirm}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {/* Right half: looping "Kairo sees Blender" demo on a light corner-burst backdrop. Purely
            decorative → aria-hidden; the left panel carries the real content. */}
        <div className="ob-hero-right" aria-hidden="true">
          <div className="ob-hero-burst">
            <svg
              ref={burstRef}
              className="ob-hero-burst-svg"
              viewBox="0 0 520 460"
              preserveAspectRatio="xMidYMid slice"
            />
          </div>

          <div ref={focusRef} className="ob-hero-focus" />

          <div className="ob-hero-tile">
            <div className="ob-hero-tile-bar"><span /><span /><span /></div>
            <div className="ob-hero-tile-shot">
              <img src={blenderShot} alt="" />
              <span className="ob-hero-tile-name">first-scene.blend</span>
            </div>
          </div>

          <aside ref={noteRef} className="ob-hero-note">
            <div className="ob-hero-note-head">
              <KairoMark className="ob-hero-note-glyph" />
              <span>Kairo sees Blender</span>
              <span className="ob-hero-note-listen"><i /><i /><i /></span>
            </div>
            <p ref={replyRef} className="ob-hero-note-reply" />
          </aside>

          <svg className="ob-hero-ink">
            <path ref={inkPathRef} className="ob-hero-ink-path" d="M 236 214 C 300 208, 268 188, 300 182" />
            <circle ref={inkOriginRef} className="ob-hero-ink-origin" cx="236" cy="214" r="4" />
            <circle ref={inkEndRef} className="ob-hero-ink-end" cx="300" cy="182" r="5" />
          </svg>
        </div>
        </motion.div>
      </DraggableSurface>
    </>
  );
}
