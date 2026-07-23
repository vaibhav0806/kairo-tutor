# Phase D — Notch Progress Dots

> **Status:** Ready to build.
> **Parent spec:** [`2026-07-23-onboarding-ux-v2.md`](./2026-07-23-onboarding-ux-v2.md) → Phase D (§ "Notch progress dots"), decision ledger #6.
> **Goal (one line):** Render 4 accent-tinted, text-free progress dots in the notch chrome — one per onboarding *chapter* — driven by a dedicated `onboarding:progress` event, cleared on finish so they never appear in normal product use.

---

## Goal

Give the first-run a quiet, always-present sense of "how far along am I" without adding a windowed breadcrumb or any text (the notch pill is tiny). Four dots, one per chapter, live in the notch — the single surface present in every act. The current chapter's dot is filled in the user's accent; past dots are the accent at low opacity; future dots are a faint neutral. Because the notch already threads the live accent CSS var, the dots start brand-violet and re-tint the instant the user picks a color in Act 1 — **zero extra wiring for personalization.** They vanish the moment onboarding finishes.

Two reasons the dots live in the notch specifically:
1. **Single source of truth** — the notch is the one surface shown in every act; no competing top-of-window breadcrumb on the windowed acts (ledger #6).
2. **Capture-exclusion** — the notch panel is `NSWindowSharingNone`, so the dots (like the mic meter in Phase F) never pollute the vision screenshots taken during the practice beats. Keeping progress UI *in* the notch is deliberate.

---

## Current state (files + real line numbers)

**`src/notch/NotchApp.tsx`** — the notch root (single React component `NotchApp`):
- L1-2: imports `emit, listen` from `@tauri-apps/api/event` (both already available).
- L52 + L58: `import { useNotchAccent } from './useNotchAccent';` and the `useNotchAccent();` call at the top of the component. This is what threads the live accent — see below.
- L59: `const [payload, setPayload] = useState<NotchPayload>(defaultPayload);` — the state cluster starts here; the new `progress` state slots in alongside.
- L1122-1131: the `cursor:level` listener `useEffect` — the exact pattern to copy for a new global-event listener (`listen(...).then(un).catch(/* no bus in tests */)` + cleanup).
- L1472-1479: `resolveCapsuleMode(...)` derives `capsuleMode`.
- L1529-1550: the single `return <NotchCapsule .../>` — where the new `progress` prop is passed.

**`src/notch/NotchCapsule.tsx`** — the presentational capsule chrome (the ONLY markup the notch renders):
- L16-33: `NotchCapsuleProps` — the prop contract; add `progress` here.
- L121-154: `NotchCapsule(props)` returns `<main className="kairo-capsule-shell">{mode === 'idle' ? null : <div className="kairo-capsule" ref={capsuleRef} …>…</div>}</main>`. The `.kairo-capsule-shell` `<main>` is **always** rendered; the inner `.kairo-capsule` pill only when `mode !== 'idle'`. `capsuleRef` stays on the `.kairo-capsule` element (the `--mic-level` + hit-rect contract). This is where the dots row is inserted, **above** the pill.

**`src/notch/useNotchAccent.ts`** — how the accent is threaded and kept live:
- L19-22: writes `--accent` (hex) and `--accent-rgb` (`"r g b"` triple) onto `document.documentElement`.
- L26-32: applies the persisted accent on mount **and** re-applies on every `accent:changed` event.
- ⚠️ **Critical grounding correction:** the notch's live accent var is **`--accent` / `--accent-rgb`**, NOT `--kairo-accent`. The parent spec's prose says dots use `var(--kairo-accent)`; that var belongs to `core/accent.ts`'s `applyAccent` (a *different* surface's convention) and is **not** set inside the notch webview. Every existing notch rule (`.kairo-capsule-coach`, `-dot`, `-viz`, `-chip`) uses `rgb(var(--accent-rgb) / a)`. **The dots MUST use `var(--accent-rgb)`** to inherit `useNotchAccent`'s live re-tint. Using `--kairo-accent` would render the dots invisible/unthemed in the notch.

**`src/styles.css`** — the notch styles (all `.kairo-capsule-*` live here, not in `onboarding.css`):
- L34-40: `:root.notch-document { --accent: #7c3aed; --accent-rgb: 124 58 237; … }` — the **brand-default fallbacks**. This is why the dots are violet *before* the user picks a color: the default var is already set on the notch document even if `useNotchAccent`'s async native read hasn't resolved.
- L1559-1570: `.kairo-capsule-shell` — `display:flex; align-items:flex-start; justify-content:center; padding: 44px 12px 12px; pointer-events:none;` (the top padding clears the physical MacBook notch).
- L1572-1598: `.kairo-capsule` — the pill; `display:flex; gap:10px;` row.
- L1719-1772: the coach-caption CSS block (`.kairo-capsule[data-mode='coach']`, `.kairo-capsule-coach`, `.kairo-capsule-caption-row`, `.kairo-capsule-dot`, `.kairo-capsule-caption`). The new dots CSS goes adjacent to this block.

**`src/onboarding/coachSurface.ts`** — how the caption is pushed/cleared:
- L12-22: `setCoachCaption` → `bridge.showNotch({ state:'coach', … })`.
- L25-27: `clearCoachCaption` → **`bridge.hideNotch()`**. This is the crux: **the caption is cleared by hiding the whole notch, and it is cleared between acts** (via `useCoach.clear()`, `useCoach.ts:77`). Therefore the dots **cannot** be derived from the coach payload — a clear would wipe them. They must be their own React state fed by a dedicated event (see Design).

**`src/onboarding/OnboardingApp.tsx`** — the act orchestrator:
- L18-27: `ACT` enum + `ACT_COUNT`. **Today this is the pre-Phase-C 7-act model** (`ARRIVAL:0 … ENDING:6`, `ACT_COUNT = 7`). Phase C inserts `HERO:0` and renumbers to the 8-act model this plan targets.
- L36: `const [actIndex, setActIndex] = useState(0);`.
- L58-60: `advance()` bumps `actIndex`.
- L62-67: a `useEffect` keyed on `[actIndex]` (the click-through toggle) — the exact pattern to copy for the progress emit.
- L72-81: the resume effect (`get_onboarding_step`) can set `actIndex` before first paint.
- L83-85: `finish()` → `invoke('finish_onboarding')`. This is where the clear-sentinel emit is added.

**`src/notch/types.ts`** — `NotchPayload` (L4-11). **Decision: the dots do NOT ride the payload.** They use a dedicated `onboarding:progress` event so they survive caption clears and are independent of the notch's per-turn payload lifecycle. `NotchPayload` is left untouched.

---

## Design

### Chapter model (locked, 8-act post-Phase-C)

8 acts collapse to 4 chapters. Names are **internal only** — the dots show **no text**.

| Dot idx | Chapter (internal name) | Acts (post-Phase-C enum) |
|---------|-------------------------|--------------------------|
| 0 | Welcome | HERO(0), ARRIVAL/color(1) |
| 1 | Set up  | HEARING(2), PERMISSIONS(3) |
| 2 | Try it  | PRACTICE(4) |
| 3 | Wrap up | SIGNIN(5), SOURCE(6), ENDING(7) |

```ts
// index = act (HERO:0 … ENDING:7); value = chapter (0..3)
const actToChapter = [0, 0, 1, 1, 2, 3, 3, 3] as const;
const CHAPTER_TOTAL = 4;
```

### Placement — a dots row ABOVE the pill (notch chrome, above the caption)

The dots render as a **sibling row directly above the `.kairo-capsule` pill**, inside a thin centered column wrapper in the shell — **not** inside the pill and **not** hung off the caption content.

```
   ┌─ (44px top padding clears the physical notch) ─┐
            • • ○ ○          ← kairo-notch-progress (dots row)
        ╭───────────────╮
        │ ● Kairo's line │    ← .kairo-capsule (coach caption pill)
        ╰───────────────╯
```

Why above-the-pill (a sibling) rather than inside the pill:
- The pill morphs its width/height off `.kairo-capsule-inner` (`useCapsuleMorph`), and compact modes force a 999px pill radius. Injecting a stacked row *inside* would fight the morph sizing and distort the pill shape (listening/thinking are pills). A sibling row above the pill leaves the pill's geometry and the `capsuleRef` hit-rect untouched.
- It still reads as notch chrome "above the caption," and it persists across pill mode changes within an act (e.g. Act 2's coach → listening → thinking) because it's outside the cross-fading layers.
- The dots row is `pointer-events:none` (decorative) and sits *outside* the reported hit-rect, so it never catches clicks — correct, since it's non-interactive.

### Data flow (dedicated event, separate state)

```
OnboardingApp (actIndex change)
   └─ emit('onboarding:progress', { chapter: actToChapter[actIndex], total: 4 })
NotchApp
   └─ listen('onboarding:progress') → setProgress({chapter,total})  (or null if chapter < 0)
       └─ <NotchCapsule progress={progress} />
           └─ renders .kairo-notch-progress above .kairo-capsule
OnboardingApp.finish()
   └─ emit('onboarding:progress', { chapter: -1, total: 4 })  ← sentinel: clear
       → NotchApp setProgress(null) → dots gone forever this session
```

The dots are their **own React state** in `NotchApp`, fed only by this event — completely decoupled from the coach payload, so `clearCoachCaption` (`hideNotch`) between acts never wipes them.

### Accent tint states (all via `--accent-rgb`)

| Dot state | Rule | Rationale |
|-----------|------|-----------|
| **current** (`i === chapter`) | `background: rgb(var(--accent-rgb))` + soft accent glow + slight scale | the filled "you are here" dot, in the user's hue |
| **past** (`i < chapter`) | `background: rgb(var(--accent-rgb) / 0.4)` | done chapters, accent at low opacity |
| **future** (`i > chapter`) | `background: rgb(255 255 255 / 0.18)` | faint neutral, recedes |

`--accent-rgb` defaults to `124 58 237` (`:root.notch-document`, violet) and is overwritten live by `useNotchAccent` on `accent:changed`. So: dots are violet from Act 0, and the instant the user confirms a color in Act 1 (`Act1Arrival` emits `accent:changed`), all filled/past dots re-tint to the chosen hue with a CSS transition — for free. Style stays subtle, matching the "accent-threaded, Raycast+Arc, no glass" notch language.

---

## Implementation steps

### 1. `src/onboarding/OnboardingApp.tsx` — emit progress on every act change

- Add the import: `import { emit } from '@tauri-apps/api/event';` (alongside the existing `invoke` import).
- Add the map near the `ACT` enum (L18-27):
  ```ts
  // index = act (HERO:0 … ENDING:7 after the Phase-C renumber); value = chapter (0..3).
  // Chapters (internal names, dots show no text): Welcome / Set up / Try it / Wrap up.
  const actToChapter = [0, 0, 1, 1, 2, 3, 3, 3] as const;
  const CHAPTER_TOTAL = 4;
  ```
- Add an effect modeled on the click-through effect (L62-67), keyed on `[actIndex]`:
  ```ts
  // Drive the notch progress dots: one dot per chapter, no text. Separate from the coach
  // caption (which is cleared between acts) — the dots ride their own event + state.
  useEffect(() => {
    if (!hasNativeBridge) return;
    const chapter = actToChapter[actIndex] ?? 0;
    klog('onboarding', 'info', 'progress emit', { act: actIndex, chapter, total: CHAPTER_TOTAL });
    void emit('onboarding:progress', { chapter, total: CHAPTER_TOTAL }).catch(() => {});
  }, [actIndex]);
  ```
  This fires on mount (`actIndex = 0` → chapter 0) and after any `advance()`/resume bump, always reflecting the live act.
- Extend `finish()` (L83-85) to emit the clear sentinel **before** the native call, so it lands while the onboarding webview is still alive:
  ```ts
  const finish = () => {
    // Clear the notch dots so they never show in normal product use.
    void emit('onboarding:progress', { chapter: -1, total: CHAPTER_TOTAL }).catch(() => {});
    klog('onboarding', 'info', 'progress cleared (finish)');
    if (hasNativeBridge) void invoke('finish_onboarding').catch(() => {});
  };
  ```

> **Ordering note (Phase D before Phase C):** `actToChapter` above assumes Phase C's HERO insert. If Phase D is built **before** Phase C (both are parallelizable), the live enum is the 7-act model (`ARRIVAL:0 … ENDING:6`); use the interim map `const actToChapter = [0, 1, 1, 2, 3, 3, 3] as const;` and swap to the 8-entry map when HERO lands. The rest of the wiring is identical. Prefer landing C first (the parent spec calls D "easiest after C's act renumber").

### 2. `src/notch/NotchApp.tsx` — listen + hold state + pass the prop

- Add state next to the payload state (near L59):
  ```ts
  // Onboarding chapter progress for the notch dots. Fed ONLY by 'onboarding:progress'
  // (never the payload), so caption clears between acts don't wipe it. null = no dots.
  const [progress, setProgress] = useState<{ chapter: number; total: number } | null>(null);
  ```
- Add a listener effect, copying the `cursor:level` pattern (L1122-1131):
  ```ts
  // Onboarding progress dots (Phase D). A chapter < 0 sentinel clears them on finish,
  // so the dots never appear during normal notch turns.
  useEffect(() => {
    let un = () => {};
    void listen<{ chapter: number; total: number }>('onboarding:progress', (event) => {
      const { chapter, total } = event.payload;
      if (chapter < 0) {
        klog('notch', 'info', 'onboarding progress cleared');
        setProgress(null);
        return;
      }
      klog('notch', 'info', 'onboarding progress', { chapter, total });
      setProgress({ chapter, total });
    })
      .then((next) => { un = next; })
      .catch(() => { /* browser preview / tests have no event bus */ });
    return () => un();
  }, []);
  ```
- Pass the prop in the `<NotchCapsule .../>` render (L1529-1550): add `progress={progress}`.

### 3. `src/notch/NotchCapsule.tsx` — dots markup above the pill

- Extend `NotchCapsuleProps` (L16-33):
  ```ts
  // Onboarding chapter progress (Phase D). null outside onboarding → no dots rendered.
  progress?: { chapter: number; total: number } | null;
  ```
- Add a small pure render helper above `NotchCapsule` (no state, decorative):
  ```tsx
  function renderProgressDots(progress: { chapter: number; total: number }) {
    const { chapter, total } = progress;
    return (
      <div
        className="kairo-notch-progress"
        role="progressbar"
        aria-label="Onboarding progress"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={Math.min(chapter + 1, total)}
      >
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className="kairo-progress-dot"
            data-state={i < chapter ? 'past' : i === chapter ? 'current' : 'future'}
            aria-hidden
          />
        ))}
      </div>
    );
  }
  ```
- Wrap the pill in a centered column stack so the dots sit above it. Change the return (L127-153) to:
  ```tsx
  return (
    <main className="kairo-capsule-shell" aria-label="Kairo status">
      {mode === 'idle' ? null : (
        <div className="kairo-capsule-stack">
          {props.progress ? renderProgressDots(props.progress) : null}
          <div
            ref={capsuleRef}
            className="kairo-capsule"
            data-mode={mode}
            onPointerEnter={props.onCapsulePointer}
            onPointerMove={props.onCapsulePointer}
            onPointerLeave={props.onPointerLeave}
            onPointerDown={props.onPointerDown}
          >
            {/* …unchanged inner… */}
          </div>
        </div>
      )}
    </main>
  );
  ```
  `capsuleRef` stays on `.kairo-capsule` (hit-rect + `--mic-level` unchanged). Dots render only when `mode !== 'idle'` (a visible capsule) **and** `progress` is set — so they never float alone and never show in normal turns (where `progress` is null anyway).

### 4. `src/styles.css` — the accent-driven dots CSS

Add adjacent to the capsule/coach block (e.g. after the `.kairo-capsule-shell` rule ~L1570, or just before the coach block ~L1719):

```css
/* Notch progress dots (Phase D onboarding). A centered column stack lifts the dots row
   above the pill without touching the pill's morph sizing or hit-rect. */
.kairo-capsule-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

/* Chapter dots — no text. Filled = current chapter in the live accent; past = accent low
   opacity; future = faint neutral. --accent-rgb is kept live by useNotchAccent(). */
.kairo-notch-progress {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  pointer-events: none; /* decorative; outside the reported hit-rect */
  animation: kairo-capsule-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.kairo-progress-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: rgb(255 255 255 / 0.18); /* future */
  transition:
    background 260ms ease,
    box-shadow 260ms ease,
    transform 260ms ease;
}
.kairo-progress-dot[data-state='past'] {
  background: rgb(var(--accent-rgb) / 0.4);
}
.kairo-progress-dot[data-state='current'] {
  background: rgb(var(--accent-rgb));
  box-shadow: 0 0 8px 1px rgb(var(--accent-rgb) / 0.7);
  transform: scale(1.15);
}
@media (prefers-reduced-motion: reduce) {
  .kairo-notch-progress { animation: none; }
  .kairo-progress-dot { transition: none; }
}
```

### 5. `klog` lines (mandatory, no `console.*`)

- `OnboardingApp`: `klog('onboarding','info','progress emit',{ act, chapter, total })` on each act change; `klog('onboarding','info','progress cleared (finish)')` in `finish()`.
- `NotchApp`: `klog('notch','info','onboarding progress',{ chapter, total })` on receipt; `klog('notch','info','onboarding progress cleared')` on the sentinel.

No new `klog` subsystem tags — reuse `onboarding` (emit side) and `notch` (consume side). No secrets/media logged (only small integers).

---

## Edge cases & gotchas

1. **Dots survive caption clears between acts.** `clearCoachCaption` → `bridge.hideNotch()` fires between acts (`useCoach.clear()`). Because the dots are their **own React state fed by `onboarding:progress`** — never derived from `NotchPayload` — the clear doesn't touch them. The native panel hiding/re-showing between acts still momentarily hides the whole notch (dots included) with the caption, but the dot **state** persists, so they reappear correctly on the next caption with no reset. This is exactly why the plan uses a dedicated event, not a payload field.
2. **Dots must vanish after finish and never appear in normal turns.** `finish()` emits the `chapter: -1` sentinel → `setProgress(null)`. In normal product use `OnboardingApp` never mounts, so `onboarding:progress` never fires and `progress` stays its initial `null` → no dots. Every launch mints a fresh notch webview with `progress = null`, so a mid-onboarding quit can't leak dots into a later normal session.
3. **Accent re-tint timing.** Dots read `var(--accent-rgb)`, defaulted to `124 58 237` in `:root.notch-document` — so they're violet from Act 0 even before `useNotchAccent`'s async native read resolves. When the user confirms a color in Act 1, `Act1Arrival` emits `accent:changed`; `useNotchAccent` rewrites `--accent-rgb`; the `transition` on `.kairo-progress-dot` animates filled/past dots to the new hue. **Do not hardcode `#7c3aed` or use `--kairo-accent`** (that var isn't set in the notch webview — see the grounding correction in Current state).
4. **Browser-preview / test guards.** The `listen('onboarding:progress')` in `NotchApp` uses the `.catch(() => {})` guard (no event bus in vitest/browser preview), matching every other listener in the file. The emit side guards with `if (!hasNativeBridge) return;` (already the file's convention) plus `.catch(() => {})`. `renderProgressDots` is pure and DOM-only, so it's inert under the node test env (the capsule isn't mounted in tests).
5. **Pill geometry untouched.** Dots are a sibling above `.kairo-capsule` inside `.kairo-capsule-stack`, so `useCapsuleMorph`'s width/height measurement, the 999px compact radius, and the `capsuleRef` hit-rect all stay exactly as-is. Verify the morph still measures correctly after the wrapper is added (it should — `capsuleRef`/`innerRef` are unchanged).
6. **Phase ordering vs the act map** — see the note under step 1: the `[0,0,1,1,2,3,3,3]` map is the post-Phase-C 8-act model; use the 7-entry interim map if D lands first.

---

## Verification

Manual (reset script in `AGENTS.md`, backend running, `tail -F ~/Library/Logs/Kairo/kairo-latest.log`):
- Fresh run → **dots appear from Act 0**, dot 0 filled, dots 1-3 faint neutral.
- Walk the acts → the **correct dot lights per chapter**: Welcome (HERO/color), Set up (hearing/permissions), Try it (practice), Wrap up (sign-in/source/ending). Past dots go accent-low-opacity, current fills.
- **Neutral→violet→chosen-hue live:** dots are violet before the pick; on color-confirm in Act 1 they re-tint to the chosen hue with a smooth transition (no rebuild, no flash).
- **Survive caption clears:** across act transitions the dots don't reset to chapter 0 or blank out permanently — they track the act.
- **Gone after finish:** completing onboarding removes the dots; subsequent normal ⌥⌃ notch turns (listening/thinking/typing/answer) show **no dots**.
- Logs show paired `onboarding:progress emit` (onboarding side) and `onboarding progress` (notch side) lines per act, and the `cleared` pair at finish.
- Accessibility: the row exposes `role="progressbar"` with `aria-valuenow/min/max` (dots themselves `aria-hidden`).

Automated (per `AGENTS.md`, before "done"):
```bash
npm run typecheck
npm run test
cargo check --manifest-path src-tauri/Cargo.toml   # no Rust change here, but run the suite
npm run tauri:build -- --bundles app
codesign --verify --deep --strict "…/Kairo Tutor.app"
```

---

## Commit breakdown

Small, revertible commits on `main` (per `AGENTS.md`):

1. **`feat(onboarding): emit onboarding:progress on each act change + clear on finish`**
   `OnboardingApp.tsx` — `actToChapter` map, the `[actIndex]` emit effect, the `finish()` clear sentinel, `emit` import, `klog` lines. (No visible change yet — no consumer.)
2. **`feat(notch): progress-dots state + onboarding:progress listener`**
   `NotchApp.tsx` — `progress` state, the listener effect, pass `progress` to `NotchCapsule`.
3. **`feat(notch): render accent-tinted progress dots above the capsule`**
   `NotchCapsule.tsx` — `progress` prop, `renderProgressDots`, the `.kairo-capsule-stack` wrapper; `styles.css` — `.kairo-capsule-stack` / `.kairo-notch-progress` / `.kairo-progress-dot` rules (accent-var driven, reduced-motion guard).

Run `npm run typecheck && npm run test` after each; rebuild + a full onboarding walk after commit 3.
