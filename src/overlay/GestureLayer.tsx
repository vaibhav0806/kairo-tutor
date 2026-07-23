// src/overlay/GestureLayer.tsx
import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { segmentGesturePath, type TimedPoint } from '../notch/gestureSegmenter';
import { gestureConfig } from '../config/gesture';
import type { OverlayDisplayBounds } from './OverlayApp';

// Renders the user's fading cursor-gesture trail on a <canvas>, drawn imperatively in one rAF loop —
// NO per-frame React re-render or SVG DOM churn, so it's smooth + high-performance and paints
// deterministically. Purely cosmetic: the notch owns the separate truth buffer that fable actually sees.
//
// The trail is a COMET: a bright glowing head at the cursor tapering (width + opacity) to a thin, faint
// tail, in the user's chosen accent. The age-based hold+fade is unchanged — the comet dissipates after
// release exactly as the old uniform trail did.
export function GestureLayer({ displayBounds }: { displayBounds: OverlayDisplayBounds }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferRef = useRef<TimedPoint[]>([]);
  const recordingRef = useRef(true); // overlay mounts during an active hold

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cfg = gestureConfig;
    // cursor:mouse is physical px; devicePixelRatio is the display's true backing scale (the CGDisplay
    // scaleFactor is unreliable in scaled-HiDPI modes).
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

    // Accent tint, read from the CSS var the overlay webview already carries (--kairo-accent-rgb, set by
    // applyAccent). Kept fresh via accent:changed (read the payload hex directly, so we never race
    // applyAccent updating the var) so a mid-session recolor — the onboarding color pick — applies live.
    const hexToRgb = (hex: string): string | null => {
      const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
      if (!m) return null;
      const n = parseInt(m[1], 16);
      return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
    };
    const readVarRgb = (): string => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--kairo-accent-rgb').trim();
      return v ? v.replace(/\s+/g, ', ') : (hexToRgb(cfg.strokeColor) ?? '139, 92, 246');
    };
    let accentRgb = readVarRgb();

    let raf = 0;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    // listen() resolves async; if we unmount before it does, dispose immediately so we never leak the
    // cursor:mouse / ptt:recording listeners across many turns.
    const addUnlisten = (u: () => void) => {
      if (cancelled) u();
      else unlisteners.push(u);
    };

    const smoothFade = (age: number): number => {
      // Full opacity for holdMs, then a smoothstep ease-out to 0 over fadeMs (UNCHANGED age-fade).
      const t = Math.min(1, Math.max(0, (age - cfg.holdMs) / cfg.fadeMs));
      return 1 - t * t * (3 - 2 * t);
    };

    const draw = () => {
      const now = performance.now();
      const maxAge = cfg.holdMs + cfg.fadeMs + cfg.windowMs + 200;
      bufferRef.current = bufferRef.current.filter((p) => now - p.t <= maxAge);
      ctx.clearRect(0, 0, cssW, cssH);
      const buf = bufferRef.current;
      const color = `rgb(${accentRgb})`;
      ctx.strokeStyle = color;

      // The comet head = the newest point overall. Taper each segment toward it: newer (near the head)
      // is thick + bright, older (down the tail) is thin + faint.
      const newestT = buf.length ? buf[buf.length - 1].t : now;
      const strokes = segmentGesturePath(buf, cfg);
      for (const stroke of strokes) {
        const pts = stroke.points;
        if (pts.length < 2) continue;
        const overallFade = smoothFade(now - pts[pts.length - 1].t);
        if (overallFade <= 0.01) continue;
        for (let i = 1; i < pts.length; i++) {
          const p0 = pts[i - 1];
          const p1 = pts[i];
          // cf: 1 at the head, → 0 by cometMs back down the tail.
          const cf = 1 - Math.min(1, Math.max(0, (newestT - p1.t) / cfg.cometMs));
          const width = cfg.tailWidthCssPx + (cfg.headWidthCssPx - cfg.tailWidthCssPx) * cf;
          const alpha = (cfg.tailOpacity + (cfg.headOpacity - cfg.tailOpacity) * cf) * overallFade;
          if (alpha <= 0.01) continue;
          ctx.globalAlpha = alpha;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(p0.x / dpr - displayBounds.x, p0.y / dpr - displayBounds.y);
          ctx.lineTo(p1.x / dpr - displayBounds.x, p1.y / dpr - displayBounds.y);
          ctx.stroke();
        }
      }

      // The glowing comet head at the cursor — bright while active, fades out after release. Drawn last
      // so the shadow glow doesn't bleed onto the tail segments.
      if (buf.length) {
        const last = buf[buf.length - 1];
        const headFade = smoothFade(now - last.t);
        if (headFade > 0.02) {
          ctx.globalAlpha = cfg.headOpacity * headFade;
          ctx.shadowBlur = cfg.glowRadiusCssPx;
          ctx.shadowColor = color;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(
            last.x / dpr - displayBounds.x,
            last.y / dpr - displayBounds.y,
            cfg.headDotRadiusCssPx,
            0,
            Math.PI * 2
          );
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      ctx.globalAlpha = 1;
      // Keep animating only while there's something to draw or we're recording; otherwise stop the loop
      // (0 CPU) until the next point or hold.
      raf = buf.length > 0 || recordingRef.current ? requestAnimationFrame(draw) : 0;
    };
    const kick = () => {
      if (raf === 0) raf = requestAnimationFrame(draw);
    };

    void listen<{ x: number; y: number }>('cursor:mouse', (e) => {
      if (!recordingRef.current) return;
      bufferRef.current.push({ x: e.payload.x, y: e.payload.y, t: performance.now() });
      kick();
    }).then(addUnlisten);

    // Freeze the buffer on release; existing strokes keep fading, no new points. The onboarding practice
    // steps drive the same trail via `onboarding:ptt` (the notch's `ptt:recording` is suppressed while
    // onboarding owns push-to-talk).
    const onRecording = (active: boolean) => {
      recordingRef.current = active;
      kick();
    };
    void listen<{ active?: boolean }>('ptt:recording', (e) => onRecording(Boolean(e.payload?.active))).then(addUnlisten);
    void listen<{ active?: boolean }>('onboarding:ptt', (e) => onRecording(Boolean(e.payload?.active))).then(addUnlisten);
    // Live recolor: the onboarding color pick (and any accent change) emits accent:changed with the hex.
    void listen<{ hex?: string }>('accent:changed', (e) => {
      const rgb = e.payload?.hex ? hexToRgb(e.payload.hex) : null;
      if (rgb) accentRgb = rgb;
    }).then(addUnlisten);

    kick();

    return () => {
      cancelled = true;
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
