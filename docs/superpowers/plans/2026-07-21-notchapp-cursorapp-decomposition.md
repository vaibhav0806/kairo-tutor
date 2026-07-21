# Plan: NotchApp / CursorApp decomposition (the last big refactor)

Status: NOT STARTED. Everything else from the maintainability pass + the paywall is DONE on `main`.
This is the one remaining "huge file" item. Do it in a FRESH session with full context.

## Why it's blocked today
`NotchApp.tsx` (~2360 lines) and `CursorApp.tsx` (~660) are **fused**: ~30–49 `useRef`s each,
shared between listeners, effects, and (Cursor) a rAF loop. The notch turn machine threads a
hand-rolled cancellation token (`turnEpochRef`) BY VALUE through ~30 sites
(`if (turnEpochRef.current !== turnEpoch) return;`). You cannot pull a clean hook out — every
candidate needs 8–10 shared refs passed in, which is worse than the inline code. Already
extracted the cleanly-separable bits: `useTurnHistory`, `NotchIcons`, `notchConstants`,
`OnboardingComponents`, `useTauriListeners`.

## The approach (order matters)

### Phase 1 — AbortController rewrite (prerequisite, NO extraction yet)
Goal: replace the epoch cancellation token with `AbortController` per turn. This is a
behavior-preserving 1:1 transform that UNBLOCKS extraction; it doesn't shrink the file itself.
- Add `turnAbortRef = useRef<AbortController | null>(null)`.
- Where a new turn starts (`turnEpochRef.current += 1` at ~L340, and `(turnEpochRef.current += 1)`
  in submitQuery/runClickTurn): `turnAbortRef.current?.abort(); turnAbortRef.current = new AbortController(); const signal = turnAbortRef.current.signal;`
- Every `turnEpoch: number` PARAM (speakFiller, playSteps, runClickTurn, armPointerFromAwaitClick,
  playResponseAndArm, processCapturedAudio, etc.) becomes `signal: AbortSignal`.
- Every `if (turnEpochRef.current !== turnEpoch) return;` → `if (signal.aborted) return;`.
- Every `if (turnEpochRef.current === turnEpoch) { ... }` → `if (!signal.aborted) { ... }`.
- Keep `playbackEpochRef` (separate concern — filler/answer queue) AS IS for now.
- **Commit Phase 1 alone.** cargo/tsc/tests green. Then SMOKE-TEST the cancellation edges (see below)
  before Phase 2 — this is the risky step, verify it in isolation.

### Phase 2 — extract hooks (now clean, since cancellation is a signal, not shared refs)
One hook per commit, `npm run typecheck` + smoke-test the touched path after each. Suggested order
(least→most coupled):
1. `useNotchLifecycle` — idle-close interval + activity refs (`lastNotchActivityAt`, `pointerInside*`)
   + `hideNotch`. Takes teardown callbacks as params.
2. `useTTSPlayback` — `answerAudioRef`/`fillerAudioRef`/`playbackEpochRef`/`isSpeaking` +
   `playAnswerAudio`/`playSteps`/`speakFiller`/`stopAnswerPlayback`. Absorb the repeated
   `cutClip(ref)` / clip-lifecycle-wiring / `awaitFillerOrTimeout` helpers (audit flagged 4–5x dup).
3. `useVoiceCapture` — mic/MediaRecorder/PCM/VAD refs + `startVoiceCapture`/`stopActiveRecording`/
   `processCapturedAudio` (which already has the paywall pre-check — keep it).
4. `useGestureCapture` — `gestureBufferRef`/`gestureRecordingRef`/`gestureHideTimerRef` + the
   `ptt:recording`/`cursor:mouse` effects. NOTE: `ptt:recording` is fused with PTT-recording truth;
   split carefully or expose `takeGestureStrokes()`.
5. `useFollowAlong` — `pointerWatchRef`/`pendingAwaitClickRef`/nudge refs + `runClickTurn`/
   `armPointerFromAwaitClick`/`settleAfterClick` + `input:click`.
6. `useTutorTurn` — `runGate`/`playResponseAndArm`/`submitQuery`, orchestrating the above via
   passed callbacks.
- Presentational: `NotchCapsule.tsx` (the render, ~last 130 lines). Target: NotchApp ≈ 150-line
  orchestrator wiring hooks → `<NotchCapsule>`.

### Phase 3 — CursorApp (same pattern, smaller)
Extract the rAF animation loop (`frame`, spring integration) into `useCursorAnimation(refs)` and the
listener effect into the `cursor:*` handlers. Less fused than notch; do after notch proves the pattern.

## Smoke-test checklist (you must exercise these — typecheck can't catch them)
Build the packaged app (`npm run app`), then:
- Ask a question, let it answer fully (no cancellation).
- **Interrupt**: start an answer, then ⌥⌃ and ask again mid-speech → old answer stops, new one plays.
- **Re-ask mid-thinking**: ask, then ask again before the first answer arrives → only the latest wins.
- Follow-along: "help me do X" → click the target → next step; wrong-button nudge.
- Idle-close: answer finishes, leave it → notch closes after ~3s.
- Paywalled (at 10/10): PTT release → instant cached upgrade line.

## Smaller remaining items (independent, lower priority)
- **Tier 3 shared modules**: `core/teachingTurn.ts` (gate→filler→playSteps shared by notch +
  `onboarding/demoController.ts`); unify `onboarding/useVoice.ts` onto `notch/voiceRecorder.ts`
  (it reimplements MediaRecorder+VAD and is subject to the silent-mic bug `acquireMicrophoneStream`
  fixes). Both need runtime testing.
- **Tests**: NotchApp helpers become unit-testable AFTER extraction — add tests per hook.
- **Minor paywall residual** (documented, low value): during onboarding the cheap gate/STT/TTS are
  reachable before the tutorial vision cap is hit (they don't increment `onboarding_used`). Bound the
  EXPENSIVE vision already (cap 6). Harden only if the cheap-model leak matters.

## Ground rules
Work on `main`, small revertible commits, `npm run typecheck` + `cargo check` + tests green per commit.
The turn machine has ZERO tests — Phase 1's correctness is only verifiable by the smoke-tests above.
