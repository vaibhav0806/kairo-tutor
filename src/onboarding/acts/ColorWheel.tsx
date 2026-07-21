import { useEffect, useRef, useState, type PointerEvent as RPE } from 'react';
import { hexToHsv, hsvToHex } from '../color';

const SIZE = 200,
  R = SIZE / 2;

// A full HSV wheel (hue = angle, saturation = radius) with a value/lightness slider — any hue
// (beats Clicky's fixed swatches, §5). Canvas-drawn; pointer drag reports a live hex.
export function ColorWheel({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [{ h, s, v }, setHsv] = useState(() => hexToHsv(value));

  // Draw the hue/sat disc at the current value (and whenever value changes).
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const dx = x - R,
          dy = y - R,
          dist = Math.hypot(dx, dy);
        const i = (y * SIZE + x) * 4;
        if (dist > R) {
          img.data[i + 3] = 0;
          continue;
        }
        const hue = (Math.atan2(dy, dx) * 180) / Math.PI + 180;
        const sat = Math.min(1, dist / R);
        const hex = hsvToHex(hue, sat, v);
        img.data[i] = parseInt(hex.slice(1, 3), 16);
        img.data[i + 1] = parseInt(hex.slice(3, 5), 16);
        img.data[i + 2] = parseInt(hex.slice(5, 7), 16);
        img.data[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
  }, [v]);

  const pick = (e: RPE) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const dx = e.clientX - rect.left - R,
      dy = e.clientY - rect.top - R;
    const dist = Math.min(R, Math.hypot(dx, dy));
    const hue = (Math.atan2(dy, dx) * 180) / Math.PI + 180;
    const sat = dist / R;
    const hex = hsvToHex(hue, sat, v);
    setHsv({ h: hue, s: sat, v });
    onChange(hex);
  };

  return (
    <div className="ob-wheel">
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        className="ob-wheel-disc"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          pick(e);
        }}
        onPointerMove={(e) => e.buttons === 1 && pick(e)}
      />
      <input
        className="ob-wheel-slider"
        type="range"
        min={0.35}
        max={1}
        step={0.01}
        value={v}
        onChange={(e) => {
          const nv = Number(e.target.value);
          const hex = hsvToHex(h, s, nv);
          setHsv({ h, s, v: nv });
          onChange(hex);
        }}
      />
      <span className="ob-wheel-swatch" style={{ background: value }} />
    </div>
  );
}
