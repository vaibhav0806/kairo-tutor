import { useEffect, useMemo, useRef } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import type { ScreenRegion } from '../core/types';
import type { DisplayBounds } from '../overlay/coordinates';
import { createNativeBridge } from '../native/nativeBridge';
import {
  POINTING_SPRING,
  SHADOW_SPRING,
  createSpring,
  springAtRest,
  stepSpring,
  type SpringConfig
} from './spring';
import { pointingTip, shadowTip, type PointingTip } from './geometry';
import {
  DRAW_APPROACH_MS,
  DRAW_DURATION_MS,
  clamp01,
  evalApproachEase,
  evalDrawEase,
  lerp
} from '../core/penDraw';
import { klog } from '../core/logger';

// How long the real mouse must sit still before the pet fades out on its own
// (item 2). Any real movement brings it straight back. Typing-hide (item 1) is
// independent and driven by the system cursor via the `cursor:visible` event.
const IDLE_HIDE_MS = 3000;

// Glyph: a clean filled navigation arrowhead pointing up-right (NOT the mac
// pointer shape). Tip lives at viewBox (28,4); the element is GLYPH_SIZE px wide,
// so the tip anchor in element px is (TIP_AX, TIP_AY). The whole element is
// translated so that anchor lands on the spring position, and mirrored via scale
// about that same anchor for edge flips.
const VIEWBOX = 32;
const GLYPH_SIZE = 20;
const TIP_AX = (28 / VIEWBOX) * GLYPH_SIZE;
const TIP_AY = (4 / VIEWBOX) * GLYPH_SIZE;

// Comet trail behind the tip during flight. TRAIL_BASE is its unscaled length;
// the right edge is anchored at the tip (transform-origin 100% 50%) and it
// stretches/​fades with speed. Default brand purple gradient.
const TRAIL_BASE = 44;
const TRAIL_H = 8;
const DEFAULT_ARROW_FILL = 'url(#kairo-cursor-grad)';
const DEFAULT_TRAIL = `linear-gradient(to left, #7c3aed, #7c3aed00)`;
// While recording, the arrow core turns a live "mic on" red so listening is
// unmistakable even apart from the halo.
const RECORDING_FILL = '#ff4d6d';

type CursorFx = 'none' | 'listening' | 'thinking' | 'speaking';

type CursorMode = 'shadow' | 'pointing' | 'drag';

type MousePayload = { x: number; y: number };
type PointPayload = { screenRegion: ScreenRegion; displayBounds: DisplayBounds; color?: string };
type DragPayload = {
  fromRegion: ScreenRegion;
  toRegion: ScreenRegion;
  displayBounds: DisplayBounds;
  durationMs?: number;
  approachMs?: number;
  color?: string;
};

// In-flight pen-drag: an `approachMs` glide from wherever the pet was to the
// box's top-left corner, then a `durationMs` tween along the diagonal to the
// bottom-right corner. `prev*` feeds the comet trail (the spring integrator is
// bypassed while dragging). All coords are window-local px.
type DragState = {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startX: number;
  startY: number;
  flipX: boolean;
  flipY: boolean;
  startMs: number | null;
  approachMs: number;
  durationMs: number;
  prevX: number;
  prevY: number;
};

export function CursorApp() {
  const nativeBridge = useMemo(() => createNativeBridge(), []);

  const elementRef = useRef<HTMLDivElement | null>(null);
  const trailRef = useRef<HTMLDivElement | null>(null);
  const arrowPathRef = useRef<SVGPathElement | null>(null);
  // Listening halo + thinking swirl layer, centred on the cursor tip each frame.
  const shellRef = useRef<HTMLDivElement | null>(null);
  const fxRef = useRef<HTMLDivElement | null>(null);
  const fxModeRef = useRef<CursorFx>('none');

  // Display origin/scale for converting global mouse points to window-local px.
  const boundsRef = useRef<DisplayBounds>({ x: 0, y: 0, width: 0, height: 0, scaleFactor: 1 });
  const modeRef = useRef<CursorMode>('shadow');
  // Set true when a fresh cursor:point fly-to-target begins; the animation loop plays the
  // arrival "pop" once when the spring settles, then clears it. Suppressed for drag/shadow.
  const pointArrivalPendingRef = useRef(false);
  // Latest real mouse, in global top-left points (kept fresh even while pointing,
  // so releasing glides back to wherever the mouse is now).
  const mouseRef = useRef<MousePayload>({ x: 0, y: 0 });
  // Resting tip + ring center + orientation while pointing, in window-local px.
  const pointRef = useRef<PointingTip>({
    tipX: 0,
    tipY: 0,
    ringX: 0,
    ringY: 0,
    flipX: false,
    flipY: false
  });

  const springX = useRef(createSpring(0));
  const springY = useRef(createSpring(0));
  const initializedRef = useRef(false);
  const flipRef = useRef({ flipX: false, flipY: false });
  // Active pen-drag reveal, or null when not dragging.
  const dragRef = useRef<DragState | null>(null);
  const reduceMotionRef = useRef(false);

  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);

  // Auto-hide state (items 1 + 2). `sysVisibleRef` mirrors the real macOS cursor
  // (false while typing); `lastActivityRef` is the last real-move timestamp for
  // idle-hide; `hiddenAppliedRef` dedupes opacity writes/logging.
  const sysVisibleRef = useRef(true);
  const lastActivityRef = useRef(0);
  const hiddenAppliedRef = useRef(false);

  useEffect(() => {
    document.documentElement.classList.add('cursor-document');
    document.body.classList.add('cursor-document');
    return () => {
      document.documentElement.classList.remove('cursor-document');
      document.body.classList.remove('cursor-document');
    };
  }, []);

  // Honor the OS "Reduce Motion" setting: the drag reveal snaps to the corner.
  useEffect(() => {
    const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) {
      return;
    }
    reduceMotionRef.current = query.matches;
    const onChange = (event: MediaQueryListEvent) => {
      reduceMotionRef.current = event.matches;
    };
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  useEffect(() => {
    let isMounted = true;
    // Start the idle clock now so the pet is visible for a full window after launch.
    lastActivityRef.current = globalThis.performance?.now?.() ?? 0;

    // Current spring target (local px) + glyph orientation for this mode.
    const resolveTarget = (): { x: number; y: number; flipX: boolean; flipY: boolean } => {
      if (modeRef.current === 'pointing') {
        const point = pointRef.current;
        return { x: point.tipX, y: point.tipY, flipX: point.flipX, flipY: point.flipY };
      }
      const bounds = boundsRef.current;
      // The mouse arrives in physical px; convert to CSS px via the webview's own
      // backing scale, then subtract the window's logical origin.
      const dpr = globalThis.devicePixelRatio || 1;
      const tip = shadowTip(
        mouseRef.current.x / dpr - bounds.x,
        mouseRef.current.y / dpr - bounds.y
      );
      return { x: tip.x, y: tip.y, flipX: false, flipY: false };
    };

    const writeTransform = () => {
      const element = elementRef.current;
      if (!element) {
        return;
      }
      const { flipX, flipY } = flipRef.current;
      const tx = springX.current.value - TIP_AX;
      const ty = springY.current.value - TIP_AY;
      element.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${flipX ? -1 : 1}, ${
        flipY ? -1 : 1
      })`;
      if (fxRef.current) {
        // Centre the listening/thinking FX on the cursor tip.
        fxRef.current.style.transform = `translate(${springX.current.value}px, ${springY.current.value}px)`;
      }
    };

    // Comet trail behind the tip: length + opacity scale with spring speed, angle
    // follows velocity. Transform/opacity only (GPU); hidden when slow or shadowing.
    const writeTrail = () => {
      const trail = trailRef.current;
      if (!trail) {
        return;
      }
      if (modeRef.current === 'shadow') {
        trail.style.opacity = '0';
        return;
      }
      const vx = springX.current.velocity;
      const vy = springY.current.velocity;
      const speed = Math.hypot(vx, vy);
      if (speed < 40) {
        trail.style.opacity = '0';
        return;
      }
      const angle = Math.atan2(vy, vx) * (180 / Math.PI);
      const length = Math.min(speed * 0.05, 44);
      const tipX = springX.current.value;
      const tipY = springY.current.value;
      trail.style.opacity = String(Math.min(speed / 1400, 0.65));
      trail.style.transform = `translate(${tipX - TRAIL_BASE}px, ${
        tipY - TRAIL_H / 2
      }px) rotate(${angle}deg) scaleX(${length / TRAIL_BASE})`;
    };

    const frame = (time: number) => {
      if (!isMounted) {
        return;
      }
      const dt = lastTimeRef.current === null ? 1 / 60 : (time - lastTimeRef.current) / 1000;
      lastTimeRef.current = time;

      // Pen-drag: drive the tip along the approach → diagonal-draw timeline, welded
      // to the box inking itself in the overlay window (same easing, same duration).
      if (modeRef.current === 'drag' && dragRef.current) {
        const drag = dragRef.current;
        if (drag.startMs === null) {
          drag.startMs = time;
        }
        const elapsed = time - drag.startMs;

        let x: number;
        let y: number;
        let finished = false;
        if (elapsed < drag.approachMs) {
          const eased = evalApproachEase(clamp01(elapsed / drag.approachMs));
          x = lerp(drag.startX, drag.fromX, eased);
          y = lerp(drag.startY, drag.fromY, eased);
        } else {
          const progress = clamp01((elapsed - drag.approachMs) / drag.durationMs);
          const eased = evalDrawEase(progress);
          x = lerp(drag.fromX, drag.toX, eased);
          y = lerp(drag.fromY, drag.toY, eased);
          finished = progress >= 1;
        }

        springX.current.velocity = dt > 0 ? (x - drag.prevX) / dt : 0;
        springY.current.velocity = dt > 0 ? (y - drag.prevY) / dt : 0;
        drag.prevX = x;
        drag.prevY = y;
        springX.current.value = x;
        springY.current.value = y;
        flipRef.current = { flipX: drag.flipX, flipY: drag.flipY };
        writeTransform();
        writeTrail();

        if (finished) {
          // Rest at the corner in pointing mode so the speaking pulse takes over.
          springX.current.velocity = 0;
          springY.current.velocity = 0;
          pointRef.current = {
            tipX: drag.toX,
            tipY: drag.toY,
            ringX: drag.toX,
            ringY: drag.toY,
            flipX: drag.flipX,
            flipY: drag.flipY
          };
          modeRef.current = 'pointing';
          dragRef.current = null;
        }
        rafRef.current = requestAnimationFrame(frame);
        return;
      }

      const target = resolveTarget();
      flipRef.current = { flipX: target.flipX, flipY: target.flipY };
      const config: SpringConfig = modeRef.current === 'pointing' ? POINTING_SPRING : SHADOW_SPRING;

      stepSpring(springX.current, target.x, config, dt);
      stepSpring(springY.current, target.y, config, dt);
      writeTransform();
      writeTrail();

      // Stop the loop once settled to keep an idle cursor free; events wake it.
      if (springAtRest(springX.current, target.x) && springAtRest(springY.current, target.y)) {
        springX.current.velocity = 0;
        springY.current.velocity = 0;
        // Arrival "pop": fires once when a cursor:point fly-to-target settles (tutor +
        // show flows). Gated to pointing mode so idle shadow-settles stay silent. The
        // cursor WebView is click-through (no user gesture → its audio is blocked), so we
        // EMIT and let the notch — which has unlocked audio — actually play the cue.
        if (pointArrivalPendingRef.current && modeRef.current === 'pointing') {
          pointArrivalPendingRef.current = false;
          void emit('cursor:arrived', {});
        }
        rafRef.current = null;
        lastTimeRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(frame);
    };

    const wake = () => {
      if (rafRef.current === null) {
        lastTimeRef.current = null;
        rafRef.current = requestAnimationFrame(frame);
      }
    };

    const snapTo = (target: { x: number; y: number }) => {
      springX.current = createSpring(target.x);
      springY.current = createSpring(target.y);
      writeTransform();
    };

    // Decide whether the pet should be visible right now and fade it accordingly.
    // Auto-hide only while idly shadowing the mouse with nothing happening — never
    // while pointing/dragging or showing a status FX (listening/thinking/speaking),
    // where the pet is an active surface the user must see.
    const applyVisibility = () => {
      const shell = shellRef.current;
      if (!shell) {
        return;
      }
      const now = globalThis.performance?.now?.() ?? 0;
      const idle = now - lastActivityRef.current >= IDLE_HIDE_MS;
      const eligible = modeRef.current === 'shadow' && fxModeRef.current === 'none';
      const hidden = eligible && (!sysVisibleRef.current || idle);
      if (hidden === hiddenAppliedRef.current) {
        return;
      }
      hiddenAppliedRef.current = hidden;
      shell.style.opacity = hidden ? '0' : '1';
      klog('cursor', 'debug', hidden ? 'pet auto-hidden' : 'pet shown', {
        sys: sysVisibleRef.current,
        idle,
        mode: modeRef.current,
        fx: fxModeRef.current
      });
    };

    const setFx = (mode: CursorFx) => {
      fxModeRef.current = mode;
      if (shellRef.current) {
        shellRef.current.dataset.fx = mode;
      }
      // Run a frame so the FX layer is repositioned onto the (possibly idle) tip.
      wake();
      // FX starting/stopping changes hide-eligibility (e.g. listening un-hides).
      applyVisibility();
    };

    void nativeBridge
      .getDisplayBounds()
      .then((bounds) => {
        if (isMounted) {
          boundsRef.current = bounds;
        }
      })
      .catch(() => {
        // Browser preview has no native display bounds.
      });

    const unlisteners: Array<() => void> = [];
    void Promise.all([
      listen<MousePayload>('cursor:mouse', (event) => {
        if (!isMounted) {
          return;
        }
        // Distinguish a real move from the tracker's ~300ms keepalive (same point):
        // only a genuine position change resets idle-hide and brings the pet back.
        const prev = mouseRef.current;
        const moved =
          Math.abs(event.payload.x - prev.x) > 0.5 || Math.abs(event.payload.y - prev.y) > 0.5;
        mouseRef.current = event.payload;
        if (moved) {
          lastActivityRef.current = globalThis.performance?.now?.() ?? 0;
          // A physical move always makes the real cursor visible again, so un-hide
          // immediately rather than waiting for the next `cursor:visible` tick.
          sysVisibleRef.current = true;
          applyVisibility();
        }
        if (!initializedRef.current) {
          // First sighting of the mouse: place the pet there instead of flying
          // in from the origin.
          initializedRef.current = true;
          const target = resolveTarget();
          flipRef.current = { flipX: target.flipX, flipY: target.flipY };
          snapTo(target);
        }
        if (modeRef.current === 'shadow') {
          wake();
        }
      }),
      listen<PointPayload>('cursor:point', (event) => {
        if (!isMounted) {
          return;
        }
        dragRef.current = null;
        const tip = pointingTip(event.payload.screenRegion, event.payload.displayBounds);
        pointRef.current = tip;
        const color = event.payload.color;
        if (arrowPathRef.current) {
          arrowPathRef.current.style.fill = color ?? DEFAULT_ARROW_FILL;
        }
        if (trailRef.current) {
          trailRef.current.style.background = color
            ? `linear-gradient(to left, ${color}, ${color}00)`
            : DEFAULT_TRAIL;
        }
        modeRef.current = 'pointing';
        // A fresh fly-to-target → arm the arrival pop (played once when it settles).
        pointArrivalPendingRef.current = true;
        // Keep the speaking pulse while pointing (it's shown at the target).
        if (fxModeRef.current !== 'speaking') {
          setFx('none');
        }
        wake();
      }),
      // Pen-drag reveal: fly to the box's top-left corner, then drag to the
      // bottom-right, welded to the box inking itself in the overlay window.
      listen<DragPayload>('cursor:drag', (event) => {
        if (!isMounted) {
          return;
        }
        pointArrivalPendingRef.current = false; // no arrival pop for a drag gesture
        const payload = event.payload;
        const from = pointingTip(payload.fromRegion, payload.displayBounds);
        const to = pointingTip(payload.toRegion, payload.displayBounds);
        const color = payload.color;
        if (arrowPathRef.current) {
          arrowPathRef.current.style.fill = color ?? DEFAULT_ARROW_FILL;
        }
        if (trailRef.current) {
          trailRef.current.style.background = color
            ? `linear-gradient(to left, ${color}, ${color}00)`
            : DEFAULT_TRAIL;
        }
        // No halo/swirl during the draw, but keep an already-running speaking pulse.
        if (fxModeRef.current !== 'speaking') {
          setFx('none');
        }
        if (reduceMotionRef.current) {
          pointRef.current = {
            tipX: to.tipX,
            tipY: to.tipY,
            ringX: to.tipX,
            ringY: to.tipY,
            flipX: to.flipX,
            flipY: to.flipY
          };
          modeRef.current = 'pointing';
          dragRef.current = null;
          snapTo({ x: to.tipX, y: to.tipY });
          return;
        }
        const startX = springX.current.value;
        const startY = springY.current.value;
        dragRef.current = {
          fromX: from.tipX,
          fromY: from.tipY,
          toX: to.tipX,
          toY: to.tipY,
          startX,
          startY,
          flipX: to.flipX,
          flipY: to.flipY,
          startMs: null,
          approachMs: payload.approachMs ?? DRAW_APPROACH_MS,
          durationMs: payload.durationMs ?? DRAW_DURATION_MS,
          prevX: startX,
          prevY: startY
        };
        modeRef.current = 'drag';
        flipRef.current = { flipX: to.flipX, flipY: to.flipY };
        wake();
      }),
      listen('cursor:release', () => {
        if (!isMounted) {
          return;
        }
        pointArrivalPendingRef.current = false; // turn ended → no stale arrival pop
        dragRef.current = null;
        if (arrowPathRef.current) {
          arrowPathRef.current.style.fill = DEFAULT_ARROW_FILL;
        }
        if (trailRef.current) {
          trailRef.current.style.opacity = '0';
        }
        modeRef.current = 'shadow';
        // A turn just ended: grant a fresh idle window so the pet doesn't blink out
        // the instant it returns to following (the mouse was still during the turn).
        lastActivityRef.current = globalThis.performance?.now?.() ?? 0;
        setFx('none');
        wake();
      }),
      // Push-to-talk listening: halo pulses with the live mic level + red "live" core.
      listen('cursor:listening', () => {
        if (!isMounted) {
          return;
        }
        pointArrivalPendingRef.current = false; // re-engaging supersedes any pending arrival
        dragRef.current = null;
        if (arrowPathRef.current) {
          arrowPathRef.current.style.fill = RECORDING_FILL;
        }
        // Leave any old pointing target: re-engaging supersedes the last turn, so the
        // halo should show while the cursor follows the mouse, not while frozen at a
        // stale target. (setFx wakes the loop, which glides back to the mouse.)
        modeRef.current = 'shadow';
        setFx('listening');
      }),
      listen<{ level: number }>('cursor:level', (event) => {
        if (!isMounted || !shellRef.current) {
          return;
        }
        const level = Math.max(0, Math.min(1, event.payload.level ?? 0));
        shellRef.current.style.setProperty('--mic-level', String(level));
      }),
      // After release: a thinking swirl while transcription + the answer are computed.
      listen('cursor:thinking', () => {
        if (!isMounted) {
          return;
        }
        if (arrowPathRef.current) {
          arrowPathRef.current.style.fill = DEFAULT_ARROW_FILL;
        }
        setFx('thinking');
      }),
      // While the answer is spoken: a calm purple pulse (shown at the target).
      listen('cursor:speaking', () => {
        if (!isMounted) {
          return;
        }
        if (arrowPathRef.current) {
          arrowPathRef.current.style.fill = DEFAULT_ARROW_FILL;
        }
        setFx('speaking');
      }),
      listen('cursor:idle', () => {
        if (!isMounted) {
          return;
        }
        if (arrowPathRef.current) {
          arrowPathRef.current.style.fill = DEFAULT_ARROW_FILL;
        }
        setFx('none');
      }),
      // System cursor visibility mirror (item 1): macOS hides the real cursor while
      // the user types; the pet vanishes with it. Reappears on move (also handled
      // eagerly in the cursor:mouse listener).
      listen<{ visible: boolean }>('cursor:visible', (event) => {
        if (!isMounted) {
          return;
        }
        sysVisibleRef.current = event.payload.visible !== false;
        applyVisibility();
      })
    ])
      .then((next) => {
        unlisteners.push(...next);
      })
      .catch(() => {
        // Browser preview and tests run without the Tauri event bus.
      });

    // Idle-hide can't ride the RAF loop (it parks when the pet is at rest), so a
    // light standalone timer re-evaluates visibility as the idle threshold crosses.
    const idleInterval = globalThis.setInterval(applyVisibility, 250);

    return () => {
      isMounted = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      globalThis.clearInterval(idleInterval);
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [nativeBridge]);

  return (
    <div className="kairo-cursor-shell" ref={shellRef} data-fx="none" aria-hidden="true">
      <div className="kairo-cursor-fx" ref={fxRef} aria-hidden="true">
        <span className="kairo-cursor-halo" />
        <span className="kairo-cursor-think">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="kairo-cursor-trail" ref={trailRef} aria-hidden="true" />
      <div
        className="kairo-cursor"
        ref={elementRef}
        style={{ width: GLYPH_SIZE, height: GLYPH_SIZE, transformOrigin: `${TIP_AX}px ${TIP_AY}px` }}
      >
        <svg className="kairo-cursor-arrow" viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}>
          <defs>
            <linearGradient id="kairo-cursor-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#c79bff" />
              <stop offset="100%" stopColor="#7c3aed" />
            </linearGradient>
          </defs>
          <path
            ref={arrowPathRef}
            d="M28 4 L6 14 L15 17 L18 26 Z"
            fill="url(#kairo-cursor-grad)"
            stroke="#ffffff"
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
}
