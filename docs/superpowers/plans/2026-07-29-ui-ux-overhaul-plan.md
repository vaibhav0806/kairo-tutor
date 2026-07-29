# Kairo desktop — UI/UX overhaul plan

**Status:** approved, in progress · **Date:** 2026-07-29 · **Scope:** desktop app only (`src/`, `src-tauri/`), not the website landing page.

> **Founder decisions, 2026-07-29 (supersede anything below that conflicts):**
> - **This is a UX + animation effort.** The visual identity — tokens, fonts, colours, the near-square/offset-shadow shape language — does **not** change. The app must stay visually consistent with the website.
> - **Karaoke captions: DEFERRED.** Captions only appear during onboarding today, and word timings would be ElevenLabs-only. Phase 7b is cut; 7a (word-level blur-in) still ships as a perf + polish win.
> - **Rive: DEFERRED.** Needs an authored `.riv` asset. Phase 13 is cut entirely for now (not even the boundary) — the current mic bars stay.
> - **OKLCH / contrast rework: CUT.** The 8 presets stay exactly as they are. Phase 12 is cut.
> - **Custom icon set: CUT.** `react-icons` stays. Phase 11 is cut.
> - **Pen lag: fix now.** Phase 5 is a priority.
> - **Phase 6 (capsule split + light command card) is HELD** pending an explicit answer to Q1 — it is the one phase that changes how a surface looks, and the "don't alter the theming" instruction makes it the wrong thing to do unasked.

**Companion artifact:** [`docs/ui-explorations/ui-library-explorer.html`](../../ui-explorations/ui-library-explorer.html) — 163 live/mock option cards across 23 surfaces, in the landing page's own visual language. Open it in a browser; every decision below references a card in it.

```bash
open -a "Brave Browser" docs/ui-explorations/ui-library-explorer.html
```

---

## 0. Principles this plan obeys

1. **No design-system swap.** The hand-rolled foundation stays (founder decision, 2026-07-29). We buy *behaviour* (focus traps, listbox semantics, dismissable layers), never *looks*.
2. **One animation owner per surface.** Today `framer-motion` and hand-written `@keyframes` both drive the capsule — `NotchCapsule.tsx` and `onboarding.css` both carry comments about them fighting. Every phase below names the single owner.
3. **The desktop never learns vendor names.** `AGENTS.md` speech rule: the desktop sends `{ text }` and the server picks engine/voice/model/codec. This constrains the karaoke caption design (§2, Q3) — no `if (provider === 'elevenlabs')` in `src/`.
4. **Accent is a first-class token.** Anything Kairo draws on the user's screen follows `--kairo-accent-rgb`. Three places currently hardcode `#a78bfa` (`styles.css:271,276,287,296,452`) and must stop.
5. **Test the packaged app.** Every phase verifies with `npm run app`, never a dev server.
6. **Small commits.** One commit per work item, per `AGENTS.md` commit discipline.

**Non-goals:** Tailwind, shadcn adoption, a component framework, dark/light theming of the whole app, custom (non-preset) accent colours, replacing the companion cursor, replacing the highlight-box draw animation.

> **Build log — 2026-07-29.** Phases 0, 1, 2, 3, 4, 5, 7a, 8, 9 and the failure-copy half of 10 are
> shipped on `main` (`9af57d1`..`744b32f`, eleven commits). `npm run typecheck`, `npm run test`
> (223 passing, +23 new), `cargo check` and `npm run build` all pass; the packaged `.app` has not
> been launched yet — that is the founder's pass. Still open: **Phase 6** (held on Q1) and the parts
> of Phase 10 that render in the capsule (paywall moment, first-run hint), which depend on it.
> Bundle check: the always-on WebViews did not grow — NotchApp 37.6kb, CursorApp 13.1kb; sonner and
> Base UI land only in the lazily-loaded settings chunk.

---

## 1. Locked decisions

| Surface | Decision | Explorer card |
|---|---|---|
| Foundation | **Stay hand-rolled.** No Base UI/Radix/Mantine as a system. Import primitives only where a bug class exists (dialog, combobox, tooltip). | `#foundation` → "Stay hand-rolled + add primitives only" |
| Buttons | **Consolidated Kairo button** — one `.kbtn` with `data-variant`, keeping the ink fill + hard offset shadow + slide-into-shadow press. Adds focus / disabled / busy states. | `#buttons` → "Consolidated Kairo button" |
| Switches | **Base UI Switch behaviour + Base UI look, filled with the user's accent.** | `#switch` → "Base UI Switch" + "macOS shape, accent fill" |
| Voice picker | **Searchable list + inline ▶ preview + filter chips** (language / gender / engine). Preview must not save. | `#select` → "Searchable voice list w/ inline preview" + "Filter chips + list" |
| Segmented control | **Sliding indicator**, indicator filled with the user's accent. | `#segmented` → "Sliding indicator" |
| Typing prompt | **Raycast *structure*** (input row + suggestions + footer hint row) — but rendered as a **light editorial card**, not Raycast's black. See Q1. | `#prompt` → "Raycast-style command bar" (restyled) |
| Dialog | **Base UI Dialog**, scrollable, with search. Explicitly **not** inline-expand — Skills will grow to hundreds of entries. | `#dialog` → "Base UI Dialog" |
| Feedback | **All three**, with a routing rule — see Q2. | `#toast` |
| Progress | **Quota ring** for free turns + **checklist** for permissions. | `#progress` → "Quota ring", "Checklist" |
| Voice visual | **Rive reactive character** — staged, see Q4. | `#voice` → "Rive reactive character" |
| Thinking | **Elapsed-aware copy** + **optimistic + revalidate** saves. | `#thinking` |
| Caption | **Word-level blur-in** on arrival + **karaoke highlight** during playback — see Q3. | `#caption` → "Word-level blur-in", "Karaoke sync with TTS" |
| Annotation | Keep the box + draw animation. **Fix pen lag** and **make the pen follow the accent.** | `#overlay` → current card |
| Companion cursor | **Unchanged.** Founder decision — the shipped pet beats every alternative shown. | `#pet` → current card |
| Accent system | Keep the 8 presets, no dynamic colour ever. Surface the **names**; derive a fixed token set per preset. | `#accent` → "Named themes" |
| Icons | **Custom Kairo glyph set** for UI verbs; `react-icons/si` stays for brand logos only. | `#icons` → "Custom Kairo glyphs" |
| States | Paywall moment (in-notch), permission recovery, offline state, first-run notch hint. | `#states` |

---

## 2. Open questions — need your call before Phase 6+

### Q1 · What the "capsule morph" is, and what to do about it

**What it refers to.** The notch is one persistent pill (`.kairo-capsule`). As Kairo changes mode — `idle → listening → thinking → speaking → coach → typing → error` — that *same DOM element* changes size, corner radius and contents. The machinery:

- `useCapsuleMorph.ts` measures an inner `max-content` box and writes `--capsule-w` / `--capsule-h` onto the pill.
- CSS transitions those two custom properties over `--spring-morph` (420ms, `cubic-bezier(.34,1.28,.5,1)`).
- `useModePresence.ts` keeps the *leaving* mode's content mounted and absolutely positioned (so it does not stretch the measurement) while it blurs+fades out and the entering one fades in.

So "the morph" is: **the pill stretching from a 96px "Listening…" pill to a 560px text input, in one continuous animation, while its contents cross-fade.** You did not like any of the options because those cards were mostly *implementation techniques* for the same morph (Motion `layout`, View Transitions, GSAP Flip), not different **designs**. Fair. Here are actual design alternatives:

**Option A — Two surfaces (recommended).**
Split by job. The **dark status pill** stays small and never contains prose: glyph + one or two words + a visualiser, ~90–220px, height fixed. Anything with text or interaction — coach caption, typing prompt, paywall, quota warning — renders as a **separate light editorial card** anchored just below the notch: `--canvas-raised`, hairline border, `--radius-card`, the hard offset shadow, Bricolage headline, Geist body. Same language as the website cards and the onboarding `.ob-card`.

- Kills the big morph entirely — the pill's width barely changes, so there is nothing to animate badly.
- Answers your typing-prompt request for free: the command bar *is* the light card.
- The light card is legible on any wallpaper without a scrim; a dark pill over a white Figma canvas currently is not.
- Cost: two surfaces to position and one new "does the card own focus?" question (it does — it is a can-become-key panel like the annotation overlay).

**Option B — Fixed-width pill.** Pill is always the same width (say 340px); only height changes, content cross-fades inside. Simplest possible; loses the "compact when idle" charm.

**Option C — Height-only morph, pinned glyph.** Kairo's eyes stay pinned left at a fixed position; the content column grows downward only. Horizontal stability is what makes a morph feel calm — this keeps it while allowing long captions.

**Option D — Keep the current morph, fix the engineering.** Replace `useCapsuleMorph` with Motion's `layout` prop so interrupted morphs interpolate instead of snapping, and delete ~60 lines. Design unchanged.

**My recommendation: A, with D's engineering applied to whatever pill remains.** It resolves the capsule complaint, the prompt-bar complaint and the "notch as toast" idea in one move, and it is the only option that makes the notch surfaces look like the website.

### Q2 · Which feedback mechanism, when

You liked Sonner, notch-as-toast, and the inline billing alert. They are not competitors — they have different **lifetimes and audiences**. Proposed rule, to be encoded in one helper so callers never choose:

| Lane | Use for | Lives |
|---|---|---|
| **Notch** (pill or card) | Things about *the product working*, while the user is working: turn failed, quota exhausted, offline/backend down, permission granted, first-run hint | 2–6s, or until the state clears |
| **Sonner** (Settings window only) | Confirmations for an action the user just took *in that window*: voice saved, skill toggled, name saved, update check result, signed out | 3s, dismissible, stacked |
| **Inline** | Persistent *state*, not events: billing/subscription notices (`billingState.ts` already does this correctly), permission rows, quota ring | Until the state changes |
| **macOS notification** (later, optional) | Only when the app is unfocused and it matters: subscription active, update installed | OS-owned |

One export: `notify({ scope: 'product' | 'settings', tone, title, body, action? })`. `scope` picks the lane. **Concern to flag:** three lanes is defensible only if the rule is written down — this table goes in `AGENTS.md` when Phase 1 lands, otherwise it drifts back into five ad-hoc mechanisms within a month.

### Q3 · Karaoke captions — what drives the word timing

Reality check on the engines:

- **ElevenLabs** exposes timestamped synthesis (character-level alignment you can fold up into words).
- **Sarvam** ships streaming TTS (HTTP stream / WebSocket) but publishes **no word-level timestamps for TTS** — their timestamp support is on the STT side. ([Sarvam TTS docs](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/overview), [Bulbul v3](https://www.sarvam.ai/blogs/bulbul-v3))

So a real-alignment karaoke would only work on one engine — and per Principle 3 the desktop is not allowed to know which engine it is on.

**Recommended: duration-proportional estimator.** The caption highlights word *k* when `audio.currentTime` crosses a boundary computed from each word's character count (with a small weight for punctuation pauses) scaled to the clip/chunk duration. Engine-agnostic, no server change, ~40 lines in `src/notch/`. Accuracy is ±1 word, which is invisible for a reading aid.

**Upgrade path (later, optional):** the server normalises ElevenLabs alignment into a generic `wordTimings: [{ w, t0, t1 }]` field on the speech response and returns `null` for Sarvam. The desktop uses timings when present, estimator otherwise — still no vendor knowledge in `src/`. Do this only if the estimator visibly drifts in testing.

**Also:** word blur-in and karaoke are complementary, not alternatives. Blur-in plays as each word *arrives*; karaoke highlights as each word is *spoken*. Ship blur-in first (Phase 7a), karaoke second (7b) behind a constant so it can be turned off if it reads as busy.

### Q4 · Rive — who authors the `.riv`?

**I cannot produce a `.riv` file.** It is a binary artifact from the Rive editor; I can write the integration, the state-machine input contract and a placeholder, but the character itself needs a person in the editor (you, or a designer).

Proposed staging so the plan does not block on an asset:

- **7a (now):** define a `<VoiceVisual level={0..1} state="idle|listening|thinking|speaking" />` component boundary in the notch and back it with the current bars + a canvas "presence" fallback. Everything downstream is then swap-safe.
- **7b (when a `.riv` exists):** drop in `@rive-app/canvas`, wire inputs `level` (number), `thinking` (bool), `found` (trigger). No other code changes.

**Concern:** the Rive runtime is ~60–100kb wasm+JS living in the notch WebView, which is created at launch. Acceptable for a panel that is already always alive, but it must be lazy-imported so a first launch does not pay for it before the first turn.

### Q5 · OKLCH vs named themes for the accent

You said presets only, forever. Then OKLCH's value (safely *generating* arbitrary hues) does not apply. **Recommendation: named themes + a fixed derived token set**, and use OKLCH only as the *authoring* format so the eight presets are perceptually matched to each other. Concretely: for each preset, precompute and store `--accent`, `--accent-hover`, `--accent-soft` (fill on light), `--accent-on-dark` (legible on the notch), `--accent-ink` (accent-coloured *text* on the light card). Today those are ~14 ad-hoc `color-mix()` calls scattered across three CSS files with values from 7% to 72%.

**Concern worth acting on:** at least two presets (Zest `#65a30d`, Ember `#ea580c`) fall below 4.5:1 as *text* on `--canvas-raised`. The explorer's `#accent` → "Contrast guard" card shows this live. Phase 12 fixes it by giving each preset a separate darker `--accent-ink` rather than tinting the raw hex.

---

## 3. Phases

Effort is my estimate for a focused session, excluding your review passes. Dependencies are listed; anything without one can start immediately.

### Phase 0 · Tokens + primitives groundwork — **SHIPPED**
**Goal:** stop the drift before adding anything on top.
**Files:** `src/styles.css`, `src/settings/settings.css`, `src/onboarding/onboarding.css`, new `src/core/accentTokens.ts`.

1. Collapse motion values to `--ease-out: cubic-bezier(.22,1,.36,1)`, `--ease-spring: cubic-bezier(.34,1.28,.5,1)`, `--dur-fast: 160ms`, `--dur: 240ms`, `--dur-morph: 420ms`. Replace all eight current durations / six curves.
2. Global `:focus-visible { outline: 2px solid rgb(var(--kairo-accent-rgb) / .7); outline-offset: 2px }` + per-control opt-outs where it clips.
3. Add the derived accent tokens from Q5; replace the ad-hoc `color-mix()` calls.
4. `npm i @base-ui-components/react sonner` (used from Phase 1 on).

**Acceptance:** tab through Settings and the onboarding cards — focus is visible everywhere; `grep -c "cubic-bezier" src/**/*.css` drops to ≤3 distinct curves.
**Effort:** ~2h.

### Phase 1 · Feedback system — **SHIPPED** (settings lane; the notch lane waits on Phase 6)
**Goal:** nothing fails silently again.
**Depends on:** Q2 answered. **Files:** new `src/core/notify.ts`, `src/settings/*`, `src/notch/NotchApp.tsx`.

1. `notify()` with the Q2 routing table; Sonner mounted only in the Settings/main WebView, restyled to hairline + offset-shadow + Geist (no default Sonner CSS).
2. Route existing failures through it: `SettingsView` `actionError`, `VoiceSettings` `error`, `UpdateSettings` error/`current` results, `authClient` sign-out.
3. Notch lane: reuse the capsule/card for product events. Add `notify.product()` → an event the notch consumes.
4. Success paths that today say nothing: voice saved, skill toggled, name saved, accent changed.
5. Undo on destructive settings actions (skill disable, sign out) instead of a confirm.
6. Write the Q2 table into `AGENTS.md`.

**Acceptance:** kill the backend, then change a voice → a toast appears in Settings *and* the notch stays quiet; exhaust the quota mid-turn → the notch reports it, Settings stays quiet.
**Effort:** ~3h.

### Phase 2 · Controls pass — **SHIPPED**
**Goal:** the three locked atom decisions.
**Files:** `src/styles.css`, `src/settings/settings.css`, `src/settings/SettingsView.tsx`, `src/settings/VoiceSettings.tsx`, `src/onboarding/onboarding.css`.

1. **Button:** one `.kbtn[data-variant="primary|ghost|mini|link"]` replacing `.primary-button`, `.secondary-button`, `.s-btn*`, `.ob-hero-cta`, `.ob-color-confirm`. Adds `:focus-visible`, `:disabled`, and `data-busy` (inline 11px ring spinner). Offsets standardised (6px rest → 3px hover → 1px active).
2. **Switch:** Base UI `Switch` under the existing `.s-toggle` CSS, geometry moved to the macOS proportions (51×31 → scaled to 44×26 for our density), knob stretches on press, fill = `--accent`.
3. **Segmented:** sliding indicator with the accent fill; measure once on mount + on resize; arrow-key navigation via Base UI `Tabs` or a roving tabindex.

**Acceptance:** no visual regression against the current screenshots; keyboard operable; press states on every button.
**Effort:** ~4h.

### Phase 3 · Voice picker rebuild — **SHIPPED**
**Goal:** the worst control becomes the best one.
**Depends on:** Phase 2. **Files:** `src/settings/VoiceSettings.tsx`, `settings.css`. **Server: no change needed** — `bridge.previewVoice(provider, voiceId)` already accepts an arbitrary voice id, so preview-without-saving works today.

1. Replace `<select>` with a searchable listbox (`cmdk`, or Base UI `Combobox` if we want zero extra deps — pick at build time; `cmdk` is 5kb and gives fuzzy match for free).
2. **Filters:** chips for language (derived from `Voice.language`), gender, and engine. Chips are additive; search narrows within the active chips. Chip row hides when the catalogue is <12 voices, so Sarvam's curated list stays clean.
3. **Inline preview:** ▶ per row, plays via the existing `previewVoice`, swaps to ❚❚ while playing, single audio element so a second click stops the first. **Never writes preferences.**
4. Selecting a row saves (optimistically — see Phase 8), the row shows a check.
5. Group headers by language; engine shown as row metadata, not as the primary axis.
6. Virtualise only if a catalogue >150 rows shows jank (`@tanstack/react-virtual`, deferred).

**Acceptance:** with ElevenLabs enabled, type "ra" → filtered in <16ms; preview three voices without a single `PATCH /preferences`; switch engine → list reloads and the stored voice is whatever the server actually chose.
**Effort:** ~4h.

### Phase 4 · Dialog + skills search — **SHIPPED**
**Goal:** a modal that works, and survives hundreds of skills.
**Depends on:** Phase 0. **Files:** `src/settings/SettingsView.tsx`, `settings.css`.

1. Base UI `Dialog` replaces the hand-rolled scrim: focus trap, Escape, scroll lock, return-focus, `aria-modal`.
2. Search field inside; filter by name + description; group by application when skills carry one.
3. Rows become switches (matching Settings), not checkboxes.
4. Keep the current card look, but drop the offset shadow on the floating dialog (an offset shadow describes a card resting on a surface; a dialog floats) — use a soft elevation instead.
5. Empty state ("no skills match") + count in the header.

**Acceptance:** Escape closes; Tab cycles inside; the page behind does not scroll; 200 synthetic skills scroll at 60fps.
**Effort:** ~3h.

### Phase 5 · Pen: performance + accent — **SHIPPED** (perfect-freehand still optional)
**Goal:** the pen stops lagging and follows the user's colour. **This is a real bug, diagnosed:**

`OverlayApp.tsx:187` calls `setDraftPenPoints([...draftPenPoints, point])` **on every `pointermove`**. Each move therefore:
- copies the whole point array (O(n²) across a stroke),
- triggers a React render,
- re-runs `normalizePointsToRegion` (`Math.min(...xs)` — O(n), and a stack-overflow risk on very long strokes),
- rebuilds the entire `<polyline points>` string and the SVG `viewBox`,
- repaints an SVG that carries `filter: drop-shadow(...)` (`styles.css:266`) — a filtered layer repainted every frame.

On a 120Hz trackpad that is ~120 React renders/second with growing work per render. That is the lag.

**Fix (mirrors `GestureLayer.tsx`, which is already smooth for exactly this reason):**
1. Live stroke moves to a `<canvas>` drawn imperatively in one rAF loop. Points accumulate in a `useRef`; **no React state during the drag**.
2. Use `event.getCoalescedEvents()` so no input samples are dropped and each frame draws once.
3. Commit to React state / `annotation:add` only on `pointerup`. Committed strokes can stay SVG (they are static) or move to the same canvas.
4. Drop the `drop-shadow` filter on the live stroke; re-apply on the committed one only if it still reads well.
5. Track the running bounding box incrementally instead of re-reducing all points.
6. **Accent:** `styles.css:296` `stroke: #a78bfa` → `rgb(var(--kairo-accent-rgb))`. Same for `.rectangle`, `.circle`, `.highlight`, `.underline` (271, 276, 280–284, 287) and `.overlay-pointer-ring` (452). Canvas path reads the var like `GestureLayer` does, and re-reads on `accent:changed`.
7. Consider `perfect-freehand` for pressure/velocity tapering once the canvas rewrite is in — it is a 3-line addition at that point (explorer `#overlay` → "perfect-freehand pen", drawable live).

**Acceptance:** draw a fast 3-second scribble — no visible lag, `performance` panel shows no long tasks; switch accent mid-session and the next stroke is the new colour.
**Effort:** ~4h (rewrite) + 1h (perfect-freehand, optional).

### Phase 6 · Capsule architecture + typing prompt — **HELD on Q1**
**Goal:** resolve the morph complaint and land the light command card.
**Depends on:** Q1. **Files:** `src/notch/NotchCapsule.tsx`, `useCapsuleMorph.ts`, `useModePresence.ts`, `src/styles.css`, `src-tauri/src/panels.rs` (if the card is a second panel).

Assuming **Option A**:
1. Status pill: fixed height, narrow width range, contents limited to glyph + ≤3 words + visualiser. `useCapsuleMorph` shrinks to a width-only tween or disappears.
2. New **command card** surface: light `--canvas-raised`, hairline, `--radius-card`, offset shadow, Bricolage title / Geist body / Geist Mono hints — visually a sibling of the onboarding `.ob-card` and the website cards.
3. Card hosts: typing prompt (input row + 3 suggestions + footer `↵ ask · esc close · ⌥⌃ talk`), coach caption, paywall moment, first-run hint.
4. Suggestions come from `useTurnHistory.ts` (recent) + 2 static starters; `↑`/`↓` recalls history.
5. Card is a can-become-key panel (the annotation overlay already proves borderless windows drop clicks — same treatment).
6. Motion `layout` owns the pill; CSS keyframes are removed from it. One owner.

**Acceptance:** the pill never exceeds ~240px; typing opens a light card that reads as the same product as the website; `⌥⌃` tap → focus lands in the input; Escape closes both.
**Effort:** ~6h (+ Rust panel work if the card is separate — likely, ~2h).
**Risk:** highest-risk phase. Touches the hit-rect contract, click-through, and the onboarding progress dots that live inside the pill. Do it after Phases 1–5 have shipped and settled.

### Phase 7 · Caption — **7a SHIPPED, 7b CUT**
**Depends on:** Q3. **Files:** `src/notch/NotchCapsule.tsx`, `src/notch/streamingTts.ts`, `src/notch/useTTSPlayback.ts`.

- **7a — word blur-in.** Replace the per-character motion spans (~90 nodes/caption) with per-word (~8). Same effect, an order of magnitude fewer animated nodes; removes the 400ms delay cap flattening long lines.
- **7b — karaoke.** Duration-proportional estimator driven off `audio.currentTime`; the spoken word takes `--accent-on-dark`. Behind `constants.ts` flag.

**Acceptance:** a 90-char caption animates with ≤12 animated nodes; the highlight never runs ahead of the audio (bias the estimator ~60ms late — early is much worse than late).
**Effort:** 7a ~2h, 7b ~3h.

### Phase 8 · Thinking + optimistic saves — **SHIPPED**
**Files:** `src/notch/thinkingVerbs.ts`, `NotchApp.tsx`, `src/settings/VoiceSettings.tsx`, `SettingsView.tsx`.

1. Elapsed-aware copy: 0–2s "Looking…", 2–5s "Reading the screen…", 5–9s "Still going — this one is dense…", 9s+ "Almost there…". Verb pool stays; the *tier* is time-driven.
2. Optimistic saves: apply the new voice/skill/name immediately, show a quiet "saving…", revert + toast on failure. Removes the "whole control disabled while saving" pattern.
3. Skeletons replacing every `"Loading…"` string (Settings card, voice list, plan section).

**Acceptance:** an 8-second turn shows three different lines; a voice change applies before the network round-trip completes.
**Effort:** ~3h.

### Phase 9 · Progress — **SHIPPED**
**Files:** `src/settings/SettingsView.tsx`, new `src/components/QuotaRing.tsx`, `src/App.tsx`, `src/settings/UpdateSettings.tsx`.

1. **Quota ring** for `me.usage.used / limit`, accent-filled, with the count beside it. Replaces the grey text pill.
2. **Permission checklist** replacing the three status pills in `App.tsx` — ✓ / ◉ current / ○ pending, with the current row carrying the one action button and one plain sentence about the relaunch.
3. Real `<progress>` for the updater (it already receives `{downloaded, total}` and renders it as text).

**Acceptance:** quota ring updates live after a turn; permission screen shows exactly one action at a time.
**Effort:** ~3h.

### Phase 10 · States — **PARTIAL** (failure copy + permission checklist done; paywall + first-run hint need Phase 6)
**Depends on:** Phase 6 (they render in the command card). **Files:** `src/notch/NotchApp.tsx`, `src/App.tsx`, `src/core/orchestrator.ts`.

1. **Paywall moment** — on the turn that exhausts the quota, the command card says so *in the flow* with "Go Pro — $10/mo" and "maybe later". Also show the ring from turn 7 so it is never a surprise.
2. **Offline / backend down** — a distinct state, not a generic error string. Retry with backoff, and say which side is broken.
3. **First-run notch hint** — a dimmed idle presence for the first 3 days ("Hold ⌥⌃ to talk"), then never again. Counter in the app config dir alongside the other markers.
4. **Permission recovery** — the Phase 9 checklist plus a "Restart Kairo" that is the primary action once a grant needs it.

**Acceptance:** unplug the network mid-turn → the notch says the server is unreachable, not "something went wrong".
**Effort:** ~4h.

### Phase 11 · Custom icon set — **CUT**
**Goal:** one visual language for every UI verb. **Yes, I can draw these** — flat SVG on a 24px grid, 1.75px stroke to sit with Geist, squared terminals to echo the near-square shape language, `currentColor` throughout.

**Files:** new `src/components/icons/` (one `Icon.tsx` with a name union + a `paths.ts`), replacing `src/notch/NotchIcons.tsx` and the generic `react-icons` imports.

Inventory (16): `mic`, `mic-off`, `pen`, `eraser`, `close`, `check`, `chevron-down`, `chevron-right`, `search`, `play`, `pause`, `gear`, `refresh`, `download`, `external`, `warning`. `KairoMark` and the pet arrow stay as they are — anything that represents Kairo itself is already ours.

`react-icons/si|fa6|ri` stays **only** for the Act 5 source-picker brand logos (a generic set has no legitimate X or LinkedIn mark).

**Concern:** this is the lowest-ROI item on the list — a user will never notice it the way they notice a missing toast. Scheduled late deliberately. If time gets tight, `lucide-react` at `strokeWidth={1.75}` gets 90% of the benefit in 20 minutes.
**Acceptance:** every UI icon comes from one file; two stroke weights (light card 1.6, dark notch 2.0) via one prop.
**Effort:** ~4h.

### Phase 12 · Accent tokens + names — **CUT**
**Files:** `src/onboarding/accentPresets.ts`, `src/core/accent.ts`, `src/settings/SettingsView.tsx`, all three CSS files.

1. Per-preset derived tokens (Q5), authored in OKLCH, emitted as hex/rgb.
2. Fix the presets that fail contrast as text on light by giving them a darker `--accent-ink`.
3. Surface preset **names** in Settings and in the onboarding colour step (the names already exist in `accentPresets.ts` and are currently marked "INTERNAL only").
4. One `applyAccentTokens(hex)` writing the whole set, replacing today's two vars.

**Acceptance:** every preset passes 4.5:1 as text on `--canvas-raised` and 4.5:1 on the notch surface; zero `color-mix()` on raw `--accent` left outside the token file.
**Effort:** ~3h.

### Phase 13 · Voice visual boundary (+ Rive later) — **DEFERRED**
**Depends on:** Q4. **Files:** new `src/notch/VoiceVisual.tsx`, `NotchCapsule.tsx`, `MicMeter.tsx`.

- **13a:** the component boundary + a canvas "presence" fallback fed by the existing `cursor:level` stream (no second `getUserMedia` — native `cpal` stays the only capture path).
- **13b:** `@rive-app/canvas`, lazy-imported, inputs `level` / `thinking` / `found`. Needs the authored `.riv`.

**Effort:** 13a ~3h · 13b ~2h once the asset exists.

---

## 4. Suggested order

If you want visible wins fastest, and lowest risk first:

```
Phase 0  tokens + focus            ~2h   ← do first, everything sits on it
Phase 1  feedback system           ~3h   ← biggest UX gap in the product
Phase 5  pen performance + accent  ~5h   ← a real bug you can feel today
Phase 3  voice picker              ~4h   ← worst control, most differentiated feature
Phase 2  controls pass             ~4h
Phase 4  dialog + skills search    ~3h
Phase 8  thinking + optimistic     ~3h
Phase 9  progress                  ~3h
──────── decision point on Q1 ────────
Phase 6  capsule + command card    ~8h   ← highest risk, do when settled
Phase 7  caption                   ~5h
Phase 10 states                    ~4h
Phase 12 accent tokens             ~3h
Phase 13 voice visual boundary     ~3h
Phase 11 custom icons              ~4h   ← lowest ROI, last
```

**Total ≈ 54h of focused work**, ~8 phases of which are independent and could be interleaved with product work.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Phase 6 breaks the notch hit-rect / click-through contract | Ship it alone, on its own commit, after 1–5 are stable. The hit-rect is reported from the outer `capsuleRef` — keep that element even if it shrinks. |
| A second light panel near the notch fights the onboarding orchestrator panel | Reuse the existing panel plumbing in `panels.rs`; do not add a third window type. |
| Sonner's default CSS leaks into the editorial look | Import the headless pieces / override every class; verify against the light card side by side. |
| Optimistic saves mask real server failures | Every optimistic path must have a revert + toast. Test with the backend killed. |
| Karaoke drifts on long captions | Bias late, cap per-word duration, and ship behind a `constants.ts` flag. |
| Rive runtime cost in an always-alive WebView | Lazy import on first turn, not at panel creation. Measure notch memory before/after. |
| Icon set is a time sink with no user-visible payoff | Scheduled last; `lucide-react` is the escape hatch. |

---

## 6. Verification (per phase, per `AGENTS.md`)

```bash
npm run typecheck
npm run test
cargo check --manifest-path src-tauri/Cargo.toml
npm run app                      # packaged .app — the only real test
tail -F ~/Library/Logs/Kairo/kairo-latest.log
```

Plus, per phase: keyboard-only pass (Tab/Escape/arrows), an accent switch mid-session, and a `prefers-reduced-motion` pass — the app handles reduced motion well today and every new animation must keep that true.

---

## 7. Decisions still needed from you

1. **Q1** — capsule architecture: A (two surfaces, recommended) / B / C / D.
2. **Q2** — confirm the four-lane feedback routing table.
3. **Q3** — confirm the duration-proportional karaoke estimator (vs. waiting for server-side alignment).
4. **Q4** — who authors the `.riv`, and do we ship 13a now regardless.
5. **Q5** — confirm named themes + derived tokens (no OKLCH generation, no custom colours).
