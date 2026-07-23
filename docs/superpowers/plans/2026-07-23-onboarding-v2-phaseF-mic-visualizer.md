# Phase F — Mic Visualizer

> **Founder direction (2026-07-23):** the OSS-vs-in-house *code* question is moot — what matters is the
> **visual design**. Do NOT invent the look ourselves. At build time, **deep-dive online references** (how
> Wispr Flow / Cluely / other voice apps render their mic-level meter) and **replicate a proven design**.
> Implementation can be our own code fed by the existing `cursor:level` (no second mic grab), but the
> *appearance* is modeled on good online examples. **Thread the user's chosen accent color** so it looks
> personalized. Treat the "in-house `<MicMeter>`" below as the wiring skeleton; the styling comes from the
> online research pass.
 (Act 2)

> **Status:** Ready to build.
> **Parent spec:** [`2026-07-23-onboarding-ux-v2.md`](./2026-07-23-onboarding-ux-v2.md) — Phase F (§333–359),
> decision-ledger row 4 (§33), data-flow row `cursor:level` (§388), gotcha 3 "notch is capture-excluded" (§406).
> **One-line goal:** Give Act 2's "say hi" drill a visible, accent-tinted mic meter — bars that react to
> the user's voice — reusing the level stream we already emit, so it doubles as a "your mic works" check.

---

## Goal

When the user holds ⌥⌃ and says "hi" in Act 2, the notch should show a small animated meter (dancing
bars) that rises and falls with their voice, and go **flat when they're silent / not recording**. This is
the trust beat competitors show ("we can hear you"). Per the founder: **source an existing component, do
NOT hand-roll a visualizer** — but the level input already exists, so the component must accept our
**numeric 0..1 level** and must **not grab its own mic** (we already own the mic natively).

The honest finding of the research below (§Component options): every mature OSS React "audio visualizer"
insists on owning the audio source (a `MediaRecorder` / `MediaStream` / `AudioContext`), which would be a
**second, redundant mic grab** in the WebView while native cpal is already recording. None accept a plain
scalar. So the master-spec's sanctioned path — "a ~40-line bars component driven by `--mic-level`"
(parent §350) — is the recommendation, and it is barely new code because **the notch already contains a
mic-reactive bar waveform**; we are surfacing it in Act 2's mode, not inventing it.

---

## Current state

The plumbing already exists end-to-end. Nothing about the level stream needs to change.

**1. Native emits the level (already live).** `src-tauri/src/audio.rs:230–241` — a dedicated thread emits
a global `cursor:level { level }` (f32, 0..1) every ~66ms **while the mic is capturing**:

```rust
// audio.rs:234–241
std::thread::spawn(move || loop {
    std::thread::sleep(Duration::from_millis(66));
    if capturing_level.load(Ordering::SeqCst) {
        let lvl = f32::from_bits(level_read.load(Ordering::SeqCst));
        // Global so BOTH the cursor halo and the status capsule react to voice.
        let _ = app_level.emit("cursor:level", json!({ "level": lvl }));
    }
});
```

The value is RMS-normalized in `append_mono` (`audio.rs:107–111`: `norm = (rms / 0.15).min(1.0)`). This
fires for **both** product push-to-talk and onboarding push-to-talk (the level is global; only the final
WAV event is split into `ptt:audio` vs `onboarding:audio`, `audio.rs:390–398`). So during Act 2's ⌥⌃ hold,
`cursor:level` is already streaming.

**2. The notch already consumes it.** `src/notch/NotchApp.tsx:1122–1131` writes the level into a CSS var
on the capsule element:

```ts
// NotchApp.tsx:1123–1131
const pending = listen<{ level: number }>('cursor:level', (event) => {
  const level = Math.max(0, Math.min(1, event.payload.level ?? 0));
  capsuleRef.current?.style.setProperty('--mic-level', String(level));
});
```

(The cursor engine does the same on the pet shell — `src/cursor/useCursorEngine.ts:577–583`.)

**3. A mic-reactive bar waveform already exists in the notch** — but only in `listening` mode. The capsule
renders a 5-bar viz (`.kairo-capsule-viz i`, `NotchCapsule.tsx:107–118`) whose bar height is driven by
`--mic-level`, styled at `src/styles.css:1856–1873`:

```css
/* styles.css:1857–1859 */
.kairo-capsule[data-mode='listening'] .kairo-capsule-viz i {
  height: calc(4px + var(--mic-level, 0) * 16px);
  transition: height 80ms ease-out;
  animation: kairo-viz-idle 1.4s ease-in-out infinite;
}
```

`--mic-level` is declared on `.kairo-capsule` (`styles.css:1573`) and accent-tinted bars already exist
(`styles.css:1836–1846`, gradient of `rgb(var(--accent-rgb))`).

**Why this waveform is invisible in Act 2:** during the say-hi drill, Act 2 puts the notch in **`coach`**
mode, not `listening` mode. `Act2Hearing.tsx:120` calls `guide('Listening…', 'Say hi — I hear you.', …)`
→ `useCoach.guide` → `setCoachCaption` → `NotchPayload.state = 'coach'` (`coachSurface.ts:12–22`) →
`resolveCapsuleMode` returns `'coach'` (`capsuleMode.ts:23`). Coach mode renders the caption row
(`NotchCapsule.tsx:38–60`: dot + caption + chip), **not** `.kairo-capsule-viz`. So the level is being
written to `--mic-level` during the hold, but nothing visible reads it in that mode.

**Net:** Phase F = render a mic-reactive bar meter **inside coach mode** (or a small element beside it),
fed by the level we already have. No native change, no new mic grab.

---

## Component options

Constraint that decides everything: **the component must take our numeric 0..1 level and must NOT open its
own mic.** A second `getUserMedia`/`MediaRecorder` in the notch WebView while native cpal is recording is
the exact "double-grab the mic" failure this phase must avoid (and it would show a second mic-in-use
indicator).

| Candidate | License | Deps | Accepts a numeric level? | Verdict |
|---|---|---|---|---|
| **`react-audio-visualize`** (`LiveAudioVisualizer`) | MIT | small | ❌ requires a `mediaRecorder` prop (it runs its own `AnalyserNode` on that stream) | **Reject** — no scalar input; would need us to hand it a MediaRecorder = a second mic grab. |
| **`react-voice-visualizer`** | MIT | React 18 peer | ❌ ships its own `useVoiceVisualizer` recorder hook; owns `getUserMedia` | **Reject** — grabs the mic itself; React-18-oriented (we're on React 19). |
| **`react-sound-visualizer` / `react-volume-meter`** | MIT | small | ❌ take a `MediaStream` / `AudioContext` node, not a scalar | **Reject** — same double-grab problem. |
| **Numeric meters** (`Base UI Meter`, `react-meter-bar`) | MIT | few/none | ✅ take a numeric value | **Reject on fit** — they render a **single filled progress bar**, not a multi-bar voice waveform; wrong aesthetic, would need heavy restyle. |
| **In-house `<MicMeter>`** (bars, ~40 lines, driven by `cursor:level` / `--mic-level`) | ours | **0 new** | ✅ that's its whole input | **✅ Recommended.** |

**Recommendation: build the tiny in-house `<MicMeter>`.** Reasons:
1. It is the **only** option that satisfies "numeric level in, no mic grab" — every real OSS visualizer
   owns its audio source (verified: `react-audio-visualize`'s `LiveAudioVisualizer` *requires* a
   `mediaRecorder`; `react-voice-visualizer` bundles its own recorder). Feeding them would reintroduce the
   mic double-grab.
2. It is **not really hand-rolling a visualizer** — the notch *already ships* a `--mic-level`-driven bar
   waveform (`styles.css:1856+`); we are extracting/re-surfacing it, not designing motion from scratch. The
   parent spec explicitly greenlights this exact fallback (§350).
3. **Zero new dependency, zero bundle cost, React-19-clean, accent-tinted for free** (`var(--accent-rgb)`),
   and it matches the notch's existing "Raycast+Arc, no glass" language by construction.

This is faithful to the founder's intent ("don't hand-roll a fancy visualizer, don't reinvent audio
analysis") — we are reusing an existing, proven micro-pattern and an existing level stream, not writing
FFT/analysis code.

### The `<MicMeter>` component (CSS bars — recommended)

~40 lines. Subscribes to the **existing** `cursor:level` (no mic access), smooths + **decays to zero**, and
writes the smoothed value to `--mic-level` on its own root so the existing bar CSS applies. Decay guarantees
duck-to-silence even though native stops emitting `cursor:level` on release (so the last value could
otherwise freeze the bars).

```tsx
// src/notch/MicMeter.tsx
import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { klog } from '../core/logger';

const BARS = 7;

/** Accent-tinted mic meter. Fed by the EXISTING `cursor:level` stream — never grabs the mic.
 *  Smooths toward the latest level and decays to 0 when no level arrives (→ flat on silence/stop). */
export function MicMeter() {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const target = useRef(0);
  const shown = useRef(0);
  const lastAt = useRef(0);

  useEffect(() => {
    let raf = 0;
    const un = listen<{ level: number }>('cursor:level', (e) => {
      target.current = Math.max(0, Math.min(1, e.payload.level ?? 0));
      lastAt.current = performance.now();
    });
    const tick = () => {
      // No fresh level for >120ms → treat as silence, ease the target to 0.
      if (performance.now() - lastAt.current > 120) target.current *= 0.8;
      shown.current += (target.current - shown.current) * 0.35; // smooth
      rootRef.current?.style.setProperty('--mic-level', shown.current.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    klog('mic', 'info', 'mic meter mounted');
    return () => { cancelAnimationFrame(raf); void un.then((f) => f()); };
  }, []);

  return (
    <span ref={rootRef} className="kairo-mic-meter" aria-hidden>
      {Array.from({ length: BARS }, (_, i) => <i key={i} />)}
    </span>
  );
}
```

Matching CSS (add to `src/styles.css`, mirrors `.kairo-capsule-viz`, accent-tinted, reduced-motion-safe):

```css
.kairo-mic-meter { --mic-level: 0; display:flex; align-items:center; gap:3px; height:18px; }
.kairo-mic-meter i {
  width:3px; border-radius:999px;
  background: linear-gradient(180deg, color-mix(in srgb, rgb(var(--accent-rgb)) 65%, #fff 35%), rgb(var(--accent-rgb)));
  /* per-bar base height varies so it reads as a waveform, not a bar chart */
  height: calc(4px + var(--mic-level,0) * 15px);
  transition: height 80ms ease-out;
  animation: kairo-viz-idle 1.4s ease-in-out infinite;
}
.kairo-mic-meter i:nth-child(odd)   { height: calc(3px + var(--mic-level,0) * 11px); }
.kairo-mic-meter i:nth-child(3n)    { height: calc(5px + var(--mic-level,0) * 18px); }
.kairo-mic-meter i:nth-child(2){animation-delay:.15s} .kairo-mic-meter i:nth-child(3){animation-delay:.3s}
.kairo-mic-meter i:nth-child(4){animation-delay:.45s} .kairo-mic-meter i:nth-child(5){animation-delay:.6s}
.kairo-mic-meter i:nth-child(6){animation-delay:.75s} .kairo-mic-meter i:nth-child(7){animation-delay:.9s}
@media (prefers-reduced-motion: reduce){ .kairo-mic-meter i{ animation:none } }
```

(`kairo-viz-idle` already exists — `styles.css:1875`.)

**Optional canvas variant** (only if we later want a richer ~20-bar *scrolling* waveform): same component
shape, but keep a rolling `Float32Array` history of the smoothed level and paint bars on a `<canvas>` with
`ctx.fillStyle = getComputedStyle(root).getPropertyValue('--kairo-accent')`. Not recommended for v1 — the
CSS bars match the notch and are cheaper. Documented here so the swap is a known, contained change.

---

## Design

**Where it renders — in the notch (coach mode), per the windowless thesis.** The notch is the one surface
present in every act, and it is **capture-excluded** (`NSWindowSharingNone`), so the meter can never leak
into vision screenshots (parent gotcha 3, §406). We render `<MicMeter>` inside the coach caption row
(`NotchCapsule.tsx` `renderModeContent`, the `mode === 'coach'` branch, ~line 42–58), gated so it only
appears for the mic drill — not for every coach caption (Act 1's wake line, Act 3's guides).

**How it's fed — the existing level stream, NOT a new mic grab.** `<MicMeter>` subscribes to the same
global `cursor:level` event native already emits (`audio.rs:239`) and that `NotchApp` already consumes
(`NotchApp.tsx:1124`). It opens **no** `getUserMedia`, creates **no** `MediaRecorder`/`AudioContext`. It is
a pure consumer of a number. (Alternative feed: read the `--mic-level` var `NotchApp` already writes on the
capsule — identical data, but subscribing to the event keeps the component self-contained and lets it own
the decay.)

**Gating it to the drill (two options — recommend A):**
- **A — payload flag (recommended, precise):** add an optional `meter?: boolean` to the coach caption.
  Thread it TS-side (`CoachCaption` in `coachSurface.ts`, `NotchPayload` in `notch/types.ts`) **and** add
  `meter: Option<bool>` to the Rust `NotchPayload` struct (`src-tauri/src/types.rs:112`, mirroring how
  `chip` is declared at line 117–118) so it survives the `show_notch` round-trip. Act 2 sets `meter:true`
  on its listening `guide(...)` during the hold; `NotchCapsule` renders `<MicMeter>` in coach mode only
  when `props.meter`. Clean, explicit, scoped exactly to the drill.
- **B — self-gating, no Rust:** mount `<MicMeter>` unconditionally in coach mode. Because native only emits
  `cursor:level` while the mic is capturing, the bars sit flat except during an actual hold — and the only
  coach-mode-with-recording moment in the whole app is Act 2's drill. Zero plumbing, but the meter is
  *technically* always present in coach captions (just idle). Simpler; slightly less intentional.

Recommend **A** — one small field, and the meter is provably drill-only. (`chip` already proves the exact
threading path works; `meter` follows it byte-for-byte.)

**Accent tint.** Free: the meter uses `rgb(var(--accent-rgb))`, which the notch already threads via
`useNotchAccent` + live `accent:changed`. It starts brand violet and re-tints the instant the user picks a
color in Act 1 — same mechanism as the progress dots (Phase D).

**Duck to silence (flat).** Guaranteed by the component's decay loop: if no `cursor:level` arrives for
>120ms (silence, or the user released ⌥⌃ and native stopped emitting), the target eases to 0 and the shown
level follows → bars settle to their minimum (`calc(4px + 0)`), a quiet flat line. No dependence on native
emitting a final zero.

---

## Implementation steps

All in `src/` (frontend) except one tiny Rust struct field if we pick gating option A.

1. **Add the component** — create `src/notch/MicMeter.tsx` with the CSS-bars `<MicMeter>` above.
   `klog('mic','info','mic meter mounted')` on mount, `klog('mic','info',{...},'mic meter unmounted')` on
   cleanup. No `console.*`.

2. **Add the styles** — append the `.kairo-mic-meter` rules to `src/styles.css` (next to the existing
   `.kairo-capsule-viz` block, ~line 1873, so the two waveforms stay visually consistent). Reuses
   `--accent-rgb`, `kairo-viz-idle`, and honors `prefers-reduced-motion`.

3. **Thread the `meter` flag (gating option A):**
   - `src/notch/types.ts` — add `meter?: boolean;` to `NotchPayload` (mirror the `chip?` comment style).
   - `src/onboarding/coachSurface.ts` — add `meter?: boolean` to `CoachCaption` and pass it into the
     `NotchPayload` (mirror the `...(c.chip ? { chip: c.chip } : {})` spread, `coachSurface.ts:17`).
   - `src/onboarding/useCoach.ts` — extend `guide(...)` (or add a `guide` opts arg) so Act 2 can request
     the meter; pass `meter` into `setCoachCaption`.
   - `src-tauri/src/types.rs:112` — add
     `#[serde(default, skip_serializing_if = "Option::is_none")] pub(crate) meter: Option<bool>,` to
     `NotchPayload` (identical treatment to `chip`, line 117–118) so `show_notch` doesn't drop it. `cargo
     check`.

4. **Render it in the capsule** — `src/notch/NotchCapsule.tsx`:
   - add `meter?: boolean;` to `NotchCapsuleProps`,
   - in the `mode === 'coach'` branch (~line 42–58), render `{props.meter ? <MicMeter /> : null}` inside
     the caption row — e.g. in place of / beside the breathing `.kairo-capsule-dot` while the drill is live,
     so "Listening… — Say hi" reads with live bars.
   - `src/notch/NotchApp.tsx:1535` — pass `meter={payload.meter}` down alongside `chip={payload.chip}`.

5. **Turn it on in Act 2** — `src/onboarding/acts/Act2Hearing.tsx`, the `onboarding:ptt` handler
   (`Act2Hearing.tsx:113–122`): when `active` is true, the existing
   `guide('Listening…', 'Say hi — I hear you.', ACT2_CHIP)` call sets `meter:true`; when the hold ends /
   the turn completes, the meter falls away with the caption. Add
   `klog('mic','info',{active},'act2 mic meter')` on the edge. No other Act 2 logic changes — recording,
   VAD, and the talk-turn are untouched.

6. **(If gating option B instead)** — skip steps 3; in step 4 render `<MicMeter />` unconditionally in the
   coach branch. No Rust change.

7. **Verify** — `npm run typecheck && npm run test && cargo check --manifest-path src-tauri/Cargo.toml`,
   then `npm run app` and walk Act 2 (reset script in `AGENTS.md`), watching
   `~/Library/Logs/Kairo/kairo-latest.log` for the `mic` lines.

---

## Edge cases & gotchas

- **Must not double-grab the mic.** `<MicMeter>` only `listen`s to `cursor:level`. It must **never** call
  `getUserMedia`, `createMediaRecorder`, `new AudioContext()`, or import `useVoice`/`voiceRecorder`. This
  is the single hard rule — a second mic grab collides with native cpal capture and lights a second mic
  indicator. (It's also why every OSS visualizer was rejected — they all open their own source.)
- **Must go flat when idle.** Native stops emitting `cursor:level` on release and may not emit a final `0`
  (the emitter thread gates on `capturing`, `audio.rs:236`; the `level_worker.store(0)` on Stop at
  `audio.rs:341` happens after the gate closes and may never be emitted). The component's decay loop
  (>120ms → ease target to 0) makes silence/stop reliably flat regardless. Do **not** rely on a native
  zero.
- **Coach captions that aren't the drill** (Act 1 wake line, Act 3 toggle guides) must not show bars —
  handled by the `meter` flag (option A). With option B they'd mount but sit flat (no capture → no level),
  which is acceptable but less intentional.
- **Browser/test guards.** `listen` from `@tauri-apps/api/event` and `requestAnimationFrame` must be
  window-safe: the component is only ever mounted inside the notch WebView, and tests are node-env
  (`AGENTS.md` — no DOM libs); don't add a test that mounts it. `performance.now()` is fine. The `cursor:level`
  listener is a no-op in a plain browser (no Tauri backend) — the meter just stays flat, which is correct.
- **Reduced motion.** The idle sway animation is disabled under `prefers-reduced-motion` (CSS), matching
  the existing `.kairo-capsule-loading` / `.kairo-capsule-viz` treatment; the height-follows-voice still
  works (it's a transition, not the looping animation), so the meter remains functional and honest.
- **Capture-exclusion is a feature, not a risk.** The notch panel is `NSWindowSharingNone`, so the meter
  never appears in the vision screenshots taken during later practice beats. Keeping the meter *in the
  notch* (not a separate window) is deliberate for this reason (parent gotcha 3, §406). Do not move it to
  an ordinary window.
- **Don't touch the level math.** RMS normalization lives in `audio.rs:107–111`; the meter is display-only.
  If the meter reads too hot/cold, tune the CSS multiplier (`* 15px`) or the component smoothing, not the
  native normalization (which also feeds the pet halo and the product listening capsule).

---

## Verification

Functional (manual, via `npm run app` + the `AGENTS.md` reset script, backend running):
- In Act 2, **hold ⌥⌃ and speak** → the notch shows accent-tinted bars that rise/fall **proportional to
  volume** (loud = tall, quiet = short).
- **Stop speaking (still holding)** → bars settle to a flat line within ~150ms.
- **Release ⌥⌃** → meter goes flat and falls away with the caption; the talk-turn still runs and Act 2
  still advances on a successful reply (no regression to `handleAudio`/VAD).
- The meter is **violet before** the color pick and **adopts the chosen hue live** after Act 1 (accent bus).
- The meter does **not** appear in Act 1 / Act 3 coach captions (option A), nor in normal product notch
  turns.
- No second mic indicator appears; logs show only the native cpal `ptt`/`mic` lines plus the frontend
  `mic` meter lines — no `getUserMedia` from the notch.

Static / build (parent §5, before "done"):
```bash
npm run typecheck
npm run test
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:build -- --bundles app
codesign --verify --deep --strict "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```

---

## Commit breakdown

Small, revertible commits on `main` (per `AGENTS.md`). Do **not** commit as part of writing this doc — this
is the build order for when the phase is executed.

1. `feat(notch): add MicMeter component + styles (accent bars, decay-to-flat)` — `src/notch/MicMeter.tsx`
   + `.kairo-mic-meter` CSS in `src/styles.css`. Reads `cursor:level`, no mic grab. (Steps 1–2.)
2. `feat(notch): thread an optional coach-caption meter flag` — `NotchPayload` (TS + Rust), `CoachCaption`,
   `useCoach.guide`, `NotchCapsule` prop + coach-mode render, `NotchApp` passthrough. (Steps 3–4.)
3. `feat(onboarding): show the mic meter during Act 2's say-hi hold` — flip `meter:true` on the listening
   guide in `Act2Hearing.tsx` + `klog('mic', …)`. (Step 5.)
4. (only if a canvas variant is later wanted) `feat(notch): canvas waveform variant for MicMeter` — separate,
   optional.

Rebuild + walk Act 2 after commit 3 (the first point the meter is visible end-to-end).

---

### Sources (component research)

- [react-audio-visualize (samhirtarif) — GitHub](https://github.com/samhirtarif/react-audio-visualize) —
  MIT; `LiveAudioVisualizer` **requires** a `mediaRecorder` prop, does not accept a scalar.
- [react-audio-visualize — npm](https://www.npmjs.com/package/react-audio-visualize)
- [react-voice-visualizer (YZarytskyi) — GitHub](https://github.com/YZarytskyi/react-voice-visualizer) —
  MIT; ships its own recorder hook (grabs the mic).
- [react-sound-visualizer — npm](https://www.npmjs.com/package/react-sound-visualizer) — takes a `MediaStream`.
- [react-volume-meter — npm](https://www.npmjs.com/package/react-volume-meter) — takes an `AudioContext` node.
- [Base UI Meter](https://base-ui.com/react/components/meter) / [react-meter-bar](https://github.com/Noor0/react-meter-bar)
  — numeric-value meters, but single-bar progress, wrong aesthetic for a voice waveform.
