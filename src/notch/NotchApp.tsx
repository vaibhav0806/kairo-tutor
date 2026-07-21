import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { activationStateToNotchPayload } from '../activation/activationState';
import { loadBrowserEnv } from '../config/env';
import { klog, type LogFields, type LogLevel } from '../core/logger';
import { playSound, playRecordingCue } from '../core/sound';
import type { UserAnnotation, VisualTarget } from '../core/types';
import {
  createNativeBridge,
  type NativeContextBaseline,
  type NativeOverlayDisplayBounds,
  type NativeScreenCapture
} from '../native/nativeBridge';
import { type NotchAnnotationTool } from './annotationActions';
import { createPointerWatch, type PointerWatch } from './pointerWatch';
import {
  asFollowButton,
  shouldNudge,
  waitFloorMs,
  type FollowButton,
  type FollowWait,
  type ScreenRegion,
} from './followAlong';
import { shouldIdleClose } from './idleClose';
import type { AskTutorResult } from './notchTutor';
import { subscribeToNotchPayload } from './notchEvents';
import { askTutorFromNotch } from './notchTutor';
import { routeVisualTargets, type RevealTransition } from '../overlay/targetRouting';
import { isNotchDismissKey, waitForNotchPaint } from './prompt';
import type { NotchPayload } from './types';
import {
  voiceFilenameForMimeType,
  voiceStatusCopy,
  type VoiceCaptureState
} from './voiceRecorder';
import { segmentGesturePath, type TimedPoint } from './gestureSegmenter';
import { compositeMarks } from './compositeMarks';
import { gestureConfig } from '../config/gesture';
import {
  defaultPayload,
  FREE_LIMIT_TEXT,
  NOTCH_IDLE_CLOSE_MS,
  pickFiller,
  pickNudge,
  VOICE_ERROR_VISIBLE_MS,
  type QuerySource
} from './notchConstants';
import { useTurnHistory } from './useTurnHistory';
import { useTTSPlayback } from './useTTSPlayback';
import { NotchCapsule, type NotchCapsuleMode } from './NotchCapsule';
import upgradeAudioUrl from './audio/upgrade.wav?url';


export function NotchApp() {
  const [payload, setPayload] = useState<NotchPayload>(defaultPayload);
  // The answer body is held back until TTS playback actually starts, so the notch
  // never shows the answer text before it is spoken.
  const [detailHidden, setDetailHidden] = useState(false);
  const [query, setQuery] = useState('');
  const [annotations, setAnnotations] = useState<UserAnnotation[]>([]);
  const [activeAnnotationTool, setActiveAnnotationTool] = useState<NotchAnnotationTool | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [voiceCaptureState, setVoiceCaptureState] = useState<VoiceCaptureState>('idle');
  const isSubmittingRef = useRef(false);
  const voiceCaptureStateRef = useRef<VoiceCaptureState>('idle');
  // The status capsule element, for writing the live mic level (--mic-level).
  const capsuleRef = useRef<HTMLDivElement | null>(null);
  // Opened on every new turn (voice re-engage OR typed submit): abort the previous
  // turn's controller and install a fresh one. A turn captures its AbortSignal and bails
  // after each await once a newer turn supersedes it (aborts the old controller), so a
  // stale turn never mutates shared state (payload/box/context-watch/TTS/voiceCaptureState).
  const turnAbortRef = useRef<AbortController | null>(null);
  // Monotonic id bumped alongside each turn controller — LOG-ONLY (cancellation rides
  // the AbortSignal, not this). Keeps PTT log lines of one turn correlatable.
  const turnLogSeqRef = useRef(0);
  // The teaching visuals for the current answer, revealed on TTS start (not when
  // the LLM answer arrives), plus the app they point at for the context watcher.
  const revealVisualsRef = useRef<() => Promise<void>>(async () => {});
  const contextBaselineRef = useRef<NativeContextBaseline | null>(null);
  // Robust notch auto-close. Rather than fragile enter/leave booleans, we track the
  // last time the user interacted WITH THE NOTCH (pointer over it, or typing) and a
  // periodic check closes once the answer has finished speaking and the notch has sat
  // idle for NOTCH_IDLE_CLOSE_MS. Self-healing if a leave event is missed, and
  // unaffected by activity in OTHER apps (scroll/click/tab-switch fire no notch DOM
  // events), so external activity never keeps it open nor forces it closed.
  const answerSettledRef = useRef(false);
  const lastNotchActivityAt = useRef(0);
  const pointerInsideNotchRef = useRef(false);
  const lastNotchPointerAt = useRef(0);
  // Session memory: rolling turn-triples for continuity (last N → tutor/gate).
  const { recordTriple, buildRecentContext, buildGateHistory } = useTurnHistory();
  // The skill pack chosen for the current task. Set by the gate (voice path); reused
  // across follow-along turns; "" lets Rust resolve it via the app-match fallback.
  const activeSkillRef = useRef<string>('');
  // Mirrors the prompt text so the idle check can tell "typing a follow-up" (block
  // close) from a merely focused-but-empty prompt (the autoFocus default).
  const queryRef = useRef('');
  // Native recording truth from the ⌥⌃ tap (`ptt:recording` event): true from the
  // moment a hold is confirmed (~250ms) until release. The idle-close timer reads this
  // so the listening capsule can never auto-close mid-hold.
  const pttRecordingRef = useRef(false);
  // Screenshot taken at voice-start, reused by the tutor turn so the ask doesn't
  // wait on a fresh capture.
  const capturedScreenRef = useRef<NativeScreenCapture | null>(null);
  // Mirrors `annotations` so the (dep-stable) annotation-watch arming can read the
  // current count without churning callback identities.
  const annotationsRef = useRef<UserAnnotation[]>([]);
  // Display bounds last used to show the pen overlay — reused to re-assert the marks
  // as a click-through preview through the turn (so PTT doesn't wipe them).
  const displayBoundsRef = useRef<NativeOverlayDisplayBounds | null>(null);
  // Hold-to-point: raw cursor:mouse points during the current hold (physical px),
  // whether we're inside a confirmed hold, and the post-release overlay-hide timer.
  const gestureBufferRef = useRef<TimedPoint[]>([]);
  const gestureRecordingRef = useRef(false);
  const gestureHideTimerRef = useRef<number | null>(null);
  // ---- Unified turn: pointer-watch (guide, emergent) --------------------------
  // No state machine / no `active` flag. After a Fable answer whose await_click is
  // present, we DRAW that one target and hand it to a thin pointer-watch that owns
  // the fade-on-scroll poll + the valid-click detection + a 30s idle. A valid click
  // just triggers another turn. Built EXACTLY ONCE (lazy-init below).
  const pointerWatchRef = useRef<PointerWatch | null>(null);
  // The visualTargets + bounds of the CURRENTLY pending await_click pointer, stored
  // so the watch's reshowPointer dep can re-route (glide) the same hint on return.
  const pendingAwaitClickRef = useRef<{ visualTargets: VisualTarget[]; bounds: NativeOverlayDisplayBounds } | null>(
    null
  );
  // Snapshot of "was a guide pointer pending when the CURRENT turn re-engaged?".
  // resetPreviousTurn clears the watch (pending → false) long before the gate runs on
  // the native PTT path, so runGate reads this pre-clear snapshot instead of the live
  // `pending` to still tell the gate "a guide pointer was on screen". Consumed + reset
  // by runGate; only ever SET true (so the 2nd resetPreviousTurn can't clobber it).
  const pointerWasPendingRef = useRef(false);
  // First pointer of a fresh voice/typed turn is DRAWN; a click-turn's next pointer
  // GLIDES (mirrors playSteps). Reset to true at the top of submitQuery.
  const followFirstPointerRef = useRef(true);
  // A valid click fires the pointer-watch's onValidClick synchronously; it routes
  // into runClickTurn via this ref so the watch can be built before runClickTurn.
  const runClickTurnRef = useRef<(wait: FollowWait, button: FollowButton) => void>(
    () => {}
  );
  // Wrong-button nudge routing (set once speakFollowClip exists, like runClickTurnRef).
  const nudgeWrongButtonRef = useRef<(expected: FollowButton) => void>(() => {});
  // Timestamp of the last spoken nudge, for the cooldown. Reset to -Infinity when a fresh
  // pointer arms so the first wrong-button nudge on it always fires (clock-independent).
  const lastNudgeAtRef = useRef(Number.NEGATIVE_INFINITY);
  const nativeBridge = useMemo(() => createNativeBridge(), []);
  const env = loadBrowserEnv();
  // All answer/filler/step/follow audio playback lives in this hook (owns the clip refs +
  // playback epoch + narration/filler done-signals); the turn machine just calls it.
  const tts = useTTSPlayback(nativeBridge);
  const {
    stopAnswerPlayback,
    playAnswerAudio,
    playSteps,
    speakFiller,
    speakFollowClip,
    speakFollowClipDone,
    playBufferedAnswer,
    getNarrationDone,
    openFillerGate
  } = tts;

  // Coerce a raw wait string (from await_click) to a known FollowWait bucket.
  const asFollowWait = (w: string): FollowWait =>
    (['instant', 'ui-settle', 'page-load'] as const).includes(w as FollowWait)
      ? (w as FollowWait)
      : 'ui-settle';

  // Build the pointer-watch once with real bridges. Lazy-init in the ref (the module
  // is pure — just closures, no I/O) so a re-render never rebuilds it and drops a
  // live pending pointer. onValidClick routes into runClickTurn via runClickTurnRef,
  // set below once runClickTurn exists.
  if (!pointerWatchRef.current) {
    pointerWatchRef.current = createPointerWatch({
      captureFrameHash: () => nativeBridge.captureFrameHash(),
      // Fade the pending pointer visually (screen drifted away, or teardown).
      fadePointer: () => {
        void nativeBridge.hideOverlay();
        void nativeBridge.cursorRelease();
      },
      // Re-show the SAME pending pointer (glide back) when the screen returns.
      reshowPointer: () => {
        const p = pendingAwaitClickRef.current;
        if (!p) {
          return;
        }
        void routeVisualTargets(nativeBridge, p.visualTargets, p.bounds, 'glide');
      },
      // A valid in-box click landed → run the next (click-triggered) turn, handing it
      // the `wait` bucket (the post-click settle delay) plus which button was used
      // (right-clicks tell Fable a context menu is now open).
      onValidClick: (wait, button) => runClickTurnRef.current(wait, button),
      // Right target, wrong button → speak a nudge (cooldown-gated), stay pending.
      onWrongButton: (expected) => nudgeWrongButtonRef.current(expected),
      // The pointer sat untouched for the idle window: it already faded + cleared
      // pending. Drop the native click watch and let the notch idle-close run.
      onIdleFade: () => {
        klog('follow', 'info', 'pointer idle fade → notch may close');
        pendingAwaitClickRef.current = null;
        void nativeBridge.disarmFollowClick();
        answerSettledRef.current = true;
        lastNotchActivityAt.current = performance.now();
      },
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (level, msg, fields) =>
        klog('follow', level as LogLevel, msg, fields as LogFields | undefined),
      cfg: {
        armedPollMs: env.followArmedPollMs,
        sameScreenBits: env.followSamescreenBits,
        clickPadPt: env.followClickPadPt,
        idleFadeMs: env.followPointerIdleFadeMs
      }
    });
  }
  const updateVoiceCaptureState = useCallback((state: VoiceCaptureState) => {
    voiceCaptureStateRef.current = state;
    setVoiceCaptureState(state);
  }, []);

  const noteNotchActivity = useCallback(() => {
    lastNotchActivityAt.current = performance.now();
  }, []);

  const markAnswerSettled = useCallback(() => {
    answerSettledRef.current = true;
    lastNotchActivityAt.current = performance.now();
  }, []);

  // ---- Session memory: rolling turn-triples -----------------------------------
  // Tear down the PREVIOUS turn's visual + context state on re-engage (a new voice
  // hold or a tap-to-type), independent of submitQuery — which for voice only runs
  // after key-release + STT, far too late to stop the old box/watch/TTS lingering.
  const resetPreviousTurn = useCallback(() => {
    // Supersede any in-flight turn the INSTANT the user re-engages (PTT promote / tap /
    // typed submit), so a stale in-flight answer can no longer paint over the fresh
    // listening/typing UI or wipe pen marks. Abort the old controller + open a fresh one;
    // the next turn captures this controller's signal.
    turnAbortRef.current?.abort();
    turnAbortRef.current = new AbortController();
    stopAnswerPlayback();
    // A re-engage supersedes any pending guide pointer: clear the watch + native
    // click arm so the next turn starts clean (it re-arms if it points again).
    // Snapshot the pre-clear pending state FIRST so the gate can still learn this
    // voice turn interrupted a live guide pointer (set-on-true only, so the second
    // resetPreviousTurn call — pending already false — can't clobber it).
    if (pointerWatchRef.current?.pending) {
      pointerWasPendingRef.current = true;
    }
    pointerWatchRef.current?.clear();
    pendingAwaitClickRef.current = null;
    void nativeBridge.disarmFollowClick();
    answerSettledRef.current = false;
    contextBaselineRef.current = null;
    // The user's FRESH pen marks belong to the UPCOMING turn — keep them on screen
    // (and in the ask-time screenshot) instead of wiping them. Re-assert them as a
    // click-through annotation_preview: configure_overlay_window flips it click-through
    // AND keeps it in the tutor's capture (mode-based include). A plain hideOverlay()
    // here is what used to erase the marks the instant PTT was pressed. No marks →
    // clear the previous answer's box as before.
    const marks = annotationsRef.current;
    const bounds = displayBoundsRef.current;
    if (marks.length > 0 && bounds) {
      klog('notch', 'info', 'reengage: keep pen marks (preview)', { count: marks.length });
      void nativeBridge.updateOverlay({
        mode: 'annotation_preview',
        displayBounds: bounds,
        targets: [],
        annotations: marks
      });
    } else if (gestureBufferRef.current.length > 0 || gestureRecordingRef.current) {
      // Don't hide the shared overlay while a gesture is active or fading. Two cases:
      // (1) release path (buffer full) — let the fade play out, the hide-timer owns
      //     teardown; hiding here made marks vanish instantly + flash on the box.
      // (2) hold-START path (recording true) — this runs right after showGestureOverlay,
      //     and on turn 2+ (bounds cached, no await) show_overlay is posted BEFORE this,
      //     so hiding here would hide the just-shown overlay (the turn-2 no-paint bug).
      // gestureRecordingRef is set true synchronously in the ptt:recording handler,
      // which runs before this, so the guard is race-independent.
      klog('notch', 'debug', 'reengage: keep gesture overlay', {
        pts: gestureBufferRef.current.length,
        recording: gestureRecordingRef.current
      });
    } else {
      klog('notch', 'debug', 'reengage: clear overlay', { marks: marks.length });
      void nativeBridge.hideOverlay();
    }
    void nativeBridge.disarmContextWatch();
    // Fresh activity so the idle-close timer can't fire immediately after re-engage.
    lastNotchActivityAt.current = performance.now();
  }, [stopAnswerPlayback, nativeBridge]);

  // Settle after a click: a plain per-bucket sleep, no pixel matching. Fable emits the
  // `wait` bucket (its guess of how long the screen takes to settle after the click);
  // we sleep exactly that long, then the caller screenshots the result for the next
  // Fable turn. The floors (constants.rs / env.ts) are generous by design so we don't
  // shoot a still-loading screen — better to over-wait than have Fable wrongly report
  // "still loading". The clock starts at the click (mouse-up), so any dead-zone before
  // the app reacts is eaten out of the floor. Within-bucket variance (a fast vs slow
  // click) is accepted, not adapted to. Genuinely slow/variable actions no longer come
  // here at all — Fable routes those to manual "tell me when you're done" mode instead
  // of await_click. Bails if a newer turn supersedes this.
  const settleAfterClick = useCallback(
    async (wait: FollowWait, signal: AbortSignal) => {
      const floors = {
        instant: env.waitInstantMs,
        uiSettle: env.waitUiSettleMs,
        pageLoad: env.waitPageLoadMs
      };
      const ms = waitFloorMs(wait, floors);
      klog('follow', 'info', 'settle after click', { wait, ms });
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      if (signal.aborted) return;
    },
    [env.waitInstantMs, env.waitUiSettleMs, env.waitPageLoadMs]
  );

  // Draw a Fable response's await_click pointer + arm the pointer-watch on it. Routes
  // the target to overlay+cursor (draw the first pointer of a turn, glide after),
  // stores it for reshow, reads the box region from the highlight_box target, captures
  // the current frame as the reference hash, and hands it to the watch + native click
  // arm. Does NOT idle-close — the watch owns the pointer + its 30s idle.
  const armPointerFromAwaitClick = useCallback(
    async (
      awaitClick: { visualTargets: VisualTarget[]; wait: string; button: string },
      signal: AbortSignal,
      boundsOverride?: NativeOverlayDisplayBounds | null
    ) => {
      const bounds =
        boundsOverride ??
        capturedScreenRef.current?.displayBounds ??
        displayBoundsRef.current ??
        null;
      if (!bounds) {
        klog('follow', 'warn', 'no display bounds — cannot arm pointer');
        return;
      }
      pendingAwaitClickRef.current = { visualTargets: awaitClick.visualTargets, bounds };
      const transition: RevealTransition = followFirstPointerRef.current ? 'draw' : 'glide';
      followFirstPointerRef.current = false;
      klog('follow', 'debug', 'arm pointer', {
        transition,
        targets: awaitClick.visualTargets.length,
        wait: awaitClick.wait,
        button: awaitClick.button
      });
      await routeVisualTargets(nativeBridge, awaitClick.visualTargets, bounds, transition);
      const boxTarget = awaitClick.visualTargets.find((t) => t.kind === 'highlight_box');
      const region = boxTarget?.screenRegion;
      if (!region) {
        klog('follow', 'warn', 'await_click has no box — not arming watch');
        return;
      }
      const refHash = await nativeBridge.captureFrameHash();
      // A newer turn superseded this one while we drew the pointer + hashed the frame
      // (e.g. a PTT hold re-engaged → resetPreviousTurn cleared the watch). Do NOT
      // re-arm a stale pointer + native click watch: tear down what we drew and bail.
      if (signal.aborted) {
        klog('follow', 'debug', 'arm superseded mid-draw — clearing stale pointer');
        pendingAwaitClickRef.current = null;
        void nativeBridge.hideOverlay();
        void nativeBridge.cursorRelease();
        void nativeBridge.disarmFollowClick();
        return;
      }
      pointerWatchRef.current?.setPending(
        region as ScreenRegion,
        refHash,
        asFollowWait(awaitClick.wait),
        asFollowButton(awaitClick.button)
      );
      lastNudgeAtRef.current = Number.NEGATIVE_INFINITY; // fresh pointer → first nudge always fires
      void nativeBridge.armFollowClick();
    },
    [nativeBridge]
  );

  // The unified render, shared by the initial voice/typed turn AND the click-turn:
  // set the answer card, record the turn-triple, play the steps (or the single
  // answer), and — AFTER narration — arm the pointer-watch if await_click is present,
  // celebrate + idle-close if done, or idle-close exactly as today when await_click is
  // null. Golden rule: with await_click null this is byte-identical to the old path.
  const playResponseAndArm = useCallback(
    (
      result: AskTutorResult,
      signal: AbortSignal,
      meta: { userSide: string; gateFiller: string }
    ) => {
      const {
        payload: answerPayload,
        steps,
        revealStep,
        revealVisuals,
        awaitClick,
        done,
        displayBounds,
        context
      } = result;

      revealVisualsRef.current = revealVisuals;
      contextBaselineRef.current = context;
      setPayload(answerPayload);
      setDetailHidden(true);
      setQuery('');
      setAnnotations([]);
      setActiveAnnotationTool(null);
      void nativeBridge.showNotch(answerPayload);

      // Record ONE triple for this turn — the kairo side is the joined step says plus a
      // short note of what was highlighted / awaited / finished.
      const said = steps
        .map((s) => s.say)
        .filter((s) => s.trim())
        .join(' ');
      const note = awaitClick ? ' [highlighted a target to click]' : done ? ' [done]' : '';
      recordTriple({
        user: meta.userSide,
        gateFiller: meta.gateFiller,
        kairo: (said || answerPayload.detail || '') + note
      });

      const armCtxWatch = () => {
        if (contextBaselineRef.current) {
          void nativeBridge.armContextWatch(contextBaselineRef.current);
        }
      };
      const hasAwaitClick = Boolean(awaitClick && awaitClick.visualTargets.length > 0);

      // Arm the await_click pointer at the ACTION step's speech-START (same timing as a
      // normal step's box reveal), not after all narration completes. Idempotent + guarded
      // so it fires exactly once; onSettled is a fallback for edge cases (no step fired it).
      let awaitArmed = false;
      const armAwaitClick = () => {
        if (awaitArmed || !hasAwaitClick || !awaitClick) return;
        awaitArmed = true;
        void armPointerFromAwaitClick(awaitClick, signal, displayBounds);
      };

      if (steps.length > 0) {
        void playSteps(
          steps,
          revealStep,
          () => {
            setDetailHidden(false);
            void emit('cursor:idle', {});
          },
          () => {
            // Superseded turn (e.g. a no-cut click aborted THIS narration's controller
            // while it was still finishing) → do NOT arm or settle. Its stale
            // markAnswerSettled would arm an idle-close that tears down the incoming turn.
            if (signal.aborted) return;
            // After narration: fallback-arm the pointer if a step-start didn't; otherwise
            // arm the context watch + idle-close exactly as today.
            if (hasAwaitClick) {
              armAwaitClick();
            } else {
              armCtxWatch();
            }
            markAnswerSettled();
          },
          (index) => {
            // At the ACTION (last) step's speech-start, draw + arm the await_click pointer.
            if (index === steps.length - 1) {
              armAwaitClick();
            }
          }
        );
      } else {
        void playAnswerAudio(
          answerPayload.detail,
          () => {
            setDetailHidden(false);
            void emit('cursor:idle', {});
            void revealVisualsRef.current().then(() => {
              if (!hasAwaitClick) {
                armCtxWatch();
              }
            });
          },
          () => {
            // Superseded turn → don't arm/settle (see the steps path above).
            if (signal.aborted) return;
            // No narration steps → arm here (nothing to interrupt/reveal-early anyway).
            armAwaitClick();
            markAnswerSettled();
          }
        );
      }
    },
    [nativeBridge, playSteps, playAnswerAudio, armPointerFromAwaitClick, markAnswerSettled, recordTriple]
  );

  // Phase 1 gate: text-only "do I need to look at the screen?". Returns the parsed
  // { needsScreen, voiceText }; defaults to looking on any failure. Sees the last 6
  // turn-triples + a `pointerPending` hint (mid-guide → bias needsScreen=true).
  const runGate = useCallback(
    async (query: string): Promise<{ needsScreen: boolean; voiceText: string; skillSlug: string }> => {
      const fallback = { needsScreen: true, voiceText: '', skillSlug: '' };
      // Consume-and-reset the pre-clear snapshot: resetPreviousTurn (PTT re-engage)
      // already cleared the live watch, so the snapshot is the source of truth for
      // "did this turn interrupt a guide pointer?". OR-in live pending for any path
      // that didn't reset (WebView voice), where the watch is still armed.
      const pointerPending = pointerWasPendingRef.current || (pointerWatchRef.current?.pending ?? false);
      pointerWasPendingRef.current = false;
      try {
        const active =
          capturedScreenRef.current?.activeApp ??
          (await nativeBridge.getActiveApp().catch(() => null));
        const raw = await nativeBridge.runGateTurn({
          userQuery: query,
          activeApp: active?.activeApp,
          bundleId: active?.bundleId ?? undefined,
          windowTitle: active?.windowTitle ?? undefined,
          history: buildGateHistory(),
          pointerPending
        });
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) {
          return fallback;
        }
        const parsed = JSON.parse(raw.slice(start, end + 1));
        return {
          needsScreen: Boolean(parsed.needsScreen),
          voiceText: typeof parsed.voiceText === 'string' ? parsed.voiceText : '',
          skillSlug: typeof parsed.skillSlug === 'string' ? parsed.skillSlug : ''
        };
      } catch {
        return fallback;
      }
    },
    [nativeBridge, buildGateHistory]
  );

  const submitQuery = useCallback(
    async (
      nextQuery: string,
      source: QuerySource = 'typed',
      providedSignal?: AbortSignal,
      hasGestureMarks = false
    ) => {
      const trimmedQuery = nextQuery.trim();
      if (!trimmedQuery) {
        return;
      }
      // Turn signal. Voice passes the signal opened in processCapturedAudio (so the
      // re-engage teardown and this turn share one controller); the typed path opens a
      // fresh turn here. A newer turn aborting this signal supersedes this one — that
      // REPLACES the old isSubmitting drop-guard (no more silently-dropped turns).
      const signal =
        providedSignal ??
        (() => {
          turnAbortRef.current?.abort();
          turnAbortRef.current = new AbortController();
          return turnAbortRef.current.signal;
        })();

      // Diagnostic: which input started this turn (pairs with the native STT
      // transcript + gate question/answer lines in the same log file).
      klog('notch', 'info', 'ask submit', { source, query_len: trimmedQuery.length });

      // Session memory: the last 20 triples give the tutor continuity. The triple for
      // THIS turn is recorded once its response arrives (in playResponseAndArm).
      const recentContext = buildRecentContext();
      // A fresh voice/typed turn draws its first pointer; a click-turn glides.
      followFirstPointerRef.current = true;

      const thinkingPayload = activationStateToNotchPayload('thinking');
      stopAnswerPlayback();
      // A new turn supersedes the last answer: mark it unsettled (blocks auto-close),
      // clear any pending guide pointer, and stop watching the old target.
      answerSettledRef.current = false;
      pointerWatchRef.current?.clear();
      pendingAwaitClickRef.current = null;
      void nativeBridge.disarmFollowClick();
      void nativeBridge.disarmContextWatch();
      // Release any lingering pointing so the cursor shadows the mouse while the
      // new answer is computed; it flies again only if the answer has a target.
      void nativeBridge.cursorRelease();
      // Also drop the previous turn's box (covers the typed path; belt-and-suspenders
      // for voice, where resetPreviousTurn already hid it on re-engage). Skip while a
      // gesture fade is playing on the shared overlay — hiding cuts the fade short.
      if (!hasGestureMarks) void nativeBridge.hideOverlay();
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      updateVoiceCaptureState('idle');
      setPayload(thinkingPayload);
      // The thinking state's own detail should show normally.
      setDetailHidden(false);
      setQuery('');
      void nativeBridge.showNotch(thinkingPayload);
      await waitForNotchPaint();

      try {
        // Phase 1 gate: keep it for voice, where direct answers can avoid a screen
        // turn. Typed asks are already explicit text, so route them screen-first;
        // the tutor/grounder then decides whether any visual target is useful.
        // Gesture marks mean the user pointed at the screen → skip the gate (like
        // the old pen did) so the turn always uses the screenshot with the marks.
        const gateRan = source === 'voice' && annotations.length === 0 && !hasGestureMarks;
        const gate = gateRan
          ? await runGate(trimmedQuery)
          : { needsScreen: true, voiceText: '', skillSlug: '' };
        // The typed/annotation path skips runGate (the only snapshot consumer), so
        // consume the pointer-pending snapshot here too — otherwise a typed turn that
        // interrupted a guide would leak "was pending" into a later voice gate.
        if (!gateRan) {
          pointerWasPendingRef.current = false;
        }
        // Route-once: cache the gate's skill pick for this task; follow-along turns
        // reuse it. Only overwrite on a POSITIVE pick — an empty pick means "no opinion
        // for this utterance" (e.g. a mid-task "is this right?"), NOT "drop the task's
        // skill". The Rust guardrail still drops a stale slug if the frontmost app changes.
        if (gateRan && gate.skillSlug) {
          activeSkillRef.current = gate.skillSlug;
        }
        // A newer turn superseded this one while the gate ran → stop mutating shared state.
        if (signal.aborted) return;
        const needsScreen =
          source === 'typed' || annotations.length > 0 || hasGestureMarks || gate.needsScreen;

        // Diagnostic: which route this turn took and whether the gate actually ran,
        // so an "unrelated answer" can be traced to the gate vs the vision turn.
        klog('notch', 'info', 'gate decision', {
          source,
          gate_ran: gateRan,
          needs_screen: needsScreen,
          path: needsScreen ? 'vision' : 'direct',
          answer_len: gate.voiceText.trim().length
        });

        if (!needsScreen && gate.voiceText.trim().length > 0) {
          // Direct answer — no screenshot, no grounding, no vision cost.
          const directPayload: NotchPayload = {
            state: 'showing_step',
            layout: 'answer',
            title: 'Kairo answered',
            detail: gate.voiceText
          };
          revealVisualsRef.current = async () => {
            await nativeBridge.hideOverlay();
          };
          contextBaselineRef.current = null;
          setPayload(directPayload);
          setDetailHidden(true);
          setAnnotations([]);
          setActiveAnnotationTool(null);
          void nativeBridge.showNotch(directPayload);
          recordTriple({ user: trimmedQuery, gateFiller: '', kairo: directPayload.detail });
          void playAnswerAudio(
            directPayload.detail,
            () => {
              setDetailHidden(false);
              void nativeBridge.hideOverlay();
            },
            () => {
              markAnswerSettled();
            }
          );
          return;
        }

        // Phase 2: needs the screen. ALWAYS play a "let me look" filler while the vision
        // turn runs. Prefer the gate's own contextual line; otherwise (gesture/annotation/
        // typed — no gate filler) pick a RANDOM line from the pool so it isn't repetitive.
        const filler = gate.voiceText || pickFiller();
        void speakFiller(filler, signal);

        const result = await askTutorFromNotch({
          query: trimmedQuery,
          nativeBridge,
          aiProvider: env.aiProvider,
          skillSlug: activeSkillRef.current,
          annotations: [],
          screenCapture: capturedScreenRef.current,
          recentContext,
          // What the gate just spoke aloud, so the tutor continues instead of re-greeting.
          spokenIntro: filler
        });
        // A newer turn superseded this one while the tutor ran → don't paint a stale
        // answer, don't play its audio, don't arm a watch for the old target.
        if (signal.aborted) return;

        // The unified render: play the steps (or the single answer), then arm the
        // pointer-watch if await_click is present — else idle-close exactly as today.
        playResponseAndArm(result, signal, { userSide: trimmedQuery, gateFiller: filler });
      } finally {
        // Only the CURRENT turn owns the submitting flag; a superseded turn must not
        // clear it out from under the newer turn that now owns it.
        if (!signal.aborted) {
          isSubmittingRef.current = false;
          setIsSubmitting(false);
        }
      }
    },
    [
      annotations,
      markAnswerSettled,
      env.aiProvider,
      nativeBridge,
      buildRecentContext,
      recordTriple,
      playAnswerAudio,
      playResponseAndArm,
      runGate,
      speakFiller,
      stopAnswerPlayback,
      updateVoiceCaptureState
    ]
  );

  // The click-turn: a valid click on the pending pointer triggers ANOTHER turn — the
  // loop, with NO controller state. Fade the old pointer, speak a cheap ack while we
  // work, settle the screen (never screenshot a loading page), capture, run the SAME
  // tutor turn with a synthetic "[clicked the highlighted target]" user side + rolling
  // history, then render via playResponseAndArm (which re-arms if it points again).
  const runClickTurn = useCallback(
    async (wait: FollowWait, button: FollowButton) => {
      // A click-turn is a new turn: open a fresh controller so a voice hold during it
      // aborts this one (supersede).
      turnAbortRef.current?.abort();
      turnAbortRef.current = new AbortController();
      const signal = turnAbortRef.current.signal;
      klog('follow', 'info', 'click turn', { wait, button });
      // NO-CUT UX: do NOT stop the current step's speech. Let the line the user clicked
      // through finish naturally; the next turn's audio queues BEHIND it. Capture the
      // current narration's done-signal so the answer can wait for it.
      const currentSpeechDone = getNarrationDone();
      let speechEnded = false;
      // Tell Fable which button was used — a right-click means a context menu is now
      // open, so its next step should point at a menu item (a normal left-click).
      const userSide =
        button === 'right'
          ? '[right-clicked the highlighted target]'
          : '[clicked the highlighted target]';

      // 1. Fade the old pointer (the watch already cleared its pending state) + disarm
      //    the native click watch until the next pointer arms.
      pendingAwaitClickRef.current = null;
      void nativeBridge.hideOverlay();
      void nativeBridge.cursorRelease();
      void nativeBridge.disarmFollowClick();

      // New turn: block idle-close, drop the old context watch, show the Thinking card.
      answerSettledRef.current = false;
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      void nativeBridge.disarmContextWatch();
      const thinkingPayload = activationStateToNotchPayload('thinking');
      setPayload(thinkingPayload);
      setDetailHidden(false);
      void nativeBridge.showNotch(thinkingPayload);
      // Show the thinking cursor once the current line finishes — don't stomp its
      // cursor:speaking while it's still talking (fires immediately if nothing's playing).
      void currentSpeechDone.then(() => {
        speechEnded = true;
        if (!signal.aborted) void emit('cursor:thinking', {});
      });

      const recentContext = buildRecentContext();

      // 2. Ack filler + the no-cut queue. The answer (playResponseAndArm) waits on the
      //    filler gate; we resolve it only once the current line — and the ack, IF we
      //    play it — has finished, so the answer never cuts the current line. Ack rule
      //    (user's): if the ack is ready BEFORE the current line ends, skip it (things
      //    are already moving); if it's ready only AFTER, play it so the wait isn't silent.
      //    openFillerGate arms the gate WITHOUT playing a clip; a voice barge-in
      //    (stopAnswerPlayback) also resolves it.
      const resolveGate = openFillerGate();
      const gateCap = (p: Promise<void>) =>
        Promise.race([p, new Promise<void>((r) => setTimeout(r, 12000))]);

      let ackText = '';
      const ackTextPromise = nativeBridge
        .runAckTurn(userSide)
        .then((t) => (t ?? '').trim())
        .catch(() => '');
      void (async () => {
        const ack = await ackTextPromise;
        if (signal.aborted) {
          resolveGate();
          return;
        }
        if (ack && speechEnded) {
          // Ready only AFTER the line ended → play it as the bridge; answer queues behind.
          await speakFollowClipDone(ack, signal);
        } else {
          // Ready before the line ended (skip it), or no ack → answer waits for the line.
          await gateCap(currentSpeechDone);
        }
        if (!signal.aborted) resolveGate();
      })();

      try {
        // 3. Settle the UI after the click (fixed per-bucket wait).
        await settleAfterClick(wait, signal);
        if (signal.aborted) return;
        // 4. Capture the settled screen + run the same tutor turn.
        const shot = await nativeBridge.captureScreen();
        if (signal.aborted) return;
        capturedScreenRef.current = shot;
        ackText = await ackTextPromise;
        const result = await askTutorFromNotch({
          query: userSide,
          nativeBridge,
          aiProvider: env.aiProvider,
          // Reuse the skill cached when this guide's task began (route-once).
          skillSlug: activeSkillRef.current,
          annotations: [],
          screenCapture: shot,
          recentContext,
          spokenIntro: ackText || 'Nice, one sec.'
        });
        if (signal.aborted) return;
        // 5. Render via the same path — re-arms the pointer if it points again.
        playResponseAndArm(result, signal, { userSide, gateFiller: ackText });
      } catch (e) {
        klog('follow', 'warn', 'click turn failed', { err: String(e) });
        if (!signal.aborted) markAnswerSettled();
      } finally {
        if (!signal.aborted) {
          isSubmittingRef.current = false;
          setIsSubmitting(false);
        }
      }
    },
    [
      nativeBridge,
      env.aiProvider,
      buildRecentContext,
      settleAfterClick,
      speakFollowClipDone,
      getNarrationDone,
      openFillerGate,
      playResponseAndArm,
      markAnswerSettled
    ]
  );

  // Route the pointer-watch's synchronous onValidClick into the latest runClickTurn
  // without making it a dependency of the once-built watch.
  runClickTurnRef.current = (wait: FollowWait, button: FollowButton) => {
    void runClickTurn(wait, button);
  };

  // Speak a wrong-button nudge, cooldown-gated so a fumbling user isn't nagged on every
  // click. Wired into the pointer-watch's onWrongButton via nudgeWrongButtonRef.
  nudgeWrongButtonRef.current = (expected: FollowButton) => {
    const now = performance.now();
    if (!shouldNudge(now, lastNudgeAtRef.current, env.followNudgeCooldownMs)) {
      klog('follow', 'debug', 'wrong button nudge suppressed (cooldown)', { expected });
      return;
    }
    lastNudgeAtRef.current = now;
    const line = pickNudge(expected);
    klog('follow', 'info', 'wrong button nudge', { expected, line });
    void speakFollowClip(line);
  };

  const hideNotch = useCallback(() => {
    stopAnswerPlayback();
    // Explicit dismiss also tears down a pending guide pointer (stops the watch's poll
    // + idle) and disarms the native click watch. No-op when nothing is pending.
    pointerWatchRef.current?.clear();
    pendingAwaitClickRef.current = null;
    void nativeBridge.disarmFollowClick();
    answerSettledRef.current = false;
    pointerInsideNotchRef.current = false;
    void nativeBridge.disarmContextWatch();
    capturedScreenRef.current = null;
    isSubmittingRef.current = false;
    setIsSubmitting(false);
    updateVoiceCaptureState('idle');
    setPayload(defaultPayload);
    setDetailHidden(false);
    setQuery('');
    setAnnotations([]);
    setActiveAnnotationTool(null);
    void nativeBridge.hideOverlay();
    void nativeBridge.cursorRelease();
    void nativeBridge.hideNotch();
  }, [nativeBridge, stopAnswerPlayback, updateVoiceCaptureState]);

  // Periodic idle-close: closes only after the answer has finished speaking AND the
  // notch has sat untouched for NOTCH_IDLE_CLOSE_MS. Hovering (pointer inside, with a
  // missed-leave recovery after 4s of no pointer events) or typing keeps it open.
  // Nothing here reacts to other apps, so scrolling/clicking/switching elsewhere
  // never keeps it open or forces it closed.
  useEffect(() => {
    const id = setInterval(() => {
      // While a guide pointer is pending, never auto-close: the pointer must stay
      // until the user acts (or the watch's own 30s idle fires), and hideNotch would
      // wipe the overlay + cursor.
      if (pointerWatchRef.current?.pending) {
        return;
      }
      const now = performance.now();
      const pointerHolding =
        pointerInsideNotchRef.current && now - lastNotchPointerAt.current < 4000;
      if (
        shouldIdleClose({
          answerSettled: answerSettledRef.current,
          isSubmitting: isSubmittingRef.current,
          voiceCaptureState: voiceCaptureStateRef.current,
          queryLen: queryRef.current.trim().length,
          pointerHolding,
          recording: pttRecordingRef.current,
          idleElapsedMs: now - lastNotchActivityAt.current,
          idleThresholdMs: NOTCH_IDLE_CLOSE_MS
        })
      ) {
        hideNotch();
      }
    }, 350);
    return () => clearInterval(id);
  }, [hideNotch]);

  // Native recording truth: the ⌥⌃ tap emits `ptt:recording` {active} when a hold is
  // confirmed (~250ms) and again on release. The idle-close timer reads this ref so the
  // listening capsule can never auto-close mid-hold.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ active?: boolean }>('ptt:recording', (event) => {
      const active = Boolean(event.payload?.active);
      pttRecordingRef.current = active;
      gestureRecordingRef.current = active;
      klog('notch', 'debug', 'ptt recording', { active });
      // Feeble STT cues: a "boop" as recording starts, a "toing" on release.
      playRecordingCue(active);
      if (active) {
        // New hold → cancel any pending hide, fresh buffer, show the gesture overlay.
        if (gestureHideTimerRef.current != null) {
          clearTimeout(gestureHideTimerRef.current);
          gestureHideTimerRef.current = null;
        }
        // Assumes serialized holds: a re-hold during the previous hold's in-flight
        // STT resets its buffer, but that turn is normally superseded when the next
        // release aborts its controller, so the reset does not corrupt a live turn.
        gestureBufferRef.current = [];
        void (async () => {
          const bounds =
            capturedScreenRef.current?.displayBounds ??
            displayBoundsRef.current ??
            (await nativeBridge.getDisplayBounds().catch(() => null));
          if (!bounds) return;
          displayBoundsRef.current = bounds;
          await nativeBridge.showGestureOverlay(bounds);
        })();
      } else {
        // Release: DO NOT clear the buffer — processCapturedAudio composites it.
        // Let the on-screen strokes finish fading, then hide the (empty) overlay so
        // its render loop stops. Guarded so a new hold cancels the hide. This fires
        // during the STT/vision "thinking" phase, before any answer box is shown.
        if (gestureHideTimerRef.current != null) clearTimeout(gestureHideTimerRef.current);
        gestureHideTimerRef.current = window.setTimeout(() => {
          gestureHideTimerRef.current = null;
          if (!gestureRecordingRef.current) void nativeBridge.hideOverlay();
          // Wait out the full hold + fade (+margin) so the overlay isn't hidden
          // mid-fade, which would cut the animation short.
        }, gestureConfig.holdMs + gestureConfig.fadeMs + 300);
      }
    })
      .then((next) => {
        unlisten = next;
      })
      .catch(() => {
        /* browser preview / tests have no event bus */
      });
    return () => {
      unlisten?.();
      // Also clear the post-release hide timer so it can't fire after unmount.
      if (gestureHideTimerRef.current != null) {
        clearTimeout(gestureHideTimerRef.current);
        gestureHideTimerRef.current = null;
      }
    };
  }, []);

  // Buffer the native cursor:mouse stream (physical px, ~60 Hz) but only while a hold
  // is confirmed — processCapturedAudio segments this at release into truth strokes.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ x: number; y: number }>('cursor:mouse', (event) => {
      if (!gestureRecordingRef.current) return;
      gestureBufferRef.current.push({ x: event.payload.x, y: event.payload.y, t: performance.now() });
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

  // A quick ⌥⌃ tap opens the typing notch and emits `notch:focus-input` so the user can
  // start typing immediately.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('notch:focus-input', () => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>('input[data-notch-input]')?.focus();
      });
    })
      .then((next) => {
        unlisten = next;
      })
      .catch(() => {
        /* browser preview / tests have no event bus */
      });
    return () => unlisten?.();
  }, []);

  // Typing a follow-up counts as notch activity (keeps it open).
  useEffect(() => {
    queryRef.current = query;
    if (query.trim().length > 0) {
      noteNotchActivity();
    }
  }, [query, noteNotchActivity]);

  // The user moved on from what Kairo pointed at (app/tab switch, scroll, or click,
  // detected natively). Clear the stale box + companion cursor; keep the notch (its
  // own idle timer governs closing) so a follow-up is still one tap away.
  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  useEffect(() => {
    const pending = listen('context:changed', () => {
      // While a guide pointer is pending, the pointer-watch's poll already owns the
      // fade-on-scroll / re-show lifecycle — don't run the normal teardown (which
      // would fade the hint out from under the watch). Leave it to the watch.
      if (pointerWatchRef.current?.pending) {
        return;
      }
      void nativeBridge.hideOverlay();
      void nativeBridge.cursorRelease();
      void nativeBridge.disarmContextWatch();
      // Also clear the user's own pen drawing (marks + state) — they moved on.
      setAnnotations([]);
      void emit('annotation:clear', {});
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [nativeBridge]);

  // Native mouse-down coordinates (display points) + which button, emitted only while a
  // guide pointer is armed. Handed to the pointer-watch, which guards internally (in-box
  // + faded + button-match checks) and fires a click-turn on a valid click.
  useEffect(() => {
    const pending = listen<{ x: number; y: number; button?: 'left' | 'right' }>(
      'input:click',
      (event) => {
        const button: FollowButton = event.payload.button === 'right' ? 'right' : 'left';
        pointerWatchRef.current?.onClick({ x: event.payload.x, y: event.payload.y }, button);
      }
    );
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // The cursor finished flying to a pointed-at target → play the arrival "pop" here (the
  // cursor WebView is click-through, so its own audio is blocked; the notch's isn't).
  useEffect(() => {
    const pending = listen('cursor:arrived', () => {
      klog('notch', 'debug', 'cursor:arrived received');
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // Authoritatively drive the companion cursor's "don't auto-hide" flag from the notch's
  // own turn state: the pet stays visible for the WHOLE processing pass (thinking → gate
  // → vision, where isSubmitting is true) and resumes normal idle-hide the moment the
  // turn ends. This is a single source of truth — far more robust than inferring "active"
  // from scattered cursor:* events, several of which fire mid-turn.
  useEffect(() => {
    void nativeBridge.cursorActive(isSubmitting);
  }, [isSubmitting, nativeBridge]);

  // Live mic level (global event) → the capsule's listening waveform.
  useEffect(() => {
    const pending = listen<{ level: number }>('cursor:level', (event) => {
      const level = Math.max(0, Math.min(1, event.payload.level ?? 0));
      capsuleRef.current?.style.setProperty('--mic-level', String(level));
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  const setVoicePayload = useCallback(
    (state: VoiceCaptureState) => {
      const copy = voiceStatusCopy(state);
      const nextPayload: NotchPayload = {
        state: state === 'transcribing' ? 'thinking' : state === 'recording' ? 'listening' : 'captured',
        layout: state === 'transcribing' || state === 'recording' ? 'compact' : 'prompt',
        title: copy.title,
        detail: copy.detail
      };
      setPayload(nextPayload);
      void nativeBridge.showNotch(nextPayload);
    },
    [nativeBridge]
  );

  const voiceErrorTimeoutRef = useRef<number | null>(null);

  const showVoiceError = useCallback(
    (detail: string) => {
      // Voice failures show a brief, self-dismissing status — NOT the typing box.
      // A voice interaction should never dump the user into a text field. layout is
      // 'compact' (never 'prompt') so capsuleMode can't become 'typing'; the
      // voiceCaptureState 'error' drives the transient 'error' capsule, which
      // auto-closes to idle after VOICE_ERROR_VISIBLE_MS.
      if (voiceErrorTimeoutRef.current != null) {
        clearTimeout(voiceErrorTimeoutRef.current);
        voiceErrorTimeoutRef.current = null;
      }
      const nextPayload: NotchPayload = {
        state: 'captured',
        layout: 'compact',
        title: 'Voice',
        detail
      };
      // Set the payload LOCALLY only. Do NOT round-trip through nativeBridge.showNotch:
      // a state:'captured' native payload re-enters subscribeToNotchPayload, which resets
      // voiceCaptureState back to 'idle' (its "re-engage → typing" branch) and would
      // instantly hide this capsule. The notch panel is already visible from the PTT
      // promote, so the local capsule renders on its own.
      updateVoiceCaptureState('error');
      setPayload(nextPayload);
      void emit('cursor:idle', {});
      // Soft "nope" cue so the user knows nothing was heard.
      playSound('error');
      voiceErrorTimeoutRef.current = window.setTimeout(() => {
        voiceErrorTimeoutRef.current = null;
        // Only self-close if still showing THIS error — a new turn (user re-pressed
        // ⌥⌃) sets voiceCaptureState away from 'error' and drives its own lifecycle.
        if (voiceCaptureStateRef.current === 'error') {
          hideNotch();
        }
      }, VOICE_ERROR_VISIBLE_MS);
    },
    [hideNotch, updateVoiceCaptureState]
  );

  // Transcribe captured audio and run the tutor turn. Shared by the WebView
  // recorder.onstop path and the native push-to-talk `ptt:audio` event.
  // Paywalled: show + speak the cached upgrade line (bundled upgrade.wav — no Sarvam call),
  // then let the notch idle-close. Used the instant PTT is released for an out-of-credits user.
  const playUpgradeMessage = useCallback(
    async (signal: AbortSignal) => {
      stopAnswerPlayback();
      updateVoiceCaptureState('idle');
      setDetailHidden(false);
      setPayload({ state: 'showing_step', layout: 'answer', title: 'Kairo', detail: FREE_LIMIT_TEXT });
      // Play the bundled upgrade.wav AS the answer; the notch idle-close begins on settle.
      await playBufferedAnswer(upgradeAudioUrl, signal, () => noteNotchActivity());
    },
    [noteNotchActivity, playBufferedAnswer, stopAnswerPlayback, updateVoiceCaptureState]
  );

  const processCapturedAudio = useCallback(
    async (audioBase64: string, mimeType: string) => {
      // Open a new turn on re-engage. resetPreviousTurn() aborts the previous controller
      // and installs a fresh one (superseding any in-flight turn) AND tears down the old
      // box/watch/TTS, so a 2nd voice turn CANCELS the old one instead of being silently
      // dropped. Capture the signal AFTER the reset — it's the freshly-opened controller.
      resetPreviousTurn();
      // A new turn supersedes any lingering voice-error capsule + its auto-close timer.
      if (voiceErrorTimeoutRef.current != null) {
        clearTimeout(voiceErrorTimeoutRef.current);
        voiceErrorTimeoutRef.current = null;
      }
      // resetPreviousTurn just opened this turn's controller (always non-null after it).
      const signal = turnAbortRef.current!.signal;
      const turnLog = (turnLogSeqRef.current += 1); // log-only correlation id
      // Paywall FIRST — the instant PTT is released, check credits BEFORE any STT/gate/vision.
      // Out of free requests → play the cached upgrade line (no provider spend, no wait).
      if (await nativeBridge.checkPaywalled()) {
        if (signal.aborted) return;
        klog('notch', 'info', 'paywalled on ptt release → cached upgrade line', { epoch: turnLog });
        await playUpgradeMessage(signal);
        return;
      }
      // Approx WAV bytes from the base64 length (×3/4), so we can correlate a bad
      // transcript with what the native mic actually delivered (see the native
      // `captured audio` / `MIC LEAK` logs for held_s vs audio_s).
      const approxBytes = Math.floor((audioBase64.length * 3) / 4);
      klog('notch', 'info', 'ptt audio received', { epoch: turnLog, mimeType, bytes: approxBytes });
      updateVoiceCaptureState('transcribing');
      setVoicePayload('transcribing');
      void emit('cursor:thinking', {});
      // Capture the screen IN PARALLEL with transcription — it isn't a blocker, so
      // the tutor turn never waits on a screenshot afterwards. submitQuery →
      // askTutorFromNotch reuses this captured frame.
      capturedScreenRef.current = null;
      const capturePromise = nativeBridge
        .captureScreen()
        .then((result) => {
          capturedScreenRef.current = result;
        })
        .catch(() => {});
      try {
        const result = await nativeBridge.transcribeAudio({
          audioBase64,
          mimeType,
          filename: voiceFilenameForMimeType(mimeType)
        });
        // A newer turn superseded this one while STT ran → bail without touching
        // shared state; the newest turn drives voiceCaptureState to completion.
        if (signal.aborted) {
          klog('notch', 'info', 'ptt turn superseded during stt', { epoch: turnLog });
          return;
        }
        const transcript = result.text.trim();
        if (!transcript) {
          // Empty transcript → the brief self-dismissing voice-error capsule. Log it
          // explicitly so a recurrence is traceable to STT, not the mic-leak path.
          klog('notch', 'warn', 'ptt empty transcript → voice error capsule', {
            epoch: turnLog,
            bytes: approxBytes
          });
          showVoiceError('No speech was detected. Try again and speak a little louder.');
          return;
        }
        klog('notch', 'info', 'ptt transcript ok', { epoch: turnLog, transcript_len: transcript.length });
        setQuery(transcript);
        await capturePromise;
        // Freeze the hold's buffer, segment it into truth strokes, composite them
        // onto the clean release screenshot (full strength, independent of the
        // on-screen fade), and hand that image to the turn.
        const strokes = segmentGesturePath(gestureBufferRef.current, gestureConfig);
        gestureBufferRef.current = [];
        if (strokes.length > 0 && capturedScreenRef.current) {
          capturedScreenRef.current = await compositeMarks(capturedScreenRef.current, strokes);
          klog('notch', 'info', 'gesture marks composited', { strokes: strokes.length, epoch: turnLog });
          if (gestureConfig.debugImages && capturedScreenRef.current.imageBase64) {
            void nativeBridge.saveGestureDebugImage(capturedScreenRef.current.imageBase64);
          }
        }
        // Gesture marks present → force a screen turn (skip the gate) so the
        // composited screenshot always reaches fable.
        await submitQuery(transcript, 'voice', signal, strokes.length > 0);
      } catch (error) {
        // A superseded turn's STT failure must not clobber the newer turn's UI.
        if (signal.aborted) {
          return;
        }
        const detail =
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : 'Voice transcription failed. Try again.';
        klog('notch', 'error', 'ptt transcription failed → voice error capsule', {
          epoch: turnLog,
          detail
        });
        showVoiceError(detail);
      }
    },
    [
      nativeBridge,
      playUpgradeMessage,
      resetPreviousTurn,
      setVoicePayload,
      showVoiceError,
      submitQuery,
      updateVoiceCaptureState
    ]
  );

  useEffect(() => {
    document.documentElement.classList.add('notch-document');
    document.body.classList.add('notch-document');

    return () => {
      document.documentElement.classList.remove('notch-document');
      document.body.classList.remove('notch-document');
    };
  }, []);

  // NOTE: no WebView mic warm-up. Push-to-talk uses NATIVE cpal capture (build the
  // stream on ⌥⌃-down, drop it on release), so the mic is active ONLY while
  // recording. A WebView getUserMedia warm-up here kept the macOS mic indicator lit
  // for the whole session (WebKit doesn't drop it after track.stop()), so it's gone.

  // (The fallback-filler pre-synth at launch now lives in useTTSPlayback.)

  useEffect(() => {
    let isMounted = true;
    let unlisten: (() => void) | undefined;

    void subscribeToNotchPayload({
      listen,
      readCurrentPayload: () => nativeBridge.getCurrentNotchPayload(),
      onPayload: (nextPayload) => {
        if (!isMounted) {
          return;
        }
        if (nextPayload.state === 'captured') {
          isSubmittingRef.current = false;
          setQuery('');
          setIsSubmitting(false);
          updateVoiceCaptureState('idle');
          // Re-engage (tap → typing): tear down the prior turn's box/watch/TTS, and
          // return the cursor to mouse-follow (a tap has no listening halo). Also
          // resets answerSettled + activity so the just-opened typing box can't
          // auto-close under the user before they type.
          resetPreviousTurn();
          void nativeBridge.cursorRelease();
        }
        if (nextPayload.state === 'listening') {
          isSubmittingRef.current = false;
          setIsSubmitting(false);
          updateVoiceCaptureState('idle');
          // Re-engage (PTT promote): tear down the prior turn's box/watch/TTS. Do NOT
          // release the cursor here — ptt_promote already emitted cursor:listening to
          // show the halo, and cursorRelease would wipe it (fx='none').
          resetPreviousTurn();
          // Keep any pen drawing + its annotations through push-to-talk. The marks are
          // already synced into `annotations` (via annotation:sync), so DON'T emit
          // annotation:finish here — that makes the overlay fire annotation:done, which
          // flips the notch to the 'captured' (text) UI instead of the listening
          // capsule. Just drop the active tool.
          setActiveAnnotationTool(null);
        }
        setPayload(nextPayload);

        // No auto-listen: voice is native push-to-talk (⌥⌃), and ⌘⇧Space just opens
        // the notch for typing. The notch no longer starts a WebView mic capture on
        // a listening/captured payload.
      }
    })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch(() => {
        // Browser preview and tests run without the Tauri event bus.
      });

    return () => {
      isMounted = false;
      unlisten?.();
    };
  }, [nativeBridge, resetPreviousTurn, updateVoiceCaptureState]);

  useEffect(() => {
    let isMounted = true;
    const unlisteners: Array<() => void> = [];

    void Promise.all([
      listen<UserAnnotation>('annotation:add', (event) => {
        if (!isMounted) {
          return;
        }

        setAnnotations((currentAnnotations) => {
          const next = [...currentAnnotations, event.payload];
          klog('notch', 'debug', 'annotation added', { count: next.length });
          return next;
        });
      }),
      listen<UserAnnotation[]>('annotation:sync', (event) => {
        if (!isMounted) {
          return;
        }

        klog('notch', 'debug', 'annotations synced', { count: event.payload.length });
        setAnnotations(event.payload);
      }),
      listen('annotation:done', () => {
        if (!isMounted) {
          return;
        }

        const capturedPayload = activationStateToNotchPayload('captured');
        isSubmittingRef.current = false;
        setActiveAnnotationTool(null);
        setPayload(capturedPayload);
        setIsSubmitting(false);
        void nativeBridge.showNotch(capturedPayload);
      })
    ])
      .then((nextUnlisteners) => {
        unlisteners.push(...nextUnlisteners);
      })
      .catch(() => {
        // Browser preview and tests run without the Tauri event bus.
      });

    return () => {
      isMounted = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [nativeBridge]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isNotchDismissKey(event.key)) {
        return;
      }

      event.preventDefault();
      hideNotch();
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hideNotch]);

  // Native push-to-talk delivers the recorded WAV here on key-release; we transcribe
  // + run the turn. (Capture itself is native — instant, mic on only while held.)
  useEffect(() => {
    const pending = Promise.all([
      listen<{ audioBase64: string; mimeType: string }>('ptt:audio', (event) => {
        void processCapturedAudio(event.payload.audioBase64, event.payload.mimeType);
      })
    ]);
    return () => {
      void pending.then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()));
    };
  }, [processCapturedAudio]);

  // Single minimal status capsule (top-center). Live waveform while listening, a
  // pulse while thinking, animated bars while speaking, and it expands into the
  // input while typing (⌘⇧Space) / on an error. Idle → hidden.
  // While speaking (TTS) the capsule hides — the cursor carries the speaking state
  // (a calm pulse at the target) instead. So: listening / thinking / typing only.
  const capsuleMode: NotchCapsuleMode =
    payload.state === 'listening'
      ? 'listening'
      : !tts.isSpeaking && voiceCaptureState === 'error'
        ? 'error'
        : !tts.isSpeaking &&
            (isSubmitting ||
              payload.state === 'thinking' ||
              voiceCaptureState === 'transcribing' ||
              detailHidden)
          ? 'thinking'
          : !tts.isSpeaking && payload.layout === 'prompt'
            ? 'typing'
            : 'idle';

  // Tell native the capsule's rect so the notch panel is click-through everywhere
  // around the small capsule (the empty panel area otherwise swallows clicks). Also
  // re-report on capsule resize (e.g. the typing input growing). idle → clear (null).
  useEffect(() => {
    const report = () => {
      const el = capsuleRef.current;
      if (capsuleMode === 'idle' || !el) {
        void nativeBridge.setNotchHitRect(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      void nativeBridge.setNotchHitRect({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      });
    };
    report();
    const el = capsuleRef.current;
    if (capsuleMode === 'idle' || !el || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [capsuleMode, nativeBridge]);

  const noteCapsulePointer = () => {
    pointerInsideNotchRef.current = true;
    lastNotchPointerAt.current = performance.now();
    noteNotchActivity();
  };

  // Guarded typed submit: ignore an in-flight turn or an empty box; on failure clear
  // the submitting flag so the box stays usable.
  const handleTypedSubmit = () => {
    if (isSubmittingRef.current || query.trim().length === 0) {
      return;
    }
    submitQuery(query, 'typed').catch(() => {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    });
  };

  const statusLabel = capsuleMode === 'listening' ? 'Listening' : 'Thinking';

  return (
    <NotchCapsule
      mode={capsuleMode}
      statusLabel={statusLabel}
      detail={payload.detail}
      query={query}
      capsuleRef={capsuleRef}
      onQueryChange={setQuery}
      onSubmit={handleTypedSubmit}
      onHide={hideNotch}
      onCapsulePointer={noteCapsulePointer}
      onPointerLeave={() => {
        pointerInsideNotchRef.current = false;
      }}
      onPointerDown={() => {
        lastNotchPointerAt.current = performance.now();
        noteNotchActivity();
      }}
    />
  );
}
