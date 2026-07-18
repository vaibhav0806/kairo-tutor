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

    void listen<{ x: number; y: number }>('cursor:mouse', (e) => {
      if (!recordingRef.current) return;
      bufferRef.current.push({ x: e.payload.x, y: e.payload.y, t: performance.now() });
    }).then((u) => unlisteners.push(u));

    // Freeze the buffer on release; existing strokes keep fading, no new points.
    void listen<{ active?: boolean }>('ptt:recording', (e) => {
      recordingRef.current = Boolean(e.payload?.active);
    }).then((u) => unlisteners.push(u));

    const tick = () => {
      const now = performance.now();
      // Prune points older than the longest a stroke can still be visible.
      const maxAge = gestureConfig.fadeMs + gestureConfig.windowMs + 200;
      bufferRef.current = bufferRef.current.filter((p) => now - p.t <= maxAge);
      force((n) => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      unlisteners.forEach((u) => u());
    };
  }, []);

  const now = performance.now();
  const strokes = segmentGesturePath(bufferRef.current, gestureConfig);

  return (
    <>
      {strokes.map((stroke, i) => {
        const age = now - stroke.points[stroke.points.length - 1].t;
        const opacity = Math.max(0, 1 - age / gestureConfig.fadeMs);
        if (opacity <= 0) return null;
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
  const scaleFactor = displayBounds.scaleFactor > 0 ? displayBounds.scaleFactor : 1;
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
      style={{ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, opacity }}
      viewBox={`0 0 ${width} ${height}`}
    >
      <polyline points={points} />
    </svg>
  );
}
