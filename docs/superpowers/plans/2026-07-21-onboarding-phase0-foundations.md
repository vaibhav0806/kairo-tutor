# Phase 0 — Foundations & Shared Contracts — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:executing-plans

**Parent spec:** [`2026-07-21-onboarding-redesign-and-modern-notch.md`](./2026-07-21-onboarding-redesign-and-modern-notch.md)
(esp. **§3B Shared Contracts** — the names below are copied from there verbatim; do not rename).

## Goal

Land the cross-cutting primitives every later phase depends on, WITHOUT changing any user-facing
behavior yet. After Phase 0 the app builds, runs, and onboards exactly as before — but five new
contracts exist and are wired end-to-end:

1. **Accent preference system** — native `get_accent()` / `set_accent(hex)` + persistence + an
   app-global `accent:changed { hex }` event + the frontend helper `src/core/accent.ts`
   (`getAccent`, `onAccentChanged`, `applyAccent`).
2. **The `vibrant_accent` blend rule** — the box/pointer accent becomes the **user accent as the
   base**, contrast-adjusted (lightness only, hue preserved) ONLY when it would be invisible
   against the pixels behind the target.
3. **The `'coach'` notch state** — added to the `NotchPayload` model + a render stub in
   `NotchCapsule.tsx` (Phase 1 styles it). Onboarding pushes it via
   `show_notch({ state:'coach', title, detail, chip? })`.
4. **Full-screen transparent onboarding orchestrator shell** — the `#/onboarding` window becomes
   full-screen + transparent + click-through, with one native click-through toggle and a
   temp-panel mount slot. The existing card renders inside the slot (no regression).
5. **Name-in-prompt plumbing** — optional `userName?` on the gate + tutor turn inputs; `prompts.rs`
   supplies `The user's name is {name}.` appended to the **non-cached** user message only. Default
   empty; wired to live turns in Phase 6.

## Architecture

- **Native (Rust, `src-tauri/src/`)** owns persistence + the authoritative accent and the prompt
  text. A new `accent.rs` module stores the chosen hex as a `0600`-ish plain file in the app config
  dir (same pattern as `auth.rs` `session.token` and `onboarding.rs` markers) and keeps a
  process-global cache so leaf utilities (`color.rs`) can read it with zero plumbing. `set_accent`
  emits `accent:changed` app-globally (reaches every webview).
- **`color.rs`** stays a pure, unit-testable leaf. `vibrant_accent` gains an explicit
  `accent_hex` parameter (pure → testable); the single caller `grounding/targets.rs::sample_accent`
  reads `crate::accent::current()` and passes it in. No signature changes ripple into
  `apply_step_targets` / `ground_visual_targets` / their tests.
- **Frontend (`src/`)** reads the accent through `src/core/accent.ts` and paints it as CSS custom
  properties (`--kairo-accent`, `--kairo-accent-rgb`) on `<html>` from the shared entry
  (`main.tsx`), so all four webviews recolor live. Phases 1/2 consume those variables for styling.
- **Notch**: `NotchPayload` (Rust struct + TS type) gains an optional `chip`; the notch state string
  gains `'coach'`; `NotchCapsule` renders a caption stub for it. The state machine / hit-rect model
  is untouched (`'coach'` shows non-key, like any display card).
- **Onboarding window**: `onboarding.rs::show_onboarding_window` builds a monitor-sized, transparent,
  decoration-less, click-through window. A `set_onboarding_click_through` command flips
  `set_ignore_cursor_events` so a mounted temp panel can catch clicks. The React shell wraps the
  existing `OnboardingFlow` in a `TempPanelSlot` that toggles interactivity while mounted.

## Tech Stack

- Rust (Tauri v2, `tauri::command`, `tauri::Emitter`), `serde`. Logging via the `klog!` macro
  (never `println!`/`eprintln!`).
- React 19 + TS + Vite. Logging via `klog()` from `src/core/logger.ts` (never `console.*`).
- Tests: **vitest** (node env — no DOM; guard `window`/`document`) + Rust `#[cfg(test)]` unit tests
  (`cargo test`). Real verification = the packaged `.app` via `npm run app`.

## File Structure

**New:**

| Path | Responsibility |
|---|---|
| `src-tauri/src/accent.rs` | Native accent pref: `get_accent`/`set_accent` commands, file persistence, process-global cache, `accent:changed` emit, `init_accent` at startup, hex validation. |
| `src/core/accent.ts` | Frontend accent helper: `getAccent`, `setAccent`, `onAccentChanged`, `applyAccent`, `hexToRgb`, `DEFAULT_ACCENT`. |
| `tests/accent.test.ts` | vitest: `hexToRgb` parsing + `applyAccent` no-op without a DOM. |
| `tests/nameInPrompt.test.ts` | vitest: `buildTutorTurnInput` threads `userName` through / omits it when absent. |

**Modified:**

| Path | Change |
|---|---|
| `src-tauri/src/constants.rs` | Add `DEFAULT_ACCENT: &str = "#7c3aed"`. |
| `src-tauri/src/lib.rs` | `mod accent;`; register `accent::get_accent`, `accent::set_accent`, `onboarding::set_onboarding_click_through`; call `accent::init_accent` in `setup`; add `user_name: None` to the `sample_tutor_turn_input` test literal. |
| `src-tauri/src/color.rs` | Replace hue-picking `vibrant_accent` with the accent-base blend rule + `parse_hex`; drop `ACCENT_HUES`/`hue_dist`; add unit tests. |
| `src-tauri/src/grounding/targets.rs` | `sample_accent` reads `crate::accent::current()` and passes it to `vibrant_accent` (both call sites). |
| `src-tauri/src/types.rs` | `NotchPayload.chip: Option<String>`; `TutorTurnInput.user_name: Option<String>`; `GateInput.user_name: Option<String>`. |
| `src-tauri/src/prompts.rs` | Add `user_name_line(Option<&str>) -> String` + unit tests. |
| `src-tauri/src/tutor.rs` | Append `user_name_line` to the gate `user_message` and the tutor user prompt (non-cached). |
| `src-tauri/src/panels.rs` | Add `chip: None` to `listening_notch_payload` + `typing_notch_payload`. |
| `src-tauri/src/onboarding.rs` | Full-screen transparent window + `fit_onboarding_to_screen` + `set_onboarding_click_through` command. |
| `src/notch/types.ts` | `NotchState` gains `'coach'`; `NotchPayload` gains `chip?: string`. |
| `src/activation/activationState.ts` | Add `coach` entry to the payload map. |
| `src/notch/NotchCapsule.tsx` | `NotchCapsuleMode` gains `'coach'`; add `title?`/`chip?` props + a coach caption render stub. |
| `src/notch/NotchApp.tsx` | `capsuleMode` maps `'coach'`; pass `title`/`chip` to `NotchCapsule`. |
| `src/onboarding/OnboardingApp.tsx` | Orchestrator shell + `TempPanelSlot` mount point. |
| `src/onboarding/onboarding.css` | Minimal `.ob-orchestrator` / `.ob-temp-panel` layout. |
| `src/core/orchestrator.ts` | `TutorTurnInput.userName?`; `buildTutorTurnInput` accepts + threads it. |
| `src/native/nativeBridge.ts` | `NativeGateInput.userName?: string`. |
| `src/main.tsx` | Boot: `getAccent().then(applyAccent)` + `onAccentChanged(applyAccent)`. |
| `src/styles.css` | Minimal placeholder style for `.kairo-capsule-coach` / `.kairo-capsule-chip`. |
| `tests/activationState.test.ts` | Add a `'coach'` map assertion. |

---

## Task 1 — Native accent preference system (`accent.rs`)

Persistence + commands + app-global event + a process-global cache. This must exist before Task 2
(the blend rule reads `accent::current()`).

- [ ] **Add the brand default constant.** In `src-tauri/src/constants.rs`, under a new
  `// ---- Accent` heading, add:
  ```rust
  // Brand-default accent (violet). The user overrides it in onboarding (Act 1); until then this
  // is the base tint for the pointer/box and every accent-threaded surface. Frontend mirror:
  // DEFAULT_ACCENT in src/core/accent.ts — keep in sync.
  pub(crate) const DEFAULT_ACCENT: &str = "#7c3aed";
  ```

- [ ] **Write the failing test first.** Create `src-tauri/src/accent.rs` with ONLY the validation
  helper + its tests (commands come next), so `cargo test` compiles and runs a red-then-green unit:
  ```rust
  //! User accent preference: the chosen highlight hue (`#rrggbb`). Persisted as a plain file in the
  //! app config dir (same pattern as auth's session.token / onboarding markers) and mirrored into a
  //! process-global cache so leaf utilities (color.rs) can read it with no plumbing. `set_accent`
  //! also emits the app-global `accent:changed { hex }` event so every webview recolors live.

  use std::sync::RwLock;
  use serde::Serialize;
  use tauri::{AppHandle, Emitter, Manager};

  use crate::constants;

  // Process-global current accent. None until init/first set → callers fall back to DEFAULT_ACCENT.
  static CURRENT_ACCENT: RwLock<Option<String>> = RwLock::new(None);

  /// True for a `#rrggbb` string (leading `#`, exactly 6 hex digits). Everything else is rejected.
  pub(crate) fn valid_hex(hex: &str) -> bool {
      let bytes = hex.as_bytes();
      bytes.len() == 7
          && bytes[0] == b'#'
          && bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
  }

  #[cfg(test)]
  mod tests {
      use super::valid_hex;

      #[test]
      fn accepts_six_digit_hex() {
          assert!(valid_hex("#7c3aed"));
          assert!(valid_hex("#FFFFFF"));
      }

      #[test]
      fn rejects_bad_hex() {
          assert!(!valid_hex("7c3aed")); // no #
          assert!(!valid_hex("#fff")); // too short
          assert!(!valid_hex("#zzzzzz")); // non-hex
          assert!(!valid_hex("#7c3aed0")); // too long
      }
  }
  ```
  Register the module: add `mod accent;` near the other `mod` lines in `src-tauri/src/lib.rs`
  (e.g. beside `mod onboarding;`).

- [ ] **Run:** `cargo test --manifest-path src-tauri/Cargo.toml valid_hex` — expect PASS (the helper
  is complete; this proves the module compiles + is wired).

- [ ] **Implement the rest of `accent.rs`** (append below `valid_hex`, above the test module):
  ```rust
  fn accent_path(app: &AppHandle) -> Option<std::path::PathBuf> {
      app.path().app_config_dir().ok().map(|d| d.join("accent"))
  }

  fn read_stored(app: &AppHandle) -> Option<String> {
      let raw = std::fs::read_to_string(accent_path(app)?).ok()?;
      let hex = raw.trim().to_string();
      if valid_hex(&hex) { Some(hex) } else { None }
  }

  fn set_cache(hex: &str) {
      if let Ok(mut guard) = CURRENT_ACCENT.write() {
          *guard = Some(hex.to_string());
      }
  }

  /// The current accent for native leaf code (color.rs). Cache first, then DEFAULT_ACCENT.
  pub(crate) fn current() -> String {
      CURRENT_ACCENT
          .read()
          .ok()
          .and_then(|g| g.clone())
          .unwrap_or_else(|| constants::DEFAULT_ACCENT.to_string())
  }

  /// Load the persisted accent into the cache at startup (call once from `setup`).
  pub(crate) fn init_accent(app: &AppHandle) {
      if let Some(hex) = read_stored(app) {
          set_cache(&hex);
          crate::klog!(app, info, accent = %hex, "accent loaded from disk");
      } else {
          crate::klog!(app, info, accent = %constants::DEFAULT_ACCENT, "accent default (none stored)");
      }
  }

  #[derive(Serialize, Clone)]
  struct AccentChanged {
      hex: String,
  }

  /// The user's chosen accent (or the brand default). `#rrggbb`.
  #[tauri::command]
  pub(crate) fn get_accent(app: AppHandle) -> String {
      read_stored(&app).unwrap_or_else(|| constants::DEFAULT_ACCENT.to_string())
  }

  /// Persist a new accent (app config file), refresh the cache, and broadcast `accent:changed`.
  /// (The account copy is written at sign-in — Phase 6 — not here.)
  #[tauri::command]
  pub(crate) fn set_accent(app: AppHandle, hex: String) -> Result<(), String> {
      if !valid_hex(&hex) {
          crate::klog!(app, warn, accent = %hex, "rejected invalid accent");
          return Err("accent must be #rrggbb".to_string());
      }
      let path = accent_path(&app).ok_or("no config dir")?;
      if let Some(dir) = path.parent() {
          std::fs::create_dir_all(dir).map_err(|e| format!("mkdir: {e}"))?;
      }
      std::fs::write(&path, hex.as_bytes()).map_err(|e| format!("write: {e}"))?;
      set_cache(&hex);
      let _ = app.emit("accent:changed", AccentChanged { hex: hex.clone() });
      crate::klog!(app, info, accent = %hex, "accent set");
      Ok(())
  }
  ```

- [ ] **Register the commands + init.** In `src-tauri/src/lib.rs`:
  - Add `accent::get_accent,` and `accent::set_accent,` to the `tauri::generate_handler![...]` list.
  - In `setup(|app| { ... })`, near the other startup wiring (e.g. after `prewarm_http_connections`),
    add: `crate::accent::init_accent(app.handle());`

- [ ] **Run:** `cargo check --manifest-path src-tauri/Cargo.toml` — expect clean (no unused warnings).

- [ ] **Commit:** `feat(accent): native get/set_accent + accent:changed event + startup cache`

## Task 2 — The `vibrant_accent` blend rule (`color.rs`)

User accent is the base; adjust lightness (never hue) only when it would be invisible against the
target's background pixels.

- [ ] **Write the failing tests first.** Add a `#[cfg(test)] mod tests` at the bottom of
  `src-tauri/src/color.rs` (this references the new `parse_hex` + the new `vibrant_accent` signature,
  so it fails to compile until the impl lands — that's the red):
  ```rust
  #[cfg(test)]
  mod tests {
      use super::{parse_hex, vibrant_accent};

      #[test]
      fn keeps_user_hue_when_it_contrasts() {
          // Violet accent on a near-white background: lightness differs plenty → hue is preserved,
          // so the result stays blue-dominant (blue is violet's max channel).
          let out = vibrant_accent("#7c3aed", 245.0, 245.0, 245.0);
          let (r, g, b) = parse_hex(&out).unwrap();
          assert!(b > r && b > g, "expected a violet-ish hue, got {out}");
      }

      #[test]
      fn shifts_lightness_when_invisible_against_bg() {
          // Background lightness ≈ accent lightness → the safety-adjust fires and the output moves.
          let out = vibrant_accent("#7c3aed", 122.0, 90.0, 175.0);
          assert_ne!(out.to_lowercase(), "#7c3aed");
      }

      #[test]
      fn falls_back_to_default_on_bad_accent() {
          let out = vibrant_accent("not-a-hex", 30.0, 30.0, 30.0);
          assert!(out.starts_with('#') && out.len() == 7);
      }
  }
  ```

- [ ] **Run:** `cargo test --manifest-path src-tauri/Cargo.toml --lib color` — expect a COMPILE error
  (proves the test targets the new API).

- [ ] **Implement the rule.** In `src-tauri/src/color.rs`:
  - Delete the `ACCENT_HUES` constant (line ~5) and the `hue_dist` function (they become unused).
  - Add a hex parser (place near `rgb_to_hsl`):
    ```rust
    // Parse "#rrggbb" → (r, g, b) as 0..255 floats (matching rgb_to_hsl's input). None if malformed.
    fn parse_hex(hex: &str) -> Option<(f64, f64, f64)> {
        let h = hex.strip_prefix('#')?;
        if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let n = u32::from_str_radix(h, 16).ok()?;
        Some((
            ((n >> 16) & 0xff) as f64,
            ((n >> 8) & 0xff) as f64,
            (n & 0xff) as f64,
        ))
    }

    // How close (in HSL lightness) the accent may sit to the background before we treat it as
    // invisible and push its lightness to the opposite end.
    const ACCENT_MIN_L_CONTRAST: f64 = 0.22;
    // Floor on saturation so the on-screen accent always reads as vibrant, not washed out.
    const ACCENT_MIN_S: f64 = 0.6;
    ```
  - Replace the whole `vibrant_accent` body (lines ~64-81) with the accent-base rule:
    ```rust
    /// The highlight/pointer accent for a target. The **user accent** (`accent_hex`) is the base:
    /// its HUE is always preserved. We only contrast-adjust its LIGHTNESS when the accent sits within
    /// `ACCENT_MIN_L_CONTRAST` of the background behind the box — then we push lightness to the
    /// opposite end so it stays visible. Saturation is floored so it stays vibrant. A malformed
    /// accent falls back to the brand default.
    pub(crate) fn vibrant_accent(accent_hex: &str, bg_r: f64, bg_g: f64, bg_b: f64) -> String {
        let (ar, ag, ab) = parse_hex(accent_hex)
            .or_else(|| parse_hex(crate::constants::DEFAULT_ACCENT))
            .unwrap_or((124.0, 58.0, 237.0));
        let (h_a, s_a, l_a) = rgb_to_hsl(ar, ag, ab);
        let (_h_bg, _s_bg, l_bg) = rgb_to_hsl(bg_r, bg_g, bg_b);
        let s = s_a.max(ACCENT_MIN_S);
        // Keep the user's own lightness unless it's too close to the background to be seen.
        let l = if (l_a - l_bg).abs() < ACCENT_MIN_L_CONTRAST {
            if l_bg > 0.5 { 0.44 } else { 0.62 }
        } else {
            l_a
        };
        let (r, g, b) = hsl_to_rgb(h_a, s, l);
        format!("#{r:02x}{g:02x}{b:02x}")
    }
    ```

- [ ] **Thread the accent at the call site.** In `src-tauri/src/grounding/targets.rs::sample_accent`
  (lines ~259-272), read the current accent once and pass it to both `vibrant_accent` calls:
  ```rust
  fn sample_accent(rgb: &Option<image::RgbImage>, [nx1, ny1, nx2, ny2]: [f64; 4]) -> String {
      let accent = crate::accent::current();
      let Some(rgb) = rgb else {
          return vibrant_accent(&accent, 90.0, 90.0, 90.0);
      };
      let (w, h) = (rgb.width() as f64, rgb.height() as f64);
      let (ar, ag, ab) = sample_background(
          rgb,
          (nx1 * w) as u32,
          (ny1 * h) as u32,
          (nx2 * w) as u32,
          (ny2 * h) as u32,
      );
      vibrant_accent(&accent, ar, ag, ab)
  }
  ```

- [ ] **Run:** `cargo test --manifest-path src-tauri/Cargo.toml --lib color` — expect PASS.
- [ ] **Run:** `cargo check --manifest-path src-tauri/Cargo.toml` — expect clean (no unused-item warnings).

- [ ] **Commit:** `feat(color): user accent is the base for vibrant_accent; contrast-adjust lightness only`

## Task 3 — Frontend accent helper (`src/core/accent.ts`) + boot wiring

- [ ] **Write the failing test first.** Create `tests/accent.test.ts` (node env — `document` is
  undefined, so `applyAccent` must no-op safely; `hexToRgb` is pure):
  ```ts
  import { describe, expect, test } from 'vitest';
  import { applyAccent, DEFAULT_ACCENT, hexToRgb } from '../src/core/accent';

  describe('accent helper', () => {
    test('hexToRgb parses #rrggbb (with or without #)', () => {
      expect(hexToRgb('#7c3aed')).toBe('124 58 237');
      expect(hexToRgb('7c3aed')).toBe('124 58 237');
      expect(hexToRgb('#FFFFFF')).toBe('255 255 255');
    });

    test('hexToRgb rejects malformed input', () => {
      expect(hexToRgb('#fff')).toBeNull();
      expect(hexToRgb('nope')).toBeNull();
    });

    test('applyAccent is a no-op without a DOM (node env)', () => {
      expect(() => applyAccent(DEFAULT_ACCENT)).not.toThrow();
    });
  });
  ```

- [ ] **Run:** `npm run test -- tests/accent.test.ts` — expect FAIL (module not found).

- [ ] **Implement `src/core/accent.ts`:**
  ```ts
  // Accent preference contract (spec §3B). Reads the user's chosen highlight hue from native,
  // subscribes to live changes, and paints it as CSS custom properties every surface consumes.
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { klog } from './logger';

  // Mirror of src-tauri/src/constants.rs DEFAULT_ACCENT — keep in sync.
  export const DEFAULT_ACCENT = '#7c3aed';

  /** The user's accent (or the brand default). Never throws — falls back on any native error. */
  export async function getAccent(): Promise<string> {
    try {
      const hex = await invoke<string>('get_accent');
      return hex || DEFAULT_ACCENT;
    } catch {
      return DEFAULT_ACCENT;
    }
  }

  /** Persist a new accent natively (also broadcasts accent:changed). Used by the color wheel (Phase 3). */
  export async function setAccent(hex: string): Promise<void> {
    try {
      await invoke('set_accent', { hex });
    } catch (error) {
      klog('accent', 'warn', 'set_accent failed', { error: String(error) });
    }
  }

  /** Subscribe to app-global accent changes. Returns an unlisten fn. */
  export async function onAccentChanged(cb: (hex: string) => void): Promise<UnlistenFn> {
    return listen<{ hex: string }>('accent:changed', (event) => {
      if (event.payload?.hex) cb(event.payload.hex);
    });
  }

  /** '#rrggbb' → 'r g b' (for `rgb(var(--x) / a)`); null if malformed. Pure. */
  export function hexToRgb(hex: string): string | null {
    const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!match) return null;
    const n = parseInt(match[1], 16);
    return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
  }

  /** Paint the accent as CSS custom properties on <html>. No-op outside a DOM (vitest node env). */
  export function applyAccent(hex: string): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.style.setProperty('--kairo-accent', hex);
    const rgb = hexToRgb(hex);
    if (rgb) root.style.setProperty('--kairo-accent-rgb', rgb);
  }
  ```

- [ ] **Run:** `npm run test -- tests/accent.test.ts` — expect PASS.

- [ ] **Wire the boot in `src/main.tsx`** (shared entry → runs in every webview). After the existing
  `installGlobalErrorLogging();` line, add:
  ```ts
  import { applyAccent, getAccent, onAccentChanged } from './core/accent';
  // ...
  // Paint the user accent immediately + keep it live across every webview (foundation for the
  // accent-threaded notch/cursor/overlay redesigns in later phases).
  void getAccent().then(applyAccent);
  void onAccentChanged(applyAccent);
  ```

- [ ] **Run:** `npm run typecheck` — expect clean.
- [ ] **Commit:** `feat(accent): src/core/accent.ts helper + boot-time apply/subscribe in every webview`

## Task 4 — The `'coach'` notch state

Model + render stub only. Phase 1 styles the caption.

- [ ] **Write the failing test first.** In `tests/activationState.test.ts`, inside the
  `describe('activation state', ...)` block, add:
  ```ts
  test('maps the coach state to a caption payload', () => {
    expect(activationStateToNotchPayload('coach')).toMatchObject({
      state: 'coach',
      layout: 'compact'
    });
  });
  ```

- [ ] **Run:** `npm run test -- tests/activationState.test.ts` — expect FAIL/TYPE error (`'coach'`
  is not an `ActivationState` yet).

- [ ] **Extend the TS model.** In `src/notch/types.ts`:
  ```ts
  export type NotchState = 'idle' | 'listening' | 'captured' | 'thinking' | 'showing_step' | 'coach';
  export type NotchLayout = 'compact' | 'prompt' | 'answer';

  export type NotchPayload = {
    state: NotchState;
    layout: NotchLayout;
    title: string;
    detail: string;
    // Optional seeded-prompt chip shown under a coach caption (e.g. "try: 'hey Kairo, what's up?'").
    chip?: string;
  };
  ```

- [ ] **Add the map entry.** In `src/activation/activationState.ts`, add a `coach` key to the
  `payloads` record (the `Record<ActivationState, NotchPayload>` is exhaustive, so this is required):
  ```ts
  coach: {
    state: 'coach',
    layout: 'compact',
    title: 'Kairo',
    detail: ''
  }
  ```

- [ ] **Run:** `npm run test -- tests/activationState.test.ts` — expect PASS.

- [ ] **Add the capsule mode + render stub.** In `src/notch/NotchCapsule.tsx`:
  - Extend the mode enum + props:
    ```ts
    export type NotchCapsuleMode = 'listening' | 'thinking' | 'typing' | 'error' | 'coach' | 'idle';
    ```
    Add to `NotchCapsuleProps`: `title?: string;` and `chip?: string;`, and accept them in the
    destructure.
  - Add a `coach` branch as the FIRST case inside the capsule (before `mode === 'typing'`):
    ```tsx
    {mode === 'coach' ? (
      <div className="kairo-capsule-coach" role="status">
        <span className="kairo-capsule-label">{detail || title}</span>
        {chip ? <span className="kairo-capsule-chip">{chip}</span> : null}
      </div>
    ) : mode === 'typing' ? (
      // ...existing typing form...
    ```

- [ ] **Extend the Rust model.** In `src-tauri/src/types.rs`, add `chip` to `NotchPayload`:
  ```rust
  #[derive(Debug, Clone, Deserialize, Serialize)]
  #[serde(rename_all = "camelCase")]
  pub(crate) struct NotchPayload {
      pub(crate) state: String,
      pub(crate) layout: Option<String>,
      pub(crate) title: String,
      pub(crate) detail: String,
      #[serde(default, skip_serializing_if = "Option::is_none")]
      pub(crate) chip: Option<String>,
  }
  ```
  Then add `chip: None,` to the two literals in `src-tauri/src/panels.rs` (`listening_notch_payload`
  and `typing_notch_payload`).

- [ ] **Map + pass it in `NotchApp`.** In `src/notch/NotchApp.tsx`:
  - In the `capsuleMode` derivation (~line 1430), make `coach` win first (a caption always shows,
    even mid-speech):
    ```ts
    const capsuleMode: NotchCapsuleMode =
      payload.state === 'coach'
        ? 'coach'
        : payload.state === 'listening'
          ? 'listening'
          : /* ...existing chain... */;
    ```
  - In the `<NotchCapsule ... />` return, add: `title={payload.title}` and `chip={payload.chip}`.

- [ ] **Add a placeholder style** in `src/styles.css` (near the other `.kairo-capsule-*` rules) so
  the stub is legible for `npm run app` verification (Phase 1 replaces this):
  ```css
  .kairo-capsule-coach { display: flex; flex-direction: column; gap: 4px; align-items: center; }
  .kairo-capsule-chip { font-size: 12px; opacity: 0.7; }
  ```

- [ ] **Run:** `npm run typecheck` && `cargo check --manifest-path src-tauri/Cargo.toml` — both clean.
- [ ] **Commit:** `feat(notch): add 'coach' caption state + optional chip to the notch payload model`

## Task 5 — Full-screen transparent onboarding orchestrator shell

Shell + click-through toggle + temp-panel mount point. The existing card renders inside the slot, so
onboarding still works.

- [ ] **Make the window full-screen + transparent + click-through.** In
  `src-tauri/src/onboarding.rs`, update the imports to `use tauri::{LogicalPosition, LogicalSize, Manager};`
  and replace `show_onboarding_window`'s builder + add the fit helper:
  ```rust
  pub(crate) fn show_onboarding_window(app: &tauri::AppHandle) {
      if let Some(win) = app.get_webview_window("onboarding") {
          let _ = win.show();
          let _ = win.set_focus();
          return;
      }
      let built = tauri::WebviewWindowBuilder::new(
          app,
          "onboarding",
          tauri::WebviewUrl::App("index.html#/onboarding".into()),
      )
      .title("Welcome to Kairo")
      .inner_size(1440.0, 900.0) // resized to the monitor below
      .resizable(false)
      .decorations(false)
      .transparent(true)
      .shadow(false) // full-screen surface: no drop shadow
      .always_on_top(true) // float above the desktop; the pet/overlay NSPanels sit even higher
      .skip_taskbar(true)
      .focused(true)
      .build();
      match built {
          Ok(win) => {
              fit_onboarding_to_screen(&win);
              // Default click-through: the desktop / pet / overlay show through and stay
              // interactive. The frontend flips it interactive while a temp panel is mounted.
              #[cfg(target_os = "macos")]
              let _ = win.set_ignore_cursor_events(true);
              crate::klog!(app, info, "onboarding window created (full-screen transparent)");
          }
          Err(error) => crate::klog!(app, error, "failed to create onboarding window: {error}"),
      }
  }

  /// Size + position the onboarding window to fully cover its monitor.
  fn fit_onboarding_to_screen(win: &tauri::WebviewWindow) {
      match win.current_monitor() {
          Ok(Some(monitor)) => {
              let scale = monitor.scale_factor();
              let size = monitor.size().to_logical::<f64>(scale);
              let pos = monitor.position().to_logical::<f64>(scale);
              let _ = win.set_position(LogicalPosition::new(pos.x, pos.y));
              let _ = win.set_size(LogicalSize::new(size.width, size.height));
          }
          _ => crate::klog!(app, warn, "onboarding: no monitor found for full-screen fit"),
      }
  }
  ```

- [ ] **Add the click-through toggle command** (append to `onboarding.rs`):
  ```rust
  /// Toggle whether the full-screen onboarding orchestrator catches clicks. Click-through by default
  /// (desktop / pet / overlay stay interactive); the frontend flips it OFF while a temporary panel
  /// (color wheel in Act 1, Google sign-in in Act 5) is mounted so that panel's controls are clickable.
  #[tauri::command]
  pub(crate) fn set_onboarding_click_through(app: tauri::AppHandle, click_through: bool) {
      if let Some(win) = app.get_webview_window("onboarding") {
          #[cfg(target_os = "macos")]
          let _ = win.set_ignore_cursor_events(click_through);
          crate::klog!(app, info, click_through = click_through, "onboarding click-through set");
      }
  }
  ```
  Register it: add `onboarding::set_onboarding_click_through,` to the `generate_handler!` list in
  `src-tauri/src/lib.rs` (beside the other `onboarding::*` commands).

- [ ] **Run:** `cargo check --manifest-path src-tauri/Cargo.toml` — expect clean.

- [ ] **Build the React shell.** Replace `src/onboarding/OnboardingApp.tsx` with an orchestrator that
  wraps the existing flow in a `TempPanelSlot` (default `active` so the card stays clickable — no
  regression). The slot toggles window interactivity while mounted:
  ```tsx
  import { useEffect, type ReactNode } from 'react';
  import { invoke } from '@tauri-apps/api/core';
  import { OnboardingFlow } from './OnboardingFlow';
  import { hasNativeBridge } from './config';

  /**
   * The temporary centered panel slot. While it holds content the orchestrator window must catch
   * clicks; when empty it stays click-through so the desktop / pet / overlay receive input.
   */
  function TempPanelSlot({ active, children }: { active: boolean; children?: ReactNode }) {
    useEffect(() => {
      if (!hasNativeBridge) return;
      void invoke('set_onboarding_click_through', { clickThrough: !active }).catch(() => {});
      return () => {
        void invoke('set_onboarding_click_through', { clickThrough: true }).catch(() => {});
      };
    }, [active]);
    if (!active) return null;
    return <div className="ob-temp-panel">{children}</div>;
  }

  /** Root of the full-screen, transparent, click-through onboarding orchestrator (#/onboarding). */
  export function OnboardingApp() {
    return (
      <div className="ob-orchestrator">
        {/* Phase 0: the existing flow lives in the temp panel. Later phases move most content to
            the notch caption + pet, keeping only color (Act 1) + sign-in (Act 5) in this slot. */}
        <TempPanelSlot active>
          <OnboardingFlow
            onComplete={() => {
              if (hasNativeBridge) void invoke('finish_onboarding').catch(() => {});
            }}
          />
        </TempPanelSlot>
      </div>
    );
  }
  ```

- [ ] **Add the shell layout** to `src/onboarding/onboarding.css` (top of the file):
  ```css
  /* Full-screen transparent orchestrator. pointer-events:none so only the temp panel is a click
     target within the webview; window-level click-through is controlled natively (Rust). */
  .ob-orchestrator {
    position: fixed;
    inset: 0;
    background: transparent;
    pointer-events: none;
    display: grid;
    place-items: center;
  }
  .ob-temp-panel { pointer-events: auto; }
  ```

- [ ] **Run:** `npm run typecheck` — expect clean.
- [ ] **Verify in the real app:** `npm run app` — with onboarding not yet completed (delete the
  marker if needed: `rm -f "$HOME/Library/Application Support/com.kairo.tutor/onboarded"` then
  relaunch). Confirm: the onboarding card still appears centered and is fully clickable, the pet still
  shadows the cursor, and `~/Library/Logs/Kairo/kairo-latest.log` shows
  `onboarding window created (full-screen transparent)` + `onboarding click-through set click_through=false`.
- [ ] **Commit:** `feat(onboarding): full-screen transparent orchestrator shell + click-through toggle + temp-panel slot`

## Task 6 — Name-in-prompt plumbing

Optional `userName` on both turn inputs; `prompts.rs` supplies the sentence; append it to the
non-cached user message only. Default empty (wired live in Phase 6).

- [ ] **Write the failing tests first (two, one per language).**
  - Rust — add to `src-tauri/src/prompts.rs` a test module (references `user_name_line`, not yet
    defined → red):
    ```rust
    #[cfg(test)]
    mod tests {
        use super::user_name_line;

        #[test]
        fn appends_for_a_name() {
            assert_eq!(user_name_line(Some("Prasad")), "The user's name is Prasad.");
        }

        #[test]
        fn empty_when_absent_or_blank() {
            assert_eq!(user_name_line(None), "");
            assert_eq!(user_name_line(Some("  ")), "");
        }
    }
    ```
  - TS — create `tests/nameInPrompt.test.ts`:
    ```ts
    import { describe, expect, test } from 'vitest';
    import { buildTutorTurnInput } from '../src/core/orchestrator';

    const request = { activeApp: 'Finder', userQuery: 'hi', annotations: [] };

    describe('name in prompt plumbing', () => {
      test('threads userName when provided', () => {
        const input = buildTutorTurnInput({ request, screenCapture: null, skillSlug: '', userName: 'Prasad' });
        expect(input.userName).toBe('Prasad');
      });

      test('omits userName when absent', () => {
        const input = buildTutorTurnInput({ request, screenCapture: null, skillSlug: '' });
        expect(input.userName).toBeUndefined();
      });
    });
    ```

- [ ] **Run:** `cargo test --manifest-path src-tauri/Cargo.toml user_name_line` (expect COMPILE fail)
  and `npm run test -- tests/nameInPrompt.test.ts` (expect FAIL — arg unknown / undefined).

- [ ] **Add the prompt helper.** In `src-tauri/src/prompts.rs` (top-level fn, above the test module):
  ```rust
  /// The user's-name line for the NON-CACHED (dynamic) section of the gate + tutor prompts. Empty
  /// when the name is unknown / signed out. Kept out of the cached system prefix so it never busts
  /// prompt caching. See spec §12.
  pub(crate) fn user_name_line(user_name: Option<&str>) -> String {
      match user_name.map(str::trim) {
          Some(name) if !name.is_empty() => format!("The user's name is {name}."),
          _ => String::new(),
      }
  }
  ```

- [ ] **Add `user_name` to the Rust inputs.** In `src-tauri/src/types.rs`:
  - `TutorTurnInput` — add at the end of the struct:
    ```rust
    // The signed-in user's display name (Google profile), appended to the NON-cached user message
    // so the tutor can address them. Empty/absent when unknown. See spec §12.
    #[serde(default)]
    pub(crate) user_name: Option<String>,
    ```
  - `GateInput` — add the same field (with `#[serde(default)]`).

- [ ] **Append it to the non-cached user messages.** In `src-tauri/src/tutor.rs`:
  - In `build_tutor_user_prompt` (which builds the user turn text — non-cached), append after the
    JSON is serialized:
    ```rust
    let mut prompt = serde_json::to_string_pretty(&context)
        .map_err(|error| format!("Failed to build tutor prompt: {error}"))?;
    let name_line = crate::prompts::user_name_line(input.user_name.as_deref());
    if !name_line.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(&name_line);
    }
    Ok(prompt)
    ```
    (Replace the existing trailing `serde_json::to_string_pretty(&context).map_err(...)` return.)
  - In `run_gate_turn`, after building `user_message`, append the line (the gate user turn is
    non-cached):
    ```rust
    let name_line = crate::prompts::user_name_line(input.user_name.as_deref());
    let user_message = if name_line.is_empty() {
        user_message
    } else {
        format!("{user_message}\n{name_line}")
    };
    ```

- [ ] **Fix the Rust test literal.** In `src-tauri/src/lib.rs`, add `user_name: None,` to the
  `sample_tutor_turn_input()` `TutorTurnInput { ... }` literal (~line 983, after `spoken_intro: None`).

- [ ] **Add `userName` to the TS inputs.**
  - `src/core/orchestrator.ts`: add `userName?: string;` to `TutorTurnInput`; add `userName?: string`
    to both the `buildTutorTurnInput` args object and the `createTutorOrchestrator().runTextTurn`
    args; and thread it in the returned object:
    ```ts
    ...(userName && userName.trim() ? { userName } : {})
    ```
    (destructure `userName` alongside `recentContext`, `spokenIntro`).
  - `src/native/nativeBridge.ts`: add `userName?: string;` to `NativeGateInput`.

- [ ] **Run:** `cargo test --manifest-path src-tauri/Cargo.toml user_name_line` (PASS) and
  `npm run test -- tests/nameInPrompt.test.ts` (PASS).
- [ ] **Run:** `npm run typecheck` && `cargo check --manifest-path src-tauri/Cargo.toml` — both clean.
- [ ] **Commit:** `feat(prompts): plumb optional userName into gate/tutor turns (non-cached), default empty`

## Final verification

- [ ] **Run the full suites:** `npm run typecheck` && `npm run test` &&
  `cargo check --manifest-path src-tauri/Cargo.toml` && `cargo test --manifest-path src-tauri/Cargo.toml`
  — all green.
- [ ] **Real build:** `npm run app -- --check` (typecheck + tests + cargo check, then build+sign+launch).
  Confirm the app launches, the notch/pet/overlay behave as before, and onboarding (if not yet done)
  shows the card. Tail `~/Library/Logs/Kairo/kairo-latest.log` for the accent + onboarding startup lines.
- [ ] **Smoke the accent round-trip (optional, dev console / a throwaway invoke):** `set_accent('#22c55e')`
  → confirm `accent set accent=#22c55e` in the log and that `get_accent` returns it after relaunch
  (persistence), and that a fresh point turn's box uses a green-family accent (the blend rule).

---

## Self-review

- **§3B names honored exactly:** `get_accent` / `set_accent(hex)` / `accent:changed { hex }`;
  `src/core/accent.ts` with `getAccent` / `onAccentChanged` / `applyAccent`; `NotchPayload.state`
  gains `'coach'` pushed via `show_notch({ state:'coach', title, detail, chip? })`; `userName?` on the
  gate/tutor input with `prompts.rs` appending `The user's name is {name}.` to the non-cached section.
- **No behavior change yet:** the accent default is the current brand purple (`#7c3aed`), so the box
  color is unchanged until a user picks one; `userName` defaults empty; the `'coach'` state is only a
  model + stub (nothing pushes it in Phase 0); the onboarding window stays interactive while the card
  is mounted, so first-run onboarding is unbroken.
- **Caching safety:** the name line lands in the user turn text (non-cached), never in the cached
  system prompt built by `build_tutor_system_prompt` — matches spec §12.
- **Blend rule is pure + testable:** `vibrant_accent(accent_hex, bg…)` takes the accent explicitly;
  only `sample_accent` reaches into `accent::current()`, so no signature churn ripples into
  `apply_step_targets` / `ground_visual_targets` or their existing tests. Hue is never overridden
  (spec §3B / §16.5); only lightness shifts, and only when contrast would fail.
- **Logging:** every native step uses `klog!`; the one frontend warn path uses `klog()`. No
  `console.*` / `println!`. No secrets or media logged.
- **Test env:** vitest is node-env, so `applyAccent` guards `typeof document` and the accent test
  asserts the no-op; the name test uses a pure builder with no DOM.
- **Struct-literal fallout handled:** `chip: None` added to the two `panels.rs` NotchPayload literals;
  `user_name: None` added to the `lib.rs` test literal — both would otherwise fail `cargo check`.
- **Risks deferred, not ignored:** true per-region click-through for the orchestrator (notch-style
  hit tracker) is NOT needed in Phase 0 because the temp panel is modal; the whole-window toggle is
  the minimal correct primitive. Z-order vs. the pet/overlay NSPanels is validated by the `npm run app`
  step (spec risk §16.1/§16.6). Paywall exemption (§3B) is Phase 5, not here.
