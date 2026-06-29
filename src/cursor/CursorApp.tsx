import { useEffect, useMemo, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
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
const GLYPH_SIZE = 26;
const TIP_AX = (28 / VIEWBOX) * GLYPH_SIZE;
const TIP_AY = (4 / VIEWBOX) * GLYPH_SIZE;

type CursorMode = 'shadow' | 'pointing';

type MousePayload = { x: number; y: number };
type PointPayload = { screenRegion: ScreenRegion; displayBounds: DisplayBounds };

export function CursorApp() {
  const nativeBridge = useMemo(() => createNativeBridge(), []);

  const elementRef = useRef<HTMLDivElement | null>(null);

  // Display origin/scale for converting global mouse points to window-local px.
  const boundsRef = useRef<DisplayBounds>({ x: 0, y: 0, width: 0, height: 0, scaleFactor: 1 });
  const modeRef = useRef<CursorMode>('shadow');
  // Latest real mouse, in global top-left points (kept fresh even while pointing,
  // so releasing glides back to wherever the mouse is now).
  const mouseRef = useRef<MousePayload>({ x: 0, y: 0 });
  // Resting tip + orientation while pointing, in window-local px.
  const pointRef = useRef<PointingTip>({ x: 0, y: 0, flipX: false, flipY: false });

  const springX = useRef(createSpring(0));
  const springY = useRef(createSpring(0));
  const initializedRef = useRef(false);
  const flipRef = useRef({ flipX: false, flipY: false });

  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('cursor-document');
    document.body.classList.add('cursor-document');
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
        return pointRef.current;
      }
      const bounds = boundsRef.current;
      const tip = shadowTip(mouseRef.current.x - bounds.x, mouseRef.current.y - bounds.y);
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
        pointRef.current = pointingTip(event.payload.screenRegion, event.payload.displayBounds);
        modeRef.current = 'pointing';
        wake();
      }),
      listen('cursor:release', () => {
        if (!isMounted) {
          return;
        }
        modeRef.current = 'shadow';
        wake();
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
    <div className="kairo-cursor-shell" aria-hidden="true">
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
