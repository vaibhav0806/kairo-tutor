# Unified Turn — Follow-Along v2 (Design Delta)

Date: 2026-07-07
Branch: `main`
Status: design — supersedes the controller/state-machine model in
`2026-07-06-follow-along-guide-mode-design.md`. Keep that doc for the mechanics
(dHash, poll, settle, click emit); THIS doc changes the orchestration.

## Why

The v1 "guide" was a closed state machine (`followController` with `active`/`goal`/
`currentStep`) entered via a cheap-model `followAlong` mode flag, fed a starved
context (step labels, not the conversation). Live QA broke exactly there: a mid-guide
voice turn ("I'm on the README, what next?") was classified `followAlong=false`, the
guide was torn down, and the normal path dumped all steps at once.

Decision: **make it open + AI-driven.** No mode flag, no state machine, no `active`.
Every turn sends the rolling conversation + the screen to Fable, and Fable decides
whether to answer or to point at something to click. The "guide" is emergent.

## The unified turn

A turn is triggered by **voice** (PTT) OR a **click** on a pending target. Both run:

1. **Gate** (cheap text-only model) — sees ~6 recent turn-triples + a
   `pointerPending` hint → returns `needsScreen` + a spoken **filler**. It NO LONGER
   decides any mode. If `needsScreen=false` it just answers (chit-chat) and the turn
   ends.
2. **Capture** the screen. A **click-turn** first waits the completed target's `wait`
   bucket + the settle-diff loop (never screenshot a loading page).
3. **One Fable vision call** — ~20 rolling turn-triples + the current screen →
   returns the unified schema (below).
4. **Narrate** `steps` via the existing `playSteps` (speak + draw boxes + the
   thinking/speaking status that already works there).
5. **If `await_click`** → keep that pointer up, arm the click-watch + fade-poll
   (the v1 mechanics, re-homed). On click → the next turn (step 1), with a synthetic
   `[clicked the highlighted target]` as this turn's user side. If `await_click` is
   null → idle-close as today. If `done` → celebrate + no pending pointer.

**No `followAlong` branch, no controller.** A tangent returns `await_click:null`
(guide pauses); a later guide question returns one again (guide resumes) — all from
Fable's read of the history.

## Unified schema (Fable output)

```json
{ "steps": [ { "say": string, "box": [x1,y1,x2,y2] | null } ],
  "await_click": { "box": [x1,y1,x2,y2], "wait": "instant"|"ui-settle"|"page-load"|"network" } | null,
  "done": boolean }
```

Prompt rules:
- Hands-on action → put the instruction in `steps[].say` (box usually null) and the
  single target in `await_click`. **One actionable step at a time** — never dump the
  whole task.
- Orientation/explanation → use `steps[].box` highlights and `await_click:null`
  (this reproduces today's `single`/`steps` behavior).
- `done:true` when the user's goal is achieved (short congratulations, no
  `await_click`).
- `box`/`await_click.box` = normalized fractions 0..1. No positional words.

`await_click:null` ⇒ **exactly today's single/steps behavior** — so the normal path
is preserved by construction (the golden rule).

## Rolling history — "turn-triples"

A **turn-triple** = `{ user: <words> | "[clicked the highlighted target]",
gateFiller: <string>, kairo: <steps' say + note of what was highlighted/awaited> }`.
Stored per turn. Windows: **20 triples → Fable**, **6 triples → gate**. Passed as
TEXT (only the current frame is an image). ~20 triples ≈ a couple thousand tokens.

## Reuse / change / delete

**Reuse (mechanics, unchanged in spirit):** in-process fast frame-hash (`framehash.rs`),
the `pointerFaded` poll + geometry + fade/re-show, the settle-diff loop, `input:click`
emit, all pure helpers in `notch/followAlong.ts`, `playSteps` + its status wiring,
the `wait` enum.

**Change:**
- `constants.rs`/`env.ts`: `page-load` → **2500ms** (network stays 2500).
- Tutor prompt (`prompts.rs build_tutor_system_prompt`) → the unified schema + the
  one-step rule; receives the 20-triple history.
- `run_tutor_turn` (`tutor.rs`) → accepts + includes the history; its apply emits
  `await_click` + `done` alongside `steps`.
- Gate (`prompts.rs gate_system_prompt`, `run_gate_turn`) → drop `followAlong`, add
  the 6-triple history + the `pointerPending` hint.
- `run_ack_turn` → generalized into the universal filler/ack (voice + click turns).
- A thin **pointer-watch** (`notch/pointerWatch.ts`) extracted from the controller:
  `setPending(box, referenceHash, wait)`, the poll (`pointerFaded`, fade/re-show),
  `onClick(coords)` → "valid click" trigger. No goal/active/history/plan.

**Delete:** `notch/followController.ts` (state machine), the `followAlong` branch in
`submitQuery`, `run_follow_turn` + `FollowTurnInput` + `apply_follow_step` (folded
into the unified tutor turn).

## Golden rule

Do not regress the shipping single/steps/voice/typed/annotation paths. A Fable
response with `await_click:null` must render identically to today. Verify the normal
path at every unit.

## Unit breakdown (subagent-driven)

- **RU1** — constants (`page-load`=2500) + unified tutor schema/prompt + apply
  (`await_click`+`done`), native. single/steps still work; +tests.
- **RU2** — rolling turn-triple history: frontend builder + thread into `run_tutor_turn`
  (20) and the gate (6).
- **RU3** — gate: strip `followAlong`, add history + `pointerPending` hint.
- **RU4** — `notch/pointerWatch.ts` module (poll/geometry/fade extracted), DI'd + tested.
- **RU5** — NotchApp unified turn engine: voice + click turns through one path;
  arm pointer-watch on `await_click`; record triples; delete the `followAlong`
  branch + wire out the controller.
- **RU6** — cleanup: delete `followController.ts`, `run_follow_turn`/`FollowTurnInput`/
  `apply_follow_step`; generalize `run_ack_turn`; final full build.
