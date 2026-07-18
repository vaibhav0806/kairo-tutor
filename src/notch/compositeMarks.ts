// src/notch/compositeMarks.ts
import type { NativeScreenCapture } from '../native/nativeBridge';
import type { GestureStroke } from './gestureSegmenter';
import { gestureConfig } from '../config/gesture';

type Xy = { x: number; y: number };
type GeomCapture = {
  displayBounds: { x: number; y: number; scaleFactor: number };
  imageGeometry: { rawWidth: number; rawHeight: number; encodedWidth: number; encodedHeight: number };
};

// Physical global px (cursor:mouse space) → encoded image px (the base64 image).
// raw* is the display's physical size; encoded* is the downscaled image size.
// Scale X and Y independently so a non-uniform downscale can't skew the marks.
export function physicalToEncoded(p: Xy, capture: GeomCapture): Xy {
  const sf = capture.displayBounds.scaleFactor > 0 ? capture.displayBounds.scaleFactor : 1;
  const scaleX = capture.imageGeometry.encodedWidth / capture.imageGeometry.rawWidth;
  const scaleY = capture.imageGeometry.encodedHeight / capture.imageGeometry.rawHeight;
  const originX = capture.displayBounds.x * sf;
  const originY = capture.displayBounds.y * sf;
  return { x: (p.x - originX) * scaleX, y: (p.y - originY) * scaleY };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('composite: image decode failed'));
    img.src = src;
  });
}

// Draw truth strokes onto a clean screenshot and return a new capture whose
// imageBase64 is the composited JPEG. Returns the input unchanged if there is
// nothing to draw or the capture lacks geometry.
export async function compositeMarks(
  capture: NativeScreenCapture,
  strokes: GestureStroke[]
): Promise<NativeScreenCapture> {
  if (
    strokes.length === 0 ||
    !capture.captured ||
    !capture.imageBase64 ||
    !capture.imageMimeType ||
    !capture.imageGeometry ||
    !capture.displayBounds
  ) {
    return capture;
  }
  const geom = { displayBounds: capture.displayBounds, imageGeometry: capture.imageGeometry };
  const img = await loadImage(`data:${capture.imageMimeType};base64,${capture.imageBase64}`);
  const canvas = document.createElement('canvas');
  canvas.width = capture.imageGeometry.encodedWidth;
  canvas.height = capture.imageGeometry.encodedHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return capture;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const scale = capture.imageGeometry.encodedWidth / capture.imageGeometry.rawWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(gestureConfig.compositeWidthPx * scale, 2);

  strokes.forEach((stroke, index) => {
    const alpha = stroke.confident ? gestureConfig.alphaConfident : gestureConfig.alphaBorderline;
    ctx.strokeStyle = withAlpha(gestureConfig.strokeColor, alpha);
    ctx.beginPath();
    stroke.points.forEach((p, i) => {
      const e = physicalToEncoded(p, geom);
      if (i === 0) ctx.moveTo(e.x, e.y);
      else ctx.lineTo(e.x, e.y);
    });
    ctx.stroke();
    if (strokes.length > 1) drawNumber(ctx, physicalToEncoded(stroke.points[0], geom), index + 1);
  });

  const dataUrl = canvas.toDataURL('image/jpeg', gestureConfig.jpegQuality);
  const newBase64 = dataUrl.split(',')[1];
  return {
    ...capture,
    imageBase64: newBase64,
    imageMimeType: 'image/jpeg',
    byteLength: Math.floor((newBase64.length * 3) / 4)
  };
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawNumber(ctx: CanvasRenderingContext2D, at: { x: number; y: number }, label: number): void {
  const r = gestureConfig.labelRadiusPx;
  ctx.save();
  ctx.fillStyle = withAlpha(gestureConfig.strokeColor, gestureConfig.labelAlpha);
  ctx.beginPath();
  ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = `bold ${Math.round(r * 1.4)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(label), at.x, at.y);
  ctx.restore();
}
