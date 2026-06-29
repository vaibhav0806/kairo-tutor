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

// Where the arrow's tip should rest, and whether the glyph is mirrored so it stays
// on-screen and still points inward at the object.
export type PointingTip = {
  x: number;
  y: number;
  flipX: boolean;
  flipY: boolean;
};

// Gap between the tip and the object's corner so the arrow never overlaps it.
export const POINTING_GAP = 8;
// Rough on-screen reach of the glyph body from its tip; used to decide edge flips.
export const GLYPH_REACH = 34;

// Offset of the shadow cursor's tip from the real mouse hotspot. The body extends
// down-left from the tip, so this parks the pet just below the system cursor.
export const SHADOW_OFFSET_X = 6;
export const SHADOW_OFFSET_Y = 10;

export function regionToLocalRect(region: ScreenRegion, displayBounds: DisplayBounds): LocalRect {
  const scaleFactor = displayBounds.scaleFactor > 0 ? displayBounds.scaleFactor : 1;
  return {
    left: region.x / scaleFactor - displayBounds.x,
    top: region.y / scaleFactor - displayBounds.y,
    width: region.width / scaleFactor,
    height: region.height / scaleFactor
  };
}

// Compute the resting tip + orientation for pointing at `region`. Default: arrow
// points up-right, body down-left, tip just off the object's bottom-left corner.
// Flips horizontally near the left edge and vertically near the bottom edge so the
// body never runs off-screen.
export function pointingTip(region: ScreenRegion, displayBounds: DisplayBounds): PointingTip {
  const rect = regionToLocalRect(region, displayBounds);
  const bottom = rect.top + rect.height;

  const wantFlipX = rect.left - POINTING_GAP - GLYPH_REACH < 0;
  const wantFlipY = bottom + POINTING_GAP + GLYPH_REACH > displayBounds.height;

  // Anchor corner of the object the tip points at, chosen per flip so the body
  // always extends toward open screen space.
  const anchorX = wantFlipX ? rect.left + rect.width : rect.left;
  const anchorY = wantFlipY ? rect.top : bottom;

  const x = anchorX + (wantFlipX ? POINTING_GAP : -POINTING_GAP);
  const y = anchorY + (wantFlipY ? -POINTING_GAP : POINTING_GAP);

  return { x, y, flipX: wantFlipX, flipY: wantFlipY };
}

// Resting tip for shadow mode: trail just below the real cursor.
export function shadowTip(mouseX: number, mouseY: number): { x: number; y: number } {
  return { x: mouseX + SHADOW_OFFSET_X, y: mouseY + SHADOW_OFFSET_Y };
}
