// src/overlay/GestureLayer.tsx
import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { segmentGesturePath, type TimedPoint } from '../notch/gestureSegmenter';
import { gestureConfig } from '../config/gesture';
import { klog } from '../core/logger';
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

    // A pre-rendered glow sprite for the comet head. ctx.shadowBlur runs a real blur pass on every
    // fill, so doing it per frame is one of the most expensive things canvas 2D offers; the glow
    // never changes shape, so it is drawn once here and blitted after that.
    const glowRadius = cfg.glowRadiusCssPx + cfg.headDotRadiusCssPx;
    const glow = document.createElement('canvas');
    glow.width = Math.ceil(glowRadius * 2 * dpr);
    glow.height = Math.ceil(glowRadius * 2 * dpr);
    let glowTint = '';
    const paintGlowSprite = (rgb: string) => {
      const gctx = glow.getContext('2d');
      if (!gctx) return;
      gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gctx.clearRect(0, 0, glowRadius * 2, glowRadius * 2);
      const gradient = gctx.createRadialGradient(
        glowRadius,
        glowRadius,
        0,
        glowRadius,
        glowRadius,
        glowRadius
      );
      gradient.addColorStop(0, `rgb(${rgb})`);
      gradient.addColorStop(cfg.headDotRadiusCssPx / glowRadius, `rgba(${rgb}, 0.85)`);
      gradient.addColorStop(1, `rgba(${rgb}, 0)`);
      gctx.fillStyle = gradient;
      gctx.beginPath();
      gctx.arc(glowRadius, glowRadius, glowRadius, 0, Math.PI * 2);
      gctx.fill();
      glowTint = rgb;
    };

    let raf = 0;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    // The region actually painted last frame. Clearing the WHOLE canvas each frame damaged a
    // full-screen transparent layer — 7.6M pixels on this display — which forces WebKit to re-upload
    // it and the window server to recomposite the entire desktop area, 60 times a second, for a
    // trail that occupies a few hundred pixels. Clearing only what was drawn keeps the damage rect
    // the size of the comet.
    // Held in an object: TypeScript's control-flow analysis cannot see that the `mark` closure
    // below reassigns a bare `let`, and would narrow it to `never` after the clear.
    const damage: { rect: { x0: number; y0: number; x1: number; y1: number } | null } = { rect: null };
    let frames = 0;
    let worstFrameMs = 0;
    let cachedStrokes: ReturnType<typeof segmentGesturePath> = [];
    let cachedSignature = '';
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

      // Erase exactly what the previous frame painted — nothing else on this canvas is ours.
      const previous = damage.rect;
      if (previous) {
        ctx.clearRect(previous.x0, previous.y0, previous.x1 - previous.x0, previous.y1 - previous.y0);
        damage.rect = null;
      }
      // Pad by half the stroke, the glow, and a pixel of slop for the quadratic's overshoot.
      const pad = cfg.trailWidthCssPx / 2 + glowRadius + 2;
      const mark = (x: number, y: number) => {
        const rect = damage.rect;
        if (!rect) {
          damage.rect = { x0: x - pad, y0: y - pad, x1: x + pad, y1: y + pad };
          return;
        }
        if (x - pad < rect.x0) rect.x0 = x - pad;
        if (y - pad < rect.y0) rect.y0 = y - pad;
        if (x + pad > rect.x1) rect.x1 = x + pad;
        if (y + pad > rect.y1) rect.y1 = y + pad;
      };

      const buf = bufferRef.current;
      ctx.globalAlpha = 1;
      ctx.lineWidth = cfg.trailWidthCssPx;

      // Re-segment only when the buffer actually changed. During a hold that is every frame, but
      // the ~600ms fade after release redraws a stream nobody is adding to — no need to re-derive
      // the same strokes 40 more times on the way out.
      const signature = buf.length === 0 ? '' : `${buf.length}:${buf[0].t}:${buf[buf.length - 1].t}`;
      if (signature !== cachedSignature) {
        cachedStrokes = segmentGesturePath(buf, cfg);
        cachedSignature = signature;
      }
      const strokes = cachedStrokes;
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
        mark(px(pts[0]), py(pts[0]));
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (px(pts[i]) + px(pts[i + 1])) / 2;
          const my = (py(pts[i]) + py(pts[i + 1])) / 2;
          ctx.quadraticCurveTo(px(pts[i]), py(pts[i]), mx, my);
          mark(px(pts[i]), py(pts[i]));
        }
        ctx.lineTo(px(pts[pts.length - 1]), py(pts[pts.length - 1]));
        mark(px(pts[pts.length - 1]), py(pts[pts.length - 1]));
        ctx.stroke();
      }

      // The glowing comet head at the cursor — bright while active, fades out after release. Drawn last
      // so the shadow glow doesn't bleed onto the tail.
      if (buf.length) {
        const last = buf[buf.length - 1];
        const headFade = smoothFade(now - last.t);
        if (headFade > 0.02) {
          if (glowTint !== accentRgb) paintGlowSprite(accentRgb);
          const hx = px(last);
          const hy = py(last);
          ctx.globalAlpha = cfg.headOpacity * headFade;
          ctx.drawImage(glow, hx - glowRadius, hy - glowRadius, glowRadius * 2, glowRadius * 2);
          ctx.globalAlpha = 1;
          mark(hx, hy);
        }
      }

      // Keep the damage rect inside the canvas — clearRect outside it is wasted work.
      const painted = damage.rect;
      if (painted) {
        painted.x0 = Math.max(0, painted.x0);
        painted.y0 = Math.max(0, painted.y0);
        painted.x1 = Math.min(cssW, painted.x1);
        painted.y1 = Math.min(cssH, painted.y1);
      }

      // Frame cost, sampled: the trail is the one surface that has to keep up with the hand, so a
      // regression here should be visible in the log rather than only in the feel.
      const frameMs = performance.now() - now;
      if (frameMs > worstFrameMs) worstFrameMs = frameMs;
      frames += 1;
      if (frames % 240 === 0) {
        klog('overlay', 'debug', 'gesture trail frames', {
          frames,
          points: buf.length,
          worst_ms: Number(worstFrameMs.toFixed(2))
        });
        worstFrameMs = 0;
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
