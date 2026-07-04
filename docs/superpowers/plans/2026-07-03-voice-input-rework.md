# Voice Input Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse voice+typing onto the single ⌥⌃ shortcut (hold = talk, tap = type), remove ⌘⇧Space, and make the on-screen "listening" indicator track the *actual* native recording state so it can never desync mid-hold.

**Architecture:** The ⌥⌃ `FlagsChanged` tap becomes the single source of truth for recording. Chord-down starts native capture immediately (the ~200ms cpal build overlaps the tap/hold decision window) and arms a 250ms promote timer. Chord-up classifies the press by held-duration: a **tap** (<250ms) cancels the capture and opens the typing notch; a **hold** (≥250ms) stops+sends the audio. A new `ptt:recording` event carries the native truth to the frontend, where the notch idle-close timer and status capsule derive from it instead of a payload that unrelated timers can overwrite. Pen (⌥⇧P) is untouched.

**Tech Stack:** Rust (Tauri v2, `core-graphics` CGEventTap, `cpal`), React 19 + Vite, Vitest, Rust unit tests.

---

## Global constraints

- **Logging is mandatory.** Every new step logs via `klog!`/`klog`. Subsystems: `ptt`, `audio`, `notch`.
- **Never** do blocking work in the tap callback — spawn a thread for the promote timer.
- Verify on the packaged app, never a dev server: `npm run tauri:build -- --bundles app` then `open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"`, tail `~/Library/Logs/Kairo/kairo-latest.log`.
- Pen shortcut (⌥⇧P) and its `pen:toggle` handler must keep working unchanged.

## File structure

- **Modify** `src-tauri/src/lib.rs` — add `AudioCommand::Cancel`; extend `ContextWatch` with a press generation + down-instant; delete `KAIRO_ACTIVATION_SHORTCUT` and its handler branch (keep pen).
- **Modify** `src-tauri/src/audio.rs` — handle `AudioCommand::Cancel` (drop stream, clear buffer, no `ptt:audio`).
- **Modify** `src-tauri/src/input.rs` — add `classify_press` (pure, tested); rewrite `spawn_ptt_tap` (down=start+timer, up=classify, promote emits `ptt:recording`).
- **Create** `src/notch/idleClose.ts` — pure `shouldIdleClose()` predicate (tested), with the new `recording` guard.
- **Modify** `src/notch/NotchApp.tsx` — `pttRecordingRef`; subscribe `ptt:recording`; idle-close interval uses `shouldIdleClose`; focus input on `notch:focus-input`.
- **Modify** `src/App.tsx` — remove the now-dead `activation:shortcut` listener (cleanup).
- **Create** `tests/idleClose.test.ts` — unit tests for `shouldIdleClose`.

---

## Task 1: Add `AudioCommand::Cancel` (stop without sending)

**Files:**
- Modify: `src-tauri/src/lib.rs:170-176` (enum), `src-tauri/src/audio.rs:214-274` (command loop)

- [ ] **Step 1: Add the `Cancel` variant**

In `src-tauri/src/lib.rs`, extend the enum:

```rust
enum AudioCommand {
    // Build the armed input stream at launch so the first press is warm.
    Warm,
    // Carries the chord-down instant so we can log time-to-record-start.
    Start(Instant),
    Stop,
    // Stop + discard: drop the stream and clear the buffer WITHOUT encoding or
    // emitting `ptt:audio`. Used when a ⌥⌃ press turns out to be a tap (→ typing).
    Cancel,
}
```

- [ ] **Step 2: Handle `Cancel` in the capture loop**

In `src-tauri/src/audio.rs`, inside the `while let Ok(cmd) = rx.recv()` match (after the `AudioCommand::Stop` arm), add:

```rust
AudioCommand::Cancel => {
    capturing_worker.store(false, Ordering::SeqCst);
    level_worker.store(0, Ordering::SeqCst);
    // Drop the stream (closes the device / turns the mic indicator off) and
    // throw the buffer away — no WAV, no `ptt:audio`, so no transcription runs.
    current.take();
    if let Ok(mut buf) = samples.lock() {
        buf.clear();
    }
    crate::klog!(ptt, info, "capture cancelled (tap → typing)");
}
```

- [ ] **Step 3: Compile-check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles (a `Cancel` unused-variant warning is fine until Task 3 wires it).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/audio.rs
git commit -m "feat(audio): add AudioCommand::Cancel (stop without sending)"
```

---

## Task 2: Pure tap/hold classifier (TDD)

**Files:**
- Modify: `src-tauri/src/input.rs` (add `PttOutcome`, `classify_press`, `PTT_TAP_MAX_MS`, and a `#[cfg(test)]` module)

- [ ] **Step 1: Write the failing test**

At the bottom of `src-tauri/src/input.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::{classify_press, PttOutcome, PTT_TAP_MAX_MS};
    use std::time::Duration;

    #[test]
    fn quick_press_is_a_tap() {
        assert_eq!(classify_press(Duration::from_millis(120), PTT_TAP_MAX_MS), PttOutcome::Tap);
    }

    #[test]
    fn just_under_threshold_is_a_tap() {
        assert_eq!(classify_press(Duration::from_millis(249), 250), PttOutcome::Tap);
    }

    #[test]
    fn at_or_over_threshold_is_a_hold() {
        assert_eq!(classify_press(Duration::from_millis(250), 250), PttOutcome::Hold);
        assert_eq!(classify_press(Duration::from_millis(900), 250), PttOutcome::Hold);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml classify_press`
Expected: FAIL — `classify_press`/`PttOutcome` not found.

- [ ] **Step 3: Add the minimal implementation**

Near the top of `src-tauri/src/input.rs` (after the imports):

```rust
// Below this hold time, a ⌥⌃ press is a "tap" (→ open typing); at/above it, a
// "hold" (→ push-to-talk). The 250ms build of the cpal stream overlaps this
// window, so a confirmed hold already has a live mic.
pub(crate) const PTT_TAP_MAX_MS: u64 = 250;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PttOutcome {
    Tap,
    Hold,
}

pub(crate) fn classify_press(held: Duration, tap_max_ms: u64) -> PttOutcome {
    if held < Duration::from_millis(tap_max_ms) {
        PttOutcome::Tap
    } else {
        PttOutcome::Hold
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml classify_press`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/input.rs
git commit -m "feat(ptt): add tap/hold press classifier"
```

---

## Task 3: Rewrite the ⌥⌃ tap (down=start+timer, up=classify, emit recording truth)

**Files:**
- Modify: `src-tauri/src/lib.rs:136-157` (ContextWatch fields + Default)
- Modify: `src-tauri/src/input.rs:131-202` (`spawn_ptt_tap`)

- [ ] **Step 1: Extend `ContextWatch` with a press generation + down instant**

In `src-tauri/src/lib.rs`, add `use std::sync::atomic::AtomicU64;` to the atomics import, then add two fields to `struct ContextWatch` (after `ptt_active`):

```rust
    // Push-to-talk: true while the ⌥⌃ chord is held. Shares the same input tap.
    ptt_active: Arc<AtomicBool>,
    // Monotonic press id. Bumped on every chord edge so a stale promote timer from
    // a previous press can't fire against the current one.
    ptt_generation: Arc<AtomicU64>,
    // When the current chord went down; used to measure tap-vs-hold duration.
    ptt_down_at: Arc<Mutex<Option<Instant>>>,
```

And in `impl Default for ContextWatch`:

```rust
            ptt_active: Arc::new(AtomicBool::new(false)),
            ptt_generation: Arc::new(AtomicU64::new(0)),
            ptt_down_at: Arc::new(Mutex::new(None)),
```

- [ ] **Step 2: Rewrite `spawn_ptt_tap`**

In `src-tauri/src/input.rs`, update imports at the top:

```rust
use crate::input::{classify_press, PttOutcome, PTT_TAP_MAX_MS}; // if referenced cross-module; otherwise same-file, skip
use crate::panels::{listening_notch_payload, show_notch_with_payload, typing_notch_payload};
```

(If `classify_press` etc. are defined in this same file, do **not** add the first `use` — they're already in scope. Only add `typing_notch_payload` to the existing `panels` import.)

Replace the tap callback body (the closure passed to `CGEventTap::new`, currently `src-tauri/src/input.rs:145-182`) with:

```rust
move |_proxy, _event_type, event| {
    let flags = event.get_flags();
    let both = flags.contains(CGEventFlags::CGEventFlagAlternate)
        && flags.contains(CGEventFlags::CGEventFlagControl);
    let was = watch.ptt_active.load(Ordering::SeqCst);

    if both && !was {
        // Chord DOWN. Start capturing immediately (the ~200ms cpal build overlaps
        // the tap/hold window). Stay visually quiet until the promote timer.
        watch.ptt_active.store(true, Ordering::SeqCst);
        let press_id = watch.ptt_generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut guard) = watch.ptt_down_at.lock() {
            *guard = Some(Instant::now());
        }
        crate::klog!(ptt, info, press = press_id, "⌥⌃ down");
        send_audio_command(&app, AudioCommand::Start(Instant::now()));

        // Promote to "listening" only if still held after the tap window AND this is
        // still the same press (generation unchanged).
        let app_promote = app.clone();
        let watch_promote = watch.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(PTT_TAP_MAX_MS));
            if watch_promote.ptt_active.load(Ordering::SeqCst)
                && watch_promote.ptt_generation.load(Ordering::SeqCst) == press_id
            {
                crate::klog!(ptt, info, press = press_id, "hold confirmed → listening");
                let _ = app_promote.emit("cursor:listening", ());
                let _ = app_promote
                    .emit("ptt:recording", serde_json::json!({ "active": true }));
                let app_main = app_promote.clone();
                let _ = app_promote.run_on_main_thread(move || {
                    let notch_state = app_main.state::<NotchState>();
                    if let Err(error) = show_notch_with_payload(
                        &app_main,
                        notch_state.inner(),
                        Some(listening_notch_payload()),
                    ) {
                        crate::klog!(ptt, error, "failed to show notch: {error}");
                    }
                });
            }
        });
    } else if !both && was {
        // Chord UP. Invalidate any pending promote, measure duration, classify.
        watch.ptt_active.store(false, Ordering::SeqCst);
        watch.ptt_generation.fetch_add(1, Ordering::SeqCst);
        let held = watch
            .ptt_down_at
            .lock()
            .ok()
            .and_then(|guard| *guard)
            .map(|at| at.elapsed())
            .unwrap_or_default();
        // Recording truth is now false regardless of branch.
        let _ = app.emit("ptt:recording", serde_json::json!({ "active": false }));

        match classify_press(held, PTT_TAP_MAX_MS) {
            PttOutcome::Tap => {
                crate::klog!(ptt, info, ms = held.as_millis(), "tap → typing");
                send_audio_command(&app, AudioCommand::Cancel);
                let app_main = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let notch_state = app_main.state::<NotchState>();
                    if let Err(error) = show_notch_with_payload(
                        &app_main,
                        notch_state.inner(),
                        Some(typing_notch_payload()),
                    ) {
                        crate::klog!(ptt, error, "failed to show typing notch: {error}");
                    }
                    let _ = app_main.emit("notch:focus-input", ());
                });
            }
            PttOutcome::Hold => {
                crate::klog!(ptt, info, ms = held.as_millis(), "hold → send");
                send_audio_command(&app, AudioCommand::Stop);
                let _ = app.emit("cursor:thinking", ());
            }
        }
    }
    CallbackResult::Keep
},
```

Note: `serde_json` is already a dependency; if `serde_json::json!` isn't resolvable inline, add `use serde_json::json;` at the top of `input.rs` and use `json!(...)`.

- [ ] **Step 3: Compile-check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles clean (no unused `Cancel` warning now).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/input.rs
git commit -m "feat(ptt): hold=talk / tap=type on ⌥⌃ with native recording-truth event"
```

---

## Task 4: Remove ⌘⇧Space

**Files:**
- Modify: `src-tauri/src/lib.rs:64` (const), `:443-473` (registration + handler)

- [ ] **Step 1: Delete the activation shortcut const**

Remove `src-tauri/src/lib.rs:64`:

```rust
const KAIRO_ACTIVATION_SHORTCUT: &str = "CommandOrControl+Shift+Space";
```

- [ ] **Step 2: Drop it from registration + simplify the handler**

Replace `src-tauri/src/lib.rs:443-473` with:

```rust
    let pen_shortcut: Shortcut = KAIRO_PEN_SHORTCUT
        .parse()
        .expect("failed to parse Kairo pen shortcut");
    let global_shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcuts([pen_shortcut.clone()])
        .expect("failed to register Kairo shortcuts")
        .with_handler(move |app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            // ⌥⇧P toggles the pen. (Voice + typing now both live on ⌥⌃: hold to
            // talk, tap to type — handled by the PTT event tap, not this plugin.)
            if shortcut == &pen_shortcut {
                let _ = app.emit("pen:toggle", ());
            }
        })
        .build();
```

If `typing_notch_payload` / `NotchState` / `show_notch_with_payload` become unused in `lib.rs` after this, leave their imports only if still referenced elsewhere; otherwise remove to avoid unused-import errors. (`typing_notch_payload` is now used by `input.rs`, imported there.)

- [ ] **Step 3: Remove the dead frontend listener**

In `src/App.tsx`, delete the `activation:shortcut` listener (search `activation:shortcut`, around `App.tsx:429`, and its handler `handleActivationShortcut` if unused elsewhere). If `handleActivationShortcut` refreshes context used elsewhere, keep the function but stop wiring it to the removed event.

- [ ] **Step 4: Compile + typecheck**

Run: `cargo check --manifest-path src-tauri/Cargo.toml && npm run typecheck`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src/App.tsx
git commit -m "feat(shortcuts): remove ⌘⇧Space (typing now = tap ⌥⌃)"
```

---

## Task 5: Frontend recording-truth guard (TDD the predicate)

**Files:**
- Create: `src/notch/idleClose.ts`
- Create: `tests/idleClose.test.ts`
- Modify: `src/notch/NotchApp.tsx:774-795` (interval), plus new refs/effects

- [ ] **Step 1: Write the failing test**

Create `tests/idleClose.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { shouldIdleClose } from '../src/notch/idleClose';

const base = {
  answerSettled: true,
  isSubmitting: false,
  voiceCaptureState: 'idle',
  queryLen: 0,
  pointerHolding: false,
  recording: false,
  idleElapsedMs: 5000,
  idleThresholdMs: 3000
};

describe('shouldIdleClose', () => {
  it('closes when settled, idle, and past the threshold', () => {
    expect(shouldIdleClose(base)).toBe(true);
  });

  it('never closes while a native PTT recording is in progress', () => {
    expect(shouldIdleClose({ ...base, recording: true })).toBe(false);
  });

  it('does not close before the answer settles', () => {
    expect(shouldIdleClose({ ...base, answerSettled: false })).toBe(false);
  });

  it('does not close while submitting, typing, or hovering', () => {
    expect(shouldIdleClose({ ...base, isSubmitting: true })).toBe(false);
    expect(shouldIdleClose({ ...base, queryLen: 3 })).toBe(false);
    expect(shouldIdleClose({ ...base, pointerHolding: true })).toBe(false);
    expect(shouldIdleClose({ ...base, voiceCaptureState: 'transcribing' })).toBe(false);
  });

  it('does not close before the idle threshold elapses', () => {
    expect(shouldIdleClose({ ...base, idleElapsedMs: 1000 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- idleClose`
Expected: FAIL — module `../src/notch/idleClose` not found.

- [ ] **Step 3: Implement the predicate**

Create `src/notch/idleClose.ts`:

```ts
// Pure decision for the notch idle auto-close. Extracted so the guard logic —
// especially the native-recording guard that fixes the "listening indicator
// vanishes mid-hold" bug — is unit-tested instead of buried in a useEffect.
export type IdleCloseState = {
  answerSettled: boolean;
  isSubmitting: boolean;
  voiceCaptureState: string;
  queryLen: number;
  pointerHolding: boolean;
  recording: boolean;
  idleElapsedMs: number;
  idleThresholdMs: number;
};

export function shouldIdleClose(s: IdleCloseState): boolean {
  if (!s.answerSettled) return false;
  if (s.isSubmitting) return false;
  if (s.voiceCaptureState !== 'idle') return false;
  if (s.queryLen > 0) return false;
  if (s.recording) return false; // native ⌥⌃ hold in progress — keep the capsule up
  if (s.pointerHolding) return false;
  return s.idleElapsedMs >= s.idleThresholdMs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- idleClose`
Expected: all passed.

- [ ] **Step 5: Wire the predicate + recording ref into NotchApp**

In `src/notch/NotchApp.tsx`:

1. Add the ref (near the other refs, e.g. by `pttModeRef`):
```tsx
const pttRecordingRef = useRef(false);
```

2. Subscribe to `ptt:recording` (new useEffect, mirror the existing `listen` effects):
```tsx
useEffect(() => {
  let unlisten: (() => void) | undefined;
  listen<{ active?: boolean }>('ptt:recording', (event) => {
    pttRecordingRef.current = Boolean(event.payload?.active);
    klog('notch', 'debug', 'ptt recording', { active: pttRecordingRef.current });
  })
    .then((next) => {
      unlisten = next;
    })
    .catch(() => {
      /* browser preview / tests have no event bus */
    });
  return () => unlisten?.();
}, [listen]);
```

3. Focus the input on `notch:focus-input` (so a tap→type lets the user type immediately). Add alongside, focusing whatever ref/`querySelector` the text `<form>` input uses (the form is at `NotchApp.tsx:1296`):
```tsx
useEffect(() => {
  let unlisten: (() => void) | undefined;
  listen('notch:focus-input', () => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>('input[data-notch-input]')?.focus();
    });
  })
    .then((next) => {
      unlisten = next;
    })
    .catch(() => {});
  return () => unlisten?.();
}, [listen]);
```
(Give the text input `data-notch-input` in its JSX if it has no stable selector yet.)

4. Replace the idle-close interval body (`NotchApp.tsx:774-795`) to use the predicate:
```tsx
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      const pointerHolding =
        pointerInsideNotchRef.current && now - lastNotchPointerAt.current < 4000;
      if (
        shouldIdleClose({
          answerSettled: answerSettledRef.current,
          isSubmitting: isSubmittingRef.current,
          voiceCaptureState: voiceCaptureStateRef.current,
          queryLen: queryRef.current.trim().length,
          pointerHolding,
          recording: pttRecordingRef.current,
          idleElapsedMs: now - lastNotchActivityAt.current,
          idleThresholdMs: NOTCH_IDLE_CLOSE_MS
        })
      ) {
        hideNotch();
      }
    }, 350);
    return () => clearInterval(id);
  }, [hideNotch]);
```

5. Add the import at the top of `NotchApp.tsx`:
```tsx
import { shouldIdleClose } from './idleClose';
```

- [ ] **Step 6: Typecheck + full test run**

Run: `npm run typecheck && npm run test`
Expected: typecheck clean; all suites pass (idleClose included).

- [ ] **Step 7: Commit**

```bash
git add src/notch/idleClose.ts tests/idleClose.test.ts src/notch/NotchApp.tsx
git commit -m "fix(notch): drive idle-close + listening capsule from native recording truth"
```

---

## Task 6 (hardening, optional): absorb modifier flicker on release

**Why:** ⌥ or ⌃ can momentarily read released (contact chatter / an OS-synthesized flags-clear during a Space/app transition) mid-hold. Without a guard, that fires an early `Stop` (sends a truncated recording) and a spurious `tap → typing`.

**Files:** Modify `src-tauri/src/input.rs` (the chord-up branch from Task 3).

- [ ] **Step 1:** Instead of acting immediately on `!both && was`, defer the classify/commit by `RELEASE_DEBOUNCE_MS = 60`. On the up edge, bump generation and record the release; spawn a thread that sleeps 60ms and only commits (Cancel/Stop + notch action) if `ptt_active` is still `false` and the generation is unchanged (i.e. no re-down arrived). If a re-down arrived within 60ms, skip — treat the blip as continuous hold.

- [ ] **Step 2:** Build the packaged app and verify a deliberately jittery hold (wiggle fingers on the modifiers) no longer flips to typing or truncates audio; a real quick tap still opens typing.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/input.rs
git commit -m "harden(ptt): debounce modifier flicker on chord release"
```

---

## Task 7: Build + manual verification matrix

Native tap/audio/notch wiring cannot be unit-tested end-to-end; verify on the packaged app.

- [ ] **Step 1: Build + launch**

Run:
```bash
npm run tauri:build -- --bundles app
open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```
Tail: `tail -F ~/Library/Logs/Kairo/kairo-latest.log`

- [ ] **Step 2: Walk the matrix** (watch the log lines in parentheses)

- [ ] Quick **tap ⌥⌃** → typing notch opens, cursor can type immediately; **no** `ptt:audio`; no transcription (`tap → typing`, `capture cancelled (tap → typing)`).
- [ ] **Hold ⌥⌃** ~1s → at ~250ms the listening capsule + halo appear; release → answer flow runs (`⌥⌃ down`, `hold confirmed → listening`, `hold → send`, `captured audio`).
- [ ] **The original bug:** ask a question, let it answer, then **hold ⌥⌃ again** for a follow-up and keep holding >4s. The listening capsule must stay for the **entire** hold (idle-close no longer fires — `shouldIdleClose` sees `recording:true`).
- [ ] **⌘⇧Space** does nothing now.
- [ ] **⌥⇧P** still toggles the pen.
- [ ] Speak during a hold and confirm the transcript captured your opening words (no clipping).

- [ ] **Step 3: Full green check**

Run: `npm run typecheck && npm run test && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all pass.

- [ ] **Step 4: Commit any fixes, then finish the branch** (see superpowers:finishing-a-development-branch).

---

## Self-review notes

- **Spec coverage:** Issue 1 (indicator desync) → Tasks 1,3,5 (Cancel + recording-truth event + `shouldIdleClose` guard). Issue 3 (one shortcut) → Tasks 3,4 (hold/tap on ⌥⌃, ⌘⇧Space removed). Pen untouched — verified in Tasks 4/7.
- **Type consistency:** `ptt:recording` payload `{active:boolean}` emitted in `input.rs` (Task 3) matches the listener in `NotchApp.tsx` (Task 5). `classify_press`/`PttOutcome`/`PTT_TAP_MAX_MS` defined in Task 2, used in Task 3.
- **Known tradeoff:** capture starts on down; a tap wastes a ~200ms cpal build (harmless). A true pre-warm was rejected to keep the mic indicator off when idle.
