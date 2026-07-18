// src/notch/compositeMarks.ts
import type { NativeScreenCapture } from '../native/nativeBridge';
import type { GestureStroke } from './gestureSegmenter';
import { gestureConfig } from '../config/gesture';

type Xy = { x: number; y: number };
type GeomCapture = {
  displayBounds: { x: number; y: number; scaleFactor: number };
  imageGeometry: { rawWidth: number; encodedWidth: number };
};

// Physical global px (cursor:mouse space) → encoded image px (the base64 image).
// raw* is the display's physical size; encoded* is the downscaled image size.
export function physicalToEncoded(p: Xy, capture: GeomCapture): Xy {
  const sf = capture.displayBounds.scaleFactor > 0 ? capture.displayBounds.scaleFactor : 1;
  const scale = capture.imageGeometry.encodedWidth / capture.imageGeometry.rawWidth;
  const originX = capture.displayBounds.x * sf;
  const originY = capture.displayBounds.y * sf;
  return { x: (p.x - originX) * scale, y: (p.y - originY) * scale };
}
