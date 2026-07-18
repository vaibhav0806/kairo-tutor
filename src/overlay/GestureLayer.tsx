// src/overlay/GestureLayer.tsx
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { createAnnotationFromPoints } from '../annotations/annotationTools';
import { segmentGesturePath, type TimedPoint } from '../notch/gestureSegmenter';
import { gestureConfig } from '../config/gesture';
import type { UserAnnotation } from '../core/types';
import type { OverlayDisplayBounds } from './OverlayApp';

// Renders fading translucent strokes from the live cursor:mouse stream. Purely
// cosmetic — the notch owns the truth buffer that fable actually sees.
export function GestureLayer({ displayBounds }: { displayBounds: OverlayDisplayBounds }) {
  const bufferRef = useRef<TimedPoint[]>([]);
  const recordingRef = useRef(true);
  const [, force] = useState(0);

  useEffect(() => {
    let raf = 0;
    const unlisteners: Array<() => void> = [];

    const tick = () => {
      const now = performance.now();
      // Prune points older than the longest a stroke can still be visible.
      const maxAge =
        gestureConfig.holdMs + gestureConfig.fadeMs + gestureConfig.windowMs + 200;
      bufferRef.current = bufferRef.current.filter((p) => now - p.t <= maxAge);
      force((n) => n + 1);
      // Keep animating only while there's something to draw or we're recording;
      // otherwise stop the loop entirely (0 CPU) until the next point or hold.
      raf = bufferRef.current.length > 0 || recordingRef.current ? requestAnimationFrame(tick) : 0;
    };
    // Start the loop on demand so an idle overlay costs nothing.
    const kick = () => {
      if (raf === 0) raf = requestAnimationFrame(tick);
    };

    void listen<{ x: number; y: number }>('cursor:mouse', (e) => {
      if (!recordingRef.current) return;
      bufferRef.current.push({ x: e.payload.x, y: e.payload.y, t: performance.now() });
      kick();
    }).then((u) => unlisteners.push(u));

    // Freeze the buffer on release; existing strokes keep fading, no new points.
    void listen<{ active?: boolean }>('ptt:recording', (e) => {
      recordingRef.current = Boolean(e.payload?.active);
      kick();
    }).then((u) => unlisteners.push(u));

    kick(); // component mounts during an active hold

    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      unlisteners.forEach((u) => u());
    };
  }, []);

  const now = performance.now();
  const strokes = segmentGesturePath(bufferRef.current, gestureConfig);

  return (
    <>
      {strokes.map((stroke, i) => {
        // Translucent baseOpacity while drawn + for holdMs after the last point,
        // then a smoothstep ease-out to 0 over fadeMs (a real fade, not a cut).
        const age = now - stroke.points[stroke.points.length - 1].t;
        const t = Math.min(1, Math.max(0, (age - gestureConfig.holdMs) / gestureConfig.fadeMs));
        const opacity = gestureConfig.baseOpacity * (1 - t * t * (3 - 2 * t));
        if (opacity <= 0.01) return null;
        const annotation = createAnnotationFromPoints({
          id: `gesture-${i}`,
          points: stroke.points.map((p) => ({ x: p.x, y: p.y }))
        });
        return (
          <GestureStrokeShape
            key={i}
            annotation={annotation}
            displayBounds={displayBounds}
            opacity={opacity}
          />
        );
      })}
    </>
  );
}

// Clone of OverlayApp's pen-branch geometry (OverlayApp.tsx:57-77) with a
// per-stroke opacity. Points are already in global-screen physical px.
function GestureStrokeShape({
  annotation,
  displayBounds,
  opacity
}: {
  annotation: UserAnnotation;
  displayBounds: OverlayDisplayBounds;
  opacity: number;
}) {
  if (!annotation.points) return null;
  // cursor:mouse points are true physical px, so convert to CSS px with the
  // webview's devicePixelRatio — NOT displayBounds.scaleFactor, which the
  // CGDisplay path reports as 1 in scaled-HiDPI modes (see spawn_mouse_tracker).
  // The cursor pet uses devicePixelRatio for the same reason.
  const scaleFactor = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const left = annotation.screenRegion.x / scaleFactor - displayBounds.x;
  const top = annotation.screenRegion.y / scaleFactor - displayBounds.y;
  const width = Math.max(annotation.screenRegion.width / scaleFactor, 1);
  const height = Math.max(annotation.screenRegion.height / scaleFactor, 1);
  const points = annotation.points
    .map((p) => `${p.x / scaleFactor - displayBounds.x - left},${p.y / scaleFactor - displayBounds.y - top}`)
    .join(' ');
  return (
    <svg
      aria-label="gesture mark"
      className="annotation-shape pen gesture"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        opacity,
        // Laser glow: a tight + a wide red halo around the crisp core.
        filter: `drop-shadow(0 0 ${gestureConfig.glowPx * 0.45}px ${gestureConfig.strokeColor}) drop-shadow(0 0 ${gestureConfig.glowPx}px ${gestureConfig.strokeColor})`
      }}
      viewBox={`0 0 ${width} ${height}`}
    >
      <polyline
        points={points}
        style={{ stroke: gestureConfig.strokeColor, strokeWidth: gestureConfig.strokeWidthCssPx }}
      />
    </svg>
  );
}
