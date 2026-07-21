# Plan: Onboarding Phase 4 — Permissions (Act 3: "Earn the Eyes")

> **REQUIRED SUB-SKILL: superpowers:executing-plans**

Status: NOT STARTED. Build in a fresh session after **Phases 0–3 land**. This is Act 3 of the
6-act onboarding redesign — the two-moment permission priming (Screen Recording → Accessibility),
the Screen-Recording quit+reopen resume, and the signature "pet points at the real Accessibility
toggle via Kairo's own vision pipeline" move (with a guided-arrow fallback).

Master spec: [`2026-07-21-onboarding-redesign-and-modern-notch.md`](./2026-07-21-onboarding-redesign-and-modern-notch.md)
— §4 Act 3, §6 Permission Priming, §3B Shared Contracts. Read those first.

---

## Goal

Turn the old batched "grant two permissions in one card" step into Act 3 of the out-of-the-card
flow: **two separate, in-voice, benefit-first, privacy-honest permission moments, fired one at a
time, never batched.**

1. **Screen Recording first** (reversing today's order — see "Why the order flips"). Trust beat →
   fire the OS prompt → a **guided-arrow bridge panel** deep-linked to the pane. Granting it forces
   a macOS quit+reopen; on relaunch we **resume at Act 3**, re-check status, and continue.
2. **Accessibility second — THE SIGNATURE MOVE.** Now Screen Recording is granted, Kairo uses its
   **real** capture → tutor/vision pipeline to locate the Accessibility toggle for "Kairo Tutor" and
   flies the pet to point at it. If vision mis-locates, fall back to the same guided-arrow bridge.
3. Both granted → advance to Act 4.

Each moment: one-line in-voice *why* + benefit + honest privacy line, then the prompt. Copy for
Accessibility is reframed as **"steer the little pointer," not "control your Mac."**

## Non-Goals (owned elsewhere)

- Mic + Input-Monitoring priming — that is **Act 2 (Phase 3)**, done before Act 3.
- The full-screen transparent orchestrator, the `'coach'` notch caption state, the accent system,
  the act-based flow machine, `voice.speak` — all **Phase 0–3**; Act 3 *consumes* them.
- The onboarding paywall exemption — **Phase 0/5** (§3B). See "Cross-phase dependency: paywall".
- Act 4 point/circle, sign-in, warm ending, "Replay intro" — Phases 5–7.

---

## Dependencies (must be merged before starting)

Act 3 is wired into surfaces Phases 0–3 create. Reference them by these exact §3B names:

- **`'coach'` notch state** — `NotchPayload.state` gains `'coach'`; pushed via
  `show_notch({ state:'coach', layout, title, detail })` (Phase 0). Act 3's captions use it.
- **Full-screen transparent orchestrator** — the onboarding webview is full-screen, transparent,
  click-through except its temp-panel region (Phase 0/3). Act 3 renders its arrow bridge into that
  temp-panel region and otherwise renders nothing (System Settings shows through).
- **Act-based flow + resume** — Phase 3 replaces the `STEPS[]` array wizard
  (`OnboardingFlow.tsx`) with an act machine that mounts one act at a time, persists an act marker
  via `set_onboarding_step`, and resumes to it on mount. Act 3 registers as one act, receiving
  `{ bridge, speak, accent, onAdvance }` props (contract defined in Task 8).
- **`voice.speak(segments, name)`** — `useVoice.ts` (already exists). Act 3 speaks its scripted
  lines through it.
- **Accent** — `getAccent()` / `accent:changed` (Phase 0). The arrow bridge + pet inherit it.

> If any of these is not yet on `main`, **do not stub it** — land the earlier phase first. Act 3 is
> the top of the ladder; it cannot be tested without the coach caption + act machine underneath it.

### Cross-phase dependency: paywall (HIGH — read this)

The Accessibility vision-point (Task 5) runs `run_tutor_turn` → the **paywalled proxy**
(`tutor.rs` L560 `proxy_post_json("/v1/llm/chat", …)`, gated by `proxy::over_free_limit`). Act 3
runs **pre-sign-in** (sign-in is Act 5), so this turn is unauthenticated / uncredited and will fail
or upgrade-wall exactly like risk #4 in the spec. The exemption (`onboarding: true` on the tutor
input, §3B) is **Phase 0/5's** deliverable, but Act 3 needs it too.

- **Ship-blocking requirement:** the Accessibility vision-point MUST run through the onboarding-
  exempt tutor path before this ships to users.
- **Testing Phase 4 in isolation (before that exemption lands):** run dev with the **proxy OFF**
  (direct provider keys). `run_tutor_turn` short-circuits the proxy when `!proxy_enabled()` and uses
  the local `OPENROUTER_API_KEY` (`tutor.rs` L560/635) — no paywall, no JWT. Confirm `AI_PROVIDER`
  defaults and keys per `constants.rs` / `.env`. Note this in the manual-test task.

### Why the order flips (Screen Recording BEFORE Accessibility)

Today (`OnboardingFlow.tsx` L408-410) grants **Accessibility first** ("it doesn't force a
relaunch"). Act 3 **reverses** this on purpose:

1. The Accessibility signature move **needs Screen Recording already granted** (the pet can't
   vision-point at the toggle without screen access).
2. Screen Recording forces the quit+reopen; getting it out of the way first means the relaunch
   lands us cleanly into the Accessibility step, not mid-way through it.

---

## Architecture / data flow

Act 3 is a **status-driven sub-step machine**. There is no hand-persisted "which half am I on" —
the live permission status is the single source of truth, so it is idempotent across the
Screen-Recording relaunch.

```
Act3Permissions (mounted by the Phase-3 act machine)
  │  set_onboarding_step('act3')            ← persist resume marker on entry
  │
  ├─ poll get_permission_status every 1.5s
  │     nextPermissionStep(status):
  │       screen != granted            → 'screen'
  │       screen granted, access != gr → 'accessibility'
  │       both granted                 → 'done' → onAdvance()  (→ Act 4)
  │
  ├─ sub == 'screen'  (3a):
  │     showNotch({state:'coach', …trust line})  + voice.speak(screen line)
  │     bridge.requestScreenRecording()          ← ONE OS prompt, screen only
  │     bridge.openPermissionSettings('screenRecording')
  │     render <PermissionBridge permission='screen'>  (arrow + "Open" + "Restart Kairo")
  │     └─ user flips toggle → macOS forces quit+reopen
  │           → relaunch → resume 'act3' → poll sees screen granted → 'accessibility'
  │
  └─ sub == 'accessibility'  (3b, THE SIGNATURE MOVE):
        showNotch({state:'coach', …reframe line})
        bridge.requestAccessibility()            ← registers Kairo in the AX list (toggle exists)
        bridge.openPermissionSettings('accessibility')
        waitForSettings()  (System Settings frontmost + settle)
        voice.speak(accessibility line)
        pointAtAccessibilityToggle(bridge):      ← REAL pipeline
            capture_screen → askTutorFromNotch(fixed query) → revealStep (cursor_point + overlay box)
        located?  yes → pet points at the real toggle; user flips it
                  no  → render <PermissionBridge permission='accessibility'>  (arrow fallback)
        poll sees access granted → 'done' → onAdvance()
```

Reused, unchanged: `demoController` helpers, `askTutorFromNotch` (`notch/notchTutor.ts`),
`routeVisualTargets` / `releaseVisualTargets` (`overlay/targetRouting.ts`), `capture_screen`,
`cursor_point`, `show_overlay` — i.e. the exact shipped point pipeline. `is_sensitive_app`
(`platform.rs`) does **not** block `com.apple.systempreferences`, so capturing System Settings works.

## Tech Stack

- **Rust** (`src-tauri/src/permissions.rs`, `lib.rs`): two focused `#[tauri::command]`s so each OS
  prompt fires alone (`request_required_permissions` batches all three — wrong for "one at a time").
- **TS/React** (`src/onboarding/`, `src/native/nativeBridge.ts`): the Act 3 component, the pure
  sub-step selector, the vision-point helper, the arrow bridge panel + CSS, copy.
- **Vitest** for the pure sub-step selector.

## File Structure

```
src-tauri/src/permissions.rs      MOD  + request_screen_recording, request_accessibility commands
src-tauri/src/lib.rs              MOD  register the two commands in invoke_handler
src/native/nativeBridge.ts        MOD  + requestScreenRecording(), requestAccessibility()
src/onboarding/copy.ts            MOD  + ACT3_LINES + act3Screen/act3Access segments + CACHED_LINES
src/onboarding/act3Permissions.ts NEW  pure nextPermissionStep(status) selector + constants
tests/act3Permissions.test.ts     NEW  unit test for the selector
src/onboarding/demoController.ts  MOD  + pointAtAccessibilityToggle()
src/onboarding/PermissionBridge.tsx NEW guided-arrow bridge panel (screen + accessibility fallback)
src/onboarding/onboarding.css     MOD  + .ob-bridge* styles (accent-threaded)
src/onboarding/Act3Permissions.tsx NEW the Act 3 sub-step controller component
<phase-3 orchestrator>            MOD  mount Act 3 in the act machine (Task 8)
```

---

## Tasks

### Task 1 — Native: two focused permission-request commands

Add `#[tauri::command]` wrappers so Act 3 can fire **exactly one** OS prompt per moment. The
internal `pub(crate)` fns already exist (`request_screen_recording_permission`,
`request_accessibility_permission`); this only exposes them individually + logs.

In `src-tauri/src/permissions.rs`, after `request_required_permissions` (around L182):

```rust
/// Fire ONLY the Screen Recording OS prompt (Act 3a). Registers Kairo in the Screen
/// Recording list and shows the system dialog. macOS forces a quit+reopen once granted —
/// the onboarding resume marker lands us back in Act 3 on relaunch. Screen-capture auth
/// is cached per-process, so `get_permission_status` may keep reading NotDetermined in
/// THIS process until that relaunch; the fresh process reads Granted.
#[tauri::command]
pub(crate) fn request_screen_recording() -> PermissionState {
    #[cfg(target_os = "macos")]
    {
        let state = request_screen_recording_permission();
        crate::klog!(app, info, state = ?state, "act3: requested screen recording");
        return state;
    }
    #[cfg(not(target_os = "macos"))]
    {
        PermissionState::Unknown
    }
}

/// Fire ONLY the Accessibility OS prompt (Act 3b). Crucially this ALSO registers Kairo
/// in the Accessibility list, so there is a toggle for the pet to point at.
#[tauri::command]
pub(crate) fn request_accessibility() -> PermissionState {
    #[cfg(target_os = "macos")]
    {
        let state = request_accessibility_permission();
        crate::klog!(app, info, state = ?state, "act3: requested accessibility");
        return state;
    }
    #[cfg(not(target_os = "macos"))]
    {
        PermissionState::Unknown
    }
}
```

(`PermissionState` derives `Debug`, so `state = ?state` is valid; `crate::klog!` is used the same
way in `onboarding.rs`.)

**Verify:** `cargo check --manifest-path src-tauri/Cargo.toml`

**Commit:** `feat(onboarding): per-permission request commands for one-at-a-time priming`

- [ ] Done

### Task 2 — Register the commands + native bridge methods

In `src-tauri/src/lib.rs` `invoke_handler` list (around L692), after `request_required_permissions,`:

```rust
            request_required_permissions,
            request_screen_recording,
            request_accessibility,
```

Confirm both are in scope (they live in `permissions.rs`, imported the same way as
`request_required_permissions`; add to the `use permissions::…` line if that pattern is used).

In `src/native/nativeBridge.ts`, add to the `NativeBridge` type (after `requestRequiredPermissions`,
L133):

```ts
  // Fire ONE OS prompt at a time (Act 3 primes Screen Recording and Accessibility
  // separately, never batched). Returns the post-call state.
  requestScreenRecording(): Promise<NativePermissionState>;
  requestAccessibility(): Promise<NativePermissionState>;
```

And to the returned object (after `requestRequiredPermissions`, L331):

```ts
    async requestScreenRecording() {
      try {
        return await invoke<NativePermissionState>('request_screen_recording');
      } catch {
        return 'unknown';
      }
    },

    async requestAccessibility() {
      try {
        return await invoke<NativePermissionState>('request_accessibility');
      } catch {
        return 'unknown';
      }
    },
```

**Verify:** `npm run typecheck` && `cargo check --manifest-path src-tauri/Cargo.toml`

**Commit:** `feat(onboarding): expose per-permission requests over the native bridge`

- [ ] Done

### Task 3 — Act 3 copy (trust + reframe lines, cached)

In `src/onboarding/copy.ts`, add an `ACT3_LINES` map + exported segments, mirroring how
`PERMISSION_LINES` is done, and extend `CACHED_LINES` so the pre-gen audio script ships them.

After `PERMISSION_LINES` (around L118):

```ts
/**
 * Act 3 — "Earn the Eyes". Two separate moments, each: why + benefit + honest privacy line.
 * Screen Recording is spoken first (it forces the relaunch); Accessibility is reframed as
 * "steer the pointer", never "control your Mac".
 */
export const ACT3_LINES: Record<'act3_screen' | 'act3_access' | 'act3_access_fallback', string> = {
  act3_screen:
    "To point things out, I need to see your screen — but only while you hold Option and Control, " +
    "and I never save it. I look, help, and forget. Flip on Screen Recording and I'll take it from here.",
  act3_access:
    "One more — Accessibility. It's how I steer the little pointer to what I'm showing you, " +
    "not to control your Mac. Watch — I'll point right at the switch. Flip this one on.",
  act3_access_fallback:
    "Almost there — turn on Accessibility so I can steer the pointer for you. It's the switch next to my name.",
};

export const act3ScreenLine: Segment[] = [{ cacheKey: 'act3_screen', text: () => ACT3_LINES.act3_screen }];
export const act3AccessLine: Segment[] = [{ cacheKey: 'act3_access', text: () => ACT3_LINES.act3_access }];
export const act3AccessFallbackLine: Segment[] = [
  { cacheKey: 'act3_access_fallback', text: () => ACT3_LINES.act3_access_fallback },
];

/** Short coach-caption text pushed to the notch per Act 3 sub-step (title / detail). */
export const ACT3_COACH: Record<'screen' | 'accessibility', { title: string; detail: string }> = {
  screen: { title: 'Let me see the screen', detail: 'Only while you hold ⌥⌃ — never saved' },
  accessibility: { title: 'Steer the pointer', detail: "I'll point at the switch — flip it on" },
};
```

Extend `CACHED_LINES` (around L128) so the three new lines are pre-generated:

```ts
export const CACHED_LINES: { key: string; text: string }[] = [
  ...STEPS.flatMap((s) => s.speech)
    .filter((seg) => seg.cacheKey)
    .map((seg) => ({ key: seg.cacheKey as string, text: seg.text('') })),
  ...Object.entries(PERMISSION_LINES).map(([key, text]) => ({ key, text })),
  ...Object.entries(ACT3_LINES).map(([key, text]) => ({ key, text })),
];
```

> The old `permissions` `StepId` / `PERMISSION_LINES` / `permissionSpeech` belong to the retired
> card flow. Leave them for now (Phase 3 removes the old `STEPS` machine); Act 3 uses only the new
> `ACT3_*` exports. Do not re-wire the old `permissions` step.

**Verify:** `npm run typecheck` (and, if the audio pre-gen script exists, regenerate:
`scripts/gen-onboarding-audio.ts` — confirm the three `act3_*` keys emit files).

**Commit:** `feat(onboarding): Act 3 permission copy — trust + steer-the-pointer, cached`

- [ ] Done

### Task 4 — Pure sub-step selector + test

The one piece of Act 3 logic worth isolating + testing: given a permission status, which sub-step
are we on? Pure function, no React, no native.

Create `src/onboarding/act3Permissions.ts`:

```ts
import type { NativePermissionStatus } from '../native/nativeBridge';

/** The Act 3 sub-steps, in dependency order (Screen Recording gates the Accessibility point). */
export type Act3SubStep = 'screen' | 'accessibility' | 'done';

/**
 * Single source of truth for where Act 3 is, derived from the LIVE permission status (not a
 * persisted marker) so it is correct across the Screen-Recording quit+reopen. Screen Recording
 * must be granted before Accessibility, so the pet can vision-point at the real toggle.
 */
export function nextPermissionStep(status: NativePermissionStatus): Act3SubStep {
  if (status.screenRecording !== 'granted') return 'screen';
  if (status.accessibility !== 'granted') return 'accessibility';
  return 'done';
}
```

Create `tests/act3Permissions.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { nextPermissionStep } from '../src/onboarding/act3Permissions';
import type { NativePermissionStatus } from '../src/native/nativeBridge';

const status = (
  screenRecording: NativePermissionStatus['screenRecording'],
  accessibility: NativePermissionStatus['accessibility'],
): NativePermissionStatus => ({ screenRecording, accessibility, microphone: 'granted' });

describe('act3 permission sub-step', () => {
  test('screen recording is primed first', () => {
    expect(nextPermissionStep(status('not_determined', 'not_determined'))).toBe('screen');
    expect(nextPermissionStep(status('denied', 'granted'))).toBe('screen');
  });

  test('accessibility only after screen recording is granted (the pet needs to see the screen)', () => {
    expect(nextPermissionStep(status('granted', 'not_determined'))).toBe('accessibility');
    expect(nextPermissionStep(status('granted', 'denied'))).toBe('accessibility');
  });

  test('both granted → done (advance to Act 4)', () => {
    expect(nextPermissionStep(status('granted', 'granted'))).toBe('done');
  });
});
```

**Verify:** `npm run test` (the new file passes; nothing else regresses).

**Commit:** `feat(onboarding): status-driven Act 3 sub-step selector + test`

- [ ] Done

### Task 5 — The signature move: `pointAtAccessibilityToggle`

Add to `src/onboarding/demoController.ts` a helper that runs Kairo's REAL pipeline to locate the
Accessibility toggle for "Kairo Tutor" and draws the box + flies the pet there — silently (the Act 3
component speaks the scripted reframe line; we don't want the tutor's own step narration on top).
Returns whether a box was found so the caller can fall back to the arrow.

```ts
// Act 3b — the signature move. With Screen Recording granted, Kairo uses its OWN vision
// pipeline to find the Accessibility ON/OFF switch for "Kairo Tutor" and points the pet at
// it. `located=false` when the model can't place a box (small system toggle) → the caller
// falls back to the guided arrow. Reveals silently; narration is the Act 3 scripted line.
const ACCESSIBILITY_POINT_QUERY =
  'On this macOS Accessibility settings screen, point at the ON/OFF toggle switch in the row labelled "Kairo Tutor".';

export async function pointAtAccessibilityToggle(
  bridge: NativeBridge,
  cb: DemoCallbacks = {},
): Promise<{ located: boolean }> {
  cb.onThinking?.();
  const capture = await bridge.captureScreen();
  if (!capture.captured) {
    klog('onboarding', 'warn', 'act3 point: capture failed', { reason: capture.reason ?? '' });
    return { located: false };
  }
  const result = await askTutorFromNotch({
    query: ACCESSIBILITY_POINT_QUERY,
    nativeBridge: bridge,
    aiProvider: AI_PROVIDER,
    skillSlug: '',
    screenCapture: capture,
  });
  const step = result.steps.find((s) => s.visualTargets.length > 0);
  klog('onboarding', 'info', 'act3 point', { located: Boolean(step), steps: result.steps.length });
  if (!step) return { located: false };
  // Draw the box + fly the pet to the toggle. No TTS — the reframe line is spoken separately.
  await step && result.revealStep(step, 'draw');
  return { located: true };
}
```

> `askTutorFromNotch` is already imported in `demoController.ts`. It bypasses the gate (we pass a
> `screenCapture` + a direct query), so it goes straight to vision — the same path the shipped point
> uses. `revealStep('draw')` runs `routeVisualTargets` → `cursorDrag` (pet inks the box) +
> `showOverlay` (persistent highlight). The caller clears it with `releaseVisualTargets` (Task 6/8).

**Verify:** `npm run typecheck` (no runtime test — this is exercised in the packaged manual QA, Task 9).

**Commit:** `feat(onboarding): pet vision-points at the real Accessibility toggle`

- [ ] Done

### Task 6 — Guided-arrow bridge panel

The fallback / Screen-Recording bridge: a small accent-threaded temp panel with an animated arrow, a
one-line instruction, an "Open Settings" button (re-deep-links the pane), and — for Screen Recording
only — a "Restart Kairo" button (safety net for the rare case macOS doesn't auto force-relaunch;
screen-capture auth is per-process, so a manual `restart_app` re-reads it).

Create `src/onboarding/PermissionBridge.tsx`:

```tsx
import { klog } from '../core/logger';

type Props = {
  permission: 'screen' | 'accessibility';
  accent: string; // hex from getAccent()
  onOpen: () => void;
  onRestart?: () => void; // provided for 'screen' only
};

const COPY: Record<Props['permission'], { title: string; hint: string; toggle: string }> = {
  screen: {
    title: 'Turn on Screen Recording',
    hint: 'Find Kairo Tutor in the list and flip its switch on.',
    toggle: 'Screen Recording',
  },
  accessibility: {
    title: 'Turn on Accessibility',
    hint: 'Flip the switch next to Kairo Tutor.',
    toggle: 'Accessibility',
  },
};

export function PermissionBridge({ permission, accent, onOpen, onRestart }: Props) {
  const c = COPY[permission];
  return (
    <div className="ob-bridge" style={{ ['--ob-accent' as string]: accent }}>
      <div className="ob-bridge-arrow" aria-hidden>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
          <path d="M12 4v14M12 18l-5-5M12 18l5-5" stroke="currentColor" strokeWidth="2.4"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h2 className="ob-bridge-title">{c.title}</h2>
      <p className="ob-bridge-hint">{c.hint}</p>
      <div className="ob-bridge-actions">
        <button type="button" className="ob-bridge-open" onClick={() => { klog('onboarding', 'info', 'bridge open settings', { permission }); onOpen(); }}>
          Open {c.toggle} settings
        </button>
        {onRestart && (
          <button type="button" className="ob-bridge-restart" onClick={() => { klog('onboarding', 'info', 'bridge restart', {}); onRestart(); }}>
            I turned it on — restart Kairo
          </button>
        )}
      </div>
    </div>
  );
}
```

Add styles to `src/onboarding/onboarding.css` (accent from `--ob-accent`; keep it small + centered
so System Settings stays visible around it):

```css
.ob-bridge {
  position: fixed;
  left: 50%;
  bottom: 48px;
  transform: translateX(-50%);
  width: min(360px, 80vw);
  padding: 20px 22px;
  border-radius: 18px;
  background: rgba(20, 20, 24, 0.92);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
  text-align: center;
  color: #f4f4f6;
  pointer-events: auto; /* the ONE interactive region of the click-through orchestrator */
}
.ob-bridge-arrow { color: var(--ob-accent, #7c3aed); animation: ob-bridge-bob 1.4s ease-in-out infinite; }
@keyframes ob-bridge-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(6px); } }
.ob-bridge-title { margin: 8px 0 4px; font-size: 16px; font-weight: 600; }
.ob-bridge-hint { margin: 0 0 14px; font-size: 13px; opacity: 0.75; }
.ob-bridge-actions { display: flex; flex-direction: column; gap: 8px; }
.ob-bridge-open { background: var(--ob-accent, #7c3aed); color: #fff; border: 0; border-radius: 10px; padding: 9px 14px; font-weight: 600; cursor: pointer; }
.ob-bridge-restart { background: transparent; color: #c9c9cf; border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 10px; padding: 8px 14px; cursor: pointer; }
@media (prefers-reduced-motion: reduce) { .ob-bridge-arrow { animation: none; } }
```

> `pointer-events: auto` here is the only clickable region; the orchestrator shell is click-through
> (Phase 0) so the empty desktop/System Settings around the card stays interactive. Confirm the
> orchestrator does not wrap this in a full-screen `pointer-events: auto` container.

**Verify:** `npm run typecheck`

**Commit:** `feat(onboarding): guided-arrow permission bridge panel (accent-threaded)`

- [ ] Done

### Task 7 — Act 3 controller component

Create `src/onboarding/Act3Permissions.tsx` — the sub-step machine that ties it all together:
persist the resume marker, poll status, drive each sub-step's coach caption + spoken line + OS
prompt, run the vision-point (with the arrow fallback), and advance on both-granted.

```tsx
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { klog } from '../core/logger';
import type { NativeBridge } from '../native/nativeBridge';
import type { Segment } from './copy';
import { ACT3_COACH, act3ScreenLine, act3AccessLine } from './copy';
import { nextPermissionStep, type Act3SubStep } from './act3Permissions';
import { pointAtAccessibilityToggle } from './demoController';
import { releaseVisualTargets } from '../overlay/targetRouting';
import { PermissionBridge } from './PermissionBridge';

type Props = {
  bridge: NativeBridge;
  accent: string;
  speak: (segments: Segment[]) => Promise<void>; // bound to voice.speak(_, name) by the orchestrator
  onAdvance: () => void; // → Act 4
};

const SETTINGS_BUNDLE = 'com.apple.systempreferences';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pushCoach(bridge: NativeBridge, c: { title: string; detail: string }) {
  // 'coach' notch state is the Phase 0 contract (NotchPayload.state gains 'coach').
  await bridge.showNotch({ state: 'coach', layout: 'compact', title: c.title, detail: c.detail } as never);
}

// Wait for System Settings to be frontmost (+ a short settle for the pane to render) so the
// screenshot the vision-point captures actually shows the Accessibility list.
async function waitForSettings(bridge: NativeBridge, timeoutMs = 4000): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const app = await bridge.getActiveApp();
    if (app.bundleId === SETTINGS_BUNDLE) { await delay(600); return true; }
    await delay(300);
  }
  return false;
}

export function Act3Permissions({ bridge, accent, speak, onAdvance }: Props) {
  const [sub, setSub] = useState<Act3SubStep | null>(null);
  const [showBridge, setShowBridge] = useState<null | 'screen' | 'accessibility'>(null);
  const spoke = useRef<Record<string, boolean>>({});
  const advanced = useRef(false);

  // Persist the resume marker on entry: granting Screen Recording forces a macOS quit+reopen,
  // and the Phase-3 act machine resumes to whatever step_marker says.
  useEffect(() => {
    void invoke('set_onboarding_step', { step: 'act3' }).catch(() => {});
  }, []);

  // Live status is the source of truth (idempotent across the relaunch). Poll → pick the sub-step.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const status = await bridge.getPermissionStatus();
      if (cancelled) return;
      const next = nextPermissionStep(status);
      if (next === 'done') {
        if (!advanced.current) { advanced.current = true; klog('onboarding', 'info', 'act3 done'); onAdvance(); }
        return;
      }
      setSub((prev) => (prev === next ? prev : next));
    };
    void tick();
    const iv = setInterval(tick, 1500);
    return () => { cancelled = true; clearInterval(iv); };
  }, [bridge, onAdvance]);

  // Drive the current sub-step's priming + prompt + bridge / vision-point (runs once per sub-step).
  useEffect(() => {
    if (!sub || sub === 'done') return;
    let cancelled = false;
    setShowBridge(null);
    (async () => {
      if (sub === 'screen') {
        await pushCoach(bridge, ACT3_COACH.screen);
        if (!spoke.current.screen) { spoke.current.screen = true; await speak(act3ScreenLine); }
        await bridge.requestScreenRecording();            // one OS prompt, screen only
        await bridge.openPermissionSettings('screen');
        if (!cancelled) setShowBridge('screen');          // arrow + Open + Restart
      } else {
        await pushCoach(bridge, ACT3_COACH.accessibility);
        await bridge.requestAccessibility();              // registers Kairo → the toggle exists
        await bridge.openPermissionSettings('accessibility');
        const settled = await waitForSettings(bridge);
        if (cancelled) return;
        if (!spoke.current.access) { spoke.current.access = true; void speak(act3AccessLine); }
        if (settled) {
          const { located } = await pointAtAccessibilityToggle(bridge);
          if (!cancelled && !located) setShowBridge('accessibility'); // vision missed → arrow fallback
        } else {
          setShowBridge('accessibility');                 // never reached settings → arrow fallback
        }
      }
    })().catch((e) => klog('onboarding', 'error', 'act3 sub-step failed', { sub, error: String(e) }));
    return () => { cancelled = true; };
  }, [sub, bridge, speak]);

  // Clear any pet highlight when we leave a sub-step / unmount.
  useEffect(() => () => { void releaseVisualTargets(bridge); }, [bridge]);

  if (showBridge) {
    return (
      <PermissionBridge
        permission={showBridge}
        accent={accent}
        onOpen={() => void bridge.openPermissionSettings(showBridge === 'screen' ? 'screen' : 'accessibility')}
        onRestart={showBridge === 'screen' ? () => void bridge.restartApp() : undefined}
      />
    );
  }
  return null; // caption lives in the notch; the real desktop / System Settings shows through
}
```

Notes / gotchas baked in above:
- `openPermissionSettings` takes a `NativePermissionKey` (`'screenRecording'`), but the native
  `open_permission_settings` also accepts the aliases `"screen"`/`"accessibility"` (`permissions.rs`
  L188-190). Use whichever the bridge type allows; if the type is strict `NativePermissionKey`, call
  `bridge.openPermissionSettings('screenRecording')`. **Confirm and match the type** — do not cast.
- The `as never` on the coach payload is a placeholder for the Phase-0 `NotchPayload` type gaining
  `'coach'`. Once Phase 0's type lands, **remove the cast** and type it properly. If Phase 0 is
  merged, there is no cast — write the real coach payload shape.

**Verify:** `npm run typecheck`

**Commit:** `feat(onboarding): Act 3 controller — two-moment priming + vision-point + fallback`

- [ ] Done

### Task 8 — Mount Act 3 in the Phase-3 act machine + resume

Wire `Act3Permissions` into whatever act-orchestrator Phase 3 produced. The exact host file/name
depends on Phase 3; this task is the integration, not new logic.

1. **Render Act 3 when the current act is 3**, passing the props contract:
   - `bridge` — the shared `createNativeBridge()` instance (Phase 3 already memoizes one; reuse it).
   - `accent` — `getAccent()` (Phase 0), re-read on `accent:changed`.
   - `speak` — bind the orchestrator's `voice.speak` with the user's name:
     `(segs) => voice.speak(segs, name)`.
   - `onAdvance` — the orchestrator's "go to Act 4" transition.
2. **Resume:** the Phase-3 orchestrator's resume-on-mount already reads `get_onboarding_step` and
   mounts the saved act. Act 3 persists `'act3'` on entry (Task 7), so the Screen-Recording
   quit+reopen resumes straight back into Act 3. **Confirm the orchestrator maps the `'act3'` marker
   to mounting `Act3Permissions`** — add the mapping if Phase 3 used numeric/other act ids (e.g.
   `{ act3: <Act3Permissions/> }`).
3. **Retire the old batched `permissions` step**: ensure the Phase-3 machine no longer renders the
   old card `permissions` step (`OnboardingFlow.tsx` `renderField()` `case 'permissions'`). If Phase
   3 already deleted the `STEPS[]` wizard, nothing to do; otherwise remove that case so the two
   flows don't both fire permission prompts.

> If Phase 3's orchestrator is still `OnboardingFlow.tsx` (card wizard not yet replaced), Act 3
> cannot be mounted correctly — **stop and finish Phase 3 first.** Do not bolt Act 3 onto the card.

**Verify:** `npm run typecheck` && `npm run test`

**Commit:** `feat(onboarding): mount Act 3 in the act machine + resume to it`

- [ ] Done

### Task 9 — Packaged build + manual QA (the real target)

Build and run the **signed .app** (never dev — TCC grants + panels only behave in the packaged app):

```bash
osascript -e 'tell application "Kairo Tutor" to quit'; npm run tauri:build -- --bundles app && open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
tail -F ~/Library/Logs/Kairo/kairo-latest.log
```

**Reset TCC first** so you actually see the prompts (self-signed stable cert; grants persist across
rebuilds, so a fresh run needs a reset):

```bash
tccutil reset ScreenCapture com.kairo.tutor
tccutil reset Accessibility com.kairo.tutor
# also clear the onboarding markers so it re-onboards from the top:
rm -f "$HOME/Library/Application Support/com.kairo.tutor/onboarded" \
      "$HOME/Library/Application Support/com.kairo.tutor/onboarding_step"
```

> Paywall: run with the **proxy off** (direct provider keys, see "Cross-phase dependency: paywall")
> until the onboarding exemption lands, or the Accessibility vision-point turn upgrade-walls.

Walk Act 3 and confirm in the log (`kairo::onboarding`, `kairo::app`, `kairo::cursor`,
`kairo::tutor`):

- **3a Screen Recording (one prompt, not batched):** entering Act 3 logs `act3: requested screen
  recording`; **only** the Screen Recording OS dialog appears (Accessibility does NOT). Coach caption
  shows the trust line; the trust line is spoken. The arrow bridge renders and its "Open" button
  re-opens the pane.
- **3b Accessibility signature move:** after Screen Recording, `act3: requested accessibility` fires;
  System Settings → Accessibility opens; `act3 point located=true` and the pet flies to and points at
  the **real Kairo Tutor toggle** with the highlight box; the reframe line is spoken.
- **Arrow fallback:** to force it, temporarily set the `ACCESSIBILITY_POINT_QUERY` to nonsense (so no
  box) → confirm `act3 point located=false` and the accessibility arrow bridge renders. Revert.
- **Advance:** flipping Accessibility on → poll sees both granted → `act3 done` → Act 4 mounts.

**Commit:** none (QA only) — record findings in the PR / notes.

- [ ] Done

### Task 10 — THE relaunch/resume test (call it out explicitly)

The single most fragile beat (spec §6, §10, risk #2, #7). Test it on its own:

1. Fresh onboarding (Task 9 reset). Reach Act 3a.
2. Open Screen Recording settings, flip **Kairo Tutor** on. macOS shows **"Quit & Reopen"** → click
   it (or use the bridge's "restart Kairo" button if macOS doesn't force it).
3. **Assert on relaunch:**
   - the app reopens and the onboarding window comes back (not a cold main window);
   - `get_onboarding_step` returned `'act3'` → the act machine mounts **Act 3**, NOT Act 1;
   - the first-poll status shows Screen Recording = granted → Act 3 goes straight to **3b
     Accessibility** (it does NOT re-ask for Screen Recording);
   - the pet vision-points at the Accessibility toggle.
4. **Both-granted-on-resume edge:** grant BOTH before a relaunch (e.g. flip Accessibility during 3b,
   then trigger a Screen-Recording-style relaunch) → on resume Act 3 sees both granted → `act3 done`
   → advances to Act 4 without re-prompting.
5. Watch the log across the restart: the pre-restart process may log Screen Recording still
   `not_determined` (per-process auth cache — expected); the **fresh** process logs it `granted`.

If resume lands on Act 1 or re-asks Screen Recording, the bug is in the Task 8 marker→act mapping or
the Task 4 selector — fix before proceeding.

**Commit:** none (QA only).

- [ ] Done

---

## Self-review checklist

Before calling Phase 4 done, confirm:

- [ ] **One prompt at a time.** Act 3a fires only Screen Recording; 3b only Accessibility. Neither
  path calls `request_required_permissions` (which batches all three).
- [ ] **Order is Screen → Accessibility.** The Accessibility vision-point never runs before Screen
  Recording is granted (`nextPermissionStep` enforces it; verified by the test).
- [ ] **Resume is flawless.** Screen-Recording quit+reopen resumes at Act 3, re-checks status, and
  continues to 3b (Task 10 passed). No re-ask, no drop to Act 1.
- [ ] **Signature move works + degrades.** The pet points at the real toggle via the real pipeline
  (`capture_screen` → `askTutorFromNotch` → `revealStep`); on a miss it falls back to the arrow.
- [ ] **Copy is right.** Trust + honest-privacy for Screen Recording ("I look, help, and forget");
  "steer the pointer, not control your Mac" for Accessibility. Static lines are in `CACHED_LINES`.
- [ ] **Coach captions** use the Phase-0 `'coach'` notch state (no `as never` cast left behind).
- [ ] **Logging (mandatory).** Every step/transition/prompt/vision-point/error uses `klog!`/`klog()`
  — no `println!`/`console.*`. No secrets/raw media (the vision-point logs `located`/`steps`, never
  screenshot bytes).
- [ ] **Highlights are cleaned up** (`releaseVisualTargets`) on leaving each sub-step / unmount.
- [ ] **Paywall dependency noted + handled** (§3B): the vision-point runs through the onboarding-
  exempt tutor path (or, in isolation, proxy-off). This is ship-blocking — verify before release.
- [ ] `npm run typecheck` && `npm run test` && `cargo check --manifest-path src-tauri/Cargo.toml`
  green; the packaged `.app` builds and Act 3 runs end-to-end (Tasks 9–10).
- [ ] Commits are small + per-task, ending with the mandated `Co-Authored-By` trailer; no unrelated
  refactors; the old batched `permissions` step is retired, not left double-firing.
```
