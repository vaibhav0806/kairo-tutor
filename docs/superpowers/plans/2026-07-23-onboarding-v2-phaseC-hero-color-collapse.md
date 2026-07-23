# Phase C — Split Hero + Color + Collapse

> **Status:** Ready to build (GIF asset pending — ships behind a one-file placeholder swap).
> **Parent spec:** [`2026-07-23-onboarding-ux-v2.md`](./2026-07-23-onboarding-ux-v2.md) → **Phase C** (§C.1–C.6).
> **One-line goal:** add a new first-impression **HERO** act (Act 0), morph it into a redesigned
> **color selector**, then **collapse the whole window into the pet** as the deliberate seam from the
> windowed intro into the windowless teaching flow.

This is the biggest phase. It touches the act numbering, adds one component, refactors the color act,
adds two sound cues, and adds three CSS animation passes (morph-out, morph-in, collapse). No new npm
dependency — all motion is CSS transform/opacity + the existing `cursor:*` event bus (see
[Animation approach](#animation-approach--library-situation)).

---

## Goal

1. **HERO (Act 0)** — a split "front door": static left (brand + one line + one CTA + tiny legal), motion
   right (one looping curated GIF placeholder + serif value line + blurred/zoomed backdrop). Lighter than
   a carousel: one demo, then rush into the real practice. **Silent** (audio-unlock gotcha, §gotchas).
2. **Hero → color morph** — "Get started" click plays the first sound cue (the click is the gesture that
   unlocks audio) and morphs the hero card into the redesigned color selector.
3. **Color redesign** — bigger tactile wheel, a live full-surface theming preview (mini notch + pet
   tinted by the live pick), a better confirm CTA ("Let's get started").
4. **Window → pet collapse** — on color-confirm, the card implodes into the pet's on-screen position; the
   pet "catches" it (entrance + celebrate beat + soft settle cue); the window goes click-through and the
   user is on their real desktop for Act 2.

---

## Current state (files + real line numbers)

| File | What's there now |
|------|------------------|
| `src/onboarding/OnboardingApp.tsx` | `ACT` enum `18-26` (`ARRIVAL:0…ENDING:6`), `ACT_COUNT=7` `27`, `INTERACTIVE=[true,false,false,false,true,true,false]` `32`, `advance` clamps to `ACT_COUNT-1` `58-60`, click-through effect `63-67`, resume-marker effect `72-81`, act `switch` `91-127`. |
| `src/onboarding/acts/Act1Arrival.tsx` | `phase: 'wake'\|'color'` `17`; wake effect (pet `cursor:entrance` + `playChime('entrance')` + `act1_wake`) `29-36`; color effect (`act1_color`, reveals wheel on audio `onStart`) `39-43`; `onWheel` live recolor `48-52`; `confirm` (`clampAccent`→`playChime('confirm')`→`applyAccent`→`emit accent:changed`→`set_accent`→`clear`→`onAdvance`) `54-64`; render `66-86`; confirm copy hard-coded `"That's the one"` `80`. |
| `src/onboarding/acts/ColorWheel.tsx` | `@uiw` `Wheel` (width/height `208` `19-20`) + `ShadeSlider`; reports live hex up. |
| `src/onboarding/acts/TempPanel.tsx` | dark glassy centered wrapper (`.ob-color-scrim` > `.ob-color-panel`) `5-13`. Used by color + Act5. |
| `src/onboarding/copy.ts` | `ACT_LINES` `56-95` (`act1_wake` `58-61`, `act1_color` `62-65`); `CACHED_LINES` aggregation `172-184`. No hero copy yet. |
| `src/onboarding/onboarding.css` | `.ob-orchestrator` `7-14`, `.onboarding-document` (Geist body) `16-23`, `.ob-vignette` `27-35`, `.ob-color-scrim/panel` + `@keyframes ob-panel-in` `40-74`, `.ob-color*` `77-162`, reduced-motion block `345-355`. |
| `src/core/sound.ts` | `SoundName='stt-start'\|'stt-end'\|'arrive'\|'error'` `24`; `URLS` `26-31`; `VOLUME` `34-39`; `playSound` (lazy shared `AudioContext`, resume-on-play) `108-137`; `playChime('confirm'\|'entrance')` procedural `<audio>` path `203-221`. |
| `src/core/accent.ts` | `DEFAULT_ACCENT='#7c3aed'` `8`; `applyAccent` (paints `--kairo-accent` vars) `45-51`; `clampAccent` (legibility clamp) `129-134`. |
| `src/onboarding/useCoach.ts` | `say(line,{onStart})` — notch caption == voice, `onStart` at audio start `38-54`. |
| `src/onboarding/demoController.ts` | pattern for the peak beat: `emit('cursor:celebrate')` + `playSound('arrive')` `168-171`. |
| `src/cursor/useCursorEngine.ts` | pet shadows the real mouse via `cursor:mouse` `426-454`; `cursor:entrance`→`runBeat('entrance')` `637-642`; `cursor:celebrate`→`runBeat('celebrate')` `644-649`. |
| `src/onboarding/Act3Permissions.tsx` | writes the resume marker `invoke('set_onboarding_step',{step:'act3'})` `28`. |
| `src-tauri/src/onboarding.rs` | `get/set_onboarding_step` `26-77`; `show_onboarding_window` (full-screen transparent, click-through by default) `125-157`; `set_onboarding_click_through` `176-183`; `finish_onboarding` `187-212`. |
| `src/main.tsx` | routes `#/onboarding`→`OnboardingApp` `28-29`; imports `@fontsource-variable/geist` `10` **but NOT `@fontsource/instrument-serif`** (dep is installed, just never imported — the serif display font currently silently falls back to Georgia). |
| `package.json` | deps `29-40`: React 19, `@uiw/react-color-*`, `@fontsource-variable/geist`, `@fontsource/instrument-serif`, `zod`. **No `framer-motion` / `motion` / any animation lib.** |

### Animation approach — library situation

**`framer-motion` is NOT a dependency and nothing else animation-ish is either.** Every existing
animation in this app is hand-rolled: CSS `@keyframes` (`ob-panel-in`, the cursor beats in
`src/styles.css`) or a rAF spring loop (`useCursorEngine`). **Decision: do the morph + collapse with CSS
transform/opacity + the existing `cursor:*` event bus — no new dependency.** This matches the codebase and
keeps the bundle lean. A true *shared-element* morph (the hero card literally reshaping into the smaller
color card) is the one thing CSS can't do cleanly across a component swap; we get 95% of the feel with a
**crossfade-morph** (hero scales-down+fades while color scales-up+fades into the same centered frame). If
the founder later wants a pixel-perfect shared-element morph, `framer-motion`'s `layout`/`AnimatePresence`
is the drop-in upgrade — noted as optional, not required for v1.

---

## Design

### Surface: one warm-white "Editorial Light" card for hero + color

Per the landing design-system memory and master spec §C.2, the front door is **Editorial Light**:
warm-white surface, violet accent (`#7c3aed` default), **Instrument Serif** for display lines, **Geist**
for body. **Both the hero and the redesigned color selector share this one light card shell** (`.ob-card`)
so the morph is seamless (light→light, same center, same accent glow). The dark glassy `.ob-color-panel` /
`TempPanel` stays untouched for the Act 5 sign-in/source cards (out of Phase C scope) — and there's **no
adjacent clash**, because after the light color card we *collapse into the pet and go windowless* (Acts
2/3/4), so the next windowed card (Act 5, dark) is far downstream with the eye fully reset.

The existing `.ob-vignette` (accent-tinted, darkens edges) stays to focus the card over any desktop.

### Hero (Act 0) — split layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  .ob-card  (warm-white, centered, ~880×460, radius 28, soft shadow)    │
│ ┌───────────────────────────┬──────────────────────────────────────┐  │
│ │ .ob-hero-left (static ~42%)│ .ob-hero-right (motion ~58%)         │  │
│ │                            │  ┌ .ob-hero-backdrop ───────────────┐ │  │
│ │  ◆ Kairo   (.ob-hero-mark, │  │  blurred + scale(1.08) demo copy │ │  │
│ │            Instrument Serif)│  │  (depth layer, filter: blur 18px)│ │  │
│ │                            │  └──────────────────────────────────┘ │  │
│ │  Meet Kairo   (.ob-hero-h1,│   ┌ .ob-hero-demo (crisp, floating) ┐ │  │
│ │   Instrument Serif, ~52px) │   │  looping GIF placeholder of the  │ │  │
│ │  Your screen-native tutor. │   │  pet pointing/circling on a real │ │  │
│ │  (.ob-hero-sub, Geist)     │   │  screen                          │ │  │
│ │                            │   │  ┌ .ob-hero-value (serif, over) ┐ │ │  │
│ │  ┌ Get started  →  ┐       │   │  │ "Points right at what you   │ │ │  │
│ │  │ .ob-hero-cta     │       │   │  │  need."                     │ │ │  │
│ │  └──────────────────┘       │   │  └──────────────────────────────┘ │ │  │
│ │                            │   └──────────────────────────────────┘ │  │
│ │  By continuing you agree…  │                                        │  │
│ │  (.ob-hero-legal, 11px)    │                                        │  │
│ └───────────────────────────┴──────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

- **Left is static** — it does not rotate (unlike a carousel). **Right is one looping GIF**, not a
  4-slide reel (on-thesis: we prove value by *doing* seconds later). Structure allows adding 2–3 rotating
  value lines later, but v1 ships one.
- **Serif value line** overlaid on the demo. **Blur + zoom depth:** `.ob-hero-backdrop` is the same demo
  frame `filter: blur(18px) saturate(1.1)` + `transform: scale(1.08)` behind a crisp `.ob-hero-demo`.
- **No login, no press logos.**
- **GIF is a placeholder** produced by the founder later; wiring the real one is a one-file change
  (see step 2.3).

### Hero → color morph

On **Get started** click (a guaranteed user gesture → unlocks the shared `AudioContext`):
1. `playSound('morph')` — the whoosh cue (new `SoundName`, §sound). This call also *unlocks* the shared
   context for every later cue/TTS.
2. Hero card runs `.ob-morph-out` (fade→0, `scale(0.94)`, `blur(6px)`, ~200ms).
3. `onGetStarted()` → orchestrator advances HERO(0)→ARRIVAL(1).
4. ARRIVAL mounts the color card with `.ob-morph-in` (fade 0→1, `scale(0.97)`→1, ~260ms) in the **same
   centered `.ob-card` frame** → reads as the big hero condensing into the compact color card.

Crossfade-morph, not shared-element (see [library situation](#animation-approach--library-situation)).

### Color selector redesign (ARRIVAL, Act 1)

- **No wake line here anymore.** The old `act1_wake` (pet entrance + "notch is where I live") **moves to
  the collapse** (below), where the pet actually comes to life on the real desktop — a stronger beat. So
  ARRIVAL opens *directly* on the color card (morphing in), and the `act1_color` line plays as it appears.
- **Bigger, tactile wheel** — `ColorWheel` width `208`→`248`, bigger handle halo.
- **Live full-surface preview** — keep `applyAccent` + `emit('accent:changed')` on every wheel move
  (already live — recolors the real pet + notch caption). **Add a visible in-card preview** `.ob-color-preview`:
  a faux notch capsule + a small pet-arrow glyph both tinted `var(--kairo-accent)`, so the user *sees* the
  personalization inside the card, not just a swatch dot.
- **Confirm CTA** → "Let's get started" (copy key), bigger button.
- **On confirm:** `clampAccent` → `applyAccent(clamped)` + `emit('accent:changed')` → `set_accent` →
  `playChime('confirm')` → **run the collapse** (below).

### Window → pet collapse (the "it's real" seam)

**Where is the pet?** The pet (in the `#/cursor` panel) *shadows the real mouse* (`useCursorEngine`
`426-454`). During the interactive color step the mouse is over the card — and at confirm it is **on the
button**. So the pet is right there. We collapse the card **toward the confirm click's viewport point**
(captured from the click event; the onboarding window is full-monitor so viewport px == screen px minus
monitor origin — no bounds math needed). That guarantees the card implodes into where the pet visibly is.
Fallback (keyboard-activated confirm, no pointer point): screen **top-center** (the notch — "where I live").

Sequence (all inside ARRIVAL's confirm handler, after `set_accent`):
1. `emit('cursor:entrance')` — the pet "wakes up" to catch the card (reuses `runBeat('entrance')`).
2. Card gets `.ob-collapsing` → `@keyframes ob-collapse`: `translate(var(--collapse-x), var(--collapse-y))
   scale(0.04)`, opacity→0, ~360ms `ease-in` (accelerates *into* the pet). `--collapse-x/y` = target
   point minus card center, set inline from the click coords.
3. At animation end (~360ms): `emit('cursor:celebrate')` (the pop as it catches) + `playSound('settle')`
   (soft landing).
4. `await say([ACT_LINES.act1_wake], { onStart: … })` — pet now alive on the real desktop:
   "Hey — I'm Kairo. See that notch… that's where I live!"
5. `await clear()` → `onAdvance()` → HEARING(2). HEARING is non-interactive, so the existing click-through
   effect (`OnboardingApp` `63-67`) flips the window click-through → the real desktop receives input.
   (During the brief collapse we stay interactive; nothing needs clicking, so it's harmless.)

Reduced-motion: skip the implode (plain fade), keep the entrance/celebrate/settle + wake line.

---

## Implementation steps

### Sub-part 1 — Act renumber (`OnboardingApp.tsx`)

**1.1** Replace the enum + counts (`18-27`):
```ts
const ACT = { HERO:0, ARRIVAL:1, HEARING:2, PERMISSIONS:3, PRACTICE:4, SIGNIN:5, SOURCE:6, ENDING:7 } as const;
const ACT_COUNT = 8;
```
**1.2** Update `INTERACTIVE` (`32`) — HERO + ARRIVAL(color) + SIGNIN + SOURCE catch clicks:
```ts
const INTERACTIVE = [true, true, false, false, false, true, true, false];
```
**1.3** Add the HERO case to the `switch` (before `ARRIVAL`, `91`):
```ts
case ACT.HERO:
  body = <Act0Hero onGetStarted={advance} />;
  break;
```
Import `Act0Hero` at top. `advance` already clamps to `ACT_COUNT-1` (`58-60`) — now 7. No change to `advance`.

**1.4** Resume markers (`72-81`) — **verify, no logic change needed.** The block uses *symbolic* refs
(`setActIndex(ACT.PERMISSIONS)`, `setActIndex(ACT.PRACTICE)`), which auto-track the new indices (3 and 4).
Resume only ever lands on PERMISSIONS (the `'act3'` marker, written by `Act3Permissions` `28`) or PRACTICE
(a `STEPS` id) — **never HERO** — so HERO is skipped on every relaunch for free. A fresh run (no marker) keeps
`useState(0)` = HERO. Add a `klog('onboarding','info','resume',{saved})` line for observability. **Add a
comment** documenting that HERO(0) is first-impression-only and is intentionally never a resume target.

**Commit 1:** "act renumber: add HERO=0, shift acts, INTERACTIVE + resume verified".

### Sub-part 2 — The hero (Act 0)

**2.1 Copy** — add to `copy.ts` (strings live here, founder can tweak):
```ts
export const HERO_COPY = {
  wordmark: 'Kairo',
  h1: 'Meet Kairo',
  sub: 'Your screen-native tutor.',
  value: 'Points right at what you need.',   // serif, over the demo
  cta: 'Get started →',
  legal: 'By continuing you agree to our Terms and Privacy Policy.',
  confirm: "Let's get started",              // color-step CTA (also used in sub-part 3)
} as const;
```
(Locked copy per spec §6. `HERO_COPY.confirm` replaces the hard-coded `"That's the one"`.)

**2.2 GIF placeholder as a one-file swap** — new module `src/onboarding/heroDemo.ts`:
```ts
// The looping hero demo. TODAY: null → Act0Hero renders the CSS placeholder mock.
// WHEN THE REAL GIF LANDS: drop it at src/assets/onboarding/hero-demo.gif and make this:
//   import gif from '../assets/onboarding/hero-demo.gif'; export const heroDemoSrc: string | null = gif;
export const heroDemoSrc: string | null = null;
```
This is the *entire* wiring surface for the real asset (mirrors the founder-produces-later pattern).

**2.3 Component** — new `src/onboarding/acts/Act0Hero.tsx`:
- Props `{ onGetStarted: () => void }`.
- Renders `.ob-vignette` + a centered `.ob-card.ob-card--hero` with `.ob-hero-left` / `.ob-hero-right`.
- Left: `.ob-hero-mark` (wordmark), `.ob-hero-h1`, `.ob-hero-sub`, the CTA `<button className="ob-hero-cta">`,
  `.ob-hero-legal`.
- Right: `.ob-hero-backdrop` (blurred/scaled copy of the demo) + `.ob-hero-demo` containing either
  `heroDemoSrc ? <img className="ob-hero-demo-media" src={heroDemoSrc} alt="" /> : <HeroDemoMock/>` and the
  overlaid `.ob-hero-value` serif line. `HeroDemoMock` is a small pure-CSS looping mock (a faux window +
  an accent pet-arrow that drifts to a target) so the layout is fully testable with **zero image asset**.
- **Silent** — no `say`, no chime, no TTS on mount (audio-unlock gotcha).
- `onClick` of the CTA → `handleStart`:
  ```ts
  const handleStart = () => {
    klog('onboarding','info','hero get-started');   // logging MANDATORY
    playSound('morph');                              // user gesture → unlocks audio + whoosh cue
    setLeaving(true);                                // adds .ob-morph-out to the card
    window.setTimeout(onGetStarted, 200);            // advance after the morph-out
  };
  ```
- `klog('onboarding','info','hero shown')` on mount.

**2.4 CSS** (`onboarding.css`) — add the shared light card + hero classes:
- `.ob-card` — warm-white surface (`#faf7f2`-ish), radius 28, soft layered shadow, `animation: ob-panel-in`
  reuse or a light variant; accent glow ring via `var(--kairo-accent)`.
- `.ob-card--hero` — wider (`min(880px, 92vw)`), grid `42% 58%`.
- `.ob-hero-mark/h1/sub/cta/legal/value/demo/backdrop/demo-media` per the wireframe; H1 + mark + value use
  `font-family:'Instrument Serif', Georgia, serif`; sub/legal/cta use Geist. CTA styled off
  `var(--kairo-accent)` (ink-on-accent via the accent, matching `.ob-color-confirm`).
- `.ob-hero-backdrop { filter: blur(18px) saturate(1.1); transform: scale(1.08); }`.
- `@keyframes ob-morph-out { to { opacity:0; transform:scale(0.94); filter:blur(6px);} }` on `.ob-morph-out`.
- Extend the `@media (prefers-reduced-motion: reduce)` block (`345-355`) to null the morph.

**2.5 Font fix** — add `import '@fontsource/instrument-serif';` to `src/main.tsx` (next to the Geist
import `10`). The dep is installed but never imported, so today's `'Instrument Serif'` references silently
fall back to Georgia. **Required for the hero's serif display lines to render correctly.**

**Commit 2:** "hero: Act0Hero split layout + copy + placeholder demo + instrument-serif import".

### Sub-part 3 — Hero → color morph + color redesign (`Act1Arrival.tsx`, `ColorWheel.tsx`)

**3.1 Sound cues** (`sound.ts`) — add to the Web-Audio path:
- `SoundName` (`24`): `… | 'morph' | 'settle'`.
- `URLS` (`26-31`): map both to **placeholder** existing WAVs for now — `morph: echoPop`, `settle: bubblePop`
  — and add a comment: *"placeholder cues; swap the two lines when the real morph/settle WAVs land
  (one-file change, mirrors heroDemo)."*
- `VOLUME` (`34-39`): `morph: 0.22`, `settle: 0.26`.
- Leave `playChime('confirm')` as-is for the color lock-in (proven two-note rise).

**3.2 Color act refactor** (`Act1Arrival.tsx`):
- **Drop the `'wake'` phase** (`17`, `29-36`) — remove the wake `useEffect` and the `cursor:entrance`/
  `playChime('entrance')` from here; the color card is the only phase now (mount straight into it).
- Reveal the color card **immediately on mount** with `.ob-morph-in` (don't gate the card on audio
  `onStart` anymore — the morph must be continuous with no empty gap). Keep `say([ACT_LINES.act1_color])`
  for the notch caption/voice; the caption-sync mandate is preserved (caption still lands with the voice via
  `useCoach.say`), only the *panel* now appears on mount instead of on audio-start. Add a comment noting this
  deliberate deviation (morph continuity > panel-on-audio-start; caption sync intact).
- `onWheel` (`48-52`) unchanged (live `applyAccent` + `emit('accent:changed')`).
- Swap `TempPanel` → the light `.ob-card.ob-card--color` shell (new small wrapper or inline). Add the
  `.ob-color-preview` mini notch+pet tinted `var(--kairo-accent)`.
- Confirm button copy → `HERO_COPY.confirm` ("Let's get started") replacing `"That's the one"` (`80`).
- **`confirm` handler** (`54-64`) — capture the click point + run the collapse:
  ```ts
  const confirm = useCallback(async (e: React.MouseEvent) => {
    const clamped = clampAccent(hex);
    klog('onboarding','info','act1 color confirmed',{ picked: hex, clamped });
    applyAccent(clamped); void emit('accent:changed', { hex: clamped });
    await invoke('set_accent', { hex: clamped }).catch(()=>{});
    playChime('confirm');
    await runCollapse({ x: e.clientX, y: e.clientY });   // sub-part 4
    await say([ACT_LINES.act1_wake], { onStart: () => void emit('cursor:celebrate') });
    await clear();
    onAdvance();
  }, [hex, clear, onAdvance]);
  ```

**3.3 Bigger wheel** (`ColorWheel.tsx`): accept an optional `size` prop (default `248`); pass
`width={size} height={size}`. Bump `.ob-wheel-slider` width to match in CSS.

**3.4 CSS** — `.ob-card--color` (light, compact ~`340px`), `.ob-morph-in`
(`@keyframes ob-morph-in { from { opacity:0; transform:scale(0.97);} }`), `.ob-color-preview` (faux notch
capsule + pet arrow, tinted). Re-tune `.ob-color-confirm` for the light surface. Extend reduced-motion.

**Commit 3:** "color: morph-in redesign, live preview, 'Let's get started', bigger wheel, morph cue".

### Sub-part 4 — Window → pet collapse

**4.1** In `Act1Arrival.tsx`, add `collapsing` state + a `runCollapse(target)` helper:
```ts
const [collapse, setCollapse] = useState<{x:number;y:number}|null>(null);
const runCollapse = (pt: {x:number;y:number}) => new Promise<void>((resolve) => {
  if (prefersReducedMotion()) {          // reuse src/core/reducedMotion
    void emit('cursor:entrance'); playSound('settle'); setTimeout(resolve, 160); return;
  }
  klog('onboarding','info','window→pet collapse',{ x: pt.x, y: pt.y });
  void emit('cursor:entrance');           // pet wakes to catch it
  setCollapse(pt);                        // adds .ob-collapsing + inline --collapse-x/y
  setTimeout(() => { playSound('settle'); resolve(); }, 360);  // settle at land; celebrate fires via say onStart
});
```
The card element sets, when `collapse` is non-null: `className += ' ob-collapsing'` and inline style
`{ ['--collapse-x' as any]: `${pt.x - cardCenterX}px`, ['--collapse-y' as any]: `${pt.y - cardCenterY}px` }`
(card center from a `ref` `getBoundingClientRect()`; or use `transform-origin` at the point + `scale(0.04)`
which avoids computing the delta — either is fine, pick the simpler at build).

**4.2 CSS** — `@keyframes ob-collapse { to { transform: translate(var(--collapse-x), var(--collapse-y))
scale(0.04); opacity:0; } }`, applied by `.ob-collapsing` with `~360ms cubic-bezier(0.4,0,1,1)` (ease-in,
accelerate into the pet). Reduced-motion → opacity-only fade.

**4.3 Pet side — no new native code.** Reuse `cursor:entrance` (`useCursorEngine` `637-642`) at collapse
start and `cursor:celebrate` (`644-649`) at the wake line's `onStart` (welded to the pet being alive).
Fallback target (no pointer point) = screen top-center: `{ x: window.innerWidth/2, y: 46 }` (just under
the notch).

**4.4 Click-through** — no change: HEARING(2) is `INTERACTIVE[2]=false`, so the existing effect
(`OnboardingApp` `63-67`) sets the window click-through when `actIndex` becomes 2 after `onAdvance()`. The
orchestrator is already transparent for the whole flow (`.ob-orchestrator` `7-14` + `.onboarding-document`
`16-23`).

**Commit 4:** "collapse: window→pet implosion on color-confirm + entrance/celebrate/settle beats".

---

## Edge cases & gotchas

1. **Audio-unlock (critical, spec §4.2).** The shared `AudioContext` (`sound.ts` ↔ streaming TTS) is
   unlocked only by a user **gesture**. HERO is the first screen, *before* any gesture → **keep HERO fully
   silent** (no `say`, no chime on mount). The **first cue is `playSound('morph')` on the Get started
   click** — a real gesture that both plays the whoosh *and* unlocks the context for every later cue/TTS
   (the color line, confirm chime, settle cue, wake line all follow the gesture, so they're safe). Never
   attach a cue to the *auto* hero-in animation.
2. **Resume skips HERO.** Resume only targets PERMISSIONS (`'act3'`) or PRACTICE (STEPS id); a fresh run
   (no marker) starts at HERO. So HERO never replays on the Screen-Recording quit+reopen. Verify the
   `resolved` gate (`42`, `88`) still holds *all* rendering until the marker is read, so HERO can't flash
   before a resume redirect (same guard that protected the old Act 1 wake line).
3. **Act-index shift breaking refs.** All act references are *symbolic* (`ACT.PERMISSIONS`, `ACT.PRACTICE`,
   `ACT.SIGNIN`, …), so the switch, resume, and `INTERACTIVE` indexing track the new numbers automatically —
   **but** the component filenames (`Act1Arrival`, `Act2Hearing`, `Act5SignIn`, `Act5Source`, `Act6Ending`)
   now mismatch their ordinals. **Leave the renames to Phase G** (spec §G) — Phase C must not do unrelated
   renames (commit discipline). Just don't add *new* numeric assumptions.
4. **Placeholder GIF.** `heroDemo.ts` returns `null` today → the CSS `HeroDemoMock` renders, so the layout
   is fully testable now. Swapping in the real GIF is exactly one file (`heroDemo.ts`) + dropping the asset.
   Keep `.ob-hero-demo` a fixed aspect box so the mock and the eventual GIF occupy identical space.
5. **Don't regress the windowless thesis.** HERO + color are the *only* new windowed surface. Acts 2/3/4
   stay on the real desktop. The collapse is the seam — make it deliberate (implode into the pet, pet
   catches, then silence→wake on the real screen). Do **not** add any windowed chrome to Acts 2–4.
6. **Morph empty-gap.** Revealing the color card on mount (not on audio-start) is intentional to avoid a
   blank frame between hero-out and voice-in. Caption↔voice sync is still guaranteed by `useCoach.say`.
7. **Collapse target correctness.** Capture the pointer point from the confirm **click event**; because the
   onboarding window is full-monitor, `clientX/clientY` are screen coords (minus monitor origin, which is
   the window origin). Pet ≈ mouse ≈ click point, so the implode lands on the pet. Fallback to top-center.
8. **`playSound` inside a gesture.** Call `playSound('morph')` *synchronously* in the click handler (not
   after an `await`) so `ctx.resume()` runs inside the user-gesture window (WebKit requirement).

---

## Verification

Reset to a true first-run (per `AGENTS.md` reset script — `tccutil reset …` + delete markers), backend up
(`npm run server:dev`), tail `~/Library/Logs/Kairo/kairo-latest.log`, then:

1. `npm run typecheck && npm run test && cargo check --manifest-path src-tauri/Cargo.toml`.
2. `npm run app` (build+sign+verify+launch the packaged `.app`) — never a dev server.
3. **Walk it:**
   - Cold launch → **HERO shows first**, before color. It is **silent** (no cue on the auto-in). Serif
     lines render in Instrument Serif (not Georgia). Placeholder demo loops.
   - Click **Get started** → whoosh cue fires (proves audio unlocked on the gesture) → smooth morph into
     the color card.
   - Drag the wheel → the real pet + notch + the in-card preview recolor live.
   - Click **"Let's get started"** → confirm chime → the card **implodes into the pet** at the cursor → pet
     entrance+celebrate → soft settle cue → wake line ("…that's where I live") on the **real desktop** →
     **Act 2 (mic)** begins windowless.
   - Logs show: `hero shown`, `hero get-started`, `act1 color confirmed`, `window→pet collapse`, `resume`.
4. **Resume test:** progress to Act 3, grant Screen Recording (forces quit+reopen) → on relaunch the app
   lands on **PERMISSIONS**, and **HERO does not replay** (no whoosh, no hero card flash).
5. **Reduced-motion:** enable macOS Reduce Motion → morph/collapse degrade to fades; entrance/celebrate/
   settle + wake line still fire.
6. `codesign --verify --deep --strict "…/Kairo Tutor.app"` passes.

---

## Commit breakdown

1. **act renumber** — `OnboardingApp.tsx` enum HERO=0 / `ACT_COUNT=8` / `INTERACTIVE` / HERO switch case /
   resume comment + `klog`. (typecheck+test green; behavior: HERO placeholder can be a stub first.)
2. **hero** — `Act0Hero.tsx` + `HeroDemoMock`, `heroDemo.ts` placeholder, `HERO_COPY` in `copy.ts`,
   `.ob-card`/`.ob-hero-*`/`ob-morph-out` CSS, `@fontsource/instrument-serif` import in `main.tsx`.
3. **color redesign + morph** — `Act1Arrival.tsx` (drop wake phase, morph-in, light card, preview, confirm
   copy + handler), `ColorWheel.tsx` `size` prop, `sound.ts` `morph`/`settle` SoundNames (placeholder WAVs),
   `.ob-card--color`/`ob-morph-in`/`.ob-color-preview` CSS.
4. **collapse** — `runCollapse` + `collapsing` state in `Act1Arrival.tsx`, `ob-collapse` keyframe +
   `.ob-collapsing` CSS, entrance/celebrate/settle wiring, reduced-motion fallbacks.

Each commit: `npm run typecheck && npm run test && cargo check`, then a manual walk. End every message with
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Work on `main`, small revertible
commits (no branches). **Do not** rename act files (Phase G).
