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
// stretches/​fades with speed. Threaded through the accent CSS vars (§11B).
export const TRAIL_BASE = 40;
export const TRAIL_H = 7;
export const DEFAULT_ARROW_FILL = 'url(#kairo-cursor-grad)';
export const DEFAULT_TRAIL = `linear-gradient(to left, var(--cur-accent), rgb(var(--cur-accent-rgb) / 0))`;
// While recording, the arrow core switches to the accent's "hot" (vivid, saturated)
// tint so listening is unmistakable even apart from the halo. Derived from the user's
// accent (§11B) rather than a fixed red — see cursorTheme.accentTints().
export const RECORDING_FILL = 'var(--cur-accent-hot)';

// One-shot expressive beats (additive; fired by onboarding, reusable in-product). The JS
// clears data-beat after these windows — kept slightly longer than the CSS animations so
// cleanup never truncates them. Reduced-motion uses the shorter, dampened variants.
export const ENTRANCE_MS = 640;
export const ENTRANCE_REDUCED_MS = 240;
export const CELEBRATE_MS = 720;
export const CELEBRATE_REDUCED_MS = 260;

export type CursorFx = 'none' | 'listening' | 'thinking' | 'speaking';

export type CursorBeat = 'entrance' | 'celebrate';

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
