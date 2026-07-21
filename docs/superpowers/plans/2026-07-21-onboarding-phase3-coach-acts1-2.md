# Onboarding Phase 3 — Coach Surface + Acts 1-2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or
> superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Commit after each task.

**Goal:** Make Kairo's onboarding drive its spoken words into the **real notch** as a caption (the
coach surface), and ship the first two acts of the redesigned first-run:
**Act 1 — Arrival + Color** (pet wakes, full color wheel with live desktop theming) and
**Act 2 — "Can you hear me?"** (Mic + Input-Monitoring primer, then the hold-⌥⌃-say-hi drill —
chord-is-the-only-Next — the first "wow"). This is the "out-of-the-card" beginning: the onboarding
window renders almost nothing; Kairo lives in the notch + on the desktop as the pet.

**Master spec:** [`2026-07-21-onboarding-redesign-and-modern-notch.md`](./2026-07-21-onboarding-redesign-and-modern-notch.md)
(§3 Coach-Surface Model, §3B Shared Contracts, §4 Acts 1-2, §5 Color Wheel + Theming, §8 Seeded
Prompts). This plan implements the Phase 3 row of §17.

**Architecture:** Phase 3 is a **consumer** of three earlier phases and adds two things of its own:
- **Consumes (do NOT rebuild):**
  - **Phase 0** — `src/core/accent.ts` (`getAccent()`, `onAccentChanged(cb)`, `applyAccent(hex)`),
    native `get_accent` / `set_accent` + the app-global `accent:changed` event, the `'coach'`
    `NotchState`, and the **full-screen transparent onboarding orchestrator shell** (the window is
    resized full-screen, transparent, click-through except a temp-panel region; it renders an ordered
    list of "acts" and exposes a temp-panel slot). Also the name-in-prompt plumbing.
  - **Phase 1** — the modern notch renders the `'coach'` state as a **caption line + optional chip**
    (adds `chip?` to the payload) and treats coach as **sticky** (no idle-close while coached).
  - **Phase 2** — the `cursor:entrance` beat and the accent-threaded pet (glow recolors on
    `accent:changed`), plus `cursor:celebrate`.
- **Adds (Phase 3 scope):**
  - A **coach-surface driver** (`src/onboarding/coachSurface.ts`) — a thin typed wrapper that pushes
    `show_notch({ state:'coach', ... })` / `hide_notch` and keeps the caption in sync with the spoken
    line.
  - **Act 1** (`acts/Act1Arrival.tsx` + `ColorWheel.tsx` + `TempPanel.tsx`) and **Act 2**
    (`acts/Act2Hearing.tsx`).
  - Native **permission-priming commands** for Act 2: a **mic-only** request (must NOT touch Screen
    Recording — that grant forces a relaunch and belongs to Act 3/Phase 4) and **Input-Monitoring**
    request + status (today `ensure_input_monitoring_access()` is only called internally at startup
    and there is no status command).

**Tech Stack:** React 19 + Vite (TS, ESM) frontend; Rust (Tauri commands) native; `klog()` /
`klog!` logging is **mandatory** (never `console.*` / `println!`); vitest for unit tests
(node env, no DOM). Build target is the **packaged `.app`** via `npm run app`.

**Scope boundary — this plan does NOT:**
- Build the accent system, the `'coach'` notch state/styling, the orchestrator shell, or
  `cursor:entrance` (those are Phases 0-2 — verified in Task 0, not built here).
- Touch Acts 3-6 (Screen Recording / Accessibility / point / circle / sign-in / ending — Phases 4-6).
- Persist the accent to the **account** (that happens at sign-in, Phase 6). Phase 3 persists it
  **natively** via `set_accent` only.
- Wire the user's name into live product turns (Phase 6). Act 2 still passes `name` to
  `onboardingChat` exactly as the legacy `learn_talk` step does today.

**Why value-before-asks holds:** Act 1 asks for **no permissions**. Act 2 primes only Mic + Input
Monitoring (neither forces a relaunch). The scary Screen-Recording grant is deferred to Act 3.

---

## Prerequisites (verified in Task 0, referenced by name)

| From | Symbol / contract Phase 3 consumes |
|---|---|
| Phase 0 | `src/core/accent.ts`: `getAccent(): string`, `applyAccent(hex: string): void`, `onAccentChanged(cb: (hex:string)=>void): () => void` |
| Phase 0 | native commands `get_accent`, `set_accent(hex)`; app-global event `accent:changed { hex }` |
| Phase 0 | `NotchState` includes `'coach'`; onboarding window is full-screen transparent + click-through with a temp-panel slot; the orchestrator renders an ordered **acts** array where each act is a component taking `{ name, onAdvance }` |
| Phase 1 | notch renders `state:'coach'` as caption + optional `chip`; `NotchPayload` has `chip?: string`; coach caption is **sticky** (no idle-close) |
| Phase 2 | events `cursor:entrance` and `cursor:celebrate`; pet glow recolors on `accent:changed` |
| Already shipped | `set_onboarding_ptt` / `ONBOARDING_PTT` / `onboarding:ptt` / `onboarding:audio`; `demoController.runTalkTurn`; `input.rs` emits `cursor:listening` + `audio.rs` emits `cursor:level` under onboarding PTT (pet halo already reacts); `playRecordingCue` |

If Task 0 finds any Phase 0/1/2 contract missing, **STOP** and finish the blocking phase first.

---

## File structure (locked before tasks)

```
kairo-tutor/
├── src-tauri/src/
│   ├── permissions.rs           # MODIFY: + request_microphone, request_input_monitoring,
│   │                            #         get_input_monitoring_status; open_permission_settings
│   │                            #         gains the "inputMonitoring" pane
│   └── lib.rs                   # MODIFY: import + register the 3 new commands in invoke_handler
├── src/native/nativeBridge.ts  # MODIFY: + requestMicrophone / requestInputMonitoring /
│                               #         getInputMonitoringStatus (+ browser fallbacks)
├── src/notch/types.ts          # VERIFY/MODIFY: NotchState has 'coach'; NotchPayload has chip?
├── src-tauri/src/types.rs      # VERIFY/MODIFY: NotchPayload gains `chip: Option<String>`
├── src/onboarding/
│   ├── coachSurface.ts         # NEW: coach-caption driver over show_notch / hide_notch
│   ├── color.ts                # NEW: hsvToHex / hexToHsv frontend color utils
│   ├── copy.ts                 # MODIFY: + ACT_LINES (Act1/Act2 + retry nudges); drop legacy
│   │                           #         `welcome` + `learn_talk` steps (Acts 1-2 supersede them)
│   ├── demoController.ts       # MODIFY: runTalkTurn returns { transcriptLen } for retry logic
│   ├── onboarding.css          # MODIFY: + vignette, temp-panel, color-wheel, ambient-accent styles
│   └── acts/                   # NEW directory
│       ├── actTypes.ts         # NEW: ActProps contract shared with the Phase 0 orchestrator
│       ├── TempPanel.tsx       # NEW: centered small panel that fades in/out (color-wheel host)
│       ├── ColorWheel.tsx      # NEW: HSV wheel + lightness slider (any hue)
│       ├── Act1Arrival.tsx     # NEW: 1a wake-up + 1b color
│       └── Act2Hearing.tsx     # NEW: 2a primer + 2b say-hi drill (chord-only-Next)
├── tests/
│   └── onboarding-color.test.ts # NEW: hsv<->hex round-trip
└── (Phase 0 orchestrator file)  # MODIFY: register Act1Arrival + Act2Hearing at the front of ACTS
```

---

## Ground rules

- Work on `main`, small revertible commits (one per task). `npm run typecheck` + `npm run test` +
  (for Rust tasks) `cargo check --manifest-path src-tauri/Cargo.toml` green **per commit**.
- End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Mandatory logging.** Every new step / state transition / error path logs via `klog()` (frontend,
  from `../core/logger`) or `klog!` (Rust). Never `console.*` / `println!`. Subsystem tag =
  `onboarding` for the acts/driver, `ptt` for the priming commands (matching existing usage).
- Never log secrets or raw media (no audio bytes, no transcript text — log `transcript_len` only).
- The **real** verification is the packaged app (Task 10), not typecheck.

---

## Tasks

### - [ ] Task 0 — Prerequisite gate (no code, no commit)

Confirm Phases 0-2 landed. Run:

```bash
cd /Users/prasad/Prasad/projects/kairo-tutor
# Phase 0
test -f src/core/accent.ts && grep -q "applyAccent" src/core/accent.ts && echo "accent.ts OK"
grep -rn "set_accent\|get_accent\|accent:changed" src-tauri/src/ | head
grep -rn "'coach'\|\"coach\"" src/notch/types.ts
# Phase 1
grep -rn "chip" src/notch/types.ts src/notch/NotchCapsule.tsx 2>/dev/null | head
# Phase 2
grep -rn "cursor:entrance\|cursor:celebrate" src/cursor/ | head
# Orchestrator shell (name may differ — find the acts array)
grep -rln "onAdvance\|ACTS\|temp-panel\|tempPanel\|TempPanel" src/onboarding/ | head
```

- If **all** present → proceed.
- If any missing → **STOP**; that phase must ship first. Record which orchestrator file/symbol the
  Phase 0 shell exposes (the acts array + the act component contract) — Task 9 registers into it.
- Note the exact `ActProps` shape Phase 0 chose. This plan assumes
  `type ActProps = { name: string; onAdvance: () => void }`. If Phase 0 named it differently, adapt
  `acts/actTypes.ts` (Task 5) and the act components to match — the *logic* below is unchanged.

---

### - [ ] Task 1 — Native: mic + input-monitoring priming commands

Act 2 must prime **Mic** and **Input Monitoring** WITHOUT firing Screen Recording (that grant forces a
quit+reopen and is Act 3's). `request_required_permissions` requests all three, so we need a mic-only
request. Input Monitoring today has no command at all — `ensure_input_monitoring_access()` is only
called at startup (`lib.rs`), and `get_permission_status` never reports it.

In `src-tauri/src/permissions.rs`, add (macOS bodies; non-macOS fallbacks like the existing commands):

```rust
/// Prompt for Microphone ONLY (Act 2). Deliberately does NOT request Screen Recording — that
/// grant forces macOS to quit+reopen the app and belongs to Act 3. Returns the full status with
/// a freshly-requested microphone state.
#[tauri::command]
pub(crate) fn request_microphone(app: tauri::AppHandle) -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        let microphone = request_microphone_permission(app);
        crate::klog!(ptt, info, mic = ?microphone, "onboarding mic primer");
        let base = get_permission_status();
        return PermissionStatus { microphone, ..base };
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        _permission_status_fallback()
    }
}

/// Fire the Input-Monitoring prompt (and register Kairo in the Settings list). The ⌥⌃ tap needs
/// this SEPARATELY from Accessibility. No-op once granted.
#[tauri::command]
pub(crate) fn request_input_monitoring() {
    #[cfg(target_os = "macos")]
    {
        ensure_input_monitoring_access();
        crate::klog!(ptt, info, "onboarding input-monitoring primer");
    }
}

/// "granted" / "not_determined" / "unknown" — lets Act 2 poll the Input-Monitoring grant.
#[tauri::command]
pub(crate) fn get_input_monitoring_status() -> String {
    #[cfg(target_os = "macos")]
    {
        return if unsafe { CGPreflightListenEventAccess() } { "granted" } else { "not_determined" }
            .to_string();
    }
    #[cfg(not(target_os = "macos"))]
    {
        "unknown".to_string()
    }
}
```

Also extend `open_permission_settings` so Act 2 can deep-link the Input-Monitoring pane — add this arm
to the `match permission.as_str()`:

```rust
"inputMonitoring" | "input_monitoring" => "Privacy_ListenEvent",
```

In `src-tauri/src/lib.rs`:
- Add `request_microphone, request_input_monitoring, get_input_monitoring_status` to the `use permissions::{…}` import list.
- Register all three in `tauri::generate_handler![ … ]` (next to `open_permission_settings`).

`ensure_input_monitoring_access` is already `#[cfg(target_os = "macos")]`-only, so the guard in
`request_input_monitoring` is required (do not call it on non-macOS).

**Verify:** `cargo check --manifest-path src-tauri/Cargo.toml` green.
**Commit:** `feat(onboarding): native mic + input-monitoring priming commands`

---

### - [ ] Task 2 — nativeBridge: expose the priming commands

In `src/native/nativeBridge.ts`, add to the `NativeBridge` interface and the real implementation
(follow the existing `requestRequiredPermissions` / `openPermissionSettings` pattern; browser
fallbacks return the fallback status / no-op):

```ts
// interface
requestMicrophone(): Promise<NativePermissionStatus>;
requestInputMonitoring(): Promise<void>;
getInputMonitoringStatus(): Promise<NativePermissionState>;

// impl (native branch)
async requestMicrophone() {
  try { return await invoke<NativePermissionStatus>('request_microphone'); }
  catch { return { ...fallbackPermissionStatus(), microphone: await requestBrowserMicrophonePermission() }; }
},
async requestInputMonitoring() {
  try { await invoke<void>('request_input_monitoring'); } catch { /* browser: no-op */ }
},
async getInputMonitoringStatus() {
  try {
    const s = await invoke<string>('get_input_monitoring_status');
    return (s === 'granted' ? 'granted' : s === 'unknown' ? 'unknown' : 'not_determined');
  } catch { return 'unknown'; }
},
```

Act 2 opens the Input-Monitoring **Settings pane** via a direct
`invoke('open_permission_settings', { permission: 'inputMonitoring' })` (that key is not part of the
typed `NativePermissionKey`, so keep it as a raw invoke — same shape the legacy permissions step uses
for `screenRecording`).

**Verify:** `npm run typecheck` green.
**Commit:** `feat(onboarding): bridge methods for mic + input-monitoring priming`

---

### - [ ] Task 3 — Coach-surface driver + confirm the coach payload shape

First **verify** the coach payload contract (Phase 0/1). If missing, add the minimal fields so Phase 3
compiles (Phase 0/1 may already own these — skip whatever exists):

- `src/notch/types.ts`: `NotchState` union includes `'coach'`; `NotchPayload` has `chip?: string`.
- `src-tauri/src/types.rs`: `NotchPayload` has
  `#[serde(skip_serializing_if = "Option::is_none")] pub(crate) chip: Option<String>`.

Then create `src/onboarding/coachSurface.ts` — the ONLY place onboarding talks to the notch:

```ts
// The coach surface: onboarding pushes Kairo's spoken caption into the REAL notch panel using the
// Phase-0 'coach' state (rendered by the Phase-1 modern notch as a caption line + optional chip).
// This is deliberately tiny — the notch is Kairo's real home, so by the end the user already knows
// where Kairo lives (master spec §3).
import type { NativeBridge } from '../native/nativeBridge';
import type { NotchPayload } from '../notch/types';
import type { Segment } from './copy';
import { klog } from '../core/logger';

export type CoachCaption = { title: string; detail: string; chip?: string };

/** Show (or update) the caption in the real notch. */
export async function setCoachCaption(bridge: NativeBridge, c: CoachCaption): Promise<void> {
  const payload: NotchPayload = {
    state: 'coach',
    layout: 'compact',
    title: c.title,
    detail: c.detail,
    ...(c.chip ? { chip: c.chip } : {}),
  };
  klog('onboarding', 'info', 'coach caption', { detail_len: c.detail.length, chip: !!c.chip });
  await bridge.showNotch(payload);
}

/** Clear the caption (hide the notch) between acts. */
export async function clearCoachCaption(bridge: NativeBridge): Promise<void> {
  await bridge.hideNotch();
}

/**
 * Speak a scripted line via the passed `speak` (useVoice.speak) AND mirror it as the notch caption,
 * so the words the user hears are the words on screen. Resolves when speech ends; the caption stays
 * up (sticky) until the next set/clear.
 */
export async function coachSay(
  bridge: NativeBridge,
  speak: (segments: Segment[], name: string) => Promise<void>,
  segments: Segment[],
  name: string,
  opts: { title: string; chip?: string },
): Promise<void> {
  const detail = segments.map((s) => s.text(name)).join(' ').trim();
  await setCoachCaption(bridge, { title: opts.title, detail, chip: opts.chip });
  await speak(segments, name);
}
```

**Verify:** `npm run typecheck` green.
**Commit:** `feat(onboarding): coach-surface driver (spoken caption -> real notch)`

---

### - [ ] Task 4 — Copy: Act 1 + Act 2 lines; retire the superseded legacy steps

In `src/onboarding/copy.ts`:

1. Add an `ACT_LINES` map (in Kairo's warm first-person voice; text drafts from master spec §4):

```ts
/** Coach-surface lines for the redesigned acts (Phase 3). Static → pre-generated + cached WAV,
 *  falling back to live Sarvam TTS if the WAV isn't shipped yet (useVoice handles the fallback). */
export const ACT_LINES = {
  act1_wake:   { cacheKey: 'act1_wake',   text: () => "Hey — I'm Kairo. I live up here, on your screen." },
  act1_color:  { cacheKey: 'act1_color',  text: () => "First — pick my color. This is me, from now on." },
  act2_primer: { cacheKey: 'act2_primer', text: () => "To hear you, I'll need your mic — and permission to notice when you hold two keys. Quick and painless." },
  act2_drill:  { cacheKey: 'act2_drill',  text: () => "This is how you talk to me. Hold Option and Control together, say hi, then let go — I'm listening the whole time you hold them." },
  act2_short:  { cacheKey: 'act2_short',  text: () => "Hold them a beat longer." },
  act2_empty:  { cacheKey: 'act2_empty',  text: () => "Didn't quite catch that — try again." },
} satisfies Record<string, Segment>;
```

2. Add the seeded-prompt chip constant reused by Act 2 (§8): `export const ACT2_CHIP = "try: 'hey Kairo, what's up?'";`

3. Extend `CACHED_LINES` so `scripts/gen-onboarding-audio.ts` pre-generates the new lines:

```ts
export const CACHED_LINES: { key: string; text: string }[] = [
  ...STEPS.flatMap((s) => s.speech).filter((seg) => seg.cacheKey).map((seg) => ({ key: seg.cacheKey as string, text: seg.text('') })),
  ...Object.entries(PERMISSION_LINES).map(([key, text]) => ({ key, text })),
  ...Object.values(ACT_LINES).map((seg) => ({ key: seg.cacheKey as string, text: seg.text('') })),
];
```

4. **Retire the two legacy steps Acts 1-2 replace**, so the flow doesn't double up:
   - Remove the `welcome` step (Act 1 is the new arrival) and the `learn_talk` step (Act 2 is the new
     drill) from the `STEPS` array.
   - Remove `'welcome'` and `'learn_talk'` from the `StepId` union.
   - In `OnboardingFlow.tsx`, delete the now-dead `learn_talk` entries from `DEMO_MODES` and the
     `renderField`/`renderPrimary` switches.
   - Leave `name`, `signin`, `source`, `permissions`, `learn_point`, `circle`, `done` untouched — the
     Phase-3 orchestrator (Task 9) runs Acts 1-2 first and then hands off to this remaining legacy
     card flow so the app stays runnable end-to-end. (Phases 4-6 replace the rest.)

> The new lines synth live if their WAV isn't shipped yet, so this task has **no** hard dependency on
> running the audio-gen script. Generating the cached WAVs (`scripts/gen-onboarding-audio.ts`, needs a
> Sarvam key) is a nice-to-have you can do later.

**Verify:** `npm run typecheck` green (the removed `StepId` members must have no remaining refs).
**Commit:** `feat(onboarding): act 1-2 copy; retire legacy welcome + learn_talk steps`

---

### - [ ] Task 5 — Color utils + ActProps contract

Create `src/onboarding/color.ts` (pure, unit-testable — no DOM):

```ts
/** HSV (h∈[0,360), s,v∈[0,1]) -> #rrggbb. */
export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = (
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  ).map((n) => Math.round((n + m) * 255));
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** #rrggbb -> HSV. */
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
```

Create `src/onboarding/acts/actTypes.ts`:

```ts
// Contract every act component honors. `onAdvance` moves the Phase-0 orchestrator to the next act;
// `name` is the user's name if already known (blank in Acts 1-2 — name arrives at sign-in, Act 5).
export type ActProps = { name: string; onAdvance: () => void };
```

Create `tests/onboarding-color.test.ts` (vitest, node env):

```ts
import { describe, it, expect } from 'vitest';
import { hsvToHex, hexToHsv } from '../src/onboarding/color';

describe('color utils', () => {
  it('round-trips the brand accent', () => {
    const { h, s, v } = hexToHsv('#7c3aed');
    expect(hsvToHex(h, s, v)).toBe('#7c3aed');
  });
  it('maps pure primaries', () => {
    expect(hsvToHex(0, 1, 1)).toBe('#ff0000');
    expect(hsvToHex(120, 1, 1)).toBe('#00ff00');
    expect(hsvToHex(240, 1, 1)).toBe('#0000ff');
  });
});
```

**Verify:** `npm run typecheck` && `npm run test` green.
**Commit:** `feat(onboarding): hsv color utils + ActProps contract`

---

### - [ ] Task 6 — TempPanel + Act 1 (Arrival + Color) + live theming

Create `src/onboarding/acts/TempPanel.tsx` — the small centered surface that hosts the color wheel
(master spec §3: only color + sign-in get a temp panel). It fades in/out and is the one interactive
region of the otherwise-transparent onboarding window:

```tsx
import type { ReactNode } from 'react';
export function TempPanel({ children }: { children: ReactNode }) {
  return (
    <div className="ob-temp-scrim" aria-hidden={false}>
      <div className="ob-temp-panel" role="dialog">{children}</div>
    </div>
  );
}
```

Create `src/onboarding/acts/ColorWheel.tsx` — a full HSV wheel (hue = angle, saturation = radius) with
a value/lightness slider, any hue (beats Clicky's fixed swatches, §5). Canvas-drawn; pointer drag
reports a live hex. Key logic:

```tsx
import { useEffect, useRef, useState, type PointerEvent as RPE } from 'react';
import { hexToHsv, hsvToHex } from '../color';

const SIZE = 200, R = SIZE / 2;

export function ColorWheel({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [{ h, s, v }, setHsv] = useState(() => hexToHsv(value));

  // Draw the hue/sat disc at the current value once (and whenever value/v changes).
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const dx = x - R, dy = y - R, dist = Math.hypot(dx, dy);
      const i = (y * SIZE + x) * 4;
      if (dist > R) { img.data[i + 3] = 0; continue; }
      const hue = (Math.atan2(dy, dx) * 180) / Math.PI + 180;
      const sat = Math.min(1, dist / R);
      const hex = hsvToHex(hue, sat, v);
      img.data[i] = parseInt(hex.slice(1, 3), 16);
      img.data[i + 1] = parseInt(hex.slice(3, 5), 16);
      img.data[i + 2] = parseInt(hex.slice(5, 7), 16);
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [v]);

  const pick = (e: RPE) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const dx = e.clientX - rect.left - R, dy = e.clientY - rect.top - R;
    const dist = Math.min(R, Math.hypot(dx, dy));
    const hue = (Math.atan2(dy, dx) * 180) / Math.PI + 180;
    const sat = dist / R;
    const hex = hsvToHex(hue, sat, v);
    setHsv({ h: hue, s: sat, v });
    onChange(hex);
  };

  return (
    <div className="ob-wheel">
      <canvas ref={canvasRef} width={SIZE} height={SIZE} className="ob-wheel-disc"
              onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); pick(e); }}
              onPointerMove={(e) => e.buttons === 1 && pick(e)} />
      <input className="ob-wheel-slider" type="range" min={0.35} max={1} step={0.01} value={v}
             onChange={(e) => { const nv = Number(e.target.value); const hex = hsvToHex(h, s, nv); setHsv({ h, s, v: nv }); onChange(hex); }} />
      <span className="ob-wheel-swatch" style={{ background: value }} />
    </div>
  );
}
```

Create `src/onboarding/acts/Act1Arrival.tsx` — the cinematic open (§4 Act 1). Two internal phases:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { createNativeBridge } from '../../native/nativeBridge';
import { applyAccent, getAccent } from '../../core/accent';   // Phase 0
import { klog } from '../../core/logger';
import { useVoice } from '../useVoice';
import { ACT_LINES } from '../copy';
import { setCoachCaption, clearCoachCaption, coachSay } from '../coachSurface';
import { TempPanel } from './TempPanel';
import { ColorWheel } from './ColorWheel';
import type { ActProps } from './actTypes';

export function Act1Arrival({ name, onAdvance }: ActProps) {
  const bridge = useMemo(() => createNativeBridge(), []);
  const voice = useVoice();
  const [phase, setPhase] = useState<'wake' | 'color'>('wake');
  const [hex, setHex] = useState<string>(() => getAccent());

  // 1a — the wake-up: pet entrance (Phase 2) + coach caption, then auto-advance to color.
  useEffect(() => {
    klog('onboarding', 'info', 'act1 wake');
    void emit('cursor:entrance');                          // Phase 2 signature entrance
    void coachSay(bridge, voice.speak, [ACT_LINES.act1_wake], name, { title: 'Kairo' })
      .then(() => setPhase('color'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1b — give me a color: caption + the wheel; live theming as it moves.
  useEffect(() => {
    if (phase !== 'color') return;
    void coachSay(bridge, voice.speak, [ACT_LINES.act1_color], name, { title: 'Kairo' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Live recolor: applyAccent broadcasts accent:changed → pet glow / overlay / notch / vignette all
  // recolor in real time (Phase 0 + §5). The onboarding window's own vignette reads var(--accent),
  // which applyAccent sets on :root.
  const onWheel = useCallback((next: string) => { setHex(next); applyAccent(next); }, []);

  const confirm = useCallback(async () => {
    klog('onboarding', 'info', 'act1 color confirmed', { hex });
    await invoke('set_accent', { hex }).catch(() => {});   // Phase 0: persist natively
    await clearCoachCaption(bridge);
    onAdvance();
  }, [hex, bridge, onAdvance]);

  return (
    <>
      <div className="ob-vignette" aria-hidden />
      {phase === 'color' && (
        <TempPanel>
          <ColorWheel value={hex} onChange={onWheel} />
          <button type="button" className="ob-wheel-confirm" onClick={() => void confirm()}>
            That&apos;s the one
          </button>
        </TempPanel>
      )}
    </>
  );
}
```

Add CSS to `src/onboarding/onboarding.css` (accent-driven, so live theming is CSS-var only):

```css
/* Act 1: subtle desktop vignette (dim during scripted beats) tinted by the chosen accent. Sits over
   the transparent onboarding window; never eats clicks. */
.ob-vignette {
  position: fixed; inset: 0; pointer-events: none;
  background:
    radial-gradient(120% 90% at 50% 8%, color-mix(in srgb, var(--accent, #7c3aed) 10%, transparent) 0%, transparent 55%),
    radial-gradient(140% 120% at 50% 120%, rgba(0,0,0,0.42) 0%, transparent 60%);
  transition: background 200ms ease;
}
/* Temp panel (color wheel host) — the one interactive region. */
.ob-temp-scrim { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
.ob-temp-panel {
  animation: ob-enter 320ms cubic-bezier(0.22,1,0.36,1) both;
  background: radial-gradient(135% 95% at 50% -12%, #271b40 0%, #150f21 44%, #0b0810 100%);
  border: 1px solid color-mix(in srgb, var(--accent, #7c3aed) 22%, rgba(255,255,255,0.07));
  border-radius: 22px; box-shadow: 0 24px 60px rgba(0,0,0,0.5); padding: 26px 30px;
  display: flex; flex-direction: column; align-items: center; gap: 18px;
}
.ob-wheel { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.ob-wheel-disc { border-radius: 50%; cursor: crosshair; touch-action: none;
  box-shadow: 0 0 0 1px rgba(255,255,255,0.08), 0 0 40px color-mix(in srgb, var(--accent, #7c3aed) 40%, transparent); }
.ob-wheel-slider { width: 200px; accent-color: var(--accent, #7c3aed); }
.ob-wheel-swatch { width: 46px; height: 46px; border-radius: 50%;
  box-shadow: 0 0 0 3px rgba(255,255,255,0.1), 0 0 22px color-mix(in srgb, var(--accent, #7c3aed) 60%, transparent); }
.ob-wheel-confirm {
  border: none; border-radius: 12px; padding: 10px 22px; font: inherit; font-weight: 600; cursor: pointer;
  color: #fff; background: var(--accent, #7c3aed);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--accent, #7c3aed) 45%, transparent);
}
@media (prefers-reduced-motion: reduce) { .ob-temp-panel { animation: none; } .ob-vignette { transition: none; } }
```

> `applyAccent` (Phase 0) is expected to set `--accent` on `:root` and emit `accent:changed`. If Phase
> 0 named the CSS var differently, update the `var(--accent, …)` references here to match — verified in
> Task 10 (moving the wheel must recolor the pet, the notch, and this vignette together).

**Verify:** `npm run typecheck` green.
**Commit:** `feat(onboarding): Act 1 — arrival + color wheel + live theming`

---

### - [ ] Task 7 — demoController.runTalkTurn returns transcript length

Act 2's retry logic (empty transcript → "try again") needs to know whether STT caught anything.
Extend `runTalkTurn` in `src/onboarding/demoController.ts` to return it (additive; the existing
`OnboardingFlow` caller ignores the return):

```ts
export async function runTalkTurn(
  bridge: NativeBridge, audioBase64: string, name: string, cb: DemoCallbacks = {},
): Promise<{ transcriptLen: number }> {
  cb.onThinking?.();
  const { text } = await bridge.transcribeAudio({ audioBase64, mimeType: WAV });
  const transcript = (text ?? '').trim();
  klog('onboarding', 'info', 'talk turn', { transcript_len: transcript.length });
  const reply = (await onboardingChat(transcript, name)) || "I hear you! Let's keep going.";
  await speak(bridge, reply, cb.onSpeaking);
  return { transcriptLen: transcript.length };
}
```

**Verify:** `npm run typecheck` green.
**Commit:** `refactor(onboarding): runTalkTurn reports transcript length for retry`

---

### - [ ] Task 8 — Act 2 (Can you hear me?) — primer + say-hi drill

Create `src/onboarding/acts/Act2Hearing.tsx`. This lifts the legacy `learn_talk` wiring (which already
uses `set_onboarding_ptt` + `onboarding:ptt` + `onboarding:audio` + `runTalkTurn`) into the coach
model, and adds the Mic + Input-Monitoring primer. The pet's listening halo already reacts live —
`input.rs` emits `cursor:listening` and `audio.rs` emits `cursor:level` under `ONBOARDING_PTT` — so no
extra event wiring is needed for "the pet hears you." **Chord is the only Next** (no button). Internal
phases `primer → drill`.

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { createNativeBridge } from '../../native/nativeBridge';
import { klog } from '../../core/logger';
import { playRecordingCue } from '../../core/sound';
import { useVoice } from '../useVoice';
import { ACT_LINES, ACT2_CHIP } from '../copy';
import { setCoachCaption, clearCoachCaption, coachSay } from '../coachSurface';
import { runTalkTurn } from '../demoController';
import type { ActProps } from './actTypes';

export function Act2Hearing({ name, onAdvance }: ActProps) {
  const bridge = useMemo(() => createNativeBridge(), []);
  const voice = useVoice();
  const [phase, setPhase] = useState<'primer' | 'drill'>('primer');
  const recordingRef = useRef(false);
  const doneRef = useRef(false);

  // 2a — primer: benefit copy in Kairo's voice, then fire Mic + Input-Monitoring (NOT Screen
  // Recording — that's Act 3). Poll both; if already granted (returning user), skip to the drill.
  useEffect(() => {
    if (phase !== 'primer') return;
    let cancelled = false;
    (async () => {
      await coachSay(bridge, voice.speak, [ACT_LINES.act2_primer], name, { title: 'Kairo' });
      const mic = await bridge.requestMicrophone();            // mic-only OS prompt
      await bridge.requestInputMonitoring();                    // input-monitoring prompt + Settings listing
      klog('onboarding', 'info', 'act2 primer', { mic: mic.microphone });
    })();
    // Poll grants; advance to the drill once mic is granted + input-monitoring is granted.
    const iv = setInterval(async () => {
      const [status, im] = await Promise.all([bridge.getPermissionStatus(), bridge.getInputMonitoringStatus()]);
      if (cancelled) return;
      if (status.microphone === 'granted' && im === 'granted') { clearInterval(iv); setPhase('drill'); }
      else if (im !== 'granted') {
        // Input Monitoring usually needs a manual toggle — bridge the user to the pane.
        void invoke('open_permission_settings', { permission: 'inputMonitoring' }).catch(() => {});
      }
    }, 1500);
    return () => { cancelled = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // 2b — the say-hi drill (first wow). Chord is the ONLY Next.
  useEffect(() => {
    if (phase !== 'drill') return;
    doneRef.current = false;
    void invoke('set_onboarding_ptt', { active: true }).catch(() => {});
    void coachSay(bridge, voice.speak, [ACT_LINES.act2_drill], name, { title: 'Kairo', chip: ACT2_CHIP });

    const uns: Array<() => void> = [];
    // ⌥⌃ hold edge (recording-truth). Native already drives the pet halo (cursor:listening/level).
    void listen<{ active?: boolean }>('onboarding:ptt', (e) => {
      const active = Boolean(e.payload?.active);
      recordingRef.current = active;
      playRecordingCue(active);
      if (active) void setCoachCaption(bridge, { title: 'Listening…', detail: 'Say hi — I hear you.', chip: ACT2_CHIP });
    }).then((u) => uns.push(u));

    // Recorded WAV on release → run the real talk turn (reuses demoController).
    void listen<{ audioBase64: string }>('onboarding:audio', (e) => {
      if (doneRef.current) return;
      void handleAudio(e.payload.audioBase64);
    }).then((u) => uns.push(u));

    return () => {
      void invoke('set_onboarding_ptt', { active: false }).catch(() => {});
      uns.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const handleAudio = useCallback(async (audioBase64: string) => {
    // Empty audio / too-short tap: nudge, stay on the drill (never blocks).
    if (!audioBase64) { await coachSay(bridge, voice.speak, [ACT_LINES.act2_short], name, { title: 'Kairo', chip: ACT2_CHIP }); return; }
    await setCoachCaption(bridge, { title: 'Thinking…', detail: 'One sec…' });
    let transcriptLen = 0;
    try {
      ({ transcriptLen } = await runTalkTurn(bridge, audioBase64, name, {
        onThinking: () => void setCoachCaption(bridge, { title: 'Thinking…', detail: 'One sec…' }),
        onSpeaking: () => void emit('cursor:speaking'),
      }));
    } catch (error) {
      klog('onboarding', 'error', 'act2 talk turn failed', { error: String(error) });
    }
    if (transcriptLen === 0) {                       // heard nothing — retry
      await coachSay(bridge, voice.speak, [ACT_LINES.act2_empty], name, { title: 'Kairo', chip: ACT2_CHIP });
      return;
    }
    doneRef.current = true;                          // one successful reply → advance
    void emit('cursor:celebrate');                   // Phase 2 subtle celebration
    klog('onboarding', 'info', 'act2 first wow');
    await new Promise((r) => setTimeout(r, 900));
    await clearCoachCaption(bridge);
    onAdvance();
  }, [bridge, name, voice.speak, onAdvance]);

  return null; // out of the card — the coach caption + the pet are the whole UI
}
```

Notes / edge cases (all from §4 Act 2):
- **Chord-only-Next:** the component renders `null`; the only way forward is a successful
  hold-talk-reply. There is no Continue button.
- **Too-short tap / empty transcript:** the WAV never arrives (below the native size gate) or STT
  returns nothing → a gentle nudge caption, and the drill stays armed (`doneRef` stays false).
- **Returning user (grants already on):** the primer's poll advances straight to the drill.
- **Input Monitoring needs a manual toggle:** the poll deep-links the pane
  (`open_permission_settings('inputMonitoring')`) so the user can flip it; no relaunch.

**Verify:** `npm run typecheck` green.
**Commit:** `feat(onboarding): Act 2 — mic/input-monitoring primer + say-hi drill`

---

### - [ ] Task 9 — Register Acts 1-2 in the Phase 0 orchestrator

Wire the two acts into the front of the Phase 0 orchestrator's ordered acts list (exact file/symbol
recorded in Task 0). Contract: the orchestrator renders one act at a time, passing
`{ name, onAdvance }`; `onAdvance` moves to the next. Insert:

```ts
import { Act1Arrival } from './acts/Act1Arrival';
import { Act2Hearing } from './acts/Act2Hearing';
// …
const ACTS = [Act1Arrival, Act2Hearing, /* …then the legacy card flow (Task 4 tail) … */];
```

- Acts 1-2 run first (arrival + color, then hearing). After Act 2's `onAdvance`, the orchestrator
  falls through to the **existing legacy card flow** starting at `permissions` (so:
  `permissions → learn_point → circle → signin → source → done`), keeping the app runnable end-to-end.
  Phases 4-6 will replace that tail act-by-act.
- **Resume (relaunch) note for Phase 3:** Acts 1-2 request no relaunch-forcing grant, so there is no
  mid-act quit+reopen to survive here. Leave the existing `get_onboarding_step` / `set_onboarding_step`
  resume for the legacy tail exactly as-is; do not gate Acts 1-2 on it. (Screen-Recording resume is
  Phase 4's problem.)
- If Phase 0's shell renders the legacy `OnboardingFlow` as its own tail act, ensure Acts 1-2 mount
  **before** it and that the transparent full-screen window still lets the desktop + pet + notch show
  through while an act renders `null` (Act 2) or only the vignette/temp-panel (Act 1).

**Verify:** `npm run typecheck` green.
**Commit:** `feat(onboarding): sequence Acts 1-2 ahead of the legacy flow`

---

### - [ ] Task 10 — Build, verify on the real app, self-review

Build + launch the packaged app (the only real test env):

```bash
osascript -e 'tell application "Kairo Tutor" to quit'
npm run tauri:build -- --bundles app && open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
# watch logs in another pane:
tail -F ~/Library/Logs/Kairo/kairo-latest.log
```

To force a fresh first-run, clear the marker before launch:
`rm -f "$HOME/Library/Application Support/com.kairo.tutor/onboarded" "$HOME/Library/Application Support/com.kairo.tutor/onboarding_step"`

**Drive it (this is the verification — typecheck can't catch these):**

Act 1:
- [ ] On launch the pet performs the `cursor:entrance` beat and the **coach caption appears in the
      real notch** ("Hey — I'm Kairo…"). The onboarding window shows only the vignette (desktop shows
      through).
- [ ] After the line, the color-wheel temp panel fades in with the coach caption "First — pick my
      color."
- [ ] Dragging the wheel recolors — **simultaneously** — the pet glow, the desktop vignette, the temp
      panel accents, AND the notch caption accent (confirms `applyAccent` → `accent:changed` reaches
      all surfaces). The value slider changes lightness.
- [ ] "That's the one" persists the accent: quit + relaunch (skip onboarding) and confirm the pet /
      notch come up in the chosen color (`get_accent` returns it). Check the log for
      `act1 color confirmed hex=…`.

Act 2:
- [ ] The primer speaks, and the macOS **Microphone** prompt fires — but **Screen Recording does
      NOT** (verify no screen-capture prompt appears; that's Act 3). The **Input Monitoring** prompt
      fires and Kairo appears in Settings › Privacy › Input Monitoring; if off, the pane deep-links
      open.
- [ ] With both granted, the drill caption appears with the seeded chip "try: 'hey Kairo, what's
      up?'". Hold ⌥⌃, say hi, release → the **pet listening halo reacts live** while held, then Kairo
      **replies for real** (spoken). Recording cues play.
- [ ] **Chord-only-Next:** there is no button; the successful reply auto-advances (pet does the
      `cursor:celebrate` beat). Log shows `act2 first wow`.
- [ ] Retry edges: a super-short tap → "hold them a beat longer"; a hold with no speech →
      "didn't quite catch that — try again"; neither advances. Then a real hold-talk succeeds.
- [ ] Returning-user path: relaunch with grants already on → primer skips straight to the drill.

Reduced motion:
- [ ] `prefers-reduced-motion` (System Settings › Accessibility › Display › Reduce motion) dampens the
      temp-panel/vignette animation (no hard failures).

**Self-review checklist:**
- [ ] No `console.*` / `println!` added — all new steps + every error path log via `klog` / `klog!`
      (tags `onboarding` / `ptt`). No transcript text or audio bytes logged (only `transcript_len`).
- [ ] Act 2 never requests Screen Recording. Only Mic + Input Monitoring.
- [ ] Onboarding still owns PTT during the drill (`set_onboarding_ptt(true)` on enter, `false` on
      cleanup) and the notch stays inert (no product turn fires on the same press).
- [ ] The coach caption is cleared (`hide_notch`) on each act's `onAdvance` so the notch doesn't
      dangle between acts.
- [ ] Cross-platform: the new Rust commands are `#[cfg(target_os = "macos")]`-guarded with non-macOS
      fallbacks (matching the existing permission commands).
- [ ] `npm run typecheck` && `npm run test` && `cargo check --manifest-path src-tauri/Cargo.toml` all
      green.

**Commit:** `chore(onboarding): verify Acts 1-2 on packaged app` (docs/notes only, if anything).

---

## Notes for the executor

- **Depends on Phase 0/1/2.** If Task 0 fails, do not proceed — those phases are the foundation and
  the coach caption / accent theming / pet entrance won't work without them.
- **The say-hi drill already exists** for the legacy `learn_talk` step; Act 2 is that same real
  pipeline, re-hosted in the coach model. Reuse `demoController.runTalkTurn` — do not fork the pipeline.
- **The pet already hears the user** during onboarding PTT (native `cursor:listening` + `cursor:level`
  under `ONBOARDING_PTT`). Phase 3 adds no mic-visualization wiring — it just drives captions +
  `cursor:speaking` / `cursor:celebrate`.
- **Keep it out of the card.** Act 2 renders `null`; Act 1 renders only the vignette + the color temp
  panel. Everything the user reads is the coach caption in the real notch. That's the whole point of
  Phase 3.
