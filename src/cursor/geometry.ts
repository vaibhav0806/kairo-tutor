import type { ScreenRegion } from '../core/types';
import type { DisplayBounds } from '../overlay/coordinates';

// All geometry here works in display-LOCAL points (CSS px inside the cursor
// window), the same space the overlay uses: region ÷ scaleFactor − display origin.

export type LocalRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

// A pulsing ring sits on the target point; the arrow rests a short standoff away,
// tip aimed at the ring. `flip*` mirrors the glyph so its body stays on-screen.
export type PointingTip = {
  tipX: number;
  tipY: number;
  ringX: number;
  ringY: number;
  flipX: boolean;
  flipY: boolean;
};

// Distance (per axis) from the target point to the arrow tip, so the arrow hugs
// the box corner closely without sitting on top of it.
export const POINTING_STANDOFF = 8;
// Rough on-screen reach of the glyph body from its tip; used to decide edge flips.
export const GLYPH_REACH = 34;

// Offset of the shadow cursor's tip from the real mouse hotspot. The body extends
// down-left from the tip, so this parks the pet just below-left of the system
// cursor (slightly left + lower so it doesn't sit on top of it).
export const SHADOW_OFFSET_X = -2;
export const SHADOW_OFFSET_Y = 16;

export function regionToLocalRect(region: ScreenRegion, displayBounds: DisplayBounds): LocalRect {
  const scaleFactor = displayBounds.scaleFactor > 0 ? displayBounds.scaleFactor : 1;
  return {
    left: region.x / scaleFactor - displayBounds.x,
    top: region.y / scaleFactor - displayBounds.y,
    width: region.width / scaleFactor,
    height: region.height / scaleFactor
  };
}

// Compute the ring center (the element's middle) and the arrow's resting tip just
// off it. Default: arrow points up-right, body down-left. Flips horizontally near
// the left edge and vertically near the bottom edge so the body stays on-screen.
export function pointingTip(region: ScreenRegion, displayBounds: DisplayBounds): PointingTip {
  const rect = regionToLocalRect(region, displayBounds);
  const ringX = rect.left + rect.width / 2;
  const ringY = rect.top + rect.height / 2;

  const wantFlipX = ringX - POINTING_STANDOFF - GLYPH_REACH < 0;
  const wantFlipY = ringY + POINTING_STANDOFF + GLYPH_REACH > displayBounds.height;

  const tipX = ringX + (wantFlipX ? POINTING_STANDOFF : -POINTING_STANDOFF);
  const tipY = ringY + (wantFlipY ? -POINTING_STANDOFF : POINTING_STANDOFF);

  return { tipX, tipY, ringX, ringY, flipX: wantFlipX, flipY: wantFlipY };
}

// Resting tip for shadow mode: trail just below the real cursor.
export function shadowTip(mouseX: number, mouseY: number): { x: number; y: number } {
  return { x: mouseX + SHADOW_OFFSET_X, y: mouseY + SHADOW_OFFSET_Y };
}
