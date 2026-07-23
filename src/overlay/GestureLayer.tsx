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

    const px = (p: TimedPoint) => p.x / dpr - displayBounds.x;
    const py = (p: TimedPoint) => p.y / dpr - displayBounds.y;

    const draw = () => {
      const now = performance.now();
      const maxAge = cfg.holdMs + cfg.fadeMs + cfg.windowMs + 200;
      bufferRef.current = bufferRef.current.filter((p) => now - p.t <= maxAge);
      ctx.clearRect(0, 0, cssW, cssH);
      const buf = bufferRef.current;
      ctx.globalAlpha = 1;
      ctx.lineWidth = cfg.trailWidthCssPx;

      const strokes = segmentGesturePath(buf, cfg);
      for (const stroke of strokes) {
        const pts = stroke.points;
        if (pts.length < 2) continue;
        const overallFade = smoothFade(now - pts[pts.length - 1].t);
        if (overallFade <= 0.01) continue;
        // ONE smooth continuous stroke (quadratic through midpoints) — no per-segment round-cap beads.
        // A head→tail alpha GRADIENT gives the comet fade (bright at the cursor → faint at the tail).
        const head = pts[pts.length - 1];
        const tail = pts[0];
        const hx = px(head);
        const hy = py(head);
        const tx = px(tail);
        const ty = py(tail);
        if (Math.hypot(hx - tx, hy - ty) < 2) {
          ctx.strokeStyle = `rgba(${accentRgb}, ${(cfg.headOpacity * overallFade).toFixed(3)})`;
        } else {
          const grad = ctx.createLinearGradient(hx, hy, tx, ty);
          grad.addColorStop(0, `rgba(${accentRgb}, ${(cfg.headOpacity * overallFade).toFixed(3)})`);
          grad.addColorStop(1, `rgba(${accentRgb}, ${(cfg.tailOpacity * overallFade).toFixed(3)})`);
          ctx.strokeStyle = grad;
        }
        ctx.beginPath();
        ctx.moveTo(px(pts[0]), py(pts[0]));
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (px(pts[i]) + px(pts[i + 1])) / 2;
          const my = (py(pts[i]) + py(pts[i + 1])) / 2;
          ctx.quadraticCurveTo(px(pts[i]), py(pts[i]), mx, my);
        }
        ctx.lineTo(px(pts[pts.length - 1]), py(pts[pts.length - 1]));
        ctx.stroke();
      }

      // The glowing comet head at the cursor — bright while active, fades out after release. Drawn last
      // so the shadow glow doesn't bleed onto the tail.
      if (buf.length) {
        const last = buf[buf.length - 1];
        const headFade = smoothFade(now - last.t);
        if (headFade > 0.02) {
          ctx.shadowBlur = cfg.glowRadiusCssPx;
          ctx.shadowColor = `rgb(${accentRgb})`;
          ctx.fillStyle = `rgba(${accentRgb}, ${(cfg.headOpacity * headFade).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(px(last), py(last), cfg.headDotRadiusCssPx, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

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
