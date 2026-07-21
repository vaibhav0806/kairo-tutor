# Onboarding Phase 2 — Pet Cursor Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the companion "pet cursor" (`src/cursor/`) so it threads the user's chosen accent color, moves with the modern notch's tighter/fluid motion vocabulary, and gains two additive expressive beats — `cursor:entrance` (Act 1 wake-up) and `cursor:celebrate` (Act 4a peak) — all without rewriting the existing engine semantics.

**Architecture:** The cursor stays exactly as it is behaviorally (rAF spring loop, fly-to-target, comet trail, listening halo / thinking swirl / speaking pulse, drag-to-draw box in `useCursorEngine.ts`). We thread color through **one set of accent-derived CSS custom properties** (`--cur-accent*`) set on `.kairo-cursor-shell`; both the CSS FX and the engine's inline `style.fill`/`style.background` writes reference those vars, so a single `accent:changed` re-derives them and everything recolors live at zero per-frame cost. The two new beats are one-shot native broadcasts (`cursor:entrance` / `cursor:celebrate`, following the existing `cursor_point`/`cursor_release` command pattern) that the engine turns into a short CSS-animation via a `data-beat` attribute on the shell. `prefers-reduced-motion` picks dampened variants.

**Tech Stack:** React 19 + TypeScript (Vite), Tauri v2 (Rust `#[tauri::command]` + `app.emit`), CSS custom properties + keyframes, vitest (node env — no DOM libs). Frontend logging via `klog()` from `src/core/logger.ts` (never `console.*`); Rust logging via `klog!` (never `println!`).

**Prerequisites:**
- **Phase 0 must be merged first.** This plan imports `getAccent` and `onAccentChanged` from `src/core/accent.ts` (§3B of the master spec). If Phase 0 is not yet on `main`, Task 4 will fail to typecheck — stop and land Phase 0 first. Tasks 1–3 and 5–8 do **not** need Phase 0 (they fall back to the brand-purple CSS var defaults), so they can proceed, but do the whole phase in Phase-0-merged order for a clean history.
- Master spec: `docs/superpowers/plans/2026-07-21-onboarding-redesign-and-modern-notch.md` — read §11B (Pet Cursor Refresh) and §3B (Shared Contracts).

**Ground rules (from `AGENTS.md`):**
- Work on `main`, small revertible commits — one commit per task.
- Every commit message ends with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Green gate per commit where applicable: `npm run typecheck`, `npm run test`, `cargo check --manifest-path src-tauri/Cargo.toml`.
- Real verification is the **packaged app**, never a dev server: `npm run app` (quit → build+sign → verify → launch). Watch logs: `tail -F ~/Library/Logs/Kairo/kairo-latest.log`.
- Log every meaningful step through the universal logger. No secrets/raw media.

---

## File Structure

**Create:**
- `src/cursor/cursorTheme.ts` — pure accent→tints color math (`accentTints`) + `applyCursorAccent` (writes the `--cur-accent*` CSS vars onto a style target). Pure + node-testable (no DOM dependency).
- `tests/cursorTheme.test.ts` — unit tests for `accentTints` + `applyCursorAccent`.

**Modify:**
- `src/cursor/cursorConstants.ts` — `DEFAULT_TRAIL` / `RECORDING_FILL` become accent-var strings; add motion-token constants (`ENTRANCE_MS`, `CELEBRATE_MS`, + reduced variants). Add `CursorBeat` type.
- `src/cursor/CursorApp.tsx` — SVG gradient stops read the accent vars; refine the arrow glyph path; add the `.kairo-cursor-burst` element for the celebrate/entrance flourish.
- `src/cursor/useCursorEngine.ts` — apply the accent on mount + subscribe to `accent:changed`; add `cursor:entrance` / `cursor:celebrate` listeners driving a `data-beat` one-shot; small comet-trail crispness tweak.
- `src/cursor/spring.ts` — refine `POINTING_SPRING` for tighter/fluid motion (kept near-critical, no overshoot).
- `tests/cursorSpring.test.ts` — add a "settles crisply" assertion locking the tighter pointing feel.
- `src/styles.css` — declare default `--cur-accent*` vars on `.kairo-cursor-shell`; re-skin every cursor FX (halo, thinking swirl, ring, arrow glow, trail) to those vars; add entrance/celebrate/burst keyframes; refine glyph stroke + trail; reduced-motion safety.
- `src/native/nativeBridge.ts` — add `cursorEntrance()` / `cursorCelebrate()` to the `NativeBridge` interface + implementation (invoke the new commands).
- `tests/nativeBridge.test.ts` — assert the two new bridge methods invoke the right command names.
- `src-tauri/src/lib.rs` — add `cursor_entrance` / `cursor_celebrate` commands (`app.emit`), register them in `tauri::generate_handler!`.

**Do NOT touch:** `src/cursor/geometry.ts` (tip/standoff math is unchanged — the refined glyph keeps its tip vertex at viewBox `(28,4)`), the notch, the overlay, or any onboarding-flow wiring (the beats are fired by later phases; Phase 2 only ships the plumbing + a manual smoke path).

---

## Task 1: Accent tint helper (pure color math)

**Files:**
- Create: `src/cursor/cursorTheme.ts`
- Test: `tests/cursorTheme.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cursorTheme.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { accentTints, applyCursorAccent } from '../src/cursor/cursorTheme';

describe('accentTints', () => {
  test('parses the brand purple into space-separated rgb', () => {
    expect(accentTints('#7c3aed').rgb).toBe('124 58 237');
  });

  test('accepts a hex without the leading hash', () => {
    expect(accentTints('3b82f6').rgb).toBe('59 130 246');
  });

  test('base echoes a normalized #rrggbb; hi/soft/hot are valid hex', () => {
    const t = accentTints('#3b82f6');
    expect(t.base).toBe('#3b82f6');
    for (const v of [t.hi, t.soft, t.hot]) {
      expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test('hi is lighter than the base (higher luminance sum)', () => {
    const sum = (hex: string) =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    const t = accentTints('#7c3aed');
    expect(sum(t.hi)).toBeGreaterThan(sum(t.base));
  });

  test('falls back to brand purple on a malformed hex', () => {
    expect(accentTints('nope').rgb).toBe('124 58 237');
  });
});

describe('applyCursorAccent', () => {
  test('writes the five --cur-accent* custom properties', () => {
    const set: Record<string, string> = {};
    const target = { style: { setProperty: (n: string, v: string) => { set[n] = v; } } };
    applyCursorAccent(target, '#7c3aed');
    expect(set['--cur-accent']).toBe('#7c3aed');
    expect(set['--cur-accent-rgb']).toBe('124 58 237');
    expect(set['--cur-accent-hi']).toMatch(/^#[0-9a-f]{6}$/);
    expect(set['--cur-accent-soft']).toMatch(/^#[0-9a-f]{6}$/);
    expect(set['--cur-accent-hot']).toMatch(/^#[0-9a-f]{6}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cursorTheme.test.ts`
Expected: FAIL — `Cannot find module '../src/cursor/cursorTheme'`.

- [ ] **Step 3: Write the implementation**

Create `src/cursor/cursorTheme.ts`:

```ts
//! Pure accent → tint math for the companion cursor. The user's accent (from Phase 0's
//! `src/core/accent.ts`) is threaded through a small set of CSS custom properties
//! (`--cur-accent*`) that BOTH the cursor CSS and the engine's inline style writes read,
//! so one `accent:changed` recolors the whole pet with no per-frame cost. Kept DOM-free
//! (accepts a minimal `{ style: { setProperty } }` target) so it's unit-testable in node.

// Brand-default accent, used when a hex can't be parsed. Matches the CSS var defaults.
const BRAND: readonly [number, number, number] = [124, 58, 237]; // #7c3aed

export type AccentTints = {
  base: string; // '#rrggbb'
  hi: string; // lighter — SVG gradient top stop / ring core / entrance bloom
  soft: string; // slightly lighter — pings / soft borders
  hot: string; // vivid + saturated — recording fill (accent-derived, not a fixed red)
  rgb: string; // 'r g b' — for rgb(var(--cur-accent-rgb) / <alpha>)
};

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseHex(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    return [...BRAND];
  }
  const int = Number.parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => clampByte(n).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) {
    return [0, 0, l];
  }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) {
    h = (gn - bn) / d + (gn < bn ? 6 : 0);
  } else if (max === gn) {
    h = (bn - rn) / d + 2;
  } else {
    h = (rn - gn) / d + 4;
  }
  return [(h / 6) * 360, s, l];
}

function hslToHex(hDeg: number, s: number, l: number): string {
  const hue = ((((hDeg % 360) + 360) % 360) / 360);
  const sat = Math.max(0, Math.min(1, s));
  const lit = Math.max(0, Math.min(1, l));
  if (sat === 0) {
    const v = clampByte(lit * 255);
    return toHex(v, v, v);
  }
  const q = lit < 0.5 ? lit * (1 + sat) : lit + sat - lit * sat;
  const p = 2 * lit - q;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return toHex(channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255);
}

export function accentTints(hex: string): AccentTints {
  const [r, g, b] = parseHex(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return {
    base: toHex(r, g, b),
    hi: hslToHex(h, s, Math.min(0.92, l + 0.2)),
    soft: hslToHex(h, s, Math.min(0.9, l + 0.12)),
    // "Hot" = clearly-activated version of the accent for the recording state: push
    // saturation up and land lightness in a vivid mid band, so it reads as "live"
    // regardless of hue (replaces the old fixed #ff4d6d red per §11B).
    hot: hslToHex(h, Math.max(s, 0.85), Math.min(0.66, Math.max(0.52, l + 0.06))),
    rgb: `${r} ${g} ${b}`
  };
}

// A minimal style target — an HTMLElement satisfies this, but so does a test stub, so
// this stays node-testable without a DOM library.
export type AccentStyleTarget = { style: { setProperty(name: string, value: string): void } };

export function applyCursorAccent(target: AccentStyleTarget, hex: string): void {
  const t = accentTints(hex);
  target.style.setProperty('--cur-accent', t.base);
  target.style.setProperty('--cur-accent-hi', t.hi);
  target.style.setProperty('--cur-accent-soft', t.soft);
  target.style.setProperty('--cur-accent-hot', t.hot);
  target.style.setProperty('--cur-accent-rgb', t.rgb);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cursorTheme.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean (no errors).

- [ ] **Step 6: Commit**

```bash
git add src/cursor/cursorTheme.ts tests/cursorTheme.test.ts
git commit -m "feat(cursor): pure accent→tint helper for the pet cursor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Re-skin cursor CSS onto accent custom properties (visual no-op)

Declare the `--cur-accent*` vars (defaulting to today's brand purple) and point every hard-coded cursor purple at them. Because the defaults equal the current colors, the pet looks **identical** after this task — it's now just var-driven and ready to recolor live.

**Files:**
- Modify: `src/styles.css` (the `.kairo-cursor-*` block, ~lines 508-715)

- [ ] **Step 1: Add default accent vars on the shell**

In `src/styles.css`, replace the `.kairo-cursor-shell` rule (currently ~lines 511-521) with:

```css
.kairo-cursor-shell {
  /* Accent custom properties — defaults are the brand purple; the engine overwrites
     these live from the user's accent (Phase 0) via applyCursorAccent(). Both the CSS
     FX below and the engine's inline style writes read them, so one accent:changed
     recolors the whole pet. */
  --cur-accent: #7c3aed;
  --cur-accent-hi: #c79bff;
  --cur-accent-soft: #a78bfa;
  --cur-accent-hot: #ff4d6d;
  --cur-accent-rgb: 124 58 237;

  background: transparent;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  position: fixed;
  /* Auto-hide fade (items 1 + 2): opacity is driven from JS; transition keeps the
     vanish/return smooth rather than a hard cut. */
  opacity: 1;
  transition: opacity 180ms ease;
}
```

Note: `--cur-accent-hot` default stays the familiar recording red so this task is a pure no-op; the accent-derived hot lands only once the engine (Task 4) applies a real accent.

- [ ] **Step 2: Point the arrow glow at the accent var**

Replace the `.kairo-cursor-arrow` rule (~lines 532-537) with:

```css
.kairo-cursor-arrow {
  display: block;
  height: 100%;
  width: 100%;
  transform-origin: 87.5% 12.5%; /* the tip vertex (28,4) of the 32-unit viewBox */
  filter: drop-shadow(0 2px 4px rgb(0 0 0 / 0.45))
    drop-shadow(0 0 8px rgb(var(--cur-accent-rgb) / 0.6));
}
```

- [ ] **Step 3: Point the comet trail at the accent var**

Replace the `.kairo-cursor-trail` `background` line (~line 543) so the rule's background reads:

```css
  background: linear-gradient(to left, var(--cur-accent), rgb(var(--cur-accent-rgb) / 0));
```

- [ ] **Step 4: Re-skin the listening halo**

Replace the `.kairo-cursor-halo` rule's `background` + `border` (~lines 572-578) so they read:

```css
  background: radial-gradient(
    circle,
    rgb(var(--cur-accent-rgb) / 0.5) 0%,
    rgb(var(--cur-accent-rgb) / 0.32) 45%,
    rgb(var(--cur-accent-rgb) / 0) 72%
  );
  border: 2px solid rgb(var(--cur-accent-rgb) / calc(0.45 + var(--mic-level, 0) * 0.55));
```

- [ ] **Step 5: Re-skin the thinking swirl dots**

Replace the `.kairo-cursor-think i` `background` (~line 630) with:

```css
  background: var(--cur-accent);
```

- [ ] **Step 6: Re-skin the target ring**

Replace `.kairo-cursor-ring-core` `border`/`box-shadow` (~lines 690-691) with:

```css
  border: 2.5px solid var(--cur-accent-hi);
  box-shadow: 0 0 10px rgb(var(--cur-accent-rgb) / 0.7);
```

and `.kairo-cursor-ring-ping` `border` (~line 700) with:

```css
  border: 2px solid rgb(var(--cur-accent-rgb) / 0.7);
```

- [ ] **Step 7: Build + eyeball (visual no-op)**

Run: `npm run app`
Expected: app builds, signs, verifies, launches. The pet, listening halo, thinking swirl, trail, and target ring look **exactly as before** (still purple). Move the mouse (shadow), hold ⌥⌃ and speak (halo + thinking), let it answer (pointing + ring). Confirm nothing changed visually.
Log check: `tail -n 40 ~/Library/Logs/Kairo/kairo-latest.log` — no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/styles.css
git commit -m "refactor(cursor): drive cursor FX from --cur-accent* CSS vars (no visual change)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Var-ize the engine's inline color constants + SVG gradient

Point the two remaining inline-styled colors (`DEFAULT_TRAIL`, `RECORDING_FILL`) and the SVG arrow gradient stops at the accent vars. Still a visual no-op (defaults unchanged), completing the plumbing so Task 4 can drive it live.

**Files:**
- Modify: `src/cursor/cursorConstants.ts` (lines 27-33)
- Modify: `src/cursor/CursorApp.tsx` (SVG `<defs>`, lines 30-35)

- [ ] **Step 1: Var-ize `DEFAULT_TRAIL` and `RECORDING_FILL`**

In `src/cursor/cursorConstants.ts`, replace the trail/fill constant block (lines 27-33) with:

```ts
export const TRAIL_BASE = 40;
export const TRAIL_H = 7;
export const DEFAULT_ARROW_FILL = 'url(#kairo-cursor-grad)';
export const DEFAULT_TRAIL = `linear-gradient(to left, var(--cur-accent), rgb(var(--cur-accent-rgb) / 0))`;
// While recording, the arrow core switches to the accent's "hot" (vivid, saturated)
// tint so listening is unmistakable even apart from the halo. Derived from the user's
// accent (§11B) rather than a fixed red — see cursorTheme.accentTints().
export const RECORDING_FILL = 'var(--cur-accent-hot)';
```

(This also nudges the trail geometry a touch crisper — `TRAIL_BASE` 44→40, `TRAIL_H` 8→7. The `.kairo-cursor-trail` CSS `width`/`height` are updated in Task 6.)

- [ ] **Step 2: Var-ize the SVG gradient stops**

In `src/cursor/CursorApp.tsx`, replace the `<linearGradient>` block (lines 31-34) with:

```tsx
            <linearGradient id="kairo-cursor-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" style={{ stopColor: 'var(--cur-accent-hi)' }} />
              <stop offset="100%" style={{ stopColor: 'var(--cur-accent)' }} />
            </linearGradient>
```

The gradient lives inside `.kairo-cursor-shell`, so it inherits the `--cur-accent*` custom properties.

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npm run test`
Expected: clean; all tests pass (existing `cursorConstants` importers still compile).

- [ ] **Step 4: Build + eyeball (still a visual no-op)**

Run: `npm run app`
Expected: identical look to Task 2. Hold ⌥⌃ to record → arrow core still shows the recording red (default `--cur-accent-hot` = `#ff4d6d`). Point at a target → gradient arrow + trail unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/cursor/cursorConstants.ts src/cursor/CursorApp.tsx
git commit -m "refactor(cursor): route arrow gradient + trail/recording fills through accent vars

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Thread the live user accent into the pet (Phase 0 wiring)

Now make it real: on mount, apply the user's accent to the shell and re-apply on every `accent:changed`. **Requires Phase 0's `src/core/accent.ts`.**

**Files:**
- Modify: `src/cursor/useCursorEngine.ts` (imports + the main listeners `useEffect`, ~lines 28-43 and ~lines 130-357)

- [ ] **Step 1: Import the accent helpers**

In `src/cursor/useCursorEngine.ts`, add to the imports near the top (after the `klog` import on line 27):

```ts
import { getAccent, onAccentChanged } from '../core/accent';
import { applyCursorAccent } from './cursorTheme';
```

- [ ] **Step 2: Apply + subscribe on mount**

Inside the main `useEffect(() => { ... }, [nativeBridge])` (the one starting ~line 130), immediately after `let isMounted = true;` and the `lastActivityRef` init line (~line 133), add:

```ts
    // Thread the user's accent (Phase 0) through the pet. Apply once now, then live-update
    // on accent:changed. Both the cursor CSS and the engine's inline style writes read the
    // resulting --cur-accent* vars, so this single call recolors the whole pet.
    const applyAccent = (hex: string) => {
      if (shellRef.current) {
        applyCursorAccent(shellRef.current, hex);
        klog('cursor', 'debug', 'accent applied', { hex });
      }
    };
    try {
      applyAccent(getAccent());
    } catch (error) {
      klog('cursor', 'warn', 'accent read failed; using CSS defaults', { error: String(error) });
    }
    const offAccent = onAccentChanged((hex) => applyAccent(hex));
```

- [ ] **Step 3: Unsubscribe on cleanup**

In the same effect's cleanup `return () => { ... }` (~line 581), add `offAccent();` alongside the other teardown (e.g. right after `globalThis.clearInterval(idleInterval);`):

```ts
      offAccent();
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean. If this errors with "Cannot find module '../core/accent'" or a missing `getAccent`/`onAccentChanged` export, **Phase 0 is not merged** — stop and land Phase 0 first (see Prerequisites).

- [ ] **Step 5: Build + verify live recolor**

Run: `npm run app`
Verification (needs a way to change the accent — use whatever Phase 0 shipped, e.g. a debug `set_accent` invoke or the Phase 3 color wheel if present; otherwise set the app-config accent value and relaunch):
- Pet arrow gradient, comet trail, listening halo, thinking swirl, and target ring all render in the **user's accent**, not purple.
- Recording (hold ⌥⌃) → arrow core shows the accent's vivid "hot" tint (not the old red).
- Changing the accent live (emit `accent:changed`) recolors the pet **without a relaunch**.
Log check: `tail -F ~/Library/Logs/Kairo/kairo-latest.log | grep 'accent applied'` shows the applied hex.

- [ ] **Step 6: Commit**

```bash
git add src/cursor/useCursorEngine.ts
git commit -m "feat(cursor): thread live user accent into the pet (getAccent + accent:changed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Motion cohesion — tighten the pointing spring

Refine the fly-to-target spring for the modern-notch feel (Raycast tightness + Arc fluidity): a touch snappier while staying near-critical so it never overshoots. Shadow-follow stays soft/lagging (Arc fluidity).

**Files:**
- Modify: `src/cursor/spring.ts` (lines 17-23)
- Test: `tests/cursorSpring.test.ts`

- [ ] **Step 1: Add a failing "settles crisply" test**

In `tests/cursorSpring.test.ts`, add inside the `describe('stepSpring', ...)` block:

```ts
  test('pointing spring settles crisply — within 1px of target by frame 60', () => {
    const spring = createSpring(0);
    for (let i = 0; i < 60; i += 1) {
      stepSpring(spring, 100, POINTING_SPRING, DT);
    }
    expect(Math.abs(100 - spring.value)).toBeLessThan(1);
  });
```

- [ ] **Step 2: Run it against the current (softer) spring to confirm it fails**

Run: `npx vitest run tests/cursorSpring.test.ts -t 'settles crisply'`
Expected: FAIL — the current `POINTING_SPRING` (stiffness 80) is still ~2-3px short at frame 60.

- [ ] **Step 3: Tighten the pointing spring**

In `src/cursor/spring.ts`, replace the `POINTING_SPRING` declaration (lines 20-23) with:

```ts
// Crisp, fluid glide to a target — the modern-notch motion vocabulary (Raycast
// tightness + Arc fluidity). Stiffness raised for a snappier arrival; damping kept
// just above critical (2*sqrt(120) ≈ 21.9) so it settles fast with NO overshoot/bounce.
export const POINTING_SPRING: SpringConfig = { stiffness: 120, damping: 22 };
```

(`SHADOW_SPRING` is intentionally left soft/overdamped — the lag is the Arc-fluidity feel while shadowing the mouse.)

- [ ] **Step 4: Run the full cursor-spring suite**

Run: `npx vitest run tests/cursorSpring.test.ts`
Expected: PASS — including the existing "does not overshoot" (max ≤ 100.5) and "eases in and settles smoothly without bounce" tests, plus the new "settles crisply".

- [ ] **Step 5: Build + feel it**

Run: `npm run app`
Expected: ask Kairo to point at something — the pet flies in and settles noticeably crisper (less drift at the end), no bounce. Shadow-follow still trails the mouse softly.

- [ ] **Step 6: Commit**

```bash
git add src/cursor/spring.ts tests/cursorSpring.test.ts
git commit -m "feat(cursor): tighten the pointing spring for notch-cohesive motion

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Refine the arrow glyph + comet trail

A crisper, more characterful glyph and trail. The arrow keeps its tip vertex at viewBox `(28,4)` so `geometry.ts`/`cursorConstants.ts` tip anchors stay valid — only the body silhouette + stroke tighten.

**Files:**
- Modify: `src/cursor/CursorApp.tsx` (the `<path>` element, lines 36-44)
- Modify: `src/styles.css` (the `.kairo-cursor-trail` rule, ~lines 542-555)

- [ ] **Step 1: Refine the arrow path + stroke**

In `src/cursor/CursorApp.tsx`, replace the `<path ...>` element (lines 36-44) with:

```tsx
          <path
            ref={arrowPathRef}
            d="M28 4 L6.5 13.4 L14.3 15.7 L16.9 25 Z"
            fill="url(#kairo-cursor-grad)"
            stroke="rgba(255, 255, 255, 0.92)"
            strokeWidth="1.25"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
```

The tip stays `(28,4)`; the body is slightly slimmer and the white outline is thinner + softened for a crisper read at the accent color.

- [ ] **Step 2: Refine the trail to match the tightened geometry**

In `src/styles.css`, replace the `.kairo-cursor-trail` rule (~lines 542-555) with:

```css
.kairo-cursor-trail {
  background: linear-gradient(to left, var(--cur-accent), rgb(var(--cur-accent-rgb) / 0));
  border-radius: 999px;
  filter: blur(0.3px);
  height: 7px;
  left: 0;
  opacity: 0;
  pointer-events: none;
  position: absolute;
  top: 0;
  transform-origin: 100% 50%;
  width: 40px;
  will-change: transform, opacity;
}
```

(Rounder cap, less blur, and `width`/`height` matched to the `TRAIL_BASE`/`TRAIL_H` from Task 3.)

- [ ] **Step 3: Crisper trail dynamics in the engine**

In `src/cursor/useCursorEngine.ts`, in `writeTrail` (~lines 188-194), replace the length/opacity lines so the trail is a touch tighter and less smeary:

```ts
      const angle = Math.atan2(vy, vx) * (180 / Math.PI);
      const length = Math.min(speed * 0.045, TRAIL_BASE);
      const tipX = springX.current.value;
      const tipY = springY.current.value;
      trail.style.opacity = String(Math.min(speed / 1500, 0.55));
      trail.style.transform = `translate(${tipX - TRAIL_BASE}px, ${
        tipY - TRAIL_H / 2
      }px) rotate(${angle}deg) scaleX(${length / TRAIL_BASE})`;
```

(`TRAIL_BASE` / `TRAIL_H` are already imported in the engine.)

- [ ] **Step 4: Typecheck + tests**

Run: `npm run typecheck && npm run test`
Expected: clean; all pass.

- [ ] **Step 5: Build + eyeball**

Run: `npm run app`
Expected: the pet's arrowhead reads crisper; when it flies to a target the comet trail is tighter and cleanly capped in the accent. No misalignment of the tip on the target (tip vertex unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/cursor/CursorApp.tsx src/styles.css src/cursor/useCursorEngine.ts
git commit -m "feat(cursor): crisper arrowhead glyph + tighter comet trail

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `cursor:entrance` beat — the "come to life" wake-up

A one-shot signature entrance (Act 1): the pet scales + fades up from its tip with a soft accent bloom. Native command → `app.emit("cursor:entrance")` (same reliable cross-WebView path as `cursor_point`), engine turns it into a `data-beat="entrance"` CSS animation, auto-clearing after the duration. Reduced-motion → a plain fade.

**Files:**
- Modify: `src-tauri/src/lib.rs` (after `cursor_active`, ~line 361; and the `generate_handler!` list, ~line 708)
- Modify: `src/native/nativeBridge.ts` (interface ~line 157; impl ~line 461)
- Modify: `src/cursor/cursorConstants.ts` (add motion tokens + `CursorBeat` type)
- Modify: `src/cursor/CursorApp.tsx` (add the burst element)
- Modify: `src/cursor/useCursorEngine.ts` (add the listener + `runBeat` helper)
- Modify: `src/styles.css` (entrance/burst keyframes)
- Test: `tests/nativeBridge.test.ts`

- [ ] **Step 1: Add the failing bridge test**

In `tests/nativeBridge.test.ts`, add inside `describe('createNativeBridge', ...)`:

```ts
  test('cursorEntrance and cursorCelebrate invoke their native commands', async () => {
    const commands: string[] = [];
    const invoke = vi.fn(async (command: string) => {
      commands.push(command);
      return undefined as never;
    });
    const bridge = createNativeBridge(invoke as unknown as NativeInvoke);
    await bridge.cursorEntrance();
    await bridge.cursorCelebrate();
    expect(commands).toEqual(['cursor_entrance', 'cursor_celebrate']);
  });
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run tests/nativeBridge.test.ts -t 'invoke their native commands'`
Expected: FAIL — `bridge.cursorEntrance is not a function`.

- [ ] **Step 3: Add the native commands (Rust)**

In `src-tauri/src/lib.rs`, immediately after the `cursor_active` command (after line 361), add:

```rust
// One-shot "come to life" beat for the companion cursor (onboarding Act 1 wake-up;
// reusable in-product). Broadcast via app.emit so it reaches the cursor WebView reliably.
#[tauri::command]
fn cursor_entrance(app: tauri::AppHandle) -> Result<(), String> {
    klog!(cursor, debug, "entrance beat → cursor");
    app.emit("cursor:entrance", ())
        .map_err(|error| format!("Failed to emit cursor entrance: {error}"))
}

// One-shot celebratory flourish (onboarding Act 4a peak; used sparingly so it stays special).
#[tauri::command]
fn cursor_celebrate(app: tauri::AppHandle) -> Result<(), String> {
    klog!(cursor, debug, "celebrate beat → cursor");
    app.emit("cursor:celebrate", ())
        .map_err(|error| format!("Failed to emit cursor celebrate: {error}"))
}
```

Then register both in the `tauri::generate_handler!` macro — add these two lines right after `cursor_active,` (line 708):

```rust
            cursor_entrance,
            cursor_celebrate,
```

(Both `cursor_entrance` and `cursor_celebrate` are added here even though the celebrate listener lands in Task 8; keeping the Rust surface in one commit is fine — the command is inert until a caller fires it.)

- [ ] **Step 4: Add the bridge methods (TS)**

In `src/native/nativeBridge.ts`, add to the `NativeBridge` interface right after `cursorActive(active: boolean): Promise<void>;` (line 157):

```ts
  cursorEntrance(): Promise<void>;
  cursorCelebrate(): Promise<void>;
```

And in the returned object, right after the `cursorActive` implementation (after line 461), add:

```ts
    async cursorEntrance() {
      try {
        await invoke<void>('cursor_entrance');
      } catch {
        // Browser previews have no native cursor window.
      }
    },

    async cursorCelebrate() {
      try {
        await invoke<void>('cursor_celebrate');
      } catch {
        // Browser previews have no native cursor window.
      }
    },
```

- [ ] **Step 5: Run the bridge test — now passes**

Run: `npx vitest run tests/nativeBridge.test.ts -t 'invoke their native commands'`
Expected: PASS.

- [ ] **Step 6: Add motion tokens + the beat type**

In `src/cursor/cursorConstants.ts`, add after the `IDLE_HIDE_MS` constant (line 12):

```ts
// One-shot expressive beats (additive; fired by onboarding, reusable in-product). The JS
// clears data-beat after these windows — kept slightly longer than the CSS animations so
// cleanup never truncates them. Reduced-motion uses the shorter, dampened variants.
export const ENTRANCE_MS = 640;
export const ENTRANCE_REDUCED_MS = 240;
export const CELEBRATE_MS = 720;
export const CELEBRATE_REDUCED_MS = 260;
```

And add near the `CursorFx` type (after line 35):

```ts
export type CursorBeat = 'entrance' | 'celebrate';
```

- [ ] **Step 7: Add the burst element to the render**

In `src/cursor/CursorApp.tsx`, inside `.kairo-cursor-fx`, add the burst span right after the closing `</span>` of `.kairo-cursor-think` (after line 21):

```tsx
        <span className="kairo-cursor-burst" />
```

So the fx layer now holds the halo, the thinking swirl, and the burst (all centered on the tip).

- [ ] **Step 8: Add the entrance + burst CSS**

In `src/styles.css`, add just before `.overlay-shell {` (line 717):

```css
/* One-shot expressive beats. Driven by data-beat on the shell (set/cleared by the engine).
   Animations target the arrow glyph + the burst ring, NOT .kairo-cursor (whose transform
   is written every frame by the spring loop), so they never fight the JS. */

/* Burst ring: an accent halo-out used by both entrance (bloom) and celebrate (pop). Centered
   on the fx-layer origin (the cursor tip) via negative margins. */
.kairo-cursor-burst {
  border: 2px solid rgb(var(--cur-accent-rgb) / 0.8);
  border-radius: 999px;
  height: 22px;
  left: 0;
  margin: -11px 0 0 -11px;
  opacity: 0;
  pointer-events: none;
  position: absolute;
  top: 0;
  width: 22px;
}

/* Entrance — the pet "comes to life": the glyph scales + fades up from its tip while a soft
   accent ring blooms out behind it. */
.kairo-cursor-shell[data-beat='entrance'] .kairo-cursor-arrow {
  animation: kairo-cursor-wake 600ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.kairo-cursor-shell[data-beat='entrance'] .kairo-cursor-burst {
  animation: kairo-cursor-burst 600ms ease-out both;
}

@keyframes kairo-cursor-wake {
  0% {
    opacity: 0;
    transform: scale(0.24);
  }
  60% {
    opacity: 1;
    transform: scale(1.12);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes kairo-cursor-burst {
  0% {
    opacity: 0.85;
    transform: scale(0.3);
  }
  100% {
    opacity: 0;
    transform: scale(3.4);
  }
}

/* Reduced-motion entrance: a plain fade, no scale/bloom. */
.kairo-cursor-shell[data-beat='entrance-reduced'] .kairo-cursor-arrow {
  animation: kairo-cursor-fade-in 220ms ease-out both;
}

@keyframes kairo-cursor-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
```

- [ ] **Step 9: Add the `runBeat` helper + entrance listener in the engine**

In `src/cursor/useCursorEngine.ts`:

(a) Extend the constants import block (lines 28-43) to also pull the new tokens/type — add these names to the existing `from './cursorConstants'` import:

```ts
  ENTRANCE_MS,
  ENTRANCE_REDUCED_MS,
  CELEBRATE_MS,
  CELEBRATE_REDUCED_MS,
  type CursorBeat,
```

(b) Define `runBeat` inside the main effect, right after the `setFx` function (after line 344):

```ts
    // One-shot expressive beat: set data-beat on the shell so CSS animates the glyph/burst,
    // then clear it after the (reduced-motion-aware) window. Entrance also force-shows the pet.
    const beatTimers = new Set<number>();
    const runBeat = (beat: CursorBeat) => {
      const shell = shellRef.current;
      if (!shell) {
        return;
      }
      const reduce = reduceMotionRef.current;
      if (beat === 'entrance') {
        // The pet is "arriving" — cancel any hide and make it visible for the wake-up.
        lastActivityRef.current = globalThis.performance?.now?.() ?? 0;
        sysVisibleRef.current = true;
        hiddenAppliedRef.current = false;
        shell.style.opacity = '1';
      }
      const name = reduce ? `${beat}-reduced` : beat;
      const durMs =
        beat === 'entrance'
          ? reduce
            ? ENTRANCE_REDUCED_MS
            : ENTRANCE_MS
          : reduce
            ? CELEBRATE_REDUCED_MS
            : CELEBRATE_MS;
      // Re-trigger cleanly if a beat is already showing (remove → next frame → set).
      delete shell.dataset.beat;
      requestAnimationFrame(() => {
        if (shellRef.current) {
          shellRef.current.dataset.beat = name;
        }
      });
      wake(); // keep the FX layer parked on the tip during the beat
      const timer = globalThis.setTimeout(() => {
        beatTimers.delete(timer);
        if (shellRef.current?.dataset.beat === name) {
          delete shellRef.current.dataset.beat;
        }
      }, durMs);
      beatTimers.add(timer);
      klog('cursor', 'debug', 'cursor beat', { beat, reduce });
    };
```

(c) Add the `cursor:entrance` listener inside the `Promise.all([ ... ])` array (alongside the other `listen(...)` calls, e.g. after the `cursor:active` listener ~line 568):

```ts
      listen('cursor:entrance', () => {
        if (!isMounted) {
          return;
        }
        runBeat('entrance');
      }),
```

(d) Clear any pending beat timers in the effect cleanup (~line 581), after `globalThis.clearInterval(idleInterval);`:

```ts
      beatTimers.forEach((timer) => globalThis.clearTimeout(timer));
```

- [ ] **Step 10: Typecheck + tests + cargo check**

Run: `npm run typecheck && npm run test && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: all clean/green.

- [ ] **Step 11: Build + verify the entrance (temporary trigger)**

The beat is fired by onboarding in a later phase; to verify now, add a **temporary** self-trigger in the engine, observe it, then revert.

Temporarily add inside the main effect, just before its `return () => {` cleanup (~line 581):

```ts
    // TEMP smoke — REMOVE before commit.
    const _smoke = globalThis.setTimeout(() => void nativeBridge.cursorEntrance(), 1500);
```

Run: `npm run app`
Expected: ~1.5s after launch the pet scales + fades up from its tip with an accent ring bloom. Log shows `cursor beat beat=entrance reduce=false`.
Reduced-motion check: enable System Settings → Accessibility → Display → Reduce Motion, relaunch → the pet just fades in (no scale/bloom); log shows `reduce=true`.

Then **remove the TEMP block** and confirm typecheck is still clean: `npm run typecheck`.

- [ ] **Step 12: Commit**

```bash
git add src-tauri/src/lib.rs src/native/nativeBridge.ts tests/nativeBridge.test.ts \
  src/cursor/cursorConstants.ts src/cursor/CursorApp.tsx src/cursor/useCursorEngine.ts src/styles.css
git commit -m "feat(cursor): add cursor:entrance wake-up beat

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `cursor:celebrate` beat — the Act 4a peak reaction

The delightful flourish on the first successful point: a quick glyph pop + accent burst. The command + bridge + burst element already exist (Task 7) — this task adds the CSS + the listener.

**Files:**
- Modify: `src/styles.css` (celebrate keyframes)
- Modify: `src/cursor/useCursorEngine.ts` (add the `cursor:celebrate` listener)

- [ ] **Step 1: Add the celebrate CSS**

In `src/styles.css`, add right after the entrance/burst block from Task 7 (before `.overlay-shell {`):

```css
/* Celebrate — the peak reaction (first real point): the glyph pops and the accent ring
   bursts out. Reuses the same burst element as entrance. */
.kairo-cursor-shell[data-beat='celebrate'] .kairo-cursor-arrow {
  animation: kairo-cursor-pop 700ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.kairo-cursor-shell[data-beat='celebrate'] .kairo-cursor-burst {
  animation: kairo-cursor-burst 700ms ease-out both;
}

@keyframes kairo-cursor-pop {
  0% {
    transform: scale(1);
  }
  30% {
    transform: scale(1.28);
  }
  55% {
    transform: scale(0.94);
  }
  100% {
    transform: scale(1);
  }
}

/* Reduced-motion celebrate: a single gentle nudge, no burst. */
.kairo-cursor-shell[data-beat='celebrate-reduced'] .kairo-cursor-arrow {
  animation: kairo-cursor-nudge 240ms ease-out both;
}

@keyframes kairo-cursor-nudge {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.08);
  }
}
```

- [ ] **Step 2: Add the celebrate listener**

In `src/cursor/useCursorEngine.ts`, in the `Promise.all([ ... ])` array, right after the `cursor:entrance` listener from Task 7, add:

```ts
      listen('cursor:celebrate', () => {
        if (!isMounted) {
          return;
        }
        runBeat('celebrate');
      }),
```

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npm run test`
Expected: clean; all pass.

- [ ] **Step 4: Build + verify (temporary trigger)**

Temporarily add inside the main effect, just before the cleanup `return`:

```ts
    // TEMP smoke — REMOVE before commit.
    const _smoke2 = globalThis.setTimeout(() => void nativeBridge.cursorCelebrate(), 2500);
```

Run: `npm run app`
Expected: ~2.5s after launch the pet pops and an accent ring bursts out from the tip. Log shows `cursor beat beat=celebrate reduce=false`.
Reduced-motion check: with Reduce Motion on, only a small nudge (no burst), log `reduce=true`.

Then **remove the TEMP block**; confirm `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/styles.css src/cursor/useCursorEngine.ts
git commit -m "feat(cursor): add cursor:celebrate peak flourish beat

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Optional subtle idle "aliveness"

A barely-there breathing on the resting glyph so an idle pet never reads as a dead dot. Gated to `data-fx='none'` (i.e. not listening/thinking/speaking) and disabled under reduced-motion and while a beat is playing.

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Add the breathing CSS**

In `src/styles.css`, add right after the celebrate block from Task 8:

```css
/* Idle aliveness: an almost-imperceptible breathe on the resting glyph so the pet feels
   alive without drawing attention. Only when no status FX is showing and no beat is
   playing; the wake/pop/fade animations (which set their own transform) take precedence. */
.kairo-cursor-shell[data-fx='none']:not([data-beat]) .kairo-cursor-arrow {
  animation: kairo-cursor-breathe 3.6s ease-in-out infinite;
}

@keyframes kairo-cursor-breathe {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.045);
  }
}
```

- [ ] **Step 2: Disable it under reduced-motion (belt-and-suspenders)**

In `src/styles.css`, add a cursor-scoped reduced-motion block right after the breathing rule:

```css
@media (prefers-reduced-motion: reduce) {
  .kairo-cursor-arrow,
  .kairo-cursor-burst {
    animation: none !important;
  }
}
```

(This is a CSS-level safety net; the engine already selects the `-reduced` beat variants, but the OS media query also kills the infinite breathe + any burst outright.)

- [ ] **Step 3: Build + eyeball**

Run: `npm run app`
Expected: at rest (shadowing the mouse, nothing happening) the pet breathes very subtly. During listening/thinking/speaking/pointing and during entrance/celebrate the breathe is absent (the fx/beat states own the glyph). With Reduce Motion on, the pet is perfectly still.
Log check: no errors; performance is unaffected (CSS-only, GPU-composited).

- [ ] **Step 4: Commit**

```bash
git add src/styles.css
git commit -m "feat(cursor): subtle idle breathing + reduced-motion safety net

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Full packaged-app smoke pass

No code — the final gate. Exercise the whole pet across every state on the real, signed app and confirm the refresh reads cohesively with the (Phase 1) notch.

**Files:** none.

- [ ] **Step 1: Green gate**

Run: `npm run typecheck && npm run test && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: all clean/green.

- [ ] **Step 2: Build the real target**

Run: `npm run app`
Then tail the log in a second terminal: `tail -F ~/Library/Logs/Kairo/kairo-latest.log`

- [ ] **Step 3: Walk every cursor state and confirm the refresh**

- **Accent:** the pet, comet trail, listening halo, thinking swirl, and target ring all render in the **user's accent** (change the accent if possible → recolors live via `accent applied` log, no relaunch).
- **Shadow / idle:** the pet follows the mouse with a soft lag; at rest it breathes subtly (unless Reduce Motion).
- **Record (hold ⌥⌃):** arrow core switches to the accent "hot" tint; the halo pulses with the live mic level (`--mic-level`).
- **Thinking:** the accent swirl orbits the tip after release.
- **Point:** the pet flies in crisply (tightened spring, no bounce) and rests at the target with the ring + speaking pulse; tip lands on the target (no misalignment).
- **Circle / box-draw:** the pen-drag reveal still draws to the box corner welded to the overlay ink.
- **Beats:** fire `cursor_entrance` / `cursor_celebrate` (temporarily, as in Tasks 7/8, or via the Phase-3+ onboarding once wired) → wake-up and pop/burst both play in the accent.
- **Reduced motion:** with System Settings → Accessibility → Reduce Motion ON, the drag snaps, beats degrade to fade/nudge, and the breathe stops.

- [ ] **Step 4: Confirm no regressions in the notch/overlay**

Ask a normal question end-to-end (voice → answer → point/overlay). Confirm the overlay box + arrival cue + notch behavior are unchanged (Phase 2 touched only `src/cursor/*`, the two Rust commands, the two bridge methods, and cursor CSS).

- [ ] **Step 5: Self-review the diff**

Run: `git log --oneline -9` and `git diff --stat main~9..HEAD` (adjust range to this phase's commits).
Confirm: no `console.*` added (all logging via `klog`/`klog!`); no secrets; `geometry.ts` untouched; every TEMP smoke block removed; the arrow tip vertex is still `(28,4)`.

There is no commit for this task unless the walk surfaces a fix — if it does, make a small dedicated commit with the standard trailer.

---

## Self-Review (author's checklist — run before handoff)

**1. Spec coverage (§11B):**
- Accent-thread `DEFAULT_TRAIL` / `DEFAULT_ARROW_FILL` / `RECORDING_FILL` + `CursorApp.tsx` gradient via `getAccent()` + live `accent:changed` → Tasks 2, 3, 4. ✓
- Recording/thinking/speaking FX derive from the accent (sensible tints, not fixed purple/red) → Task 1 (`accentTints.hot`), Tasks 2-4. ✓
- Motion cohesion (Raycast tightness + Arc fluidity) — shared spring/easing vocabulary → Task 5 (pointing spring), Tasks 7-8 (shared cubic-bezier/burst vocabulary). ✓
- Refine arrowhead glyph + trail → Task 6. ✓
- New beats `cursor:entrance` (Act 1) + `cursor:celebrate` (Act 4a), event-driven + additive → Tasks 7, 8. ✓
- Optional subtle idle aliveness → Task 9. ✓
- Re-skin status FX (halo/swirl/pulse) in the accent, tighter/legible → Task 2. ✓
- Respect `prefers-reduced-motion` → Tasks 7, 8 (`-reduced` variants), Task 9 (media-query net); existing drag reduced-motion untouched. ✓
- Keep engine semantics (spring, fly-to-target, comet trail, halo/swirl/pulse, drag-to-draw) — no behavior rewrite → verified in Task 10. ✓
- Ships independently of onboarding (accent + re-skin land first; beats are additive plumbing) → yes; onboarding fires the beats in later phases. ✓

**2. Placeholder scan:** every step has concrete code/paths/commands; no TBD/TODO/"handle edge cases". ✓

**3. Type/name consistency:** `--cur-accent` / `--cur-accent-hi` / `--cur-accent-soft` / `--cur-accent-hot` / `--cur-accent-rgb` used identically in Tasks 1, 2, 3, 6, 7, 8. `accentTints`/`applyCursorAccent` (Task 1) consumed in Task 4. `ENTRANCE_MS`/`ENTRANCE_REDUCED_MS`/`CELEBRATE_MS`/`CELEBRATE_REDUCED_MS`/`CursorBeat` (Task 7) consumed by `runBeat` (Task 7) + the celebrate listener (Task 8). `cursor_entrance`/`cursor_celebrate` (Rust, Task 7) match `cursorEntrance`/`cursorCelebrate` (bridge, Task 7) and the `cursor:entrance`/`cursor:celebrate` event names (listeners, Tasks 7-8). `TRAIL_BASE`/`TRAIL_H` values set in Task 3 match the CSS width/height in Task 6. Arrow tip vertex `(28,4)` preserved across Tasks 2 (transform-origin 87.5%/12.5%) and 6 (path). ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-onboarding-phase2-pet-cursor.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks (REQUIRED SUB-SKILL: superpowers:subagent-driven-development).
2. **Inline Execution** — execute tasks in this session with checkpoints (REQUIRED SUB-SKILL: superpowers:executing-plans).

Note: land Phase 0 (`src/core/accent.ts`) before Task 4.
