# Hold-to-Point Gestures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ⌥⇧P toggle pen with cursor gestures captured during the ⌥⌃ talk-hold: intentional pointing is detected, shown as a translucent ~1s-fading mark (cosmetic) and composited full-strength onto the screenshot sent to fable.

**Architecture:** The native mouse tracker already emits `cursor:mouse` at ~60 Hz; we broadcast it app-wide. Two independent consumers share one pure segmenter: the **overlay** renders fading strokes (cosmetic, opacity by age), the **notch** buffers points during the hold and, at key-release, segments them into truth strokes and composites them onto the clean release screenshot before the tutor turn. No local element detection — fable interprets the marks as hints.

**Tech Stack:** React 19 + TypeScript (webviews), Rust + Tauri (native), vitest (node-env unit tests), HTML canvas for compositing.

---

## Design facts (verified against current code)

- `cursor:mouse` payload = `{ x, y }` in **physical px, global top-left** (`panels.rs:341`, `types.rs:128-133`). No timestamp — the consumer stamps arrival time.
- `UserAnnotation` (`src/core/types.ts:7-12`) = `{ id, type, screenRegion, points? }`; `points`/`screenRegion` are in **global-screen physical px** (same space as `cursor:mouse`). Build one from raw physical points with `createAnnotationFromPoints` (`src/annotations/annotationTools.ts:63-76`) — do **not** use `createPenAnnotationFromDisplayPoints`, which re-applies `toScreenPoint` and would double-transform.
- Pen strokes render via `OverlayAnnotationShape` (`OverlayApp.tsx:40-81`): global px → canvas CSS px is `point.x / scaleFactor - displayBounds.x - left`. Stroke styled by CSS `.annotation-shape.pen polyline` (`styles.css:275-282`) with no opacity — we add per-stroke `stroke-opacity`.
- Screenshot: `capture_screen` → `NativeScreenCapture` (`nativeBridge.ts:42-63`): `imageBase64` + `imageMimeType`, `imageGeometry.{rawWidth,rawHeight,encodedWidth,encodedHeight}`, `displayBounds.{x,y,width,height,scaleFactor}`. `raw*` = physical px of the main display; `encoded*` = the base64 image's real pixel size; `displayBounds` = logical points, `scaleFactor` = physical/logical.
- Capture happens at **release**: `ptt:audio` → `processCapturedAudio` → `captureScreen()` (`NotchApp.tsx:1918-1924`), handed to the turn via `submitQuery` → `askTutorFromNotch({ screenCapture })` (`NotchApp.tsx:1396-1406`). `notchTutor.ts:80-83` re-captures only when `annotations.length > 0`.
- Overlay capture inclusion is mode-based (`panels.rs:478-486`): `annotate`/`annotation_preview` are included; anything else is excluded. Our new `gesture` mode must be **click-through + excluded** (base shot stays clean).
- `ptt:recording {active}` fires on hold-confirm (true) and release (false) (`NotchApp.tsx:1717-1725`, native `input.rs`).

## File structure

**Create:**
- `src/config/gesture.ts` — all gesture tuning (frontend analog of `constants.rs`; detection/render/composite run in webviews).
- `src/notch/gestureSegmenter.ts` — pure detection: `classifyWindow`, `segmentGesturePath` + geometry helpers. Unit-tested.
- `src/notch/compositeMarks.ts` — `physicalToEncoded` (pure, tested) + `compositeMarks` (canvas, manual-verify).
- `src/overlay/GestureLayer.tsx` — cosmetic fading render, consumes `cursor:mouse`.
- `tests/gestureSegmenter.test.ts`, `tests/compositeMarks.test.ts`.

**Modify:**
- `src-tauri/src/panels.rs` — broadcast `cursor:mouse` app-wide; handle `gesture` overlay mode.
- `src-tauri/src/lib.rs` — remove ⌥⇧P; add `save_gesture_debug_image` command.
- `src-tauri/src/prompts.rs` — add the gesture-hint paragraph.
- `src/native/nativeBridge.ts` — add `gesture` mode to payload types; add debug-save wrapper.
- `src/overlay/OverlayApp.tsx` — render `GestureLayer` on `mode === 'gesture'`.
- `src/notch/NotchApp.tsx` — gesture buffer + hold wiring + composite at release; remove pen UI/listener/`startAnnotation`.

---

## Task 1: Gesture config

**Files:**
- Create: `src/config/gesture.ts`

- [ ] **Step 1: Write the config module**

```ts
// src/config/gesture.ts
// Tuning for hold-to-point gestures. All logic runs in the webviews (notch +
// overlay), so config lives here (the frontend analog of src-tauri/constants.rs).
// Distances are in PHYSICAL px (cursor:mouse space). Tune with the debug images
// (GESTURE_DEBUG_IMAGES) then rebuild.

export const gestureConfig = {
  // Detection ------------------------------------------------------------
  windowMs: 200, // sliding window for per-point classification
  minPathPx: 45, // below this total movement in the window = rest (ignored)
  directnessMax: 0.5, // net/path below this = localized gesture
  turningMin: 1.0, // radians of accumulated turning in the window = curved gesture (catches big circles)
  minStrokePts: 4, // discard strokes shorter than this on close
  minStrokePathPx: 60, // discard strokes whose total path is below this
  confidentDwellMs: 180, // a stroke lasting at least this long renders/composites as "confident"

  // Cosmetic render ------------------------------------------------------
  fadeMs: 900, // on-screen stroke fades to nothing over this (competitor look)
  strokeColor: '#a78bfa', // Kairo accent
  strokeWidthCssPx: 5, // on-screen stroke width (CSS px)

  // Composite (image sent to fable) --------------------------------------
  compositeWidthPx: 6, // stroke width in physical px, scaled to the encoded image
  alphaConfident: 0.85,
  alphaBorderline: 0.5,
  jpegQuality: 0.9,

  // Debug ----------------------------------------------------------------
  debugImages: false // true = save each composited image + open the folder once
} as const;

export type GestureConfig = typeof gestureConfig;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (new file, no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add src/config/gesture.ts
git commit -m "feat(gesture): add hold-to-point tuning config"
```

---

## Task 2: Pure gesture segmenter (TDD)

**Files:**
- Create: `src/notch/gestureSegmenter.ts`
- Test: `tests/gestureSegmenter.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/gestureSegmenter.test.ts
import { describe, it, expect } from 'vitest';
import { segmentGesturePath, type TimedPoint } from '../src/notch/gestureSegmenter';
import { gestureConfig } from '../src/config/gesture';

const cfg = gestureConfig;

// Build a point stream at ~60Hz (16ms/step) from an (x,y) generator.
function stream(gen: (i: number) => { x: number; y: number }, n: number, startT = 0): TimedPoint[] {
  return Array.from({ length: n }, (_, i) => ({ ...gen(i), t: startT + i * 16 }));
}

function circle(cx: number, cy: number, r: number, n: number, startT = 0): TimedPoint[] {
  return stream((i) => {
    const a = (i / (n - 1)) * Math.PI * 2;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }, n, startT);
}

function line(x0: number, y0: number, x1: number, y1: number, n: number, startT = 0): TimedPoint[] {
  return stream((i) => {
    const f = i / (n - 1);
    return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f };
  }, n, startT);
}

describe('segmentGesturePath', () => {
  it('ignores a resting cursor (no strokes)', () => {
    const pts = stream(() => ({ x: 500, y: 500 }), 40);
    expect(segmentGesturePath(pts, cfg)).toHaveLength(0);
  });

  it('drops straight travel across the screen', () => {
    const pts = line(100, 100, 1200, 100, 40);
    expect(segmentGesturePath(pts, cfg)).toHaveLength(0);
  });

  it('keeps a small circle as one stroke', () => {
    const pts = circle(400, 400, 40, 40);
    expect(segmentGesturePath(pts, cfg)).toHaveLength(1);
  });

  it('keeps a big circle as one stroke (curvature, not spread)', () => {
    const pts = circle(700, 500, 300, 60);
    expect(segmentGesturePath(pts, cfg)).toHaveLength(1);
  });

  it('keeps a back-and-forth underline', () => {
    const fwd = line(200, 600, 500, 600, 20);
    const back = line(500, 600, 200, 600, 20, 20 * 16);
    expect(segmentGesturePath([...fwd, ...back], cfg)).toHaveLength(1);
  });

  it('circle → travel → circle yields two strokes, no connector', () => {
    const a = circle(200, 200, 45, 40, 0);
    const travel = line(200, 200, 1100, 200, 30, 40 * 16);
    const b = circle(1100, 200, 45, 40, 70 * 16);
    const strokes = segmentGesturePath([...a, ...travel, ...b], cfg);
    expect(strokes).toHaveLength(2);
  });

  it('marks a sustained stroke confident and a brief one borderline', () => {
    const sustained = circle(400, 400, 60, 40); // ~640ms
    const [s] = segmentGesturePath(sustained, cfg);
    expect(s.confident).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- gestureSegmenter`
Expected: FAIL with "Cannot find module '../src/notch/gestureSegmenter'".

- [ ] **Step 3: Implement the segmenter**

```ts
// src/notch/gestureSegmenter.ts
import type { GestureConfig } from '../config/gesture';

export type TimedPoint = { x: number; y: number; t: number }; // physical px, ms
export type GestureStroke = { points: TimedPoint[]; confident: boolean };

function dist(a: TimedPoint, b: TimedPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Absolute turn angle (radians) at b, between segment a→b and b→c.
function turn(a: TimedPoint, b: TimedPoint, c: TimedPoint): number {
  const v1x = b.x - a.x, v1y = b.y - a.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const cross = v1x * v2y - v1y * v2x;
  const dot = v1x * v2x + v1y * v2y;
  const ang = Math.atan2(cross, dot);
  return Math.abs(ang);
}

// The slice of points within `windowMs` ending at index i.
function windowEndingAt(points: TimedPoint[], i: number, windowMs: number): TimedPoint[] {
  const endT = points[i].t;
  let start = i;
  while (start > 0 && endT - points[start - 1].t <= windowMs) start--;
  return points.slice(start, i + 1);
}

export function classifyWindow(win: TimedPoint[], cfg: GestureConfig): 'rest' | 'gesture' | 'travel' {
  if (win.length < 2) return 'rest';
  let path = 0;
  for (let i = 1; i < win.length; i++) path += dist(win[i - 1], win[i]);
  if (path < cfg.minPathPx) return 'rest';
  let turning = 0;
  for (let i = 2; i < win.length; i++) turning += turn(win[i - 2], win[i - 1], win[i]);
  const net = dist(win[0], win[win.length - 1]);
  const directness = net / path;
  if (directness < cfg.directnessMax || turning > cfg.turningMin) return 'gesture';
  return 'travel';
}

function finalize(points: TimedPoint[], out: GestureStroke[], cfg: GestureConfig): void {
  if (points.length < cfg.minStrokePts) return;
  let path = 0;
  for (let i = 1; i < points.length; i++) path += dist(points[i - 1], points[i]);
  if (path < cfg.minStrokePathPx) return;
  const duration = points[points.length - 1].t - points[0].t;
  out.push({ points, confident: duration >= cfg.confidentDwellMs });
}

// Segment a full point stream into gesture bursts. Travel/rest windows break
// the current stroke, so "circle → travel → circle" yields two strokes with no
// connecting line. Pure + deterministic — also re-runnable each frame for the
// live cosmetic render.
export function segmentGesturePath(points: TimedPoint[], cfg: GestureConfig): GestureStroke[] {
  const strokes: GestureStroke[] = [];
  let cur: TimedPoint[] | null = null;
  for (let i = 0; i < points.length; i++) {
    const cls = classifyWindow(windowEndingAt(points, i, cfg.windowMs), cfg);
    if (cls === 'gesture') {
      if (!cur) cur = [];
      cur.push(points[i]);
    } else if (cur) {
      finalize(cur, strokes, cfg);
      cur = null;
    }
  }
  if (cur) finalize(cur, strokes, cfg);
  return strokes;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- gestureSegmenter`
Expected: PASS (7 tests). If the big-circle or underline test fails, adjust `turningMin`/`directnessMax` in `src/config/gesture.ts` and re-run — the thresholds are the tuning surface.

- [ ] **Step 5: Commit**

```bash
git add src/notch/gestureSegmenter.ts tests/gestureSegmenter.test.ts
git commit -m "feat(gesture): pure directness+curvature segmenter with tests"
```

---

## Task 3: Coordinate mapping helper (TDD)

**Files:**
- Create: `src/notch/compositeMarks.ts` (pure part only in this task)
- Test: `tests/compositeMarks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/compositeMarks.test.ts
import { describe, it, expect } from 'vitest';
import { physicalToEncoded } from '../src/notch/compositeMarks';

const capture = {
  displayBounds: { x: 0, y: 0, width: 1440, height: 900, scaleFactor: 2 },
  imageGeometry: { rawWidth: 2880, rawHeight: 1800, encodedWidth: 1280, encodedHeight: 800 }
};

describe('physicalToEncoded', () => {
  it('maps top-left physical origin to image origin', () => {
    expect(physicalToEncoded({ x: 0, y: 0 }, capture)).toEqual({ x: 0, y: 0 });
  });

  it('scales physical px down to encoded px', () => {
    // scale = 1280/2880 = 0.4444...
    const p = physicalToEncoded({ x: 2880, y: 1800 }, capture);
    expect(p.x).toBeCloseTo(1280, 5);
    expect(p.y).toBeCloseTo(800, 5);
  });

  it('subtracts a non-zero display origin (secondary display)', () => {
    const cap = { ...capture, displayBounds: { ...capture.displayBounds, x: 1440, y: 0 } };
    // physical origin = x(1440) * scaleFactor(2) = 2880; point at physical 2880 → image 0
    expect(physicalToEncoded({ x: 2880, y: 0 }, cap).x).toBeCloseTo(0, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- compositeMarks`
Expected: FAIL with "Cannot find module '../src/notch/compositeMarks'".

- [ ] **Step 3: Implement the pure helper**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- compositeMarks`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/notch/compositeMarks.ts tests/compositeMarks.test.ts
git commit -m "feat(gesture): physical→encoded coord mapping with tests"
```

---

## Task 4: Canvas compositor

**Files:**
- Modify: `src/notch/compositeMarks.ts`

No unit test (needs DOM canvas — verified manually via debug images in Task 9/13).

- [ ] **Step 1: Append the compositor**

```ts
// src/notch/compositeMarks.ts  (append below physicalToEncoded)

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
  return { ...capture, imageBase64: dataUrl.split(',')[1], imageMimeType: 'image/jpeg' };
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawNumber(ctx: CanvasRenderingContext2D, at: { x: number; y: number }, label: number): void {
  ctx.save();
  ctx.fillStyle = 'rgba(167,139,250,0.95)';
  ctx.beginPath();
  ctx.arc(at.x, at.y, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(label), at.x, at.y);
  ctx.restore();
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/notch/compositeMarks.ts
git commit -m "feat(gesture): canvas compositor draws truth strokes onto the shot"
```

---

## Task 5: Broadcast `cursor:mouse` app-wide

**Files:**
- Modify: `src-tauri/src/panels.rs:341`

Currently the tracker emits only to the cursor window; the overlay and notch need it too.

- [ ] **Step 1: Change the emit target**

Replace (`panels.rs:341`):

```rust
            let _ = window.emit("cursor:mouse", MousePoint { x, y });
```

with:

```rust
            // Broadcast app-wide so the cursor pet, the overlay (cosmetic gesture
            // render) and the notch (truth buffer) all receive it. Payload is
            // physical px, global top-left; each webview scales as needed.
            let _ = app.emit("cursor:mouse", MousePoint { x, y });
```

(`app` is the `AppHandle` already used in the same loop at `app.cursor_position()`; the `Emitter` trait is already in scope.)

- [ ] **Step 2: Compile-check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS. If `app` was moved into the closure and not available, capture an `app.clone()` before the thread and use it — verify by reading the surrounding `spawn_mouse_tracker` body.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/panels.rs
git commit -m "feat(gesture): broadcast cursor:mouse app-wide"
```

---

## Task 6: Add the `gesture` overlay mode (native + bridge types)

**Files:**
- Modify: `src-tauri/src/panels.rs:449-489` (`configure_overlay_window`)
- Modify: `src/native/nativeBridge.ts:99-105` (`NativeOverlayPayload`)
- Modify: `src/overlay/OverlayApp.tsx:23-29` (`OverlayPayload`)

- [ ] **Step 1: Make `gesture` click-through + excluded from capture**

In `configure_overlay_window` (`panels.rs`), the mode already drives click-through via `is_annotation_mode` and capture via `shows_user_marks`. `gesture` must be click-through (not annotate) and excluded (not in `shows_user_marks`) — which is already the default `else` behavior for any unrecognized mode. Add an explicit comment so it's intentional, right after the `shows_user_marks` binding (`panels.rs:479-482`):

```rust
    // "gesture" (hold-to-point cosmetic layer) intentionally falls here: it is
    // click-through (is_annotation_mode == false) AND excluded from capture, so
    // the fading marks never leak into the base screenshot — the notch composites
    // the truth marks in code instead.
    let shows_user_marks = matches!(
        payload.mode.as_deref(),
        Some("annotate") | Some("annotation_preview")
    );
```

(No behavior change needed — `gesture` already resolves to click-through + excluded. This step is the comment + confirming the branch during review.)

- [ ] **Step 2: Add `gesture` to the frontend payload types**

`nativeBridge.ts:99` — change:

```ts
export type NativeOverlayPayload = {
  mode?: 'visual' | 'annotate' | 'annotation_preview';
```

to:

```ts
export type NativeOverlayPayload = {
  mode?: 'visual' | 'annotate' | 'annotation_preview' | 'gesture';
```

`OverlayApp.tsx:24` — change:

```ts
  mode?: 'visual' | 'annotate' | 'annotation_preview';
```

to:

```ts
  mode?: 'visual' | 'annotate' | 'annotation_preview' | 'gesture';
```

Also add a `showGestureOverlay` wrapper to the bridge object in `nativeBridge.ts` (mirrors `showAnnotationOverlay` at `394-412`, but mode `gesture` and no tool). It reuses the existing internal `createAnnotationOverlayBounds` helper so the overlay covers the full display, and `show_overlay` makes the panel visible + routes the mode through `configure_overlay_window`:

```ts
async showGestureOverlay(displayBounds: NativeOverlayDisplayBounds) {
  try {
    const overlayDisplayBounds = createAnnotationOverlayBounds(displayBounds);
    await invoke<void>('show_overlay', {
      payload: { mode: 'gesture', displayBounds: overlayDisplayBounds, targets: [] }
    });
  } catch {
    // Browser previews have no native overlay window.
  }
},
```

(Use the same `displayBounds` parameter type as `showAnnotationOverlay` — check its signature at `nativeBridge.ts:154-157` and match it.)

- [ ] **Step 3: Compile-check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/panels.rs src/native/nativeBridge.ts src/overlay/OverlayApp.tsx
git commit -m "feat(gesture): add click-through, capture-excluded 'gesture' overlay mode"
```

---

## Task 7: Overlay `GestureLayer` (cosmetic fading render)

**Files:**
- Create: `src/overlay/GestureLayer.tsx`
- Modify: `src/overlay/OverlayApp.tsx:337-374` (render branch)
- Modify: `src/styles.css` (gesture stroke style)

- [ ] **Step 1: Write the GestureLayer component**

```tsx
// src/overlay/GestureLayer.tsx
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { createAnnotationFromPoints } from '../annotations/annotationTools';
import { segmentGesturePath, type TimedPoint } from '../notch/gestureSegmenter';
import { gestureConfig } from '../config/gesture';
import type { UserAnnotation } from '../core/types';
import type { OverlayDisplayBounds } from './OverlayApp';

// Renders fading translucent strokes from the live cursor:mouse stream. Purely
// cosmetic — the notch owns the truth buffer that fable actually sees.
export function GestureLayer({ displayBounds }: { displayBounds: OverlayDisplayBounds }) {
  const bufferRef = useRef<TimedPoint[]>([]);
  const recordingRef = useRef(true);
  const [, force] = useState(0);

  useEffect(() => {
    let raf = 0;
    const unlisteners: Array<() => void> = [];

    void listen<{ x: number; y: number }>('cursor:mouse', (e) => {
      if (!recordingRef.current) return;
      bufferRef.current.push({ x: e.payload.x, y: e.payload.y, t: performance.now() });
    }).then((u) => unlisteners.push(u));

    // Freeze the buffer on release; existing strokes keep fading, no new points.
    void listen<{ active?: boolean }>('ptt:recording', (e) => {
      recordingRef.current = Boolean(e.payload?.active);
    }).then((u) => unlisteners.push(u));

    const tick = () => {
      const now = performance.now();
      // Prune points older than the longest a stroke can still be visible.
      const maxAge = gestureConfig.fadeMs + gestureConfig.windowMs + 200;
      bufferRef.current = bufferRef.current.filter((p) => now - p.t <= maxAge);
      force((n) => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      unlisteners.forEach((u) => u());
    };
  }, []);

  const now = performance.now();
  const strokes = segmentGesturePath(bufferRef.current, gestureConfig);

  return (
    <>
      {strokes.map((stroke, i) => {
        const age = now - stroke.points[stroke.points.length - 1].t;
        const opacity = Math.max(0, 1 - age / gestureConfig.fadeMs);
        if (opacity <= 0) return null;
        const annotation = createAnnotationFromPoints({
          id: `gesture-${i}`,
          points: stroke.points.map((p) => ({ x: p.x, y: p.y }))
        });
        return (
          <GestureStrokeShape
            key={i}
            annotation={annotation}
            displayBounds={displayBounds}
            opacity={opacity}
          />
        );
      })}
    </>
  );
}

// Clone of OverlayApp's pen-branch geometry (OverlayApp.tsx:57-77) with a
// per-stroke opacity. Points are already in global-screen physical px.
function GestureStrokeShape({
  annotation,
  displayBounds,
  opacity
}: {
  annotation: UserAnnotation;
  displayBounds: OverlayDisplayBounds;
  opacity: number;
}) {
  if (!annotation.points) return null;
  const scaleFactor = displayBounds.scaleFactor > 0 ? displayBounds.scaleFactor : 1;
  const left = annotation.screenRegion.x / scaleFactor - displayBounds.x;
  const top = annotation.screenRegion.y / scaleFactor - displayBounds.y;
  const width = Math.max(annotation.screenRegion.width / scaleFactor, 1);
  const height = Math.max(annotation.screenRegion.height / scaleFactor, 1);
  const points = annotation.points
    .map((p) => `${p.x / scaleFactor - displayBounds.x - left},${p.y / scaleFactor - displayBounds.y - top}`)
    .join(' ');
  return (
    <svg
      aria-label="gesture mark"
      className="annotation-shape pen gesture"
      style={{ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, opacity }}
      viewBox={`0 0 ${width} ${height}`}
    >
      <polyline points={points} />
    </svg>
  );
}
```

- [ ] **Step 2: Export `OverlayDisplayBounds` from OverlayApp**

Confirm `OverlayDisplayBounds` (`OverlayApp.tsx:17-21`) is exported; if it is only a local `type`, add `export`:

```ts
export type OverlayDisplayBounds = ScreenDimensions & { x: number; y: number; scaleFactor: number };
```

- [ ] **Step 3: Render GestureLayer on `mode === 'gesture'`**

In `OverlayApp.tsx` render (`337-374`), add a branch before the `annotation_preview` one:

```tsx
    {payload?.mode === 'gesture' ? (
      <GestureLayer displayBounds={payload.displayBounds} />
    ) : payload?.mode === 'annotate' ? (
```

Add the import near the top of `OverlayApp.tsx`:

```ts
import { GestureLayer } from './GestureLayer';
```

- [ ] **Step 4: Style the gesture stroke**

Append to `src/styles.css` (below the `.annotation-shape.pen` block at ~282):

```css
/* Hold-to-point cosmetic strokes: same geometry as the pen, softer + fading
   (opacity is set inline per-stroke by GestureLayer). */
.annotation-shape.pen.gesture { filter: none; }
.annotation-shape.pen.gesture polyline {
  stroke: #a78bfa;
  stroke-width: 5px;
  stroke-opacity: 0.9;
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/overlay/GestureLayer.tsx src/overlay/OverlayApp.tsx src/styles.css
git commit -m "feat(gesture): overlay GestureLayer renders fading cursor strokes"
```

---

## Task 8: Native debug-image command

**Files:**
- Modify: `src-tauri/src/lib.rs` (add command + register)
- Modify: `src/native/nativeBridge.ts` (wrapper)

- [ ] **Step 1: Add the Rust command**

Add near the other `#[tauri::command]`s in `lib.rs` (place it before `run()`):

```rust
/// Save a base64 JPEG (the exact image sent to fable) to a debug folder and,
/// on the first call of the session, open the folder in Finder. Debug-only —
/// gated by the frontend gestureConfig.debugImages flag.
#[tauri::command]
fn save_gesture_debug_image(app: tauri::AppHandle, base64: String) -> Result<String, String> {
    use base64::Engine as _;
    use std::io::Write as _;
    let dir = dirs::home_dir()
        .ok_or_else(|| "no home dir".to_string())?
        .join("Library/Logs/Kairo/gesture-debug");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("gesture-{stamp}.jpg"));
    let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    klog!(gesture, info, path = %path.display(), "saved gesture debug image");
    // Open the folder once per session so the user can watch images land.
    static OPENED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !OPENED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        let _ = std::process::Command::new("open").arg(&dir).spawn();
    }
    let _ = app; // reserved for future per-window routing
    Ok(path.display().to_string())
}
```

Register it in the `invoke_handler!`/`generate_handler!` list in `lib.rs` (add `save_gesture_debug_image` to the existing macro call). Confirm `base64` and `dirs` crates are already dependencies (they are used by capture/config); if `dirs` is absent, use `std::env::var("HOME")` instead.

- [ ] **Step 2: Add the bridge wrapper**

In `nativeBridge.ts`, add to the bridge object:

```ts
async saveGestureDebugImage(base64: string) {
  try {
    return await invoke<string>('save_gesture_debug_image', { base64 });
  } catch {
    return null;
  }
},
```

- [ ] **Step 3: Compile-check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml && npm run typecheck`
Expected: PASS. (`gesture` is a new klog subsystem tag — allowed, tags are free-form.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src/native/nativeBridge.ts
git commit -m "feat(gesture): native debug-image save command + bridge wrapper"
```

---

## Task 9: Notch gesture controller (truth buffer + hold wiring + composite)

**Files:**
- Modify: `src/notch/NotchApp.tsx` (refs, ptt:recording listener, cursor:mouse listener, processCapturedAudio, resetPreviousTurn)

- [ ] **Step 1: Add refs + imports**

Near the other refs (around `capturedScreenRef`, `NotchApp.tsx:283`) add:

```ts
// Hold-to-point: raw cursor:mouse points during the current hold (physical px),
// whether we're inside a confirmed hold, and the post-release overlay-hide timer.
const gestureBufferRef = useRef<TimedPoint[]>([]);
const gestureRecordingRef = useRef(false);
const gestureHideTimerRef = useRef<number | null>(null);
```

Add imports at the top of `NotchApp.tsx`:

```ts
import { segmentGesturePath, type TimedPoint } from './gestureSegmenter';
import { compositeMarks } from './compositeMarks';
import { gestureConfig } from '../config/gesture';
```

- [ ] **Step 2: Buffer cursor:mouse + drive the overlay from the ptt:recording listener**

Extend the existing `ptt:recording` listener (`NotchApp.tsx:1717-1725`). Replace its body with:

```ts
  listen<{ active?: boolean }>('ptt:recording', (event) => {
    const active = Boolean(event.payload?.active);
    pttRecordingRef.current = active;
    gestureRecordingRef.current = active;
    klog('notch', 'debug', 'ptt recording', { active });
    playSound(active ? 'stt-start' : 'stt-end');
    if (active) {
      // New hold → cancel any pending hide, fresh buffer, show the gesture overlay.
      if (gestureHideTimerRef.current != null) {
        clearTimeout(gestureHideTimerRef.current);
        gestureHideTimerRef.current = null;
      }
      gestureBufferRef.current = [];
      void (async () => {
        const bounds =
          capturedScreenRef.current?.displayBounds ??
          displayBoundsRef.current ??
          (await nativeBridge.getDisplayBounds().catch(() => null));
        if (!bounds) return;
        displayBoundsRef.current = bounds;
        await nativeBridge.showGestureOverlay(bounds);
      })();
    } else {
      // Release: DO NOT clear the buffer — processCapturedAudio composites it.
      // Let the on-screen strokes finish fading, then hide the (empty) overlay so
      // its render loop stops. Guarded so a new hold cancels the hide. This fires
      // during the STT/vision "thinking" phase, before any answer box is shown.
      if (gestureHideTimerRef.current != null) clearTimeout(gestureHideTimerRef.current);
      gestureHideTimerRef.current = window.setTimeout(() => {
        gestureHideTimerRef.current = null;
        if (!gestureRecordingRef.current) void nativeBridge.hideOverlay();
      }, gestureConfig.fadeMs + 400);
    }
  })
```

Add a dedicated `cursor:mouse` listener effect (place beside the other listener effects, e.g. after the `ptt:recording` effect):

```ts
useEffect(() => {
  let unlisten: (() => void) | undefined;
  void listen<{ x: number; y: number }>('cursor:mouse', (event) => {
    if (!gestureRecordingRef.current) return;
    gestureBufferRef.current.push({ x: event.payload.x, y: event.payload.y, t: performance.now() });
  }).then((u) => {
    unlisten = u;
  });
  return () => unlisten?.();
}, []);
```

- [ ] **Step 3: Composite truth strokes at release inside processCapturedAudio**

In `processCapturedAudio` (`NotchApp.tsx:1894-1969`), replace the block from `await capturePromise;` through `await submitQuery(...)` (lines ~1950-1951) with:

```ts
        await capturePromise;
        // Freeze the hold's buffer, segment it into truth strokes, composite them
        // onto the clean release screenshot (full strength, independent of the
        // on-screen fade), and hand that image to the turn.
        const strokes = segmentGesturePath(gestureBufferRef.current, gestureConfig);
        gestureBufferRef.current = [];
        if (strokes.length > 0 && capturedScreenRef.current) {
          capturedScreenRef.current = await compositeMarks(capturedScreenRef.current, strokes);
          klog('notch', 'info', 'gesture marks composited', { strokes: strokes.length, epoch });
          if (gestureConfig.debugImages && capturedScreenRef.current.imageBase64) {
            void nativeBridge.saveGestureDebugImage(capturedScreenRef.current.imageBase64);
          }
        }
        await submitQuery(transcript, 'voice', epoch);
```

- [ ] **Step 4: Ensure the turn uses the composited frame (annotations empty)**

In `submitQuery` (`NotchApp.tsx:1396-1406`), change the `askTutorFromNotch` call's `annotations` argument to `[]` so `notchTutor.ts:80-83` reuses our composited `screenCapture` instead of re-capturing:

```ts
        annotations: [],
```

> **Do NOT modify `resetPreviousTurn` for gestures.** It runs at the *start* of `processCapturedAudio` (the same hold's release handler), so clearing `gestureBufferRef` there would wipe the buffer before Step 3 composites it. The buffer is reset at each hold start (Step 2) and cleared after compositing (Step 3); the overlay is hidden by Step 2's post-release timer. No change to `resetPreviousTurn` is needed. (With the pen removed, `annotationsRef.current` is always empty, so `resetPreviousTurn`'s existing marks branch already falls through to `hideOverlay` — leave it as-is.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/notch/NotchApp.tsx
git commit -m "feat(gesture): notch truth buffer + composite marks at release"
```

---

## Task 10: Fable prompt hint

**Files:**
- Modify: `src-tauri/src/prompts.rs:66-67`

- [ ] **Step 1: Add the gesture-hint paragraph**

In `build_tutor_system_prompt`, add a new element to the base `vec!` right after the existing annotations paragraph (`prompts.rs:66`), before the closing `];` (`prompts.rs:67`):

```rust
        "The user can also point by moving the cursor while talking. Translucent marks on the screenshot show where they circled or lingered — treat them as hints to disambiguate the spoken question, not as ground truth. They may gesture near one thing while asking about another; when the words and the marks conflict, trust the words. Multiple numbered marks indicate multiple things they mean, in that order.".to_string(),
```

- [ ] **Step 2: Compile-check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/prompts.rs
git commit -m "feat(gesture): prompt fable to treat cursor marks as hints"
```

---

## Task 11: Remove the ⌥⇧P pen shortcut (native)

**Files:**
- Modify: `src-tauri/src/lib.rs` (const `71-73`, registration `545-561`, plugin `570`, import `11`)

- [ ] **Step 1: Delete the shortcut const, registration, and plugin**

- Delete the const (`lib.rs:71-73`): the `KAIRO_PEN_SHORTCUT` block.
- Delete the registration + handler (`lib.rs:545-561`): the `let pen_shortcut ... .build();` block.
- Delete the plugin registration line (`lib.rs:570`): `.plugin(global_shortcut_plugin)`.
- Delete the now-unused import (`lib.rs:11`): `use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};`.

- [ ] **Step 2: Compile-check (surfaces any missed references)**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS with no `unused import` / `cannot find value` warnings for the removed items. (Leaving the `tauri-plugin-global-shortcut` dep in `Cargo.toml` and the `global-shortcut:allow-*` capabilities is harmless; remove them only if you want a full cleanup — optional.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "refactor(gesture): remove the ⌥⇧P pen shortcut"
```

---

## Task 12: Remove the pen UI + toggle (frontend)

**Files:**
- Modify: `src/notch/NotchApp.tsx` (pen button `2425-2434`, `pen:toggle` listener `2321-2323`, `startAnnotation` `1601-1624` + companions, `armAnnotationWatch` usage)

- [ ] **Step 1: Remove the pen button**

Delete the pen `<button>` JSX (`NotchApp.tsx:2425-2434`) and the `PenIcon` import if it becomes unused (check with a search for `PenIcon`).

- [ ] **Step 2: Remove the `pen:toggle` listener**

In the effect at `NotchApp.tsx:2316-2328`, delete the listener:

```ts
      listen('pen:toggle', () => {
        void startAnnotation('pen');
      })
```

Remove the now-dangling comma in the `Promise.all([...])` array and drop `startAnnotation` from that effect's dependency list (`2328`).

- [ ] **Step 3: Remove `startAnnotation` and pen-only companions**

Delete `startAnnotation` (`1601-1624`). Delete `finishAnnotation` (`1626-1630`), `undoAnnotation` (`1632-1634`), and `clearAnnotations` (`1636-1640`) **only if** a search shows no remaining callers. Delete `armAnnotationWatch` (`1588-1599`) if its only caller was `startAnnotation`. Also remove the `activeAnnotationTool` state and `setActiveAnnotationTool` if the pen button was their only consumer (search to confirm).

- [ ] **Step 4: Typecheck (catches any remaining references)**

Run: `npm run typecheck`
Expected: PASS. Fix any "declared but never read" / missing-reference errors by removing the dead symbol the compiler names. Do **not** remove `annotations` state wholesale if `submitQuery`/`resetPreviousTurn` still read it — it now stays permanently empty (`[]`), which is correct and safe (leave those read sites, they resolve to no-ops).

- [ ] **Step 5: Commit**

```bash
git add src/notch/NotchApp.tsx
git commit -m "refactor(gesture): remove pen button, toggle listener, and startAnnotation"
```

---

## Task 13: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Static checks**

Run: `npm run typecheck && npm run test && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: all PASS (gestureSegmenter + compositeMarks suites green).

- [ ] **Step 2: Build + launch the packaged app**

Run:
```bash
osascript -e 'tell application "Kairo Tutor" to quit'; npm run tauri:build -- --bundles app && open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```
Expected: builds, signs, launches.

- [ ] **Step 3: Manual gesture check (debug images on)**

Set `debugImages: true` in `src/config/gesture.ts`, rebuild, then:
- Hold ⌥⌃, circle one UI element while asking "what's this?", release.
- Confirm: the mark appears while circling and fades in ~1s; the app underneath stayed clickable during the hold (Way B, non-modal).
- The gesture-debug folder opens; confirm the saved image has the mark **on the circled element** (coord mapping correct) at readable translucency.
- Repeat circling **two** elements in one hold → two numbered marks, no line between them.
- Rest the cursor / move straight across → no mark (rest + travel rejected).
- Tail logs: `tail -F ~/Library/Logs/Kairo/kairo-latest.log` → `gesture marks composited` with the expected stroke count.

- [ ] **Step 4: Tune + confirm**

Adjust `directnessMax` / `turningMin` / `minPathPx` / alpha / `fadeMs` in `src/config/gesture.ts` as needed from the debug images; rebuild; re-check. Set `debugImages: false` when satisfied.

- [ ] **Step 5: Verify the pen is gone**

- ⌥⇧P does nothing; no pen button in the notch; a plain voice turn with no mouse movement behaves exactly as before (no marks, no regressions).

- [ ] **Step 6: Commit any tuning**

```bash
git add src/config/gesture.ts
git commit -m "chore(gesture): tune thresholds and disable debug images"
```

---

## Notes / non-goals (from the spec)

- No local UI-element detection or snapping — fable does the semantics.
- No gesture vocabulary (circle vs arrow) — every burst is just "the user pointed here."
- No mark-without-talking mode.
- Multi-display: capture is single (main) display today; `physicalToEncoded` subtracts the display origin so it is ready for one non-origin display, but marks outside the captured display are not composited. Acceptable for now.
- The overlay's old `annotate`/`AnnotationOverlay` pointer-drawing path is left in place but unreachable (no caller enters `annotate` mode). Removing it entirely is a safe follow-up cleanup, out of scope here.
