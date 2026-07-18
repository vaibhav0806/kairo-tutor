// src/overlay/GestureLayer.tsx
import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { segmentGesturePath, type TimedPoint } from '../notch/gestureSegmenter';
import { gestureConfig } from '../config/gesture';
import type { OverlayDisplayBounds } from './OverlayApp';

// Renders the user's fading cursor-gesture strokes on a <canvas>, drawn imperatively
// in one rAF loop — NO per-frame React re-render or SVG DOM churn, so it's smooth +
// high-performance and paints deterministically. Purely cosmetic: the notch owns the
// separate truth buffer that fable actually sees.
export function GestureLayer({ displayBounds }: { displayBounds: OverlayDisplayBounds }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferRef = useRef<TimedPoint[]>([]);
  const recordingRef = useRef(true); // overlay mounts during an active hold

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cfg = gestureConfig;
    // cursor:mouse is physical px; devicePixelRatio is the display's true backing
    // scale (the CGDisplay scaleFactor is unreliable in scaled-HiDPI modes).
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const cssW = displayBounds.width;
    const cssH = displayBounds.height;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr); // draw in CSS px, crisp on retina
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let raf = 0;
    const unlisteners: Array<() => void> = [];

    const draw = () => {
      const now = performance.now();
      const maxAge = cfg.holdMs + cfg.fadeMs + cfg.windowMs + 200;
      bufferRef.current = bufferRef.current.filter((p) => now - p.t <= maxAge);
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.strokeStyle = cfg.strokeColor;
      ctx.lineWidth = cfg.strokeWidthCssPx;
      const strokes = segmentGesturePath(bufferRef.current, cfg);
      for (const stroke of strokes) {
        const age = now - stroke.points[stroke.points.length - 1].t;
        // Full baseOpacity for holdMs, then a smoothstep ease-out to 0 over fadeMs.
        const t = Math.min(1, Math.max(0, (age - cfg.holdMs) / cfg.fadeMs));
        const opacity = cfg.baseOpacity * (1 - t * t * (3 - 2 * t));
        if (opacity <= 0.01) continue;
        ctx.globalAlpha = opacity;
        ctx.beginPath();
        const pts = stroke.points;
        for (let i = 0; i < pts.length; i++) {
          const x = pts[i].x / dpr - displayBounds.x;
          const y = pts[i].y / dpr - displayBounds.y;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Keep animating only while there's something to draw or we're recording;
      // otherwise stop the loop (0 CPU) until the next point or hold.
      raf = bufferRef.current.length > 0 || recordingRef.current ? requestAnimationFrame(draw) : 0;
    };
    const kick = () => {
      if (raf === 0) raf = requestAnimationFrame(draw);
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

    kick();

    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      unlisteners.forEach((u) => u());
    };
  }, [displayBounds]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: `${displayBounds.width}px`,
        height: `${displayBounds.height}px`,
        pointerEvents: 'none'
      }}
    />
  );
}
