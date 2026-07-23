# Phase G — Onboarding Code Cleanup

> **Status:** Ready to build — runs **LAST** (after Phases A–F land). **Strictly no behavior change.**
> **Parent spec:** [`2026-07-23-onboarding-ux-v2.md`](./2026-07-23-onboarding-ux-v2.md) → Phase G (§ "Phase G — Code-quality cleanup").
> **Goal (one line):** de-mess `src/onboarding/` after ~100 feature commits — pure rename / move / dedupe / delete-dead passes, each its own bisectable commit, with `npm run typecheck && npm run test && cargo check` staying green and the onboarding walk byte-for-byte identical.

---

## Goal

The onboarding tree grew organically across the "out-of-the-card" build (~100 commits). Reading the whole
tree surfaced real, confirmable rot: dead modules kept alive only by their own test, dead exports with
zero call sites, half a hook that nothing consumes, ordinal file names that already don't match the act
indices (and will match even less after Phase C's renumber), one act living in the wrong folder, and a
"legacy STEPS wizard" carrying full machinery to drive two beats.

Phase G fixes **only** those — no feature work, no logic change. Every commit is a mechanical transform
whose correctness is proven by the three green checks plus an unchanged first-run walk. It runs last so it
operates on the **final** file set (Phase C adds `HeroAct`, renumbers acts; Phase F may touch Act 2), and
so it never fights an in-flight feature branch.

**Logging:** no `klog!`/`klog()` call is added or removed except the two confirmed **dead** ones (an unused
import; nothing that ever executes). All live log lines + tags are preserved verbatim.

---

## Findings

Every row below was confirmed by reading the file + `grep` across `src/`, `tests/`, `scripts/`. "Confirmed"
= verified with a call-site search; the one intent-judgment call is marked.

| # | File · line(s) | Issue (confirmed) | Fix |
|---|----------------|-------------------|-----|
| F1 | `OnboardingApp.tsx:5` | `import { klog } from '../core/logger'` — **never used** (`grep klog OnboardingApp.tsx` → only the import line). | Delete the import. |
| F2 | `acts/Act5SignIn.tsx:82` | `export type Act5SignInProps = …` — **zero importers** repo-wide. Dead export. | Delete the type (and its explanatory comment lines 80–81). |
| F3 | `backendClient.ts:22-33` `onboardingStt`, `:36-49` `extractField` | **Zero call sites** anywhere in repo (the STT/name-extract onboarding step was removed; name now comes from Google sign-in). Dead exports. | Delete both functions. |
| F4 | `color.ts` (whole file) + `tests/onboarding-color.test.ts` | `hsvToHex`/`hexToHsv` are imported **only** by their own test. Production `ColorWheel.tsx:4` uses `@uiw/color-convert` (`hsvaToHex`/`hexToHsva`), not this module. Dead product code kept green by a test of nothing shipped. | Delete `src/onboarding/color.ts` **and** `tests/onboarding-color.test.ts` in one commit (drops a test of unused code; app behavior unchanged). |
| F5 | `useVoice.ts` recording half — VAD consts `:18-21`; refs `streamRef/recRef/chunksRef/ctxRef/rafRef/onEndRef/endedRef` `:33-39`; `teardown` `:121`, `stopInternal` `:131`, `startListening` `:147`, `stopListening` `:207`; imports `acquireMicrophoneStream/createVoiceRecorder/rmsFromTimeDomainData` `:4-8`; state `isListening/level` `:24-26`; the unmount `teardown()` `:209-215` | **Nothing consumes** `voice.startListening/stopListening/isListening/level` (`grep` → only the definitions). Onboarding records via the **native ⌥⌃ PTT** path (`onboarding:audio` events), not this browser `MediaRecorder`. Only `speak`/`stop` (+ the audio-unlock effect) are live. | Remove the entire recording apparatus + its imports + VAD consts + `isListening`/`level` state; keep `speak`, `stop`, the `playUrl`/unlock logic, and the unmount `audioRef.current?.pause()`. Return only `{ speak, stop }` (drop `isSpeaking` too — also unconsumed). |
| F6 | `copy.ts:5-12` `StepId` union | Members `'name' \| 'signin' \| 'source' \| 'permissions' \| 'done'` never appear in a `StepDef`/`STEPS` (only `learn_point`/`circle` do) and have no other use. Dead union members. | Trim `StepId` to `'learn_point' \| 'circle'`. |
| F7 | `Act3Permissions.tsx` (in `onboarding/` root); `act3SubStep.ts` (root) | **Placement inconsistency** — every other act is in `onboarding/acts/`; Act 3 + its helper sit in root. Both are live (`Act3Permissions` mounted by `OnboardingApp:99`; `nextPermissionStep`/`Act3SubStep` used by Act3Permissions). | Move both into `acts/`. Update: OnboardingApp import `./Act3Permissions`→`./acts/Act3Permissions`; inside Act3Permissions `./useCoach`→`../useCoach`, `./copy`→`../copy`, `../core/logger`→`../../core/logger`, `./acts/actTypes`→`./actTypes`, `./act3SubStep`→`./act3SubStep` (unchanged after both move); inside act3SubStep `../native/nativeBridge`→`../../native/nativeBridge`. |
| F8 | `acts/Act5SignIn.tsx`, `acts/Act5Source.tsx` (+ doc comments "Act 5a"/"Act 5b") | **Naming drift** — two different acts both prefixed `Act5`. Ordinal-based file names already mismatch act indices and will drift further after Phase C's renumber (`SIGNIN` 4→5, `SOURCE` 5→6, `ENDING` 6→7). | Rename act components to **stable, ordinal-free concept names**: `Act1Arrival→ArrivalAct`, `Act2Hearing→HearingAct`, `Act3Permissions→PermissionsAct`, `Act5SignIn→SignInAct`, `Act5Source→SourceAct`, `Act6Ending→EndingAct` (and Phase C's `Act0Hero→HeroAct`). One rename per commit; update file name, exported fn name, `OnboardingApp` imports, and self-comments. |
| F9 | `acts/TempPanel.tsx` | **Not dead** — used 3× (Act1Arrival, Act5SignIn, Act5Source), a thin scrim+panel wrapper. But mis-named ("Temp" implies scaffold; it's the permanent floating-panel shell) and its comment (`:4`) references class `.ob-temp-panel` that **no longer exists** (`grep` → only this comment). | Keep the component (shared, real). Rename `TempPanel`→`FloatingPanel` (file + importers) and delete the stale `.ob-temp-panel` mention. |
| F10 | `OnboardingApp.tsx:72-81` **and** `OnboardingFlow.tsx:48-55` | **Duplicated resume read** — both independently `invoke('get_onboarding_step')`. OnboardingApp uses it to pick the macro act; OnboardingFlow uses it to pick the practice beat. | Make OnboardingApp the **single reader**: it already resolves the marker; have it pass the resolved beat down to the practice component as a prop. Remove OnboardingFlow's own `get_onboarding_step` read. (OnboardingFlow keeps its `set_onboarding_step` **write** — that's not the duplicated read.) |
| F11 | `OnboardingFlow.tsx` (whole) — `index`/`setIndex` `:32`, `go` `:43-45`, `STEPS[index]` `:33`, resume `:48-55`, persist `:57-60` | Self-describes as "legacy STEPS wizard, now just point + circle" (`:13`) yet carries full N-step wizard machinery to run **2** beats. | After F10 removes the duplicate read, shrink to a **2-beat driver**: drive the two `STEPS` entries with a minimal beat index (no `go(delta)` clamp gymnastics), seeded by the prop from F10. Behavior identical (beat 0 → on success beat 1 → on success `onComplete()`; miss → retry). |
| F12 | `onboarding.css` imported at `OnboardingFlow.tsx:11` | **Import placement smell** — the CSS styles `.ob-orchestrator` (owned by OnboardingApp) + the Act1/Act5 panels, but is imported by OnboardingFlow, which **renders `null` and uses none of these classes**. Works only because OnboardingFlow is statically in the bundle. | Move `import './onboarding.css'` to `OnboardingApp.tsx` (the always-mounted root that owns `.ob-orchestrator`). Global-CSS side effect is identical. |
| F13 | Stale ordinal comments: `OnboardingApp.tsx:30,44`; `OnboardingFlow.tsx:13,113`; `copy.ts:28-29,151,160,165,176,180`; `onboarding.css:1-2,37,164`; `acts/actTypes.ts:2`; `demoController.ts:81` (`// learn_talk:` — a `StepId` that never existed) | Comments say "Act 4/5/6", "Acts 1-4", "Act 5a/5b" — already loose, **wrong after Phase C's renumber**. | Doc-only sweep: update to the stable names (F8) / correct final ordinals; fix `learn_talk`→`runTalkTurn`. |
| F14 | `copy.ts:66-95` `ACT_LINES.act2_primer` / `act2_im` / `act2_im_skip` + `audio/act2_primer.wav`, `audio/act2_im.wav`, `audio/act2_im_skip.wav` | **Confirmed unreferenced** — no act speaks them (`grep ACT_LINES.` → only `act1_wake/act1_color/act2_mic/act2_drill/act2_short/act2_empty`). Leftovers from the retired Input-Monitoring primer. Their wavs are bundled but never played (`useVoice` globs all wavs but only cached keys that are spoken are used). **Intent caveat:** the *code* is dead-confirmed, but whether the founder wants them retained for the Phase F Act-2 work is an intent call — hence this is the last, flagged commit. | (Optional, last) Delete the 3 `ACT_LINES` entries + the 3 wavs. `CACHED_LINES` (copy.ts:172) recomputes from `ACT_LINES`, so `scripts/gen-onboarding-audio.ts` stops regenerating them automatically — consistent. Rebuild + `codesign` after (touches bundle). |

**Nothing was left "unverified"** except the single flagged *intent* judgment in F14 (the code is confirmed
dead; keep-vs-delete is the founder's call). Explicitly **cleared as NOT-dead** (so we don't wrongly cut
them): `TempPanel` (F9, used 3×), `actTypes.ts`/`ActProps` (used 4×), `act3SubStep.ts` (used by Act 3),
`ColorWheel.tsx` (used by Act 1), all `demoController` exports, and every `authClient`/`backendClient`
function except F3's two.

---

## Refactor plan

One item per commit. Ordered safest/most-isolated → most structural, so a bisect lands on the smallest
possible change. Each leaves the three checks green and behavior identical.

1. **Drop unused symbols** — remove `klog` import (`OnboardingApp.tsx:5`, F1) and the `Act5SignInProps`
   type + its 2 comment lines (`acts/Act5SignIn.tsx:80-82`, F2). Imports touched: none beyond the deleted
   lines.
2. **Delete dead backend client fns** — remove `onboardingStt` and `extractField` (`backendClient.ts`, F3).
   No importers, so no other file changes.
3. **Delete dead `color.ts` module** — remove `src/onboarding/color.ts` **and** `tests/onboarding-color.test.ts`
   together (F4). No production importer; the only importer was the deleted test.
4. **Trim dead `StepId` members** (`copy.ts:5-12`, F6) → `type StepId = 'learn_point' | 'circle'`. Consumers
   (`STEPS`, `DEMO_MODE` in OnboardingFlow) already only use those two; typecheck confirms.
5. **Strip `useVoice` recording half** (F5) — delete the VAD consts, recording refs, `teardown`,
   `stopInternal`, `startListening`, `stopListening`, `isListening`/`level` state, the `voiceRecorder`
   imports, and the recording-teardown in the unmount effect (keep `audioRef.current?.pause()`). Return
   `{ speak, stop }`. Consumers destructure only `voice.speak`(internally)/`voice.stop` — unaffected.
6. **Move `onboarding.css` import** from `OnboardingFlow.tsx:11` → top of `OnboardingApp.tsx` (F12). Pure
   relocation of a side-effect import.
7. **Co-locate Act 3** (F7) — `git mv` `Act3Permissions.tsx` and `act3SubStep.ts` into `acts/`. Fix the
   relative imports listed in F7, and OnboardingApp's `./Act3Permissions`→`./acts/Act3Permissions`.
8. **Rename act components to stable names** (F8) — one commit **per** rename, in this order so the two
   ambiguous `Act5*` files go first:
   - 8a `Act5SignIn.tsx`→`SignInAct.tsx` (`Act5SignIn`→`SignInAct`; update `OnboardingApp` import + JSX).
   - 8b `Act5Source.tsx`→`SourceAct.tsx` (`Act5Source`→`SourceAct`).
   - 8c `Act6Ending.tsx`→`EndingAct.tsx` (`Act6Ending`→`EndingAct`).
   - 8d `Act1Arrival.tsx`→`ArrivalAct.tsx`; 8e `Act2Hearing.tsx`→`HearingAct.tsx`; 8f
     `Act3Permissions.tsx`→`PermissionsAct.tsx` (full-consistency renames; each updates its `OnboardingApp`
     import + exported fn + self-comment). Each uses `git mv` so history follows the file.
9. **Rename `TempPanel`→`FloatingPanel`** (F9) — `git mv acts/TempPanel.tsx acts/FloatingPanel.tsx`, rename
   the fn, update the 3 importers, delete the stale `.ob-temp-panel` comment.
10. **Dedupe resume read** (F10) — delete `OnboardingFlow.tsx:48-55` (its `get_onboarding_step` read); have
    `OnboardingApp` pass the resolved practice beat (already computed at `:74-81`) as a prop
    (e.g. `initialBeatId`) to the practice component. OnboardingApp stays the single reader.
11. **Shrink the practice driver** (F11) — with the prop from step 10 seeding the start beat, reduce
    OnboardingFlow's `index`/`go(delta)`/clamp machinery to a minimal 2-beat index (advance beat 0→1→done).
    Keep the `set_onboarding_step` write and all PTT/listen wiring byte-identical.
12. **Comment/ordinal sweep** (F13) — doc-only: fix the stale "Act N" references + `learn_talk` across
    `OnboardingApp`, `OnboardingFlow`, `copy.ts`, `onboarding.css`, `actTypes.ts`, `demoController.ts`.
13. **(Optional, flagged) Remove dead Act-2 primer copy + wavs** (F14) — delete the 3 `ACT_LINES` entries +
    the 3 wavs; rebuild + `codesign`. Do **only after** confirming Phase F doesn't want them; it's last so
    that decision is settled.

---

## Ordering & dependencies

**Why this phase runs last (after A–F):**

- **Phase C renumbers the acts** (`HERO:0 … ENDING:7`) and adds a new act component. Renaming files to
  match ordinals *before* C would just re-drift; the stable-name scheme in F8 is precisely the fix for
  C's renumber, and it must rename the **final** set — including C's new `HeroAct` (so it lands as
  `HeroAct.tsx`, not `Act0Hero.tsx`). Running G before C would leave `Act0Hero` inconsistent with the
  renamed peers.
- **Phase F may touch Act 2** (mic visualizer, possibly a new component + reusing the `cursor:level`
  stream). F14 (deleting the dead `act2_primer`/`act2_im`/`act2_im_skip` copy + wavs) and 8e
  (`Act2Hearing`→`HearingAct`) must run **after** F so they don't collide with F's edits and so F gets
  to decide whether it re-uses any of that retired copy.
- **Phase D** adds the notch progress dots (in `NotchApp`, outside `onboarding/`) and an
  `onboarding:progress` emit in `OnboardingApp`. G leaves that wiring untouched — but doing G after D means
  the dedupe/shrink in steps 10–11 operate on the OnboardingApp that already carries the progress emit, so
  no rebase churn.
- **Phase A** makes the app Regular and removes the per-act policy flips in `onboarding.rs` (Rust). None of
  G's TS moves depend on that, but running last means G never has to reason about a half-migrated shell.
- G touches **no `sound.ts` cues** (Phase C adds those) and **no Rust** — it is confined to `src/onboarding/`
  + the one dead test, so it can't regress A/B/D/E/F native work.

**Net:** by running last, every "is this dead?" question is answered against the shipped-final flow, and
every rename covers the complete, final component set.

---

## Verification

**After EACH commit** (mandatory, per `AGENTS.md`):

```bash
npm run typecheck
npm run test
cargo check --manifest-path src-tauri/Cargo.toml
```

All three green, and **behavior identical** — every commit is a pure rename/move/dedupe/delete-dead, so a
green typecheck + unchanged test suite is the proof for the TS-only commits (1–12). For any commit that
touches bundled assets (step 13 removes wavs) **also** run the real target + signature check:

```bash
npm run tauri:build -- --bundles app
codesign --verify --deep --strict "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```

**After the whole phase** — one full first-run walk via the reset script in `AGENTS.md` (`tccutil reset …`
+ delete markers), backend up (`npm run server:dev`), watching `~/Library/Logs/Kairo/kairo-latest.log`.
Confirm the walk is **unchanged**:

- Hero → color → hearing → permissions → practice (point + circle) → sign-in → source → ending, every
  spoken line + caption + cue as before.
- The Screen-Recording quit+reopen still **resumes onto Act 3** (F7 move + F10 dedupe must not change the
  resume landing) and never replays the intro.
- Mid-practice relaunch still resumes onto the correct beat (F10/F11 must preserve this exactly).
- Every `klog('onboarding', …)` line still appears in the log at the same points (only the dead F1 import
  is gone — it never logged).

If any check goes red or the walk differs, the offending commit reverts cleanly (that's why it's one
refactor per commit).

---

## Commit breakdown

Ordered, one refactor per commit (per `AGENTS.md`: small, revertible, on `main`). **Do not `git commit`
as part of writing this plan** — this is the build order for the implementer.

1. `chore(onboarding): drop unused klog import + Act5SignInProps dead type` (F1, F2)
2. `chore(onboarding): remove dead onboardingStt/extractField backend clients` (F3)
3. `chore(onboarding): delete dead color.ts module + its test` (F4)
4. `chore(onboarding): trim StepId union to the two live beats` (F6)
5. `refactor(onboarding): strip unused recording half of useVoice` (F5)
6. `refactor(onboarding): import onboarding.css from OnboardingApp, not OnboardingFlow` (F12)
7. `refactor(onboarding): co-locate Act3Permissions + act3SubStep under acts/` (F7)
8. `refactor(onboarding): rename Act5SignIn → SignInAct` (F8a)
9. `refactor(onboarding): rename Act5Source → SourceAct` (F8b)
10. `refactor(onboarding): rename Act6Ending → EndingAct` (F8c)
11. `refactor(onboarding): rename Act1Arrival → ArrivalAct` (F8d)
12. `refactor(onboarding): rename Act2Hearing → HearingAct` (F8e)
13. `refactor(onboarding): rename Act3Permissions → PermissionsAct` (F8f)
14. `refactor(onboarding): rename TempPanel → FloatingPanel, fix stale comment` (F9)
15. `refactor(onboarding): make OnboardingApp the sole get_onboarding_step reader` (F10)
16. `refactor(onboarding): shrink OnboardingFlow to a 2-beat driver` (F11)
17. `docs(onboarding): fix stale Act-ordinal + learn_talk comments` (F13)
18. `chore(onboarding): remove dead act2 primer copy + wavs` — **optional/last, gated on Phase F** (F14)
