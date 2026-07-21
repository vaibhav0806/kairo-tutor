//! Companion-cursor constants + types: glyph layout, comet-trail geometry, the
//! status-FX / mode enums, and the native event payload shapes. Pure data + types —
//! kept out of the engine hook so CursorApp reads as render and useCursorEngine reads
//! as behavior, not config.

import type { ScreenRegion } from '../core/types';
import type { DisplayBounds } from '../overlay/coordinates';

// How long the real mouse must sit still before the pet fades out on its own
// (item 2). Any real movement brings it straight back. Typing-hide (item 1) is
// independent and driven by the system cursor via the `cursor:visible` event.
export const IDLE_HIDE_MS = 3000;

// Glyph: a clean filled navigation arrowhead pointing up-right (NOT the mac
// pointer shape). Tip lives at viewBox (28,4); the element is GLYPH_SIZE px wide,
// so the tip anchor in element px is (TIP_AX, TIP_AY). The whole element is
// translated so that anchor lands on the spring position, and mirrored via scale
// about that same anchor for edge flips.
export const VIEWBOX = 32;
export const GLYPH_SIZE = 20;
export const TIP_AX = (28 / VIEWBOX) * GLYPH_SIZE;
export const TIP_AY = (4 / VIEWBOX) * GLYPH_SIZE;

// Comet trail behind the tip during flight. TRAIL_BASE is its unscaled length;
// the right edge is anchored at the tip (transform-origin 100% 50%) and it
// stretches/​fades with speed. Default brand purple gradient.
export const TRAIL_BASE = 44;
export const TRAIL_H = 8;
export const DEFAULT_ARROW_FILL = 'url(#kairo-cursor-grad)';
export const DEFAULT_TRAIL = `linear-gradient(to left, #7c3aed, #7c3aed00)`;
// While recording, the arrow core turns a live "mic on" red so listening is
// unmistakable even apart from the halo.
export const RECORDING_FILL = '#ff4d6d';

export type CursorFx = 'none' | 'listening' | 'thinking' | 'speaking';

export type CursorMode = 'shadow' | 'pointing' | 'drag';

export type MousePayload = { x: number; y: number };
export type PointPayload = { screenRegion: ScreenRegion; displayBounds: DisplayBounds; color?: string };
export type DragPayload = {
  fromRegion: ScreenRegion;
  toRegion: ScreenRegion;
  displayBounds: DisplayBounds;
  durationMs?: number;
  approachMs?: number;
  color?: string;
};

// In-flight pen-drag: an `approachMs` glide from wherever the pet was to the
// box's top-left corner, then a `durationMs` tween along the diagonal to the
// bottom-right corner. `prev*` feeds the comet trail (the spring integrator is
// bypassed while dragging). All coords are window-local px.
export type DragState = {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startX: number;
  startY: number;
  flipX: boolean;
  flipY: boolean;
  startMs: number | null;
  approachMs: number;
  durationMs: number;
  prevX: number;
  prevY: number;
};
