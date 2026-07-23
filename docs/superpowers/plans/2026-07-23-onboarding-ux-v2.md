# Onboarding UX v2 — Regular App · Split Hero · Notch Progress · Polish

> **Status:** Locked for implementation (design finalized 2026-07-23, in discussion with the founder).
> **Predecessor:** [`2026-07-21-onboarding-redesign-and-modern-notch.md`](./2026-07-21-onboarding-redesign-and-modern-notch.md)
> shipped the "out-of-the-card" 6-act flow (now live on `main`, ~100 commits). This doc is the **UX
> polish + architecture pass** on top of it, benchmarked against Wispr Flow, Cluely, and heyclicky.
> **Scope discipline:** file/line refs below reflect the architecture as of `e9cd2da`. Adapt if code moved.

**North star (unchanged):** the onboarding is Kairo giving the user their first *real* lesson on their
*real* screen. We are **not** copying competitors' windowed, login-first, watch-a-sizzle-reel onboarding.
We adopt only the things that are objectively better UX and keep our differentiator (windowless teaching,
value-first, chord-is-the-only-Next) fully intact.

---

## 0. Why v2 (the founder's brief, distilled)

Researched Wispr Flow, Cluely, heyclicky. Findings sorted into "adopt / adapt / keep / drop." The
through-line filter for every item: **does this make Kairo better, or just make it look like everyone
else?** We adopt what's better, resist what erases the edge, unless a real need (billing) forces it.

---

## 1. Decision ledger (locked)

| # | Decision | Verdict |
|---|----------|---------|
| 1 | **Kairo becomes a Regular macOS app** — Dock icon + Dock right-click menu + keep the menu-bar item. Window opens on demand; tutoring behavior identical (quiet by default). | ✅ Build |
| 5 | **OAuth focus-return**: Regular app (#1) is expected to fix it as a side effect. Separate debug task **only if still flaky** after #1. | ✅ Contingent |
| 6 | **Notch progress**: 4 accent-tinted **dots** (no text — notch is tiny), rendered in the notch chrome **above the caption**, one dot per "chapter". Single source of truth (no competing top-breadcrumb on windowed acts). | ✅ Build |
| 10 | **Split hero** as a new **Act 0**: static left (brand + one line + one CTA + legal), motion right (looping curated GIF), serif value line, blurred/zoomed backdrop. **CTA = "Get started", NOT login.** Lighter than Wispr's 4-slide carousel — one strong line + one demo, then rush into the real practice. | ✅ Build |
| 3 | **Focus-grab hard at Act 0/1** — front the app on first-run. **No blanket "hide others"** (Act 3 needs System Settings visible). | ✅ Build |
| 4 | **Mic visualizer** in Act 2 — source a good OSS component, don't hand-roll. Level stream already exists (`cursor:level`). | ✅ Build |
| — | **Hero → color transition**: click "Get started" → the hero card smoothly morphs into a **redesigned** color selector, with a sound effect. On color-confirm ("cool button copy") → sound → the windowless tutorial begins. | ✅ Build |
| — | **Hero → windowless transition**: when we leave the windowed acts for the real desktop, **collapse the whole window into the Kairo pet/cursor** as a signature "it's real" moment. | ✅ Build |
| 2 | Login stays **late** (Act 5, after the "whoa"). | ✅ Keep |
| 7 | Permissions stay **progressive / just-in-time** (not batched upfront). | ✅ Keep |
| 8 | Teaching beats stay **windowless** (real desktop, pet, chord). | ✅ Keep |
| 9 | **No music.** | ✅ Drop |
| — | **No press logos** on the hero (we have none yet). **No login on the hero.** | ✅ Drop |

**Explicitly NOT in scope for this plan** (future work the Regular-app shell merely *unblocks*): the
actual settings / account / usage / billing / paywall UI content. This plan delivers the *shell* (Regular
app + Dock + the `main` window opening as "home"); the pages inside it are a later effort.

---

## 2. Phased build order

Keystone first — #1 unblocks the home window **and** is expected to fix #5.

| Phase | Item | Depends on | Parallelizable? |
|-------|------|-----------|-----------------|
| **A** | Regular app (Dock + menu bar + home window + kill the policy flip-flop) | — | — |
| **B** | OAuth focus re-test → debug only if needed | A | — |
| **C** | Split hero (Act 0) + hero→color morph + color redesign + window→pet collapse | A | GIF assets produced by founder in parallel |
| **D** | Notch progress dots (4 chapters, accent-tinted) | — (but easiest after C's act renumber) | Yes |
| **E** | Focus-grab hard at Act 0 | A | Yes |
| **F** | Mic visualizer (Act 2) | — | Yes |
| **G** | Code-quality cleanup of `src/onboarding/` | C, D done | Last |

Each phase = its own small, revertible commits (per `AGENTS.md` commit discipline). Rebuild + manual
onboarding walk after every phase (reset script in `AGENTS.md`).

---

## Phase A — Kairo becomes a Regular app

### A.1 Goal
Move off `Accessory`. Kairo gets a Dock icon, an app menu, appears in ⌘-Tab — a first-class Mac app that
**still feels quiet** (windows closed by default; the notch is the ambient tool). The Dock icon is the
re-entry point to a real "home" window (the existing `main` window).

### A.2 The two policies (precise distinction)
- **`Accessory`** (today, `lib.rs:692`): no Dock icon, no app menu bar, absent from ⌘-Tab. Pure agent.
- **`Regular`** (target): Dock icon + app menu + ⌘-Tab present. Can still keep every window closed.

`LSUIElement` is **not** set in `Info.plist`/`tauri.conf.json` (verified) — the policy is entirely
code-driven, so this is a code change only.

### A.3 Current state (files)
- `src-tauri/src/lib.rs:681-695` — the flip-flop: `Accessory` on normal launch, `Regular` only for
  setup/onboarding.
- `src-tauri/src/lib.rs:711-726` — first-run: `show_onboarding_window` + `activate_frontmost` ×2.
- `src-tauri/src/lib.rs:459-462` — comment: "runs as `Accessory`… only always-visible affordance is the
  menu bar." Needs rewrite.
- `src-tauri/src/lib.rs:524-567` — `create_menu_bar_tray` (keep; extend copy).
- `src-tauri/src/onboarding.rs:100, 209, 228` — the per-act `Regular`/`Accessory` flips during onboarding.
- `tauri.conf.json:16-25` — `main` window: 1180×820, `visible:false`. This is the home window.

### A.4 Target behavior
- **Always `Regular`.** Delete the `if !show_setup && !need_onboarding { set … Accessory }` branch
  (`lib.rs:691-693`) and the per-act flips in `onboarding.rs` (100/209/228). The app is Regular from
  launch to quit. Simpler code, and it's the mechanism that makes OAuth focus reliable.
- **Left-click Dock icon** (app running, no window) → open/show the `main` window. macOS fires the
  "reopen" event; handle it via Tauri's `RunEvent::Reopen { has_visible_windows }` (or the tray/dock
  handler) → `main.show()+set_focus()`.
- **Right-click Dock icon** → a **Dock menu** with the "bunch of options" the founder wants (e.g.
  *Open Kairo* / *Show Notch* / *Replay intro* / *Quit*). See A.6 — this needs `applicationDockMenu:`.
- **Menu-bar item stays** (`create_menu_bar_tray`) → quick status + Quit. Dock **and** menu bar, both.
- **Red close button** on `main` → hides the window, app keeps running (default Mac behavior; ensure we
  don't `tauri::Exit` on last-window-close). **⌘Q** → real quit.
- **App menu** (new, because Regular apps show one): minimal — About Kairo / Settings… / Hide / Quit.
  Tauri default menu is acceptable for v1; customize copy later.

### A.5 Home window = the existing `main` window
`App.tsx` is today the setup/permissions dashboard. Repurpose it as the Regular-app **home**: for now it
can keep showing setup/status; the account/billing/settings content lands later (out of scope). The Dock
icon and its menu just `show()` this window. No new window is created.

### A.6 The Dock right-click menu (implementation note / unknown to resolve)
macOS shows a Dock context menu from `NSApplicationDelegate applicationDockMenu:`. Tauri does **not**
expose this directly. Options, in order of preference:
1. **objc2 delegate hook** — set the app's dock menu via `NSApplication` (mirrors how `activate_frontmost`
   already reaches into `objc2_app_kit`). Build an `NSMenu` with the items and return it from
   `applicationDockMenu:`. Cleanest match to the founder's ask.
2. **Fallback** — if wiring the delegate is costly, rely on left-click-opens-home + the existing menu-bar
   menu for the option list, and revisit the Dock menu later. **Left-click-to-open is the must-have; the
   Dock right-click menu is the nice-to-have.**

Reuse the item IDs/handlers already in `create_menu_bar_tray` (`tray_show_notch`, `tray_replay_intro`,
`tray_quit`) so both menus share one handler.

### A.7 ⚠️ The critical gotcha (why Accessory was chosen originally)
`lib.rs:681-688` explains the original reason for `Accessory`: a `Regular` app, when **launched**, makes
macOS **yank the user off any full-screen Space onto the desktop**. Going always-Regular reintroduces this.

Why it's acceptable:
- It only happens on a **cold launch**. Kairo runs persistently (login item / already-open); normal notch
  usage does **not** relaunch the process, so there's no repeated Space-yank during daily use.
- On **first run** we *want* to grab focus (that's Phase E). So the yank is desirable there.
- All three competitors are Regular and live with this.

Mitigation to verify: confirm that after onboarding, day-to-day ⌥⌃ usage (notch show/hide) does **not**
trigger a Space switch (it shouldn't — the notch is a non-activating `NSPanel` and the process is already
running). **This must be manually verified on a full-screen Space before Phase A is called done.**

### A.8 Verification (Phase A)
- Dock icon appears; app in ⌘-Tab; app menu present.
- Left-click Dock (no window) → `main` opens.
- Right-click Dock → option menu (or fallback documented).
- Red-close `main` → app stays alive (menu-bar + Dock still there); ⌘Q quits.
- On a full-screen Space: launching front-fronts Kairo (first run); **subsequent notch usage does not
  switch Spaces**.
- `codesign --verify --deep --strict` still passes; no new entitlements/Info.plist keys needed.

---

## Phase B — OAuth focus-return (contingent on A)

### B.1 Hypothesis
Competitors nail focus-return every time because they're Regular apps: LaunchServices fronts a Regular
URL-scheme handler the normal, reliable way. Kairo's flakiness comes from being `Accessory` + doing
activation gymnastics (`focus_onboarding_window`, `onboarding.rs:92-118`) that race on Sonoma's
cooperative-activation policy. **Phase A likely dissolves this.**

### B.2 Procedure
1. After Phase A ships, run the OAuth sign-in **several times** (Act 5) and confirm Kairo reliably fronts
   over the browser.
2. If solid → #5 is **done**, no code. Simplify `focus_onboarding_window` to a plain `show()+set_focus()`
   now that the app is Regular (the objc2 `activate()` dance may be redundant — verify before deleting).
3. **If still flaky** → open a dedicated debug task (systematic-debugging, don't guess):
   - Instrument `on_open_url` (`lib.rs:819`): log that it fired at all (rules out "deep link never
     arrived" — a distinct third bug).
   - Log `NSApp.isActive()` right after activate, and again ~500ms later (distinguishes "never took" from
     "took then bounced").
   - Reproduce 2–3 real failures, read the logs, then fix the *actual* failure mode:
     - "never took" → call activate **synchronously** in the handler (drop the `run_on_main_thread`
       queueing when already on main) + a second activate ~300ms later.
     - "took then bounced" → the act-advance after `exchange_code` (`Act5SignIn` → `advance`) is
       hiding/reshowing the window; stop it from reordering focus.

### B.3 Verification
10 consecutive OAuth round-trips all return focus to Kairo. Log shows `on_open_url` fired each time.

---

## Phase C — Split hero (Act 0) + color morph + window→pet collapse

The single biggest UX lift. Four sub-parts: the hero screen, the hero→color morph, the color redesign,
and the window→pet collapse into the windowless flow.

### C.1 Act renumber
Add `HERO` as the new first act. `src/onboarding/OnboardingApp.tsx:18-27`:

```
ACT = { HERO:0, ARRIVAL:1, HEARING:2, PERMISSIONS:3, PRACTICE:4, SIGNIN:5, SOURCE:6, ENDING:7 }
ACT_COUNT = 8
INTERACTIVE = [true, true, false, false, false, true, true, false]  // HERO + ARRIVAL(color) + SIGNIN + SOURCE catch clicks
```
Update the resume markers (`get_onboarding_step` handling at `OnboardingApp.tsx:72-81`) so a mid-flow
relaunch still lands correctly (HERO is skipped on resume — it's a first-impression-only act).

### C.2 The hero layout (Act 0) — spec
Adopt the competitor split, **lighter** (option b). Windowed (uses the interactive orchestrator + a
centered/full card). Reuse the design system: **Editorial Light**, warm-white, violet accent,
**Instrument Serif** for the display line + **Geist** for body (per the landing design-system memory).

```
┌──────────────────────────────┬───────────────────────────────┐
│  LEFT (static, ~42%)         │  RIGHT (motion, ~58%)         │
│                              │                               │
│  ◆ Kairo            (logo)   │   ┌─ serif value line ──┐     │
│                              │   │ "Points right at     │     │
│  Meet Kairo         (H1)     │   │  what you need."     │     │
│  Your screen-native tutor.   │   └──────────────────────┘     │
│  (subhead, Geist)            │                               │
│                              │   [ looping curated GIF of     │
│  ┌────────────────────────┐  │     the pet pointing/circling  │
│  │  Get started        →  │  │     on a real screen ]         │
│  └────────────────────────┘  │                               │
│                              │   • blurred + zoomed backdrop  │
│  By continuing you agree…    │     behind a crisp UI mockup   │
│  (legal, tiny)               │                               │
└──────────────────────────────┴───────────────────────────────┘
```
- **Left is static** (unlike Wispr's identical-across-slides left, ours simply doesn't rotate).
- **Right is one looping GIF**, not a 4-slide carousel — on-thesis (we prove value by *doing* seconds
  later, not by a sizzle reel). If we later want 2–3 rotating value props, the structure allows it, but v1
  ships one.
- **Serif value line** overlaid on the demo (Wispr pattern): e.g. *"Points right at what you need."*
- **Blur + zoom + depth**: blurred, slightly-scaled backdrop behind a sharp floating mockup — the premium
  look the founder liked. CSS `filter: blur()` + `transform: scale()` on a bg layer.
- **CTA copy** — "cool text in buttons" per founder. Candidates: **"Get started →"**, "Let's go →".
  (Final copy TBD; put it in `copy.ts`.)
- **No login, no press logos.**
- **Asset dependency:** the right-side GIF is produced by the founder later. Until then, ship a tasteful
  placeholder (static frame or the existing pet animation) behind a feature flag so the layout is testable.

### C.3 Hero → color morph
On "Get started" click:
- The hero card **morphs** smoothly into the color selector (not a hard cut). Implementation: shared
  container with a layout/crossfade transition (Framer Motion `layout` or a CSS transform/opacity
  choreography). Left panel recedes / the demo panel gives way to the wheel.
- **Sound effect** on the click (this click is a user gesture → it unlocks the shared `AudioContext`, so
  the cue reliably plays — see the audio-unlock gotcha in §4). Add a new cue to `src/core/sound.ts`
  (`SoundName` union) with a subtle "whoosh/confirm".

### C.4 Color selector redesign
Current: `acts/Act1Arrival.tsx` (wake line → wheel) + `acts/ColorWheel.tsx` (`@uiw/react-color` wheel +
shade slider) inside `TempPanel`. Make it **cooler + nicer**:
- Larger, more tactile wheel; live full-surface theming preview (the accent already broadcasts via
  `accent:changed` → pet glow, notch caption recolor in real time — keep that, make the preview more
  visible, e.g. a live sample of the notch/pet using the picked hue).
- Better confirm CTA copy — founder wants "Let's get started" or similar (currently "That's the one",
  `Act1Arrival.tsx:80`). Put in `copy.ts`.
- On confirm: `clampAccent` (keep the legibility clamp, `Act1Arrival.tsx:55`) → persist (`set_accent`) →
  **sound effect** → begin the windowless flow via the collapse (C.5).
- Keep the existing sync discipline (wheel/caption/voice land together; live recolor without a file write
  per move).

### C.5 Window → pet collapse (the "it's real" moment)
When leaving the windowed acts (after color confirm) for the windowless teaching, **collapse the entire
onboarding card into the Kairo pet/cursor**:
- Animate the card shrinking/imploding toward the pet's on-screen position (the companion cursor lives in
  its own `#/cursor` panel; get its point or use a target near the notch).
- As the card collapses, the orchestrator window goes click-through/transparent (it already becomes
  click-through for non-interactive acts, `OnboardingApp.tsx:63-67`) and the pet "catches" the collapse
  (a `cursor:celebrate`/entrance-style beat).
- Net effect: the beautiful window *becomes* the pet, then the user is on their real desktop. This is the
  bridge from windowed → windowless. Design it deliberately — abrupt = jarring; choreographed = magic.
- Sound: a soft settle cue as the pet lands.

### C.6 Verification (Phase C)
- Fresh run (reset script) → hero shows first, before color.
- "Get started" → smooth morph → color wheel; cue plays.
- Pick + confirm → cue → card collapses into the pet → Act 2 (mic) begins on the real desktop.
- Resume after a mid-flow relaunch does **not** replay the hero.
- Placeholder GIF renders; swapping in the real GIF is a one-file change.

---

## Phase D — Notch progress dots (4 chapters, accent-tinted)

### D.1 Chapter model
8 acts → 4 chapters (option b, no text). Map act → chapter:

| Dot | Chapter | Acts |
|-----|---------|------|
| 1 | Welcome | HERO(0), ARRIVAL/color(1) |
| 2 | Set up | HEARING(2), PERMISSIONS(3) |
| 3 | Try it | PRACTICE(4) |
| 4 | Wrap up | SIGNIN(5), SOURCE(6), ENDING(7) |

`actToChapter = [0,0,1,1,2,3,3,3]` (index = act). (Chapter *names* are internal only — dots show no text.)

### D.2 Where they live
The **notch is the one surface present in every act** (caption pushed via `coachSurface.ts`; rendered by
`NotchApp`/`NotchCapsule`). Dots render in the **notch chrome, above the caption**, as their own
persistent element — **not** hung off the caption (the caption is *cleared between acts* via
`coachSurface.clear()`; dots must survive that).

### D.3 Data flow
- `OnboardingApp` emits `onboarding:progress { chapter, total }` whenever `actIndex` changes (derive
  `chapter = actToChapter[actIndex]`). Emit `total:4`.
- `NotchApp` listens for `onboarding:progress`, stores `{chapter,total}` in state, renders a dots row in
  the capsule chrome. On `finish_onboarding` (or a `onboarding:progress {chapter:-1}` sentinel), clear it
  so the dots never show during normal product use.
- **Accent tint for free:** the notch already threads `--kairo-accent` via `useNotchAccent` and live
  `accent:changed`. Dots use `var(--kairo-accent)` for the filled state → they start default violet
  (`#7c3aed`) and **re-tint the instant the user picks a color in Act 1**. Zero extra wiring — the
  personalization is a side effect of the existing accent bus.
- Style: filled dot = accent, past dots = accent at lower opacity, future dots = faint neutral. Subtle,
  matching the "accent-threaded, Raycast+Arc, no glass" notch language.

### D.4 Verification
- Dots appear from Act 0; correct dot lights per chapter; dots are neutral→violet before the pick, then
  adopt the chosen hue live.
- Dots survive caption clears between acts (don't blink out).
- Dots vanish once onboarding finishes; never appear in normal notch turns.

---

## Phase E — Focus-grab hard at Act 0

### E.1 Goal
First run opens **in front** of everything (competitor parity), so the hero has undivided attention.

### E.2 Detail
- Reuse `activate_frontmost` (`lib.rs:467-488`) — already called twice at first-run (`lib.rs:719-724`).
  With the app now Regular (Phase A), activation is reliable; keep the double-activate (launch-time
  activation is finicky until the runloop is up).
- **No blanket "hide others".** Do **not** call `hideOtherApplications:`. Act 3 (permissions) needs System
  Settings visible while the pet points at the real toggle — hiding others would break that beat. Focus =
  "come to front," not "minimize the world."

### E.3 Verification
Cold first-run with other apps open → Kairo hero is frontmost. Act 3 still shows System Settings
alongside the pet.

---

## Phase F — Mic visualizer (Act 2)

### F.1 Goal
Add the animated input-level meter competitors show — bars/waveform reacting to the user's voice. Builds
trust + doubles as a mic-permission/works check. Founder: **source an existing OSS component, don't
hand-roll.**

### F.2 Plumbing already exists
`audio.rs:239` emits `cursor:level { level }` (0..1) during capture; `NotchApp` already consumes it into
`--mic-level` (`NotchApp.tsx:1122-1131`). So the level stream is live — Phase F is mostly picking a
component and wiring the same event into Act 2's surface.

### F.3 Component sourcing (at build time)
Look for a lightweight, dependency-light React/canvas mic-level visualizer (react-audio-visualize,
wavesurfer, or a small canvas bars component). Constraints: MIT-ish license, works with a **numeric level
input** (we already have `cursor:level` — we don't need it to grab the mic itself; feed it our value), no
heavy deps, styleable to the accent. If nothing fits cleanly, a ~40-line canvas bars component driven by
`--mic-level` is the fallback.

### F.4 Placement
Act 2 (`acts/Act2Hearing.tsx`) is notch+chord driven today. The visualizer can render **in the notch**
(consistent with windowless) or as a small floating element near the notch during the "say hi" drill —
whichever reads better; prefer the notch. Must **duck to silence** when not recording.

### F.5 Verification
Speaking during Act 2 animates the meter proportionally to volume; silence → flat. Accent-tinted.

---

## Phase G — Code-quality cleanup (`src/onboarding/`)

Founder flagged ~100 commits → likely mess. Separate, **no-behavior-change** commits, done last. Concrete
targets already spotted:

- **Naming drift** — files `Act5SignIn`/`Act5Source` map to ACT indices 4/5 (now 5/6 after the hero add),
  and comments say "Act 5" for two different acts. Rename act components to match their real ordinal (or
  to stable names: `SignInAct`, `SourceAct`, `EndingAct`) and fix the stale comments.
- **Dead code** — `acts/TempPanel.tsx` ("Temp" scaffold) — inline or delete if it's just a wrapper;
  `acts/actTypes.ts` / `act3SubStep.ts` — confirm still used.
- **Inconsistent placement** — `Act3Permissions.tsx` sits in `onboarding/` root while every other act is
  in `onboarding/acts/`. Move it into `acts/`.
- **Shrink `OnboardingFlow.tsx`** — it self-describes as "legacy STEPS wizard, now just point + circle"
  yet carries full wizard machinery (`index`/`go`/`STEPS`) for 2 beats. Reduce to a 2-beat driver.
- **Dedupe resume logic** — both `OnboardingApp` and `OnboardingFlow` independently call
  `get_onboarding_step` (`OnboardingApp.tsx:72`, `OnboardingFlow.tsx:48`). One owner.
- Re-run `npm run typecheck && npm run test && cargo check` after each cleanup commit; behavior identical.

---

## 3. Cross-cutting: data-flow additions summary

| New event / command | Emitter | Consumer | Purpose |
|---------------------|---------|----------|---------|
| `onboarding:progress { chapter, total }` | `OnboardingApp` | `NotchApp` | drive the dots |
| new `SoundName`s (morph, confirm, collapse) | onboarding acts | `sound.ts` | transition cues |
| (reuse) `cursor:level` | `audio.rs:239` | Act 2 visualizer | mic meter |
| (reuse) `accent:changed` | color wheel | notch dots | live re-tint |
| Dock reopen → `main.show()` | `RunEvent::Reopen` | `main` window | home entry |

---

## 4. Risks & gotchas (read before building)

1. **Regular-app Space-yank on cold launch** (§A.7) — the original reason for `Accessory`. Acceptable
   (cold-launch only; competitors do it), but **must verify** daily notch use doesn't switch Spaces.
2. **Audio unlock** — `sound.ts` shares one `AudioContext` unlocked by the first TTS/PTT **gesture**. The
   hero is the very first screen, *before* any such gesture. So a cue on the *auto* hero-in animation may
   not play. **Tie the first cue to the "Get started" click** (a user gesture → unlocks the context);
   cues after that are fine. Don't rely on a sound before the first click.
2b. **Onboarding voice** — Act 0's hero, if it speaks, faces the same unlock: keep the hero silent (visual
   only) until the first click, or gate any voice behind the click. The existing acts already unlock audio
   via their play gestures.
3. **Notch is capture-excluded** (`NSWindowSharingNone`) — good: dots + mic meter in the notch won't
   pollute the vision screenshots during practice beats. Keep them *in* the notch for this reason.
4. **Dock right-click menu** (§A.6) is the one genuinely-new native surface (needs `applicationDockMenu:`
   via objc2). Treat as nice-to-have; don't let it block Phase A. Left-click-opens-home is the must-have.
5. **Resume markers** — adding HERO shifts act indices; the Screen-Recording quit+reopen resume
   (`OnboardingApp.tsx:69-81`) must still land on the right act. HERO must be skipped on resume.
6. **Don't regress the windowless thesis** — the hero and color are the *only* new windowed surface; Acts
   2/3/4 stay on the real desktop. The window→pet collapse is the seam; get it right so windowed→windowless
   feels like magic, not a context switch.

---

## 5. Test / verification plan (per `AGENTS.md`)

Before any phase is "done":
```bash
npm run typecheck
npm run test
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:build -- --bundles app          # the real target
codesign --verify --deep --strict "…/Kairo Tutor.app"
```
Then a **full onboarding walk** via the reset script in `AGENTS.md` (`tccutil reset …` + delete markers),
backend running (`npm run server:dev`), watching `~/Library/Logs/Kairo/kairo-latest.log`. Verify:
- Dock icon / ⌘-Tab / app menu / left-click-home / red-close-stays-alive / ⌘Q-quits.
- Full-screen-Space: first launch fronts; daily notch use doesn't switch Spaces.
- Hero → morph → color → collapse → windowless flow, all cues firing.
- Dots: correct chapter, neutral→accent re-tint, cleared after finish.
- OAuth: 10 sign-ins all return focus.
- Mic meter reacts to voice in Act 2.

---

## 6. Resolved (founder sign-off 2026-07-23)

1. **Chapter names** ✅ — internal only (dots show no text): **Welcome / Set up / Try it / Wrap up**.
2. **Hero copy** ✅ — locked to the doc's draft: H1 **"Meet Kairo"**, subhead **"Your screen-native
   tutor."**, serif value line **"Points right at what you need."**, CTA **"Get started →"**. (Founder can
   still tweak wording in `copy.ts` at build; strings live there, not hard-coded.)
3. **Confirm-button copy** (color step) ✅ — **"Let's get started"**.
4. **GIF asset** ✅ — founder produces later; **ship a placeholder now, wire the real GIF in as a one-file
   change** when delivered.

---

## 7. What we are deliberately NOT doing (guardrails against scope creep)

- No login on the hero / no login-first. Login stays Act 5.
- No music.
- No press logos.
- No batched-upfront permissions.
- No windowed teaching acts — Acts 2/3/4 stay windowless.
- No 4-slide auto-carousel on the hero (one demo, ship fast).
- No new settings/billing/account UI *content* in this plan (Regular shell only; content is later work).
```