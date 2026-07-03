import { useEffect, useMemo, useRef } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
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

type CursorMode = 'shadow' | 'pointing';

type MousePayload = { x: number; y: number };
type PointPayload = { screenRegion: ScreenRegion; displayBounds: DisplayBounds; color?: string };

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

  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('cursor-document');
    document.body.classList.add('cursor-document');
    // Tell the native side the cursor webview has mounted with its transparent
    // background applied, so it can reveal the full-screen panel without flashing the
    // screen white. Emitted directly (NOT via rAF) — a hidden window throttles rAF, so
    // rAF wouldn't fire until shown; mount already means the DOM + CSS are in place.
    void emit('cursor:ready', {});
    return () => {
      document.documentElement.classList.remove('cursor-document');
      document.body.classList.remove('cursor-document');
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

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
      if (modeRef.current !== 'pointing') {
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

    const setFx = (mode: CursorFx) => {
      fxModeRef.current = mode;
      if (shellRef.current) {
        shellRef.current.dataset.fx = mode;
      }
      // Run a frame so the FX layer is repositioned onto the (possibly idle) tip.
      wake();
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
        mouseRef.current = event.payload;
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
        // Keep the speaking pulse while pointing (it's shown at the target).
        if (fxModeRef.current !== 'speaking') {
          setFx('none');
        }
        wake();
      }),
      listen('cursor:release', () => {
        if (!isMounted) {
          return;
        }
        if (arrowPathRef.current) {
          arrowPathRef.current.style.fill = DEFAULT_ARROW_FILL;
        }
        if (trailRef.current) {
          trailRef.current.style.opacity = '0';
        }
        modeRef.current = 'shadow';
        setFx('none');
        wake();
      }),
      // Push-to-talk listening: halo pulses with the live mic level + red "live" core.
      listen('cursor:listening', () => {
        if (!isMounted) {
          return;
        }
        if (arrowPathRef.current) {
          arrowPathRef.current.style.fill = RECORDING_FILL;
        }
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
      })
    ])
      .then((next) => {
        unlisteners.push(...next);
      })
      .catch(() => {
        // Browser preview and tests run without the Tauri event bus.
      });

    return () => {
      isMounted = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
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
