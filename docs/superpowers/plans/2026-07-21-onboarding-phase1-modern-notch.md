# Phase 1 — Modern Notch Redesign (Implementation Plan)

> REQUIRED SUB-SKILL: superpowers:executing-plans

> **Parent spec:** [`2026-07-21-onboarding-redesign-and-modern-notch.md`](./2026-07-21-onboarding-redesign-and-modern-notch.md)
> — read **§11 Modern Notch Redesign** and **§3B Shared Contracts** before starting. This plan
> implements **Phase 17.Phase-1** of that spec.
> **Depends on Phase 0** (not yet landed at time of writing): `src/core/accent.ts`
> (`getAccent()`, `onAccentChanged(cb)`, `applyAccent(hex)` + `accent:changed { hex }` event),
> `NotchState` gains `'coach'`, and `NotchPayload` gains optional `chip?: string`. Phase 1 **consumes**
> these by name; it does not define them. Task 0 gates on their presence.
>
> **Commit trailer (every commit, per AGENTS.md):**
> `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
> **Build/run the real target** (never a dev server): `npm run app` (quit → build+sign → verify → launch).
> **Logs:** `tail -F ~/Library/Logs/Kairo/kairo-latest.log`. **Log every step with `klog()`** — never `console.*`.

---

## Goal

Redesign the notch capsule into **one state-morphing element** that reshapes fluidly between its
states instead of hard-swapping cards — **Raycast tightness + Arc fluidity, NO Liquid Glass** —
threaded with the user's chosen accent color. States: `idle` · `listening` · `thinking` ·
`typing` · `error` · **`coach`** (the new onboarding caption state from Phase 0). This is a
**visual + transitions redesign only**: `NotchApp.tsx` turn orchestration semantics stay byte-for-byte
identical; the presentational surface `NotchCapsule.tsx` and the capsule CSS in `src/styles.css` are
what change.

Success = the capsule morphs (spring width/height/radius, cross-fading text — never a hard cut)
between listening / thinking / typing / coach; the accent color drives the listening pulse, thinking
shimmer, chip, and focus/highlight strokes and updates live on `accent:changed`; the base is neutral
dark with soft depth (no heavy translucency/backdrop-blur); `prefers-reduced-motion` is respected; and
every existing behavior (PTT, idle-close, hit-rect click-through, live mic level) still works in the
packaged `.app`.

---

## Architecture

**Where the notch lives.** One React entry (`src/main.tsx`) routes `#/notch` → `NotchApp`
(`src/notch/NotchApp.tsx`, ~1500 lines of turn orchestration). `NotchApp` derives a `NotchCapsuleMode`
from the current `NotchPayload` + TTS/voice state and hands it to `NotchCapsule.tsx` (the ONLY markup
the notch WebView renders — purely presentational). All CSS is in the shared `src/styles.css`,
scoped by the `.notch-document` class (added to `<html>`/`<body>` while the notch is mounted). The
native panel is a fixed-size transparent NSPanel (`760×236`, `panels.rs::notch_window_size`) centered
under the physical notch; the capsule sits inside it and `NotchApp` reports the capsule's bounding rect
via `set_notch_hit_rect` so the panel is click-through everywhere except the visible capsule.

**Contracts Phase 1 MUST preserve (do NOT touch these):**
- `NotchApp` writes the live mic level to `capsuleRef.current.style` as `--mic-level` (from the
  `cursor:level` event). The redesigned capsule must keep `capsuleRef` on the **outer** capsule
  element and keep consuming `--mic-level`.
- `NotchApp` observes `capsuleRef` with a `ResizeObserver` and re-reports the hit rect on every resize
  — so morphing the capsule width automatically keeps click-through correct. Keep `capsuleRef` on the
  element whose visible bounds define the clickable region.
- The `capsuleMode` derivation output for the existing five modes must stay identical (same mode in the
  same situation). Only add the new `coach` branch.
- `showNotch(payload)` round-trips, `subscribeToNotchPayload`, the idle-close timer, PTT/gesture
  handlers, `handleTypedSubmit`, `hideNotch` — all unchanged.

**Morph mechanism (no animation library — house style is CSS + hand-rolled springs, e.g.
`cursor/spring.ts`).** One persistent `.kairo-capsule` element (mounted whenever `mode !== 'idle'`).
Its width/height follow the active content and animate via CSS transitions on a spring-flavored
`cubic-bezier` (slight overshoot = spring feel):
- An inner content wrapper (`width: max-content`) is observed by a `ResizeObserver`; its measured
  `offsetWidth`/`offsetHeight` are written to the capsule as `--capsule-w`/`--capsule-h`, which the
  capsule transitions. Content swaps instantly inside; the capsule box morphs smoothly around it.
- Content **cross-fades** rather than hard-swaps: a tiny presence hook keeps the outgoing mode mounted
  for the transition window and layers old+new in the same grid cell (old fades/blurs out, new fades
  in) while the box morphs.
- `border-radius`, `transform` (subtle scale-on-change), and `box-shadow` transition on the same
  spring tokens. `prefers-reduced-motion` collapses the spring tokens to ~instant and disables the
  keyframe FX.

> **Key decision — animation approach.** Two options were weighed: **(A) zero-dependency CSS
> morph** (measured-width + CSS transitions + a ~40-line presence hook) vs **(B) add `framer-motion`**
> (`layout` + `AnimatePresence` gives the morph for free). **Recommendation: (A).** It matches the
> repo's minimal-dependency, CSS-driven, hand-rolled-spring house style (`spring.ts`, all-CSS notch),
> adds nothing to the public OSS Tauri bundle, and reuses the existing `prefers-reduced-motion` CSS. If
> QA finds the hand-rolled morph janky, (B) is a clean, notch-scoped swap — noted at Task 8. This plan's
> tasks are written against **(A)**.

**Accent threading.** Phase 0's `src/core/accent.ts` is the source of truth. A small notch-only hook
`useNotchAccent()` reads `getAccent()` on mount, converts the hex to a space-separated `r g b` triple
(matching the existing `--box-rgb` convention in `styles.css`), writes `--accent` + `--accent-rgb` on
`document.documentElement`, and re-writes them on `onAccentChanged`. All accent-colored CSS reads
`rgb(var(--accent-rgb) / a)`; text stays a light neutral for contrast (accent is used for
glows/strokes/chips, never as a text background — per §5 contrast rule).

---

## Tech Stack

- **Frontend:** React 19 + Vite (existing). No new runtime deps.
- **Styling:** plain CSS in `src/styles.css` (existing convention; `.notch-document`-scoped). CSS
  custom properties for accent (`--accent`, `--accent-rgb`), morph size (`--capsule-w`, `--capsule-h`),
  mic level (`--mic-level`, already wired), and spring easing tokens (`--spring-morph`, `--spring-fast`).
  Uses `color-mix(in srgb, …)` for accent shading (supported by the system WebKit on the shipping macOS
  target; a plain-rgb fallback layer is kept underneath).
- **Logging:** `klog('notch', level, msg, fields)` from `src/core/logger.ts` (mandatory).
- **Tests:** vitest, **node environment** (`vitest.config.ts` → `environment: 'node'`, no DOM libs) —
  so unit tests cover **pure helpers only** (`hexToRgbTriple`, `resolveCapsuleMode`). Visual/interaction
  states are verified by building and running the packaged `.app` and reading the log (the house
  workflow), not by DOM tests.
- **Native:** `src-tauri/src/panels.rs::notch_window_size` (verified, bumped only if a state overflows
  the frame). No other Rust changes.

---

## File Structure

**New files**
```
src/core/colorHex.ts            hexToRgbTriple(hex) -> "r g b"  (shared; Phase 2 cursor reuses)
src/notch/capsuleMode.ts        NotchCapsuleMode type + pure resolveCapsuleMode() (extracted from NotchApp, + 'coach')
src/notch/useNotchAccent.ts     reads getAccent()/onAccentChanged → sets --accent/--accent-rgb on <html>
src/notch/useCapsuleMorph.ts    ResizeObserver on inner content → writes --capsule-w/--capsule-h
src/notch/useModePresence.ts    keeps the outgoing mode mounted briefly so content cross-fades during morph
tests/colorHex.test.ts          pure test for hexToRgbTriple
tests/notchCapsuleMode.test.ts  pure test: existing 5 modes unchanged + new 'coach' branch
```

**Modified files**
```
src/notch/NotchCapsule.tsx      persistent morphing shell; layered cross-fade; coach caption + chip; accent-threaded markup
src/notch/NotchApp.tsx          call useNotchAccent(); use resolveCapsuleMode(); pass chip; (capsuleRef/--mic-level/hit-rect UNCHANGED)
src/styles.css                  rewrite .kairo-capsule* block: neutral-dark base (no glass), accent vars, spring tokens, per-state visuals, morph transitions, reduced-motion
src-tauri/src/panels.rs         notch_window_size — VERIFY fits widest/tallest morph state; bump only if overflow
```

**Do-not-touch (Phase 0 / other phases own these):** `src/core/accent.ts`, `src/notch/types.ts`
(`'coach'` + `chip?` come from Phase 0), `activation/activationState.ts`, the turn/PTT/idle-close
logic in `NotchApp.tsx`.

---

## Tasks

### Task 0 — Prerequisite gate + baseline

Confirm Phase 0 landed and the app builds clean before any visual change.

- [ ] Confirm `src/core/accent.ts` exists and exports `getAccent(): string`, `onAccentChanged(cb: (hex: string) => void): () => void`, `applyAccent(hex: string)`. (`grep -n "export" src/core/accent.ts`)
- [ ] Confirm `NotchState` in `src/notch/types.ts` includes `'coach'` and `NotchPayload` includes `chip?: string`. (`grep -n "coach\|chip" src/notch/types.ts`)
- [ ] If either is missing, STOP — Phase 1 is blocked on Phase 0; record the blocker and do not proceed.
- [ ] Baseline build is green: `npm run typecheck && npm run test && cargo check --manifest-path src-tauri/Cargo.toml`.
- [ ] `npm run app` launches; hold ⌥⌃ shows the current listening capsule; tap ⌥⌃ opens the typing box (sanity that the notch works before we touch it).
- [ ] No commit (verification only).

---

### Task 1 — Shared hex→rgb helper + pure test

Give the accent system a tested hex → `"r g b"` conversion (the `--box-rgb`/`--accent-rgb` format).

- [ ] Create `src/core/colorHex.ts`:
  ```ts
  // Convert a #rrggbb (or #rgb) hex to a space-separated "r g b" triple for CSS
  // `rgb(var(--x) / a)` usage — matches the existing --box-rgb convention in styles.css.
  // Returns null for malformed input so callers can fall back to a default.
  export function hexToRgbTriple(hex: string): string | null {
    const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `${r} ${g} ${b}`;
  }
  ```
- [ ] Create `tests/colorHex.test.ts` covering `#7c3aed` → `"124 58 237"`, 3-digit `#0af`, a leading-`#`-less input, and a malformed input → `null`.
- [ ] `npm run test` green; `npm run typecheck` green.
- [ ] Commit: `feat(notch): add tested hexToRgbTriple helper for accent CSS vars`.

---

### Task 2 — `useNotchAccent()` hook + accent CSS vars

Thread the user's accent into the notch and keep it live.

- [ ] Add default accent + spring tokens to `src/styles.css` under the notch-document scope (near the existing `.notch-document` rules at the top):
  ```css
  :root.notch-document {
    --accent: #7c3aed;
    --accent-rgb: 124 58 237;            /* brand default until getAccent() writes the user's */
    /* spring-flavored easings: slight overshoot = "settle" feel (Arc fluidity) */
    --spring-morph: 420ms cubic-bezier(0.34, 1.28, 0.5, 1);
    --spring-fast: 240ms cubic-bezier(0.34, 1.4, 0.6, 1);
  }
  ```
- [ ] Create `src/notch/useNotchAccent.ts`:
  ```ts
  import { useEffect } from 'react';
  import { getAccent, onAccentChanged } from '../core/accent';
  import { hexToRgbTriple } from '../core/colorHex';
  import { klog } from '../core/logger';

  // Write the user's accent (from Phase 0's accent pref) onto <html> as --accent /
  // --accent-rgb so every notch CSS rule threads it, and keep it live on accent:changed.
  export function useNotchAccent(): void {
    useEffect(() => {
      const apply = (hex: string) => {
        const triple = hexToRgbTriple(hex);
        if (!triple) {
          klog('notch', 'warn', 'ignored malformed accent', { hex });
          return;
        }
        const root = document.documentElement;
        root.style.setProperty('--accent', hex);
        root.style.setProperty('--accent-rgb', triple);
        klog('notch', 'debug', 'accent applied', { hex });
      };
      apply(getAccent());
      const off = onAccentChanged(apply);
      return () => off();
    }, []);
  }
  ```
- [ ] Call it once at the top of `NotchApp` (one line, no logic change):
  ```ts
  // inside NotchApp(), near the other top-level hooks
  useNotchAccent();
  ```
  and add `import { useNotchAccent } from './useNotchAccent';`.
- [ ] `npm run typecheck` green. `npm run app`; in the log confirm `accent applied` fires on mount. If Phase 0 exposes a way to change the accent, change it and confirm a second `accent applied` line (live update). Otherwise defer the live-update confirmation to Task 8's QA.
- [ ] Commit: `feat(notch): thread user accent into notch via useNotchAccent + CSS vars`.

---

### Task 3 — Neutral-dark base (kill the glass) + spring morph transitions

Rebuild the capsule shell: no backdrop-blur/vibrancy, soft depth, and transition tokens ready for morph.

- [ ] In `src/styles.css` replace the `.kairo-capsule` base rule (currently `backdrop-filter: blur(24px) saturate(1.3)` + translucent gradient) with a neutral-dark, non-glass base that reads `--capsule-w/-h` and transitions on the spring tokens:
  ```css
  .kairo-capsule {
    --mic-level: 0;
    align-items: center;
    /* Neutral dark, NOT liquid glass: near-opaque, no backdrop-filter. */
    background: linear-gradient(180deg, #1b1d23, #101216);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 20px;                 /* rounded-rect; pill for compact states via --radius */
    box-shadow:
      0 10px 30px rgb(0 0 0 / 0.46),
      0 0 0 0.5px rgb(0 0 0 / 0.55),
      inset 0 1px 0 rgb(255 255 255 / 0.06);
    color: #eef1f5;
    display: flex;
    gap: 10px;
    padding: 9px 16px;
    pointer-events: auto;
    width: var(--capsule-w, auto);
    min-height: var(--capsule-h, auto);
    transition:
      width var(--spring-morph),
      min-height var(--spring-morph),
      border-radius var(--spring-fast),
      transform var(--spring-fast),
      box-shadow 200ms ease;
    animation: kairo-capsule-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  /* Compact states read as a pill; roomy states (typing/coach) as a soft rounded-rect. */
  .kairo-capsule[data-mode='listening'],
  .kairo-capsule[data-mode='thinking'],
  .kairo-capsule[data-mode='error'] {
    border-radius: 999px;
  }
  ```
- [ ] Keep the existing `@keyframes kairo-capsule-in` (entrance) but retune the transform for a spring settle:
  ```css
  @keyframes kairo-capsule-in {
    from { opacity: 0; transform: translateY(-10px) scale(0.94); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  ```
- [ ] Add a reduced-motion block that collapses the springs and stops FX (place it right after the capsule rules):
  ```css
  @media (prefers-reduced-motion: reduce) {
    :root.notch-document { --spring-morph: 1ms linear; --spring-fast: 1ms linear; }
    .kairo-capsule { animation: none; }
    .kairo-capsule * { animation: none !important; }
  }
  ```
- [ ] `npm run app`; hold ⌥⌃ and confirm the capsule now reads as a solid neutral-dark pill with a soft shadow (no frosted-glass blur). No regression in show/hide.
- [ ] Commit: `feat(notch): neutral-dark non-glass capsule base + spring transition tokens`.

---

### Task 4 — Morph engine: persistent shell + width/height follow + content cross-fade

Turn `NotchCapsule` into one persistent morphing element whose box follows its content and whose content cross-fades.

- [ ] Create `src/notch/useCapsuleMorph.ts`:
  ```ts
  import { useEffect, type RefObject } from 'react';

  // Observe the inner content (width: max-content) and mirror its measured size onto the
  // outer capsule as --capsule-w / --capsule-h, which the capsule transitions (spring).
  // Content swaps instantly inside; the box morphs smoothly around it.
  export function useCapsuleMorph(
    outerRef: RefObject<HTMLElement | null>,
    innerRef: RefObject<HTMLElement | null>
  ): void {
    useEffect(() => {
      const outer = outerRef.current;
      const inner = innerRef.current;
      if (!outer || !inner || typeof ResizeObserver === 'undefined') return;
      const sync = () => {
        outer.style.setProperty('--capsule-w', `${Math.ceil(inner.offsetWidth)}px`);
        outer.style.setProperty('--capsule-h', `${Math.ceil(inner.offsetHeight)}px`);
      };
      sync();
      const ro = new ResizeObserver(sync);
      ro.observe(inner);
      return () => ro.disconnect();
    }, [outerRef, innerRef]);
  }
  ```
- [ ] Create `src/notch/useModePresence.ts`:
  ```ts
  import { useEffect, useRef, useState } from 'react';

  export type Presence<T> = { key: T; phase: 'in' | 'out' };

  // Keep the outgoing mode mounted for `ms` so its content can cross-fade/blur out while
  // the new content fades in and the capsule box morphs. Returns 1 (steady) or 2 (during
  // a transition) layers to render in the same grid cell.
  export function useModePresence<T>(mode: T, ms: number): Presence<T>[] {
    const [layers, setLayers] = useState<Presence<T>[]>([{ key: mode, phase: 'in' }]);
    const prev = useRef(mode);
    useEffect(() => {
      if (prev.current === mode) return;
      const leaving = prev.current;
      prev.current = mode;
      setLayers([{ key: leaving, phase: 'out' }, { key: mode, phase: 'in' }]);
      const t = setTimeout(() => setLayers([{ key: mode, phase: 'in' }]), ms);
      return () => clearTimeout(t);
    }, [mode, ms]);
    return layers;
  }
  ```
- [ ] Rewrite `src/notch/NotchCapsule.tsx` to a persistent morphing shell. Keep `capsuleRef` on the OUTER capsule (preserves `--mic-level` + hit-rect contract). Add an internal `innerRef` for morph measuring. Render layered content via `useModePresence`; extract per-mode content into a `renderModeContent(mode)` helper. Accept a new `chip?: string` prop for the coach state. Sketch:
  ```tsx
  import { useRef } from 'react';
  import { CloseIcon } from './NotchIcons';
  import type { NotchCapsuleMode } from './capsuleMode';
  import { useCapsuleMorph } from './useCapsuleMorph';
  import { useModePresence } from './useModePresence';

  const MORPH_MS = 420; // keep in sync with --spring-morph

  type NotchCapsuleProps = {
    mode: NotchCapsuleMode;
    statusLabel: string;
    detail: string;
    chip?: string;                 // coach seeded-prompt chip (Phase 0 payload.chip)
    query: string;
    capsuleRef: React.RefObject<HTMLDivElement | null>;
    onQueryChange: (v: string) => void;
    onSubmit: () => void;
    onHide: () => void;
    onCapsulePointer: () => void;
    onPointerLeave: () => void;
    onPointerDown: () => void;
  };

  export function NotchCapsule(props: NotchCapsuleProps) {
    const { mode, capsuleRef } = props;
    const innerRef = useRef<HTMLDivElement | null>(null);
    useCapsuleMorph(capsuleRef, innerRef);
    const layers = useModePresence(mode, MORPH_MS);

    return (
      <main className="kairo-capsule-shell" aria-label="Kairo status">
        {mode === 'idle' ? null : (
          <div
            ref={capsuleRef}
            className="kairo-capsule"
            data-mode={mode}
            onPointerEnter={props.onCapsulePointer}
            onPointerMove={props.onCapsulePointer}
            onPointerLeave={props.onPointerLeave}
            onPointerDown={props.onPointerDown}
          >
            <div className="kairo-capsule-inner" ref={innerRef}>
              {layers.map((l) => (
                <div key={String(l.key)} className="kairo-capsule-layer" data-phase={l.phase}>
                  {renderModeContent(l.key, props)}
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    );
  }
  ```
  where `renderModeContent(mode, props)` returns the existing `typing`/`error`/`listening`/`thinking`
  markup (moved verbatim from today's component) plus the new `coach` markup (Task 6). The measured
  layer for `--capsule-w/-h` is the **entering** (`data-phase="in"`) layer — the leaving layer is
  absolutely positioned so it does not inflate the measurement (see CSS below).
- [ ] Add the layer/inner CSS to `src/styles.css`:
  ```css
  .kairo-capsule-inner {
    display: grid;
    grid-template-areas: 'stack';
    width: max-content;
    align-items: center;
    justify-items: start;
  }
  .kairo-capsule-layer {
    grid-area: stack;
    transition: opacity 200ms ease, filter 200ms ease, transform var(--spring-fast);
  }
  .kairo-capsule-layer[data-phase='in'] { opacity: 1; filter: blur(0); }
  /* Leaving layer is taken out of flow so it doesn't stretch the measured size. */
  .kairo-capsule-layer[data-phase='out'] {
    position: absolute;
    inset: 0;
    opacity: 0;
    filter: blur(6px);
    pointer-events: none;
  }
  ```
- [ ] `npm run app`; exercise transitions: hold ⌥⌃ (listening) → release (thinking) → tap ⌥⌃ (typing). Confirm the capsule **reshapes fluidly** (width/height/radius spring) and text **cross-fades** rather than hard-swaps. Confirm the typing box still focuses and submits, and the hit-rect still lets clicks pass around the capsule (nothing else on screen becomes unclickable). Check the log for no new errors.
- [ ] Commit: `feat(notch): morphing capsule — persistent shell, size-follow, content cross-fade`.

---

### Task 5 — Extract `resolveCapsuleMode()` (pure) + add the `coach` branch

Make the mode derivation pure + tested, and add `coach` without changing the existing five outcomes.

- [ ] Create `src/notch/capsuleMode.ts` — move `NotchCapsuleMode` here (add `'coach'`) and lift the exact inline logic from `NotchApp.tsx` (lines ~1430-1443), prepending the `coach` branch:
  ```ts
  import type { NotchPayload } from './types';
  import type { VoiceCaptureState } from './voiceRecorder';

  export type NotchCapsuleMode =
    | 'listening' | 'thinking' | 'coach' | 'typing' | 'error' | 'idle';

  // Pure mirror of NotchApp's derivation. The five existing branches are byte-identical
  // to the previous inline logic; the only addition is the leading 'coach' branch, which
  // renders Phase 0's onboarding caption state.
  export function resolveCapsuleMode(a: {
    state: NotchPayload['state'];
    layout: NotchPayload['layout'];
    isSpeaking: boolean;
    isSubmitting: boolean;
    voiceCaptureState: VoiceCaptureState;
    detailHidden: boolean;
  }): NotchCapsuleMode {
    if (a.state === 'coach') return 'coach';
    if (a.state === 'listening') return 'listening';
    if (!a.isSpeaking && a.voiceCaptureState === 'error') return 'error';
    if (
      !a.isSpeaking &&
      (a.isSubmitting || a.state === 'thinking' || a.voiceCaptureState === 'transcribing' || a.detailHidden)
    )
      return 'thinking';
    if (!a.isSpeaking && a.layout === 'prompt') return 'typing';
    return 'idle';
  }
  ```
- [ ] In `NotchApp.tsx`: replace the inline `const capsuleMode: NotchCapsuleMode = payload.state === 'listening' ? … : 'idle';` block with:
  ```ts
  const capsuleMode = resolveCapsuleMode({
    state: payload.state,
    layout: payload.layout,
    isSpeaking: tts.isSpeaking,
    isSubmitting,
    voiceCaptureState,
    detailHidden
  });
  ```
  Update imports: `import { resolveCapsuleMode, type NotchCapsuleMode } from './capsuleMode';` and change the `NotchCapsule` import to `import { NotchCapsule } from './NotchCapsule';` (the type now lives in `capsuleMode.ts`). Have `NotchCapsule.tsx` import `NotchCapsuleMode` from `./capsuleMode` too.
- [ ] Create `tests/notchCapsuleMode.test.ts` asserting: listening→`listening`; error (not speaking)→`error`; thinking/transcribing/isSubmitting/detailHidden (not speaking)→`thinking`; `layout:'prompt'` (not speaking)→`typing`; speaking suppresses everything except listening→`idle`; and `state:'coach'`→`coach` (regardless of other fields).
- [ ] `npm run test` + `npm run typecheck` green.
- [ ] Commit: `refactor(notch): extract pure resolveCapsuleMode + add coach branch (tested)`.

---

### Task 6 — Coach state visual: caption + seeded-prompt chip

Render Phase 0's `coach` payload as a clean caption line with an optional accent chip.

- [ ] In `NotchApp.tsx`, pass the chip through to the capsule (payload already carries `detail`):
  ```tsx
  <NotchCapsule
    mode={capsuleMode}
    statusLabel={statusLabel}
    detail={payload.detail}
    chip={payload.chip}
    …
  />
  ```
- [ ] In `NotchCapsule.tsx` `renderModeContent`, add the coach branch:
  ```tsx
  if (mode === 'coach') {
    return (
      <div className="kairo-capsule-coach">
        <span className="kairo-capsule-caption">{props.detail}</span>
        {props.chip ? <span className="kairo-capsule-chip">{props.chip}</span> : null}
      </div>
    );
  }
  ```
- [ ] Add the coach CSS to `src/styles.css` (light neutral caption text; accent only on the chip stroke/fill — contrast-safe):
  ```css
  .kairo-capsule-coach {
    display: flex;
    flex-direction: column;
    gap: 7px;
    max-width: 520px;
    padding: 2px 2px;
  }
  .kairo-capsule-caption {
    color: #eef1f5;
    font-size: 0.9rem;
    font-weight: 560;
    line-height: 1.35;
  }
  .kairo-capsule-chip {
    align-self: flex-start;
    border: 1px solid rgb(var(--accent-rgb) / 0.55);
    background: rgb(var(--accent-rgb) / 0.12);
    color: color-mix(in srgb, rgb(var(--accent-rgb)) 55%, #ffffff 45%);
    border-radius: 999px;
    padding: 3px 11px;
    font-size: 0.76rem;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  ```
- [ ] Verify without onboarding by pushing a coach payload from the notch WebView devtools console (or a throwaway `emit`), e.g.:
  ```js
  // in the notch WebView console (Web Inspector on the packaged app)
  window.__TAURI__.event.emit('notch:update',
    { state: 'coach', layout: 'compact', title: 'Kairo',
      detail: "Hold Option and Control together, say hi, then let go.",
      chip: "try: 'hey Kairo, what's up?'" });
  ```
  Confirm the capsule morphs to a caption + accent chip and the chip reads in the user's accent.
  Remove any throwaway test emit before committing.
- [ ] `npm run typecheck` green.
- [ ] Commit: `feat(notch): render coach caption + accent seeded-prompt chip`.

---

### Task 7 — Accent-threaded state visuals: listening pulse, thinking shimmer, typing/error

Re-skin the live states so the accent (not the old hard-coded purple) drives them.

- [ ] **Listening** — accent waveform + a mic-level-driven accent glow. Replace the `.kairo-capsule-viz` / listening rules so bars use the accent and add a glow ring that scales with `--mic-level`:
  ```css
  .kairo-capsule-viz i {
    background: linear-gradient(180deg,
      color-mix(in srgb, rgb(var(--accent-rgb)) 65%, #ffffff 35%),
      rgb(var(--accent-rgb)));
    border-radius: 999px;
    width: 3px;
    height: 6px;
  }
  .kairo-capsule[data-mode='listening'] {
    /* accent halo breathes with the live mic level */
    box-shadow:
      0 10px 30px rgb(0 0 0 / 0.46),
      0 0 calc(6px + var(--mic-level, 0) * 22px)
        rgb(var(--accent-rgb) / calc(0.18 + var(--mic-level, 0) * 0.5));
  }
  .kairo-capsule[data-mode='listening'] .kairo-capsule-viz i {
    height: calc(4px + var(--mic-level, 0) * 16px);
    transition: height 80ms ease-out;
    animation: kairo-viz-idle 1.4s ease-in-out infinite;
  }
  ```
  Keep the existing `nth-child` animation-delays and `@keyframes kairo-viz-idle`.
- [ ] **Thinking** — accent shimmer. Keep the bar markup but tint it accent, and add a subtle accent sweep across the capsule:
  ```css
  .kairo-capsule[data-mode='thinking'] .kairo-capsule-viz i {
    background: rgb(var(--accent-rgb) / 0.85);
    animation: kairo-viz-think 1s ease-in-out infinite;
  }
  .kairo-capsule[data-mode='thinking']::after {
    content: '';
    position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
    background: linear-gradient(100deg, transparent 30%,
      rgb(var(--accent-rgb) / 0.16) 50%, transparent 70%);
    background-size: 220% 100%;
    animation: kairo-accent-shimmer 1.6s linear infinite;
  }
  @keyframes kairo-accent-shimmer {
    from { background-position: 200% 0; }
    to   { background-position: -20% 0; }
  }
  ```
  (Ensure `.kairo-capsule` is `position: relative` so `::after` anchors — add it to the base rule.)
- [ ] **Typing + error** — swap the remaining hard-coded purples to accent:
  - `.kairo-capsule-prompt input:focus` border → `rgb(var(--accent-rgb) / 0.7)`.
  - `.kairo-capsule-ask` gradient → `linear-gradient(135deg, color-mix(in srgb, rgb(var(--accent-rgb)) 78%, #ffffff 22%), rgb(var(--accent-rgb)))`.
  - `.kairo-capsule-icon[data-active='true']` background → `rgb(var(--accent-rgb) / 0.5)`.
  - Keep the amber error tint (`.kairo-capsule[data-mode='error']`) — a warning color should stay non-accent, but modernize its border/label to match the new base.
- [ ] `npm run app`; hold ⌥⌃ and speak — confirm the halo + bars pulse with your voice **in the accent color**; release → accent shimmer while thinking; open typing → accent focus ring + Ask button. If Phase 0 lets you change the accent, verify all three restyle live.
- [ ] Commit: `feat(notch): accent-thread listening pulse, thinking shimmer, typing/error`.

---

### Task 8 — Show/hide spring, micro-interactions, reduced-motion polish

Make the capsule spring in/out of the notch cutout and add the small settle/glow beats; finalize reduced-motion.

- [ ] **Scale-on-change micro-interaction:** add a brief transform nudge when the mode changes (uses the entering layer):
  ```css
  .kairo-capsule-layer[data-phase='in'] { transform: scale(1); }
  @keyframes kairo-mode-pop { from { transform: scale(0.985); } to { transform: scale(1); } }
  .kairo-capsule { animation: kairo-capsule-in 220ms cubic-bezier(0.22,1,0.36,1) both; }
  .kairo-capsule[data-mode] .kairo-capsule-layer[data-phase='in'] {
    animation: kairo-mode-pop var(--spring-fast) both;
  }
  ```
- [ ] **Exit (hide) spring:** the capsule currently just unmounts on idle. Add a soft exit by keeping the entrance keyframe symmetric and letting `useModePresence` cover the content fade; verify the `idle` unmount reads as a gentle retract (it slides up into the notch via the reverse of `kairo-capsule-in` — if the hard unmount looks abrupt, add a short `data-mode='idle'` fade-out layer before unmount; otherwise leave the instant unmount, which is acceptable and matches "smooth show" being the priority).
- [ ] **Accent peak-glow hook (capability only; wired in Phase 5):** add a `data-glow` attribute style the pet's celebration can flash later — do NOT trigger it here:
  ```css
  .kairo-capsule[data-glow='peak'] {
    box-shadow:
      0 10px 30px rgb(0 0 0 / 0.46),
      0 0 34px rgb(var(--accent-rgb) / 0.55);
    animation: kairo-peak-glow 700ms ease-out;
  }
  @keyframes kairo-peak-glow {
    0% { box-shadow: 0 10px 30px rgb(0 0 0 / 0.46), 0 0 0 rgb(var(--accent-rgb) / 0); }
    40% { box-shadow: 0 10px 30px rgb(0 0 0 / 0.46), 0 0 40px rgb(var(--accent-rgb) / 0.6); }
    100% { box-shadow: 0 10px 30px rgb(0 0 0 / 0.46), 0 0 18px rgb(var(--accent-rgb) / 0.25); }
  }
  ```
  Add a code comment noting Phase 5 sets `data-glow="peak"` on the first successful point.
- [ ] **Reduced-motion:** confirm the Task 3 block also silences the new shimmer/pop/glow (the `.kairo-capsule *` rule covers them). Add explicit `transition: none` for the layers under reduced-motion if any residual movement remains.
- [ ] `npm run app` with **System Settings → Accessibility → Display → Reduce Motion ON**: confirm the capsule snaps between states with no springy overshoot and no shimmer, and content still cross-fades (opacity only). Turn it OFF and confirm the fluid morph returns.
- [ ] **Alternative escape hatch (note only, no code):** if the hand-rolled morph reads janky here, the fallback is to add `framer-motion` scoped to the notch (`<motion.div layout>` + `AnimatePresence` + `MotionConfig reducedMotion="user"`) — swap in `NotchCapsule.tsx` only; the rest of this plan is unaffected.
- [ ] Commit: `feat(notch): show/hide spring, mode-change micro-interactions, reduced-motion`.

---

### Task 9 — Native frame sizing sanity (`notch_window_size`)

The capsule morphs **inside** the fixed transparent panel; confirm the frame fits the widest/tallest state.

- [ ] Read `src-tauri/src/panels.rs::notch_window_size` — it currently returns a fixed `(760.0, 236.0)` for all states, with `let _ = layout; let _ = state;`.
- [ ] With the app running, exercise the widest states (typing input `min(560px, 72vw)` + Ask + Close; a 2-line coach caption + chip) and confirm the capsule never clips against the 760×236 frame (44px top padding clears the physical notch). The capsule is centered, so it has ~760px to grow into and ~192px vertical.
- [ ] If (and only if) a real state overflows, bump the constant (e.g. width to `860.0` and/or height to `260.0`) and add a `klog!(notch, debug, w = …, h = …, "notch frame size")` where the size is chosen. Otherwise leave it fixed and add a one-line comment: `// morph happens INSIDE this fixed frame; capsule sizes itself (see NotchCapsule --capsule-w/-h)`.
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` green; rebuild via `npm run app` and re-verify.
- [ ] Commit: `chore(notch): confirm panel frame fits the morphing capsule` (or `fix(notch): widen notch frame for coach caption` if bumped).

---

### Task 10 — Self-review & verification

Full pass against the spec and the preserved-logic guardrails.

- [ ] `npm run typecheck` — clean.
- [ ] `npm run test` — clean (colorHex + notchCapsuleMode included).
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` — clean.
- [ ] `npm run app` and drive every state end-to-end while tailing `~/Library/Logs/Kairo/kairo-latest.log`:
  - [ ] Hold ⌥⌃ → **listening**: accent halo + bars pulse with your voice (`--mic-level`); no auto-close mid-hold.
  - [ ] Release → **thinking**: accent shimmer; morph from listening was fluid (no hard cut).
  - [ ] A real answer speaks → capsule hides (cursor carries speaking) exactly as before (behavior preserved).
  - [ ] Tap ⌥⌃ → **typing**: focus ring + Ask in accent; typing/submit works; click-through around the capsule still works (targets under the notch remain clickable).
  - [ ] Trigger a **voice error** (release without speaking) → amber self-dismissing capsule, then idle.
  - [ ] Emit a **coach** payload (Task 6 method) → caption + accent chip; morphs in/out smoothly.
  - [ ] Change accent (if Phase 0 provides a control) → every state restyles live (`accent applied` in the log).
  - [ ] Reduce Motion ON → no springs/shimmer, opacity-only cross-fade; OFF → fluid morph returns.
- [ ] Confirm **no logic changed**: `git diff` shows `NotchApp.tsx` touched only for `useNotchAccent()`, `resolveCapsuleMode()`, and the `chip` prop — the turn/PTT/idle-close/hit-rect/`--mic-level` code is untouched. `capsuleRef` still on the outer capsule.
- [ ] Confirm **no glass**: `grep -n "backdrop-filter" src/styles.css` shows the `.kairo-capsule` base no longer uses it (only unrelated non-notch rules may).
- [ ] Confirm **no `console.*`** added: `grep -rn "console\." src/notch/*.ts src/notch/*.tsx` is clean (all logging via `klog`).
- [ ] Re-read spec **§11** and check off each bullet: one morphing element ✓, spring morph/no hard swaps ✓, Raycast-tight + Arc-fluid ✓, no Liquid Glass ✓, accent-threaded (listening/thinking/highlights) ✓, legible per-state ✓, coach caption+chip ✓, smooth show/hide ✓, micro-interactions ✓, `prefers-reduced-motion` ✓, logic preserved ✓.
- [ ] Final commit if any fixes: `chore(notch): phase-1 modern notch self-review fixes`.

---

## Self-Review Checklist (author, before handing off)

- [ ] Every new symbol referenced exists or is an explicit Phase 0 prerequisite (Task 0 gates it):
  `getAccent`/`onAccentChanged` (accent.ts), `NotchState:'coach'`, `NotchPayload.chip?`.
- [ ] No new runtime dependency added (CSS-first morph; framer-motion is only a documented fallback).
- [ ] `NotchApp.tsx` diff is limited to accent hook + pure mode helper + `chip` prop; orchestration
  (turns, PTT, idle-close, hit-rect, `--mic-level`) untouched; `capsuleRef` stays on the outer capsule.
- [ ] All accent colors read `rgb(var(--accent-rgb) / a)`; text stays light-neutral (accent only on
  glows/strokes/chips) per the §5 contrast rule.
- [ ] Reduced-motion path verified; no state relies on motion to be legible.
- [ ] Each task is independently committable and leaves the app runnable; commit messages carry the
  AGENTS.md trailer.
- [ ] Pure helpers (`hexToRgbTriple`, `resolveCapsuleMode`) are unit-tested in node env; visual states
  verified in the packaged `.app`, not DOM tests.
