# Onboarding Phase 7 — Re-runnable + Polish — Implementation Plan

> **Status:** Ready to implement. Final polish phase of the onboarding redesign.
> **Depends on:** Phases 0-6 of the onboarding redesign (see
> [`2026-07-21-onboarding-redesign-and-modern-notch.md`](./2026-07-21-onboarding-redesign-and-modern-notch.md),
> §10 Re-runnable+Resume, §5 accent contrast, §11/§11B motion, §16 Risks, §3B Shared Contracts).
> This phase assumes Phase 0's `src/core/accent.ts` (`getAccent`/`setAccent`/`applyAccent`/
> `onAccentChanged`) + the `vibrant_accent` blend rule exist, Phase 1's morphing notch capsule
> exists, Phase 2's pet beats (`cursor:entrance`, `cursor:celebrate`) exist, and Phases 3-6's
> 6-act onboarding orchestrator + color wheel + sign-in + `finish_onboarding` wiring exist.

> REQUIRED SUB-SKILL: superpowers:executing-plans

---

## Goal

Ship the final polish that makes the new onboarding **survivable and inclusive**:

1. **Replay intro** — a menu-bar tray item ("Replay intro") + a native command that clears the
   onboarded marker and reopens the onboarding window. Critical because macOS permission prompts +
   Sequoia's periodic Screen-Recording reset interrupt the first run (spec §10).
2. **Reduced motion** — one shared `prefers-reduced-motion` source of truth, audited across the
   notch morph (Phase 1), the pet springs/entrance/celebrate (Phase 2), and the onboarding
   transitions (Phases 3-6). Motion-sensitive users get snaps + instant fades, never spinning.
3. **Accent contrast clamps** — enforce a legible mark/glow + readable text-on-accent for ANY
   chosen hue, guarding both the color wheel (frontend, `src/core/accent.ts`) and the native
   `vibrant_accent` blend (`src-tauri/src/color.rs`) (spec §5, §16 risk 5).
4. **Sequoia reset heads-up** — a friendly, non-blocking in-product note when macOS silently resets
   Screen Recording, so the OS nag doesn't read as "Kairo broke" (spec §6, §16).
5. **Optional music toggle** — off by default, localStorage-gated like the sound cues; ships the
   toggle + a no-op-safe player, with the asset itself explicitly deferred.
6. **End-to-end QA checklist** — the final task: build the packaged `.app` and walk all 6 acts,
   the Screen-Recording quit+reopen resume, value-first ordering, and the paywall exemption.

Each item is independent and additive — none rewrites onboarding logic. Every task leaves the app
runnable and is its own commit.

---

## Architecture

- **Replay intro** lives entirely native: a `replay_onboarding` helper in `src-tauri/src/onboarding.rs`
  (mirror of `finish_onboarding` — it deletes the marker instead of writing it), a thin
  `#[tauri::command]` wrapper, a new `MenuItem` in `create_menu_bar_tray` (`src-tauri/src/lib.rs`),
  and one `invoke_handler` registration.
- **Reduced motion** is centralized in a new `src/core/reducedMotion.ts` (`prefersReducedMotion()` +
  `onReducedMotionChange`). The existing hand-rolled `matchMedia` in `useCursorEngine.ts` (line ~118)
  is refactored to consume it; the notch morph + onboarding orchestrator read the same helper. Pure
  CSS animations get `@media (prefers-reduced-motion: reduce)` blocks (extending the ones already in
  `src/styles.css` and `src/onboarding/onboarding.css`).
- **Accent contrast** splits into (a) frontend `clampAccent`/`contrastRatio`/`accentInk` helpers added
  to Phase 0's `src/core/accent.ts` — the color wheel runs its picked hue through `clampAccent` before
  `setAccent`; and (b) a native `ensure_contrast` helper in `src-tauri/src/color.rs` — the accent
  blend nudges lightness (preserving hue) until it clears a WCAG-ish floor against the sampled pixels.
- **Sequoia heads-up** is a product-level runtime detector: a `screen_recording_granted` marker (a
  sibling of the `onboarded` marker) records that Screen Recording was *ever* authorized. On startup
  the app compares the marker against the live `get_permission_status`; a marker-but-now-denied state
  means macOS reset it → emit an app-global `permissions:screen-recording-reset` event. The notch
  (`NotchApp.tsx`) listens and shows a friendly, one-click-to-fix line. Never blocks a turn.
- **Music toggle** copies the `src/core/sound.ts` localStorage pattern into a small
  `src/core/music.ts` (`musicEnabled()` gated by `kairo.music.enabled`, default `false`), plus a
  mute/unmute control in the onboarding orchestrator. No asset is bundled; the player no-ops when the
  asset is absent so nothing half-built ships audibly.

## Tech Stack

- **Native:** Rust + Tauri v2 (`tauri::menu`, `tauri::tray`, `#[tauri::command]`, `app.emit`,
  `app.path().app_config_dir()`), `klog!` logging (mandatory — never `println!`/`eprintln!`).
- **Frontend:** React 19 + TypeScript, `matchMedia`, `localStorage`, `@tauri-apps/api` `invoke` +
  `listen` (via `useTauriListeners`), `klog()` logging (mandatory — never `console.*`).
- **Tests:** vitest (node env, no DOM libs — guard `window`/`matchMedia`) in `tests/`; `cargo test`
  for the Rust color math.
- **Build/verify:** `npm run typecheck`, `npm run test`, `cargo check --manifest-path
  src-tauri/Cargo.toml`, and the packaged `.app` via `npm run app` (never a dev server).

---

## File Structure

```text
NEW
  src/core/reducedMotion.ts             shared prefers-reduced-motion source of truth
  src/core/music.ts                     optional ambient-music player (off by default, no-op safe)
  tests/accent.test.ts                  unit tests for clampAccent/contrastRatio/accentInk
  tests/reducedMotion.test.ts           unit tests for prefersReducedMotion (matchMedia guarded)

MODIFIED (native)
  src-tauri/src/onboarding.rs           + replay_onboarding() helper + replay_onboarding_cmd command
  src-tauri/src/lib.rs                  + "Replay intro" tray item + handler; register the command;
                                        + screen-recording-reset detection + marker + event emit
  src-tauri/src/color.rs                + relative_luminance/contrast_ratio/ensure_contrast; enforce
                                        the contrast floor in the accent path
  src-tauri/src/permissions.rs          (only if a small is-authorized helper is needed for the marker)

MODIFIED (frontend)
  src/core/accent.ts                    + clampAccent, contrastRatio, luminance, accentInk (Phase 0 file)
  src/cursor/useCursorEngine.ts         refactor onto reducedMotion.ts; dampen entrance/celebrate
  src/notch/NotchApp.tsx                listen for permissions:screen-recording-reset → friendly line
  src/onboarding/OnboardingFlow.tsx     color-wheel → clampAccent before setAccent; RM-gate transitions;
                                        music toggle control
  src/styles.css                        + @media(reduce) blocks for the Phase 1 morph capsule classes
  src/onboarding/onboarding.css         extend the existing @media(reduce) block for new act/panel classes
  src/native/nativeBridge.ts            + replayOnboarding() typed wrapper (optional, for parity)
```

> **Note on Phase dependencies:** Tasks 4-6 (reduced-motion) and Task 2's color-wheel wiring touch
> classes/refs/events introduced by Phases 1-6. Where an exact class name is Phase-owned, this plan
> names the Phase-3B contract (e.g. `cursor:entrance`, `permissions:screen-recording-reset`, the
> `'coach'` notch state) and says "extend the block added in Phase N". Confirm the exact selector in
> the running code before editing — the mechanism (shared helper + `@media` block) is what matters.

---

## Tasks

### Task 1 — "Replay intro" native command + tray item

**Depends on:** existing `onboarding.rs` (`finish_onboarding`, `show_onboarding_window`,
`onboarded_marker`, `onboarding_step_marker`) and `lib.rs` `create_menu_bar_tray`.

**1.1** In `src-tauri/src/onboarding.rs`, add a reusable helper + a command wrapper. Place after
`finish_onboarding`:

```rust
/// Re-run first-run onboarding on demand ("Replay intro" tray item / `replay_onboarding_cmd`).
/// The inverse of `finish_onboarding`: delete the onboarded marker + any stale resume step, drop
/// PTT ownership, flip back to Regular so the window can take keyboard focus, then (re)open the
/// onboarding window. Idempotent — safe to call while already onboarding.
pub(crate) fn replay_onboarding(app: &tauri::AppHandle) {
    if let Some(path) = onboarded_marker(app) {
        let _ = std::fs::remove_file(path);
    }
    if let Some(path) = onboarding_step_marker(app) {
        let _ = std::fs::remove_file(path);
    }
    crate::input::ONBOARDING_PTT.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
    show_onboarding_window(app);
    crate::klog!(app, info, "replay intro: onboarding marker cleared + window reopened");
}

/// Frontend/tray entry point for "Replay intro".
#[tauri::command]
pub(crate) fn replay_onboarding_cmd(app: tauri::AppHandle) {
    replay_onboarding(&app);
}
```

**1.2** In `src-tauri/src/lib.rs` `create_menu_bar_tray`, add the item and wire it. The tray closure
already receives `app: &AppHandle`, so it can call the helper directly:

```rust
    let show_item = MenuItem::with_id(app, "tray_show_notch", "Show Notch", true, None::<&str>)?;
    let replay_item =
        MenuItem::with_id(app, "tray_replay_intro", "Replay intro", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray_quit", "Quit Kairo", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &replay_item, &separator, &quit_item])?;
```

And in the `on_menu_event` match, add a new arm (before the `other =>` fallthrough):

```rust
            "tray_replay_intro" => {
                klog!(app, info, "menu bar: replay intro selected");
                crate::onboarding::replay_onboarding(app);
            }
```

**1.3** Register the command in the `tauri::generate_handler!` list in `lib.rs` (next to the other
`onboarding::` entries, ~line 725-728):

```rust
            onboarding::finish_onboarding,
            onboarding::replay_onboarding_cmd,
            onboarding::set_onboarding_step,
            onboarding::get_onboarding_step,
            onboarding::set_onboarding_ptt,
```

**1.4** (Optional, for typed parity) In `src/native/nativeBridge.ts` add
`replayOnboarding(): Promise<void>` to the `NativeBridge` type + the Tauri impl (`invoke('replay_onboarding_cmd')`)
and a browser no-op. Skip if no frontend surface needs it yet — the tray path is native-only.

**Verify:**
```bash
cargo check --manifest-path src-tauri/Cargo.toml
npm run app
```
Then: complete onboarding once (or already onboarded) → click the menu-bar icon → **Replay intro** →
the onboarding window reopens at Act 1 and the app is Regular (window takes focus). Confirm the log
line: `tail -F ~/Library/Logs/Kairo/kairo-latest.log | grep -i "replay intro"`.

**Commit:** `feat(onboarding): add Replay intro tray item + replay_onboarding command`

- [ ] Task 1 complete

---

### Task 2 — Accent contrast clamp helpers (frontend) + guard the color wheel

**Depends on:** Phase 0's `src/core/accent.ts` (`getAccent`/`setAccent`/`applyAccent`/`onAccentChanged`)
and Phase 3's color-wheel temp panel in `OnboardingFlow.tsx`.

**2.1** Add contrast helpers to `src/core/accent.ts`. These enforce spec §5: "clamp against
unreadable/low-contrast picks" — the accent stays a legible mark/glow on both the dark notch and a
light desktop, and text placed on the accent gets a readable ink color.

```ts
// --- Contrast + clamp helpers (Phase 7) --------------------------------------
// All colors are #rrggbb. hexToHsl/hslToHex are local so accent.ts stays self-contained.

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16)
  ];
}

/** WCAG relative luminance (0..1). */
export function luminance(hex: string): number {
  const chan = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The readable ink color to place ON an accent fill (dark ink on light accents, else white). */
export function accentInk(hex: string): '#0a0a0a' | '#ffffff' {
  return contrastRatio(hex, '#0a0a0a') >= contrastRatio(hex, '#ffffff') ? '#0a0a0a' : '#ffffff';
}

/**
 * Pull a chosen hue into a legible band so an almost-black or almost-white pick can never vanish
 * as a glow/stroke on the notch or the desktop. Preserves hue; lifts saturation to a floor; clamps
 * lightness into a mid band that reads on both dark + light backdrops. Returns #rrggbb.
 */
export function clampAccent(hex: string): string {
  const [h, s, l] = hexToHsl(hex);           // hexToHsl/hslToHex: reuse Phase 0's helpers if present,
  const clampedS = Math.max(s, 0.45);        // else add them here.
  const clampedL = Math.min(Math.max(l, 0.45), 0.68);
  return hslToHex(h, clampedS, clampedL);
}
```

> If Phase 0 did **not** already add `hexToHsl`/`hslToHex` to `accent.ts`, add them here (standard
> HSL<->hex conversion). Reuse rather than duplicate if they exist.

**2.2** In `OnboardingFlow.tsx` (the Act-1 color wheel handler), run the picked hue through
`clampAccent` before persisting, so the confirmed accent is always legible:

```ts
import { clampAccent, setAccent, applyAccent } from '../core/accent';
// ...
const confirmAccent = (rawHex: string) => {
  const hex = clampAccent(rawHex);
  applyAccent(hex);                       // live recolor (already Phase 0)
  void setAccent(hex);                    // persist (native + account at sign-in)
  klog('onboarding', 'info', 'accent confirmed', { picked: rawHex, clamped: hex });
};
```

> Keep the *live preview* on the raw hue as the wheel drags (so dragging feels direct), but clamp on
> confirm. If the wheel already only exposes a legible band, `clampAccent` is a cheap safety net.

**2.3** Add `tests/accent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { clampAccent, contrastRatio, accentInk, luminance } from '../src/core/accent';

describe('accent contrast clamps', () => {
  it('pulls a near-black pick up into the legible band', () => {
    const out = clampAccent('#010203');
    expect(luminance(out)).toBeGreaterThan(luminance('#010203'));
  });
  it('pulls a near-white pick down into the legible band', () => {
    const out = clampAccent('#fefefe');
    expect(luminance(out)).toBeLessThan(luminance('#fefefe'));
  });
  it('leaves an already-vivid mid accent essentially in-band', () => {
    const out = clampAccent('#7c3aed'); // brand violet
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('contrastRatio is symmetric and white-on-black is ~21', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
  it('accentInk picks readable ink for extremes', () => {
    expect(accentInk('#f5d90a')).toBe('#0a0a0a'); // bright yellow → dark ink
    expect(accentInk('#3a2a8c')).toBe('#ffffff'); // deep indigo → white ink
  });
});
```

**Verify:**
```bash
npm run typecheck
npm run test -- accent
```

**Commit:** `feat(accent): contrast clamp + readable-ink helpers; guard the color wheel`

- [ ] Task 2 complete

---

### Task 3 — Native accent contrast floor (`color.rs`)

**Depends on:** Phase 0's accent blend that tints `vibrant_accent`/the box+pointer color toward the
user accent. This task adds the *guarantee* that the result clears a contrast floor against the
sampled pixels for ANY hue (spec §16 risk 5).

**3.1** In `src-tauri/src/color.rs`, add WCAG helpers + a lightness-nudging contrast enforcer. Place
after `hsl_to_rgb`:

```rust
fn srgb_channel(c: f64) -> f64 {
    let s = c / 255.0;
    if s <= 0.03928 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
}

/// WCAG relative luminance (0..1) of an sRGB triple.
fn relative_luminance(r: f64, g: f64, b: f64) -> f64 {
    0.2126 * srgb_channel(r) + 0.7152 * srgb_channel(g) + 0.0722 * srgb_channel(b)
}

/// WCAG contrast ratio (1..21) between two sRGB triples.
fn contrast_ratio(a: (f64, f64, f64), b: (f64, f64, f64)) -> f64 {
    let la = relative_luminance(a.0, a.1, a.2);
    let lb = relative_luminance(b.0, b.1, b.2);
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

/// Given a desired accent `#rrggbb` and the sampled background, return an accent that keeps the
/// user's HUE but nudges lightness (up if the bg is dark, down if the bg is light) until it clears
/// `min_ratio` contrast against the background — so the user's color can never become invisible on
/// the pixels behind a box. If the floor can't be reached within bounds, returns the best attempt.
pub(crate) fn ensure_contrast(
    accent_hex: &str,
    bg_r: f64,
    bg_g: f64,
    bg_b: f64,
    min_ratio: f64,
) -> String {
    let hex = accent_hex.trim_start_matches('#');
    let parse = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0) as f64;
    if hex.len() < 6 {
        return accent_hex.to_string();
    }
    let (h, s, mut l) = rgb_to_hsl(parse(0), parse(2), parse(4));
    let bg = (bg_r, bg_g, bg_b);
    let bg_l = relative_luminance(bg_r, bg_g, bg_b);
    // Push lightness away from the background's: darker bg → brighten accent, and vice versa.
    let step = if bg_l < 0.5 { 0.04 } else { -0.04 };
    for _ in 0..12 {
        let (r, g, b) = hsl_to_rgb(h, s, l);
        if contrast_ratio((r as f64, g as f64, b as f64), bg) >= min_ratio {
            return format!("#{r:02x}{g:02x}{b:02x}");
        }
        l = (l + step).clamp(0.12, 0.88);
    }
    let (r, g, b) = hsl_to_rgb(h, s, l);
    format!("#{r:02x}{g:02x}{b:02x}")
}
```

**3.2** Call `ensure_contrast` as the **final** step of the accent path so it applies to any hue.
Where Phase 0 blends the user accent (the function that returns the box/pointer color — e.g. the
Phase-0 wrapper around `vibrant_accent`, or `vibrant_accent` itself if Phase 0 left it as the
fallback), wrap the returned color:

```rust
// After the user accent has been chosen/blended for this target:
let accent = crate::color::ensure_contrast(&accent, bg_r, bg_g, bg_b, 3.0); // 3:1 = legible mark/UI floor
```

> 3.0 is the WCAG AA floor for large text / UI components — appropriate for a stroke/box/pointer, not
> body text. If Phase 0 named its blend function differently, apply `ensure_contrast` at its return
> site. If Phase 0 is not yet merged, add the helper now and leave a `// TODO(phase0): call from the
> accent-blend site` comment at `vibrant_accent`'s return so the wiring is a one-liner later.

**3.3** Add a `#[cfg(test)]` module at the bottom of `color.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_contrast_brightens_on_dark_bg() {
        // Near-black accent on a black background must brighten to clear the floor.
        let out = ensure_contrast("#050505", 8.0, 8.0, 8.0, 3.0);
        let hex = out.trim_start_matches('#');
        let r = u8::from_str_radix(&hex[0..2], 16).unwrap();
        assert!(r > 5, "expected brightened accent, got {out}");
    }

    #[test]
    fn ensure_contrast_preserves_hue() {
        // A blue stays blue (B channel dominant) after adjustment.
        let out = ensure_contrast("#1020c0", 250.0, 250.0, 250.0, 3.0);
        let hex = out.trim_start_matches('#');
        let b = u8::from_str_radix(&hex[4..6], 16).unwrap();
        let r = u8::from_str_radix(&hex[0..2], 16).unwrap();
        assert!(b > r, "expected blue-dominant, got {out}");
    }
}
```

**Verify:**
```bash
cargo test --manifest-path src-tauri/Cargo.toml color
cargo check --manifest-path src-tauri/Cargo.toml
```

**Commit:** `feat(color): WCAG contrast floor for the accent so any hue stays legible`

- [ ] Task 3 complete

---

### Task 4 — Shared reduced-motion helper + notch morph audit

**Depends on:** Phase 1's morphing notch capsule (its spring transitions + the state-morph CSS
classes on `.kairo-capsule` / whatever Phase 1 named them).

**4.1** Create `src/core/reducedMotion.ts` — one source of truth so the notch, pet, and onboarding
dampen together:

```ts
// One source of truth for the OS "Reduce Motion" preference, shared by the notch morph, the pet
// cursor, and the onboarding orchestrator so all three dampen together. matchMedia is absent in
// tests/browser-preview → default to "not reduced".
let cached: MediaQueryList | undefined;

function mq(): MediaQueryList | undefined {
  if (cached) return cached;
  cached = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  return cached;
}

export function prefersReducedMotion(): boolean {
  return mq()?.matches ?? false;
}

/** Subscribe to changes; returns an unlisten. No-op where matchMedia is unavailable. */
export function onReducedMotionChange(cb: (reduced: boolean) => void): () => void {
  const query = mq();
  if (!query) return () => {};
  const handler = (event: MediaQueryListEvent) => cb(event.matches);
  query.addEventListener?.('change', handler);
  return () => query.removeEventListener?.('change', handler);
}
```

**4.2** Add `tests/reducedMotion.test.ts` (guards the no-matchMedia path used in the node test env):

```ts
import { describe, it, expect } from 'vitest';
import { prefersReducedMotion, onReducedMotionChange } from '../src/core/reducedMotion';

describe('reducedMotion (no matchMedia in node env)', () => {
  it('defaults to not-reduced when matchMedia is unavailable', () => {
    expect(prefersReducedMotion()).toBe(false);
  });
  it('returns a no-op unlisten when matchMedia is unavailable', () => {
    const unlisten = onReducedMotionChange(() => {});
    expect(() => unlisten()).not.toThrow();
  });
});
```

**4.3** Notch morph (Phase 1) — gate the JS-driven spring/morph. In the Phase-1 capsule component
(the one that runs the state-morph animation), read `prefersReducedMotion()` and, when true, apply
the target state instantly (no spring, no cross-fade duration). Example shape:

```ts
import { prefersReducedMotion } from '../core/reducedMotion';
// when computing the morph transition config:
const morph = prefersReducedMotion()
  ? { type: 'none' }                    // snap to the new capsule shape/text
  : { type: 'spring', stiffness: /* Phase 1 value */, damping: /* Phase 1 value */ };
```

**4.4** Notch morph CSS — extend `src/styles.css`. The file already has
`@media (prefers-reduced-motion: reduce)` blocks for `.notch-card` and the `notch-orb` pulse; add the
Phase-1 morph capsule classes so the pure-CSS transitions/keyframes are disabled:

```css
@media (prefers-reduced-motion: reduce) {
  /* Phase 1 morphing capsule — no spring morph, no shimmer/pulse, no cross-fade. */
  .kairo-capsule,
  .kairo-capsule[data-mode] {
    transition: none !important;
    animation: none !important;
  }
  .kairo-capsule-viz i,          /* listening waveform bars */
  .kairo-capsule .notch-orb {    /* thinking shimmer */
    animation: none !important;
  }
}
```

> Confirm the actual class names Phase 1 shipped (`NotchCapsule.tsx` currently uses `.kairo-capsule`,
> `.kairo-capsule-viz`; Phase 1 may add morph-specific ones). Disable the morph/shimmer/pulse; the
> capsule still appears, just without motion.

**Verify:**
```bash
npm run typecheck
npm run test -- reducedMotion
npm run app
```
Manual: System Settings → Accessibility → Display → **Reduce Motion ON** → trigger a notch turn
(idle→listening→thinking→answer). The capsule should snap between states with no spring wobble/shimmer.

**Commit:** `feat(notch): shared reducedMotion helper + reduced-motion audit of the morph`

- [ ] Task 4 complete

---

### Task 5 — Reduced-motion audit: pet cursor springs + entrance/celebrate

**Depends on:** Phase 2's pet refresh (`cursor:entrance`, `cursor:celebrate` beats in
`useCursorEngine.ts` / `cursorConstants.ts`).

**5.1** Refactor the hand-rolled reduce-motion detection in `src/cursor/useCursorEngine.ts` (the
`useEffect` at ~line 117 that sets `reduceMotionRef`) to consume the shared helper — one source of
truth, and it keeps the live `change` subscription:

```ts
import { prefersReducedMotion, onReducedMotionChange } from '../core/reducedMotion';
// ...
useEffect(() => {
  reduceMotionRef.current = prefersReducedMotion();
  return onReducedMotionChange((reduced) => {
    reduceMotionRef.current = reduced;
  });
}, []);
```

**5.2** Dampen the Phase-2 beats. In the `cursor:entrance` handler, skip the "breathing to life"
build-up and place the pet at its resting pose immediately when `reduceMotionRef.current` is true. In
the `cursor:celebrate` handler, skip the flourish (no bounce/burst) — optionally a single static
emphasis frame, then settle. The existing fly-to-target spring already honors `reduceMotionRef` (the
drag reveal snaps); ensure the *entrance* and *celebrate* additions do too:

```ts
// cursor:entrance
if (reduceMotionRef.current) {
  // Snap to resting pose; skip the wake-up build-up.
  placePetAtRest();
  klog('cursor', 'debug', 'entrance: reduced-motion snap');
} else {
  runEntranceAnimation();
}

// cursor:celebrate
if (reduceMotionRef.current) {
  klog('cursor', 'debug', 'celebrate: reduced-motion (skipped flourish)');
  return; // no bounce/burst
}
runCelebrateFlourish();
```

> Names `placePetAtRest`/`runEntranceAnimation`/`runCelebrateFlourish` are illustrative — apply the
> `reduceMotionRef.current` guard to whatever Phase 2 named these beats.

**5.3** Any spring stiffness/duration constants Phase 2 added to `cursorConstants.ts` for the beats:
leave them, but ensure the guard above short-circuits before they're used under reduce-motion.

**Verify:**
```bash
npm run typecheck
npm run app
```
Manual: Reduce Motion ON → Replay intro (Task 1) → Act 1 pet entrance should appear instantly (no
wake-up), and Act 4a's first successful point should not do the celebration flourish. Reduce Motion
OFF → both play normally.

**Commit:** `feat(cursor): route pet reduce-motion through shared helper; dampen entrance/celebrate`

- [ ] Task 5 complete

---

### Task 6 — Reduced-motion audit: onboarding transitions

**Depends on:** Phases 3-6's onboarding orchestrator (`OnboardingFlow.tsx` + `onboarding.css`): the
temp-panel fade in/out (color wheel, sign-in), the desktop dim/vignette, the caption cross-fades, and
the act-to-act transitions.

**6.1** Extend the existing `@media (prefers-reduced-motion: reduce)` block in
`src/onboarding/onboarding.css` (currently covers `.ob-surface`, `.ob-title`, `.ob-say`,
`.ob-controls`, `.ob-aurora`, `.ob-orb-*`) to also disable motion on the new act/panel/vignette
classes Phases 3-6 introduced. Add transition disables (the existing block only zeroes `animation`):

```css
@media (prefers-reduced-motion: reduce) {
  /* existing: .ob-surface, .ob-title, ... { animation: none !important; } */

  /* Phase 3-6 orchestrator: instant fades, no vignette pulse, no panel spring. */
  .ob-temp-panel,          /* color-wheel + sign-in temp panel */
  .ob-vignette,            /* desktop dim/vignette */
  .ob-caption,             /* notch-caption cross-fade (if rendered by the orchestrator) */
  .ob-act {                /* per-act container transitions */
    transition: none !important;
    animation: none !important;
  }
  .ob-progress span {
    transition: none !important;   /* the progress bar currently animates width 440ms */
  }
}
```

> Confirm the real class names in the Phase 3-6 orchestrator; the ones above are the likely `ob-`
> prefix continuation. The rule set is: temp panels appear/disappear instantly, no vignette breathing,
> no width-animated progress.

**6.2** Gate any JS-driven timing in `OnboardingFlow.tsx` (e.g. a `setTimeout`-sequenced fade or a
spring on the temp panel) behind `prefersReducedMotion()` — when true, use `0ms`/immediate:

```ts
import { prefersReducedMotion } from '../core/reducedMotion';
const fadeMs = prefersReducedMotion() ? 0 : 320;
```

> The chord-only-Next advance logic and caption *content* must NOT change — only the visual
> transition timing. A reduced-motion user still does every beat; they just don't get the motion.

**Verify:**
```bash
npm run typecheck
npm run app
```
Manual: Reduce Motion ON → Replay intro → the color-wheel panel and sign-in panel appear/disappear
instantly, no vignette breathing, progress bar jumps. All 6 acts still complete.

**Commit:** `feat(onboarding): reduced-motion audit of act/panel/vignette transitions`

- [ ] Task 6 complete

---

### Task 7 — Sequoia Screen-Recording reset heads-up

**Depends on:** existing `get_permission_status` (`permissions.rs` → `PermissionStatus`), the
`app.emit` pattern (already used for `cursor:*` events), and the notch listener plumbing
(`useTauriListeners` / `NotchApp.tsx`). This is **product-level**, not onboarding-blocking (spec §6).

**7.1** In `src-tauri/src/lib.rs`, add a marker + a reset detector. The marker records that Screen
Recording was *ever* authorized (so we can distinguish "never granted / first run" from "granted then
macOS reset it"). Put the helpers near the other config-dir marker code:

```rust
fn screen_recording_marker(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("screen_recording_granted"))
}

/// Compare the "was ever granted" marker against the live status. Returns true exactly once per
/// reset: marker present + status now NOT authorized → macOS reset Screen Recording (Sequoia does
/// this ~monthly, plus the "Allow for One Session" option). Keeps the marker in sync otherwise.
fn detect_screen_recording_reset(app: &tauri::AppHandle) -> bool {
    let status = crate::permissions::get_permission_status();
    let authorized = matches!(status.screen_recording, crate::permissions::PermissionState::Authorized);
    let Some(marker) = screen_recording_marker(app) else { return false; };
    let was_granted = marker.exists();
    if authorized {
        if !was_granted {
            if let Some(dir) = marker.parent() { let _ = std::fs::create_dir_all(dir); }
            let _ = std::fs::write(&marker, b"1");
        }
        return false;
    }
    // Not authorized now. If it was previously granted, it's a reset (fire once; leave the marker so
    // a re-grant re-syncs it above and we don't re-nag every launch — clear it here to nag only once).
    if was_granted {
        let _ = std::fs::remove_file(&marker);
        return true;
    }
    false
}
```

> Confirm the exact `PermissionState` variant name for "granted" in `permissions.rs`
> (`Authorized` is the likely name; adjust to match). Removing the marker on reset means we heads-up
> once, then re-arm when the user re-grants.

**7.2** In `lib.rs` `setup`, after the tray is created (and after the initial permission read), fire
the heads-up if a reset is detected. Emit an app-global event so the notch can catch it:

```rust
if detect_screen_recording_reset(app.handle()) {
    klog!(app, warn, "screen recording was reset by macOS since last run");
    let _ = app.handle().emit("permissions:screen-recording-reset", ());
}
```

> Only fire this **outside** first-run onboarding (guard on `!crate::onboarding::is_onboarded(..)`
> is inverted — you want it only when onboarded; during onboarding Act 3 handles Screen Recording).
> So: `if crate::onboarding::is_onboarded(app.handle()) && detect_screen_recording_reset(...)`.

**7.3** Frontend — the notch listens and shows a friendly, one-click-to-fix line. In `NotchApp.tsx`,
add a listener (via the existing `useTauriListeners`) for `permissions:screen-recording-reset`. On
receipt, surface a coach/error-style capsule line and offer to reopen the pane:

```ts
useTauriListeners([
  () => listen('permissions:screen-recording-reset', () => {
    klog('notch', 'info', 'screen-recording reset heads-up shown');
    showNotchLine({
      // reuse the Phase-1 'coach'/error capsule surface — friendly, NOT an error tone
      title: 'macOS turned off my screen access',
      detail: 'It does this every so often. One click to turn it back on.',
      action: { label: 'Re-enable', run: () => invoke('open_permission_settings', { permission: 'screenRecording' }) }
    });
  })
], []);
```

> Reuse whatever the Phase-1 notch exposes for a transient coach line + optional action. If there is
> no action affordance, at minimum show the line and call `open_permission_settings('screenRecording')`
> when the capsule is clicked. Copy must read friendly, not broken (spec §6). Non-blocking: it never
> stops a turn; the user can ignore it.

**Verify:**
```bash
cargo check --manifest-path src-tauri/Cargo.toml
npm run typecheck
npm run app
```
Manual reset simulation: with the app onboarded + Screen Recording granted once (marker written),
quit Kairo → System Settings → Privacy → Screen Recording → toggle Kairo **off** → relaunch via
`npm run app`. On launch the notch should show the friendly "macOS turned off my screen access" line
with a Re-enable action. Log: `grep -i "screen recording was reset" ~/Library/Logs/Kairo/kairo-latest.log`.

**Commit:** `feat(permissions): friendly heads-up when macOS resets Screen Recording`

- [ ] Task 7 complete

---

### Task 8 — Optional background-music toggle (off by default)

**Depends on:** the `src/core/sound.ts` localStorage pattern (`kairo.sounds.enabled`) and the
onboarding orchestrator for the toggle affordance. Music is a nice-to-have (spec §3, §16 risk 9) —
**off by default**, and the asset itself is deferred.

**8.1** Create `src/core/music.ts` — mirrors `sound.ts`'s localStorage gate, defaults OFF, and
no-ops safely when no ambient asset is bundled (so nothing half-built ships audibly):

```ts
// Optional low ambient music for the onboarding cinematic beats. OFF by default (unlike the UI
// cues in sound.ts, which default ON). Gated by one localStorage flag, shared across WebViews.
// No asset is bundled yet — the player no-ops until an ambient loop is added (see the TODO), so
// shipping this toggle can never produce sound until we deliberately add the file.
import { klog } from './logger';

const STORAGE_KEY = 'kairo.music.enabled';

/** Music on? Default OFF — only an explicit "true" enables it. */
export function musicEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setMusicEnabled(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'true' : 'false');
  } catch {
    // storage unavailable (tests/preview) — no-op
  }
  klog('onboarding', 'info', 'music toggled', { on });
  if (on) void startMusic();
  else stopMusic();
}

// TODO(deferred): import an ambient loop asset (WAV, per sound.ts's WebKit note) and wire it here.
// Until then these no-op so the toggle is inert-but-present.
let el: HTMLAudioElement | undefined;

export async function startMusic(): Promise<void> {
  if (!musicEnabled()) return;
  // const src = (await import('../assets/sounds/ambient-loop.wav')).default;  // <- add asset to enable
  // el = el ?? new Audio(src); el.loop = true; el.volume = 0.12; await el.play().catch(() => {});
  klog('onboarding', 'debug', 'music start requested (no asset bundled — no-op)');
}

export function stopMusic(): void {
  el?.pause();
}
```

**8.2** In the onboarding orchestrator (`OnboardingFlow.tsx`, Act-1 temp panel corner), add a small
mute/unmute control bound to `musicEnabled()`/`setMusicEnabled`. Render it only if an asset exists
(guard on a `HAS_MUSIC_ASSET = false` const) so we don't show a dead toggle:

```ts
import { musicEnabled, setMusicEnabled } from '../core/music';
const HAS_MUSIC_ASSET = false; // flip to true when the ambient loop is added
// ...
{HAS_MUSIC_ASSET && (
  <button
    className="ob-music-toggle"
    aria-label={musicEnabled() ? 'Mute music' : 'Play music'}
    onClick={() => setMusicEnabled(!musicEnabled())}
  >
    {musicEnabled() ? '♪' : '♪̸'}
  </button>
)}
```

**8.3** Add a one-line unit sanity check to confirm the default-OFF contract. Append to
`tests/reducedMotion.test.ts` or a small `tests/music.test.ts`:

```ts
import { musicEnabled } from '../src/core/music';
it('music defaults OFF', () => { expect(musicEnabled()).toBe(false); });
```

**Verify:**
```bash
npm run typecheck
npm run test -- music
```

**Commit:** `feat(onboarding): optional music toggle (off by default; asset deferred)`

- [ ] Task 8 complete

---

### Task 9 — End-to-end QA checklist (final)

No code. Build the packaged `.app` and walk the whole thing. This is the gate for calling the
onboarding redesign done. Run:

```bash
npm run typecheck && npm run test && cargo check --manifest-path src-tauri/Cargo.toml
npm run app          # packaged, signed .app — the real target (never a dev server)
tail -F ~/Library/Logs/Kairo/kairo-latest.log    # watch in a second terminal
```

Reset TCC to rehearse a true first run when needed (re-grant afterwards):
```bash
tccutil reset ScreenCapture com.kairo.tutor
tccutil reset Accessibility com.kairo.tutor
tccutil reset Microphone com.kairo.tutor
tccutil reset ListenEvent com.kairo.tutor
rm -f "$HOME/Library/Application Support/com.kairo.tutor/onboarded" \
      "$HOME/Library/Application Support/com.kairo.tutor/onboarding_step" \
      "$HOME/Library/Application Support/com.kairo.tutor/screen_recording_granted"
```

**All 6 acts (fresh run):**
- [ ] Act 1 — pet entrance plays; color wheel recolors pet/vignette/caption live; confirm clamps an
      extreme pick (try near-black + near-white) to a legible accent.
- [ ] Act 2 — Mic + Input Monitoring primed in-voice (one at a time); hold ⌥⌃ → listening halo reacts
      to voice → real spoken reply. Chord is the only Next (no Continue button).
- [ ] Act 3 — Screen Recording primer → **quit+reopen**; on relaunch the flow **resumes at Act 3**
      (not Act 1), re-reads permissions; Accessibility primer → pet points at the real toggle (or the
      guided-arrow fallback fires if vision mis-locates).
- [ ] Act 4a — point on the real screen (peak): pet flies + points at a real menu-bar target,
      celebration flourish + `arrive` cue. Act 4b — circle a target → described correctly.
- [ ] Act 5 — Google sign-in (browser hand-off returns focus to Kairo); name + chosen color persist;
      "where'd you hear" chip saved.
- [ ] Act 6 — warm, name-personalized sign-off; pet settles toward the notch; `finish_onboarding`
      writes the marker, drops to Accessory. App now live.

**Value-first ordering:**
- [ ] The first "whoa" (say-hi in Act 2, point in Act 4a) happens **before** sign-in (Act 5). No
      signup wall precedes value.

**Paywall exemption (spec §3B, §16 risk 4):**
- [ ] Onboarding practice turns (Acts 2/4) are NOT metered and NOT blocked by the paywall — they run
      pre-sign-in. Confirm no `upgrade.wav` plays and no credit is spent during onboarding. Verify
      against the backend-authoritative credit check (the `ONBOARDING_PTT` / onboarding-turn path).

**Screen-Recording resume (spec §16 risk 2):**
- [ ] The quit+reopen mid-onboarding lands back at Act 3 with Screen Recording now granted, then
      continues to Accessibility → Act 4. Repeat once to confirm it's reliable, not lucky.

**Replay intro (Task 1):**
- [ ] After finishing, menu-bar → **Replay intro** reopens onboarding at Act 1; app is Regular
      (window takes focus); the onboarded marker was cleared + is rewritten on the next finish.

**Reduced motion (Tasks 4-6):**
- [ ] With Reduce Motion ON: notch snaps between states (no spring/shimmer), pet entrance/celebrate
      are skipped/snapped, onboarding panels/vignette/progress are instant. Every beat still
      completes. With Reduce Motion OFF: full motion returns.

**Accent contrast (Tasks 2-3):**
- [ ] Pick extreme accents (near-black, near-white, very desaturated) → the pet glow, notch accent,
      and the on-screen box/pointer stay visible against both dark and light targets; text-on-accent
      is readable.

**Sequoia reset heads-up (Task 7):**
- [ ] Simulate a reset (toggle Screen Recording off in System Settings while onboarded, relaunch) →
      the notch shows the friendly "macOS turned off my screen access" line with a working Re-enable
      action; it does NOT read as an error and does NOT block a turn.

**Music (Task 8):**
- [ ] `musicEnabled()` is `false` by default; no music plays; the toggle is hidden while
      `HAS_MUSIC_ASSET` is false.

**Regression sweep:**
- [ ] Outside onboarding, a normal ⌥⌃ turn (talk / point / circle) still works end-to-end; the notch,
      overlay, and pet behave as before; `npm run smoke:providers` passes if any provider path was
      touched.

**Commit:** `docs(onboarding): Phase 7 QA checklist run + fixes` (only if the run surfaced fixes;
otherwise no commit for a pure checklist pass).

- [ ] Task 9 complete

---

## Self-Review

Before marking Phase 7 done, confirm:

- **Logging (mandatory, AGENTS.md):** every new path logs via `klog!` (Rust) / `klog()` (frontend) —
  the replay command, the reset detector + event, the music toggle, the accent-confirm. No
  `println!`/`eprintln!`/`console.*` was introduced. No secrets/raw media logged.
- **No logic rewrites:** Phase 7 is additive polish. Onboarding advance semantics (chord-only-Next),
  the tutor/gate pipeline, and the paywall logic are unchanged — only re-runnability, motion damping,
  contrast clamping, and a heads-up were added.
- **Contracts honored (spec §3B):** consumes `getAccent`/`setAccent`/`applyAccent`, the `'coach'`
  notch state, `cursor:entrance`/`cursor:celebrate`, and the onboarding markers by their exact names.
  New surface names introduced here (`permissions:screen-recording-reset`,
  `screen_recording_granted` marker, `kairo.music.enabled`, `src/core/reducedMotion.ts`) are listed in
  the File Structure so later work can find them.
- **Reduced motion is one source of truth:** the notch, pet, and onboarding all read
  `reducedMotion.ts`; the old hand-rolled `matchMedia` in `useCursorEngine.ts` was folded into it.
- **Contrast is enforced on both sides:** the frontend clamps the picked hue (`clampAccent`) and the
  native accent path enforces a floor against the pixels (`ensure_contrast`). Neither silently
  overrides the user's hue — both preserve hue and only move lightness/saturation.
- **Sequoia heads-up is product-level, not onboarding-blocking**, fires at most once per reset, and
  re-arms on re-grant.
- **Build gate passes:** `npm run typecheck`, `npm run test`, `cargo check --manifest-path
  src-tauri/Cargo.toml`, and the packaged `npm run app` all succeed; Task 9's checklist is walked on
  the real `.app`.
- **Each task was its own commit** with the trailer
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`, on `main`, no unrelated
  refactors bundled in.
