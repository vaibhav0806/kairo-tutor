import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { activationStateToNotchPayload } from '../activation/activationState';
import { loadBrowserEnv } from '../config/env';
import { klog } from '../core/logger';
import type { TutorStep, UserAnnotation } from '../core/types';
import {
  createNativeBridge,
  type NativeContextBaseline,
  type NativeOverlayDisplayBounds,
  type NativeScreenCapture
} from '../native/nativeBridge';
import { type NotchAnnotationTool } from './annotationActions';
import { buildAudioDataUrl } from './audioPlayback';
import { createBufferedClip, createStreamingClip, type SpeechClip } from './streamingTts';
import { shouldIdleClose } from './idleClose';
import { subscribeToNotchPayload } from './notchEvents';
import { askTutorFromNotch } from './notchTutor';
import type { RevealTransition } from '../overlay/targetRouting';
import {
  getNotchInteractionState,
  isNotchDismissKey,
  waitForNotchPaint
} from './prompt';
import type { NotchPayload } from './types';
import {
  VOICE_SILENCE_THRESHOLD,
  blobToBase64,
  acquireMicrophoneStream,
  createVoiceRecorder,
  encodeWavFromFloat32Chunks,
  rmsFromTimeDomainData,
  shouldStopVoiceCapture,
  voiceFilenameForMimeType,
  voiceStatusCopy,
  type VoiceCaptureState
} from './voiceRecorder';

const defaultPayload: NotchPayload = {
  state: 'idle',
  layout: 'compact',
  title: 'Kairo is ready',
  detail: 'Press the shortcut to start'
};

// A voice failure (no speech / STT error) shows a brief, self-dismissing status
// capsule instead of the typing box — then auto-closes to idle after this long.
const VOICE_ERROR_VISIBLE_MS = 2400;

// Breathing pause between spoken steps of a walkthrough, so it doesn't feel rushed.
const STEP_GAP_MS = 700;
// Tight per-step TTS timeout: a stalled step synth fails fast → retried, instead of
// freezing the walkthrough. The full direct answer uses the generous native default.
const STEP_SYNTH_TIMEOUT_MS = 20_000;

// Recent conversation kept for continuity + analytics. The last HISTORY_TURNS are
// formatted into `recentContext` and sent to the tutor so a follow-up (or a resumed,
// interrupted walkthrough) has context. A larger buffer is retained for analytics.
const HISTORY_TURNS = 10;
const CONVERSATION_BUFFER = 50;
type ConversationTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; mode: string; saidSteps: string[]; completed: boolean; interrupted: boolean };

// After the answer finishes speaking, close the notch this long after the user
// stops interacting with it (also clears the box + companion cursor).
const NOTCH_IDLE_CLOSE_MS = 3000;
// Body copy shown under the title while the answer is being synthesized to speech,
// after the LLM has replied but before playback (and the visuals) begin.
const PREPARING_NEXT_STEP_TEXT = 'Preparing the next step';

// "Let me look" fillers, pre-synthesized at launch so they play INSTANTLY when the
// gate flags a screen question — no per-question TTS latency.
const FILLER_LINES = ['Let me take a look.', 'Sure, one sec.', 'Okay, let me check.', 'Let me see.'];
type QuerySource = 'typed' | 'voice';

function NotchIcon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="notch-icon"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.9}
      viewBox="0 0 24 24"
      width={size}
    >
      {children}
    </svg>
  );
}

const PenIcon = () => (
  <NotchIcon>
    <path d="M15.5 5.5l3 3" />
    <path d="M5 19l1-4L16.5 4.5a1.8 1.8 0 0 1 2.6 0l.4.4a1.8 1.8 0 0 1 0 2.6L9 18l-4 1z" />
  </NotchIcon>
);
const UndoIcon = () => (
  <NotchIcon>
    <path d="M9 7L4.5 11.5 9 16" />
    <path d="M4.5 11.5H15a4.5 4.5 0 0 1 0 9h-1.5" />
  </NotchIcon>
);
const ClearIcon = () => (
  <NotchIcon>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </NotchIcon>
);
const DoneIcon = () => (
  <NotchIcon>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </NotchIcon>
);
const CloseIcon = () => (
  <NotchIcon size={16}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </NotchIcon>
);
const MicIcon = () => (
  <NotchIcon>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
    <path d="M8.5 21h7" />
  </NotchIcon>
);
const StopIcon = () => (
  <svg aria-hidden="true" className="notch-icon" fill="currentColor" height="15" viewBox="0 0 24 24" width="15">
    <rect x="6.5" y="6.5" width="11" height="11" rx="3" />
  </svg>
);

const annotationTools: Array<{ label: string; icon: ReactNode; tool: NotchAnnotationTool }> = [
  { label: 'Pen', icon: <PenIcon />, tool: 'pen' }
];

function promptPlaceholder(payload: NotchPayload) {
  return payload.state === 'showing_step' ? 'Ask a follow-up' : 'Ask about this screen';
}

function annotationCountText(count: number) {
  if (count === 0) {
    return '';
  }

  return `${count} annotation${count === 1 ? '' : 's'}`;
}

export function NotchApp() {
  const [payload, setPayload] = useState<NotchPayload>(defaultPayload);
  // The answer body is held back until TTS playback actually starts, so the notch
  // never shows the answer text before it is spoken.
  const [detailHidden, setDetailHidden] = useState(false);
  // True while the answer is actually being spoken (TTS playing) — drives the
  // "Speaking" state of the status capsule.
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [query, setQuery] = useState('');
  const [annotations, setAnnotations] = useState<UserAnnotation[]>([]);
  const [activeAnnotationTool, setActiveAnnotationTool] = useState<NotchAnnotationTool | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [voiceCaptureState, setVoiceCaptureState] = useState<VoiceCaptureState>('idle');
  const isSubmittingRef = useRef(false);
  const voiceCaptureStateRef = useRef<VoiceCaptureState>('idle');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const answerAudioRef = useRef<SpeechClip | null>(null);
  // The status capsule element, for writing the live mic level (--mic-level).
  const capsuleRef = useRef<HTMLDivElement | null>(null);
  // Set true when the real answer supersedes the gate's "let me look" filler, so a
  // slow filler synth doesn't play over the answer.
  const fillerCancelRef = useRef(false);
  // Pre-synthesized filler audio (data URLs), used only as a fallback line.
  const fillerAudioUrlsRef = useRef<string[]>([]);
  // The currently-playing filler clip, kept separate from the answer so the answer
  // can QUEUE behind it (wait for it to finish) instead of cutting it off.
  const fillerAudioRef = useRef<SpeechClip | null>(null);
  // Resolves when the current filler finishes (or is cancelled); the answer awaits it.
  const fillerDoneRef = useRef<Promise<void> | null>(null);
  const fillerResolveRef = useRef<(() => void) | null>(null);
  // Bumped on every stopAnswerPlayback so a queued answer can detect it was
  // superseded by a newer turn while waiting for the filler, and not play stale.
  const playbackEpochRef = useRef(0);
  // Bumped on every new turn (voice re-engage OR typed submit). A turn captures its
  // epoch and bails after each await once a newer turn supersedes it, so a stale turn
  // never mutates shared state (payload/box/context-watch/TTS/voiceCaptureState).
  const turnEpochRef = useRef(0);
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
  // Backstop so the answer always "settles" even if the audio 'ended' event misfires.
  const settleFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Session memory: recent turns for continuity + analytics (what was actually
  // spoken, and whether a walkthrough was cut off). Never sent as-is beyond the last
  // HISTORY_TURNS (as `recentContext`).
  const conversationRef = useRef<ConversationTurn[]>([]);
  const activeAssistantTurnRef = useRef<Extract<ConversationTurn, { role: 'assistant' }> | null>(
    null
  );
  // Mirrors the prompt text so the idle check can tell "typing a follow-up" (block
  // close) from a merely focused-but-empty prompt (the autoFocus default).
  const queryRef = useRef('');
  const voiceMonitorCleanupRef = useRef<(() => void) | null>(null);
  const pcmCaptureCleanupRef = useRef<(() => void) | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const pcmSampleRateRef = useRef<number>(24_000);
  const audioChunksRef = useRef<Blob[]>([]);
  const voiceCancelledRef = useRef(false);
  const voiceHeardSpeechRef = useRef(false);
  // Call the latest startVoiceCapture without making it an effect dependency
  // (otherwise the payload subscription re-subscribes on every render and loops).
  const startVoiceCaptureRef = useRef<() => void>(() => {});
  // True while a push-to-talk (⌥⌃ hold) capture is in flight, so the monitor keeps
  // recording until release instead of auto-stopping on silence.
  const pttModeRef = useRef(false);
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
  const nativeBridge = useMemo(() => createNativeBridge(), []);
  const env = loadBrowserEnv();
  const interaction = getNotchInteractionState({
    payload,
    voiceState: voiceCaptureState,
    isSubmitting
  });
  const canSubmitCurrent =
    interaction.submitMode === 'voice'
      ? interaction.canUseVoice
      : interaction.canSubmitText && query.trim().length > 0;

  const stopVoiceTracks = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const updateVoiceCaptureState = useCallback((state: VoiceCaptureState) => {
    voiceCaptureStateRef.current = state;
    setVoiceCaptureState(state);
  }, []);

  const stopVoiceMonitor = useCallback(() => {
    voiceMonitorCleanupRef.current?.();
    voiceMonitorCleanupRef.current = null;
  }, []);

  const stopPcmCapture = useCallback(() => {
    pcmCaptureCleanupRef.current?.();
    pcmCaptureCleanupRef.current = null;
  }, []);

  const stopAnswerPlayback = useCallback(() => {
    setIsSpeaking(false);
    // Any new playback supersedes a pending gate filler.
    fillerCancelRef.current = true;
    // Supersede anything queued behind the filler (see playAnswerAudio).
    playbackEpochRef.current += 1;
    // Stop the filler clip + unblock any answer waiting on it.
    if (fillerAudioRef.current) {
      try {
        fillerAudioRef.current.pause();
      } catch {
        // ignore
      }
      fillerAudioRef.current = null;
    }
    if (fillerResolveRef.current) {
      fillerResolveRef.current();
      fillerResolveRef.current = null;
    }
    if (settleFallbackRef.current) {
      clearTimeout(settleFallbackRef.current);
      settleFallbackRef.current = null;
    }
    if (!answerAudioRef.current) {
      return;
    }

    answerAudioRef.current.pause();
    answerAudioRef.current.src = '';
    answerAudioRef.current = null;
  }, []);

  const noteNotchActivity = useCallback(() => {
    lastNotchActivityAt.current = performance.now();
  }, []);

  const markAnswerSettled = useCallback(() => {
    answerSettledRef.current = true;
    lastNotchActivityAt.current = performance.now();
  }, []);

  // ---- Session memory (continuity + analytics) --------------------------------
  // Format the last HISTORY_TURNS into the `recentContext` string sent to the tutor.
  const buildRecentContext = useCallback(() => {
    const turns = conversationRef.current.slice(-HISTORY_TURNS);
    if (turns.length === 0) return '';
    return turns
      .map((turn) => {
        if (turn.role === 'user') return `User: ${turn.text}`;
        const said = turn.saidSteps.map((s) => `"${s}"`).join(' | ');
        const status = turn.interrupted
          ? `${turn.mode}, interrupted after ${turn.saidSteps.length} step${turn.saidSteps.length === 1 ? '' : 's'}`
          : turn.mode;
        return `Kairo (${status}): ${said || '(no answer)'}`;
      })
      .join('\n');
  }, []);

  const recordUserTurn = useCallback((text: string) => {
    conversationRef.current.push({ role: 'user', text });
    if (conversationRef.current.length > CONVERSATION_BUFFER) {
      conversationRef.current = conversationRef.current.slice(-CONVERSATION_BUFFER);
    }
  }, []);

  const beginAssistantTurn = useCallback((mode: string) => {
    const turn = {
      role: 'assistant' as const,
      mode,
      saidSteps: [] as string[],
      completed: false,
      interrupted: false
    };
    conversationRef.current.push(turn);
    activeAssistantTurnRef.current = turn;
  }, []);

  const recordStepSpoken = useCallback((say: string) => {
    const turn = activeAssistantTurnRef.current;
    if (turn && say.trim()) {
      turn.saidSteps.push(say.trim());
    }
  }, []);

  const completeAssistantTurn = useCallback(() => {
    const turn = activeAssistantTurnRef.current;
    if (turn) {
      turn.completed = true;
    }
    activeAssistantTurnRef.current = null;
  }, []);

  // A new turn is starting: if the previous answer never finished (interrupted mid
  // walkthrough), record that so the next turn's recentContext knows where it stopped.
  const markTurnInterrupted = useCallback(() => {
    const turn = activeAssistantTurnRef.current;
    if (turn && !turn.completed) {
      turn.interrupted = true;
      klog('notch', 'info', 'walkthrough interrupted', {
        mode: turn.mode,
        spoken: turn.saidSteps.length
      });
    }
    activeAssistantTurnRef.current = null;
  }, []);

  // Tear down the PREVIOUS turn's visual + context state on re-engage (a new voice
  // hold or a tap-to-type), independent of submitQuery — which for voice only runs
  // after key-release + STT, far too late to stop the old box/watch/TTS lingering.
  const resetPreviousTurn = useCallback(() => {
    // Supersede any in-flight turn the INSTANT the user re-engages (PTT promote / tap /
    // typed submit), so a stale in-flight answer can no longer paint over the fresh
    // listening/typing UI or wipe pen marks. The next turn captures the bumped epoch.
    turnEpochRef.current += 1;
    // If a walkthrough was cut off mid-way, record it before the next turn starts.
    markTurnInterrupted();
    stopAnswerPlayback();
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
    } else {
      klog('notch', 'debug', 'reengage: clear overlay', { marks: marks.length });
      void nativeBridge.hideOverlay();
    }
    void nativeBridge.disarmContextWatch();
    // Fresh activity so the idle-close timer can't fire immediately after re-engage.
    lastNotchActivityAt.current = performance.now();
  }, [markTurnInterrupted, stopAnswerPlayback, nativeBridge]);

  const stopActiveRecording = useCallback(
    (cancelled = false) => {
      voiceCancelledRef.current = cancelled;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
        return true;
      }

      stopVoiceMonitor();
      stopPcmCapture();
      stopVoiceTracks();
      updateVoiceCaptureState('idle');
      return false;
    },
    [stopPcmCapture, stopVoiceMonitor, stopVoiceTracks, updateVoiceCaptureState]
  );

  const startVoiceMonitor = useCallback(
    // autoStop=false for push-to-talk: keep recording (and feeding the cursor halo)
    // until the user releases the keys, instead of stopping on detected silence.
    (stream: MediaStream, recorder: MediaRecorder, autoStop = true) => {
      stopVoiceMonitor();

      const AudioContextConstructor = globalThis.AudioContext;
      if (!AudioContextConstructor || !globalThis.requestAnimationFrame) {
        voiceHeardSpeechRef.current = true;
        const timeout = window.setTimeout(() => {
          if (recorder.state !== 'inactive') {
            recorder.stop();
          }
        }, 18_000);
        voiceMonitorCleanupRef.current = () => window.clearTimeout(timeout);
        return;
      }

      const audioContext = new AudioContextConstructor();
      void audioContext.resume().catch(() => {});
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      const data = new Uint8Array(analyser.fftSize);
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      let heardSpeech = false;
      let silenceStartedAt: number | null = null;
      const startedAt = performance.now();
      let frame = 0;
      let lastLevelEmit = 0;
      const maxTimeout = window.setTimeout(() => {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      }, 18_000);

      const tick = (now: number) => {
        if (recorder.state === 'inactive') {
          return;
        }

        analyser.getByteTimeDomainData(data);
        const rms = rmsFromTimeDomainData(data);
        // Feed the cursor's listening halo with the live mic level (throttled ~15fps).
        if (now - lastLevelEmit >= 66) {
          lastLevelEmit = now;
          void emit('cursor:level', { level: Math.min(1, rms / 0.15) });
        }
        if (rms >= VOICE_SILENCE_THRESHOLD) {
          heardSpeech = true;
          voiceHeardSpeechRef.current = true;
          silenceStartedAt = null;
        } else if (heardSpeech && silenceStartedAt === null) {
          silenceStartedAt = now;
        }

        const silenceMs = silenceStartedAt === null ? 0 : now - silenceStartedAt;
        if (
          autoStop &&
          shouldStopVoiceCapture({
            elapsedMs: now - startedAt,
            heardSpeech,
            silenceMs,
            rms
          })
        ) {
          recorder.stop();
          return;
        }

        frame = requestAnimationFrame(tick);
      };

      frame = requestAnimationFrame(tick);
      voiceMonitorCleanupRef.current = () => {
        cancelAnimationFrame(frame);
        window.clearTimeout(maxTimeout);
        source.disconnect();
        void audioContext.close();
      };
    },
    [stopVoiceMonitor]
  );

  const playAnswerAudio = useCallback(
    // `onSpeechStart` fires when playback actually begins (reveal the text +
    // visuals then); `onSettled` fires when playback ends, or immediately when
    // there is nothing to play, so the notch auto-close countdown can begin.
    async (text: string, onSpeechStart?: () => void, onSettled?: () => void) => {
      const trimmedText = text.trim();
      if (!trimmedText) {
        stopAnswerPlayback();
        // Nothing to speak: reveal immediately so the answer isn't left hidden.
        onSpeechStart?.();
        onSettled?.();
        return;
      }

      // Start STREAMING the answer NOW, while the "let me look" filler is still
      // playing, so Sarvam is already synthesizing and first audio is ready the
      // moment the filler ends (no silent gap). The clip plays progressively.
      const clip = createStreamingClip(nativeBridge, trimmedText);

      // QUEUE behind the filler: wait for it to finish rather than cutting it off.
      // Guarded by a timeout so a stuck filler can't wedge the answer forever.
      const epoch = playbackEpochRef.current;
      const pendingFiller = fillerDoneRef.current;
      fillerDoneRef.current = null;
      if (pendingFiller) {
        await Promise.race([
          pendingFiller,
          new Promise<void>((resolve) => setTimeout(resolve, 12000))
        ]);
      }
      // A newer turn superseded this one while we waited → don't play a stale answer.
      if (playbackEpochRef.current !== epoch) {
        clip.pause();
        return;
      }

      stopAnswerPlayback();

      answerAudioRef.current = clip;
      const audio = clip;
      // Reveal the answer text + teaching visuals the instant speech begins.
      audio.onplay = () => {
        setIsSpeaking(true);
        onSpeechStart?.();
        // Cursor shows a calm speaking pulse (survives the fly-to-target).
        void emit('cursor:speaking', {});
        // Backstop: guarantee the answer settles (so auto-close can run) even if
        // 'ended' never fires. Cleared by 'ended' or a new turn (stopAnswerPlayback).
        if (settleFallbackRef.current) {
          clearTimeout(settleFallbackRef.current);
        }
        settleFallbackRef.current = setTimeout(() => onSettled?.(), 60000);
      };
      audio.onended = () => {
        setIsSpeaking(false);
        void emit('cursor:idle', {});
        if (settleFallbackRef.current) {
          clearTimeout(settleFallbackRef.current);
          settleFallbackRef.current = null;
        }
        onSettled?.();
      };
      try {
        await audio.play();
      } catch {
        // Playback is best-effort; reveal + settle so nothing is left hidden.
        onSpeechStart?.();
        onSettled?.();
      }
    },
    [nativeBridge, stopAnswerPlayback]
  );

  // Play a multi-step answer: speak each step's `say` in order while revealing that
  // step's box/cursor, with a breathing gap between. All step audio is synthesized
  // in PARALLEL up front, so the next clip is ready before the current ends — the
  // only pause between steps is the intentional STEP_GAP_MS. Interruptible: a new
  // turn bumps playbackEpoch (via stopAnswerPlayback) and every await bails.
  const playSteps = useCallback(
    async (
      steps: TutorStep[],
      revealStep: (step: TutorStep, transition?: RevealTransition) => Promise<void>,
      onFirstSpeechStart?: () => void,
      onSettled?: () => void,
      onStepStart?: (index: number, step: TutorStep) => void
    ) => {
      if (steps.length === 0) {
        onFirstSpeechStart?.();
        onSettled?.();
        return;
      }

      // Each step is a STREAMING clip: constructing it kicks off synthesis right away
      // (so it's effectively prefetched) and playback begins at first byte. A clip's
      // own buffered fallback covers a failed stream, so no step is left silent.
      // null = empty text (nothing to speak).
      const clips: Array<SpeechClip | null | undefined> = new Array(steps.length);
      const stopClips = () => {
        for (const clip of clips) {
          if (clip) {
            try {
              clip.pause();
            } catch {
              // ignore
            }
          }
        }
      };

      // Prefetch window: keep at most 2 synths in flight. Sarvam's bulbul:v3 stalls
      // several simultaneous requests, so we DON'T create all N at once — we create
      // step i+1 and i+2 as each step starts playing, spreading requests across
      // playback (also keeps us well under the per-minute rate).
      const prefetch = (index: number) => {
        if (index < steps.length && clips[index] === undefined) {
          const say = steps[index].say.trim();
          clips[index] = say ? createStreamingClip(nativeBridge, say, STEP_SYNTH_TIMEOUT_MS) : null;
        }
      };
      prefetch(0);
      prefetch(1);

      // Queue behind the "let me look" filler (mirror playAnswerAudio).
      const epoch = playbackEpochRef.current;
      const pendingFiller = fillerDoneRef.current;
      fillerDoneRef.current = null;
      if (pendingFiller) {
        await Promise.race([pendingFiller, new Promise<void>((resolve) => setTimeout(resolve, 12000))]);
      }
      if (playbackEpochRef.current !== epoch) {
        stopClips();
        return;
      }

      // stopAnswerPlayback() bumps playbackEpoch, so capture the epoch to check the
      // loop against AFTER it — otherwise the first iteration sees epoch+1 and bails
      // immediately (nothing ever plays). A genuinely newer turn bumps it again,
      // which still makes every await below bail correctly.
      stopAnswerPlayback();
      const playEpoch = playbackEpochRef.current;

      let firstSpoken = false;
      // The first box a walkthrough shows is drawn; once it's on screen, later
      // steps glide the same box to the next target instead of re-popping it.
      let boxOnScreen = false;
      const startStep = (index: number) => {
        const step = steps[index];
        onStepStart?.(index, step);
        if (!firstSpoken) {
          firstSpoken = true;
          onFirstSpeechStart?.();
        }
        const hasBox = step.visualTargets.some((target) => target.kind === 'highlight_box');
        const transition: RevealTransition = hasBox && boxOnScreen ? 'glide' : 'draw';
        boxOnScreen = hasBox;
        void revealStep(step, transition);
        // Keep 2 steps ahead prefetched (fires i+2 as i starts; i+1 already in flight).
        prefetch(index + 1);
        prefetch(index + 2);
      };

      for (let i = 0; i < steps.length; i += 1) {
        if (playbackEpochRef.current !== playEpoch) {
          stopClips();
          return; // superseded → stop
        }
        prefetch(i); // safety: ensure this step's clip was created
        const clip = clips[i] ?? null;

        if (!clip) {
          // No audio (empty step): still reveal the step briefly.
          startStep(i);
          await new Promise<void>((resolve) => setTimeout(resolve, 900));
        } else {
          await new Promise<void>((resolve) => {
            answerAudioRef.current = clip;
            let done = false;
            const finish = () => {
              if (!done) {
                done = true;
                resolve();
              }
            };
            clip.onplay = () => {
              setIsSpeaking(true);
              startStep(i);
              void emit('cursor:speaking', {});
            };
            clip.onended = () => {
              setIsSpeaking(false);
              finish();
            };
            // stopAnswerPlayback (a new turn / interruption) pauses the clip, which
            // fires 'pause' — unblock the loop so the epoch check below bails.
            clip.onpause = finish;
            clip.onerror = finish;
            void clip.play().catch(finish);
          });
        }

        if (playbackEpochRef.current !== playEpoch) {
          stopClips();
          return;
        }
        // Breathing gap between steps (not after the last).
        if (i < steps.length - 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, STEP_GAP_MS));
        }
      }

      if (playbackEpochRef.current !== playEpoch) {
        stopClips();
        return;
      }
      setIsSpeaking(false);
      void emit('cursor:idle', {});
      onSettled?.();
    },
    [nativeBridge, stopAnswerPlayback]
  );

  // Phase 1 gate: text-only "do I need to look at the screen?". Returns the parsed
  // { needsScreen, voiceText }; defaults to looking on any failure.
  const runGate = useCallback(
    async (query: string): Promise<{ needsScreen: boolean; voiceText: string }> => {
      const fallback = { needsScreen: true, voiceText: '' };
      try {
        const active =
          capturedScreenRef.current?.activeApp ??
          (await nativeBridge.getActiveApp().catch(() => null));
        const raw = await nativeBridge.runGateTurn({
          userQuery: query,
          activeApp: active?.activeApp,
          windowTitle: active?.windowTitle ?? undefined
        });
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) {
          return fallback;
        }
        const parsed = JSON.parse(raw.slice(start, end + 1));
        return {
          needsScreen: Boolean(parsed.needsScreen),
          voiceText: typeof parsed.voiceText === 'string' ? parsed.voiceText : ''
        };
      } catch {
        return fallback;
      }
    },
    [nativeBridge]
  );

  // Speak the gate's "let me look" filler while the vision turn runs. Guarded so a
  // slow synth never plays over the real answer.
  const speakFiller = useCallback(
    async (text: string, turnEpoch: number) => {
      fillerCancelRef.current = false;
      // Set up the "filler finished" signal the answer will queue behind.
      let resolveDone: () => void = () => {};
      fillerDoneRef.current = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      fillerResolveRef.current = resolveDone;
      const finishFiller = () => {
        fillerAudioRef.current = null;
        fillerResolveRef.current?.();
        fillerResolveRef.current = null;
      };
      const startClip = (audio: SpeechClip) => {
        fillerAudioRef.current = audio;
        audio.onended = finishFiller;
        audio.onerror = finishFiller;
        // A barge-in (stopAnswerPlayback) pauses the clip → unblock the answer.
        audio.onpause = finishFiller;
      };

      const trimmed = text.trim();
      // Preferred: speak the gate's OWN contextual filler (references the question,
      // e.g. "let me look at that button"). STREAMED so it starts at first byte.
      if (trimmed) {
        // Supersede check up front — streaming plays as it arrives, so unlike the old
        // buffered path there's no synth window to become stale within.
        if (fillerCancelRef.current || turnEpochRef.current !== turnEpoch) {
          finishFiller();
          return;
        }
        try {
          const clip = createStreamingClip(nativeBridge, trimmed);
          startClip(clip);
          await clip.play();
          return;
        } catch {
          // fall through to the generic cached fallback
        }
      }
      // Fallback: a generic pre-synthesized line (gate returned no text / synth failed).
      const cached = fillerAudioUrlsRef.current;
      if (cached.length > 0 && !fillerCancelRef.current && turnEpochRef.current === turnEpoch) {
        const url = cached[Math.floor(Math.random() * cached.length)];
        const audio = createBufferedClip(url);
        startClip(audio);
        void audio.play().catch(finishFiller);
        return;
      }
      // Nothing played → unblock the answer immediately.
      finishFiller();
    },
    [nativeBridge]
  );

  const submitQuery = useCallback(
    async (nextQuery: string, source: QuerySource = 'typed', epoch?: number) => {
      const trimmedQuery = nextQuery.trim();
      if (!trimmedQuery) {
        return;
      }
      // Turn epoch. Voice passes the epoch stamped in processCapturedAudio (so the
      // re-engage teardown and this turn share one epoch); the typed path opens a
      // fresh turn here. A newer turn bumping the epoch supersedes this one — that
      // REPLACES the old isSubmitting drop-guard (no more silently-dropped turns).
      const turnEpoch = epoch === undefined ? (turnEpochRef.current += 1) : epoch;

      // Diagnostic: which input started this turn (pairs with the native STT
      // transcript + gate question/answer lines in the same log file).
      klog('notch', 'info', 'ask submit', { source, query_len: trimmedQuery.length });

      // Session memory: capture the recent conversation BEFORE recording this turn,
      // then record the user's question. `recentContext` gives the tutor continuity.
      const recentContext = buildRecentContext();
      recordUserTurn(trimmedQuery);

      const thinkingPayload = activationStateToNotchPayload('thinking');
      stopAnswerPlayback();
      // A new turn supersedes the last answer: mark it unsettled (blocks auto-close)
      // and stop watching the old target.
      answerSettledRef.current = false;
      void nativeBridge.disarmContextWatch();
      // Release any lingering pointing so the cursor shadows the mouse while the
      // new answer is computed; it flies again only if the answer has a target.
      void nativeBridge.cursorRelease();
      // Also drop the previous turn's box (covers the typed path; belt-and-suspenders
      // for voice, where resetPreviousTurn already hid it on re-engage).
      void nativeBridge.hideOverlay();
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
        const gate =
          source === 'voice' && annotations.length === 0
            ? await runGate(trimmedQuery)
            : { needsScreen: true, voiceText: '' };
        // A newer turn superseded this one while the gate ran → stop mutating shared state.
        if (turnEpochRef.current !== turnEpoch) return;
        const needsScreen = source === 'typed' || annotations.length > 0 || gate.needsScreen;

        // Diagnostic: which route this turn took and whether the gate actually ran,
        // so an "unrelated answer" can be traced to the gate vs the vision turn.
        klog('notch', 'info', 'gate decision', {
          source,
          gate_ran: source === 'voice' && annotations.length === 0,
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
          beginAssistantTurn('single');
          recordStepSpoken(directPayload.detail);
          void playAnswerAudio(
            directPayload.detail,
            () => {
              setDetailHidden(false);
              void nativeBridge.hideOverlay();
            },
            () => {
              completeAssistantTurn();
              markAnswerSettled();
            }
          );
          return;
        }

        // Phase 2: needs the screen. ALWAYS play a "let me look" filler while the
        // vision turn runs (cached → instant), including annotation asks where the
        // gate is skipped and there's no gate voiceText.
        void speakFiller(gate.voiceText || 'Let me take a look.', turnEpoch);

        const {
          payload: answerPayload,
          steps,
          revealStep,
          revealVisuals,
          context
        } = await askTutorFromNotch({
          query: trimmedQuery,
          nativeBridge,
          aiProvider: env.aiProvider,
          defaultSkill: env.defaultSkill,
          annotations,
          screenCapture: capturedScreenRef.current,
          recentContext,
          // What the gate just spoke aloud, so the tutor continues instead of re-greeting.
          spokenIntro: gate.voiceText || 'Let me take a look.'
        });
        // A newer turn superseded this one while the tutor ran → don't paint a stale
        // answer, don't play its audio, don't arm a watch for the old target.
        if (turnEpochRef.current !== turnEpoch) return;

        // Hold the box + cursor until speech starts; reveal them together with the
        // text so nothing points at the screen while the notch is still silent.
        revealVisualsRef.current = revealVisuals;
        contextBaselineRef.current = context;

        setPayload(answerPayload);
        setDetailHidden(true);
        setQuery('');
        setAnnotations([]);
        setActiveAnnotationTool(null);
        void nativeBridge.showNotch(answerPayload);

        // Arm the context watch once (after the final step reveals its box) so
        // mid-walkthrough scrolling doesn't tear a step down under the user.
        const armWatch = () => {
          if (contextBaselineRef.current) {
            void nativeBridge.armContextWatch(contextBaselineRef.current);
          }
        };

        if (steps.length > 0) {
          beginAssistantTurn(steps.length > 1 ? 'steps' : 'single');
          void playSteps(
            steps,
            revealStep,
            () => {
              // First step speaking: reveal the answer text; per-step visuals are
              // revealed inside playSteps.
              setDetailHidden(false);
              void emit('cursor:idle', {});
            },
            () => {
              completeAssistantTurn();
              armWatch();
              markAnswerSettled();
            },
            (_index, step) => recordStepSpoken(step.say)
          );
        } else {
          void playAnswerAudio(
            answerPayload.detail,
            () => {
              setDetailHidden(false);
              void emit('cursor:idle', {});
              void revealVisualsRef.current().then(armWatch);
            },
            () => {
              markAnswerSettled();
            }
          );
        }
      } finally {
        // Only the CURRENT turn owns the submitting flag; a superseded turn must not
        // clear it out from under the newer turn that now owns it.
        if (turnEpochRef.current === turnEpoch) {
          isSubmittingRef.current = false;
          setIsSubmitting(false);
        }
      }
    },
    [
      annotations,
      markAnswerSettled,
      env.aiProvider,
      env.defaultSkill,
      nativeBridge,
      beginAssistantTurn,
      buildRecentContext,
      completeAssistantTurn,
      recordStepSpoken,
      recordUserTurn,
      playAnswerAudio,
      playSteps,
      runGate,
      speakFiller,
      stopAnswerPlayback,
      updateVoiceCaptureState
    ]
  );

  // Arm the context watcher for a FINALIZED user drawing, so tab/window switch,
  // scroll, or click clears it (same reset as Kairo's own box). Only called once the
  // pen is off — never mid-stroke, or the drawing gestures would clear themselves.
  const armAnnotationWatch = useCallback(async () => {
    if (annotationsRef.current.length === 0) {
      return;
    }
    const active =
      capturedScreenRef.current?.activeApp ??
      (await nativeBridge.getActiveApp().catch(() => null));
    await nativeBridge.armContextWatch({
      bundleId: active?.bundleId,
      windowTitle: active?.windowTitle ?? undefined
    });
  }, [nativeBridge]);

  const startAnnotation = useCallback(
    async (tool: NotchAnnotationTool) => {
      // Tapping the already-active tool toggles it off: stop drawing and let the
      // overlay become click-through preview (drawn marks stay visible).
      if (activeAnnotationTool === tool) {
        setActiveAnnotationTool(null);
        void emit('annotation:finish', {});
        void armAnnotationWatch();
        return;
      }
      setActiveAnnotationTool(tool);
      // Show the drawing overlay from the notch (the main window's webview is
      // hidden/suspended, so its listener can't be relied on). Reuse the
      // voice-start screenshot's bounds, else fetch the display bounds natively.
      const bounds =
        capturedScreenRef.current?.displayBounds ?? (await nativeBridge.getDisplayBounds());
      // Cache the bounds so re-engage can re-assert the marks as a preview (see
      // resetPreviousTurn) without a fresh native round-trip.
      displayBoundsRef.current = bounds;
      klog('notch', 'info', 'pen annotation started', { tool });
      await nativeBridge.showAnnotationOverlay(bounds, tool);
    },
    [activeAnnotationTool, armAnnotationWatch, nativeBridge]
  );

  const finishAnnotation = useCallback(() => {
    setActiveAnnotationTool(null);
    void emit('annotation:finish', {});
    void armAnnotationWatch();
  }, [armAnnotationWatch]);

  const undoAnnotation = useCallback(() => {
    void emit('annotation:undo', {});
  }, []);

  const clearAnnotations = useCallback(() => {
    setAnnotations([]);
    setActiveAnnotationTool(null);
    void emit('annotation:clear', {});
  }, []);

  const hideNotch = useCallback(() => {
    stopAnswerPlayback();
    answerSettledRef.current = false;
    pointerInsideNotchRef.current = false;
    void nativeBridge.disarmContextWatch();
    voiceCancelledRef.current = true;
    stopActiveRecording(true);
    mediaRecorderRef.current = null;
    stopPcmCapture();
    stopVoiceMonitor();
    stopVoiceTracks();
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
  }, [
    nativeBridge,
    stopActiveRecording,
    stopAnswerPlayback,
    stopPcmCapture,
    stopVoiceMonitor,
    stopVoiceTracks,
    updateVoiceCaptureState
  ]);

  // Periodic idle-close: closes only after the answer has finished speaking AND the
  // notch has sat untouched for NOTCH_IDLE_CLOSE_MS. Hovering (pointer inside, with a
  // missed-leave recovery after 4s of no pointer events) or typing keeps it open.
  // Nothing here reacts to other apps, so scrolling/clicking/switching elsewhere
  // never keeps it open or forces it closed.
  useEffect(() => {
    const id = setInterval(() => {
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
      pttRecordingRef.current = Boolean(event.payload?.active);
      klog('notch', 'debug', 'ptt recording', { active: pttRecordingRef.current });
    })
      .then((next) => {
        unlisten = next;
      })
      .catch(() => {
        /* browser preview / tests have no event bus */
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
  const processCapturedAudio = useCallback(
    async (audioBase64: string, mimeType: string) => {
      // Open a new turn on re-engage. resetPreviousTurn() bumps the epoch (superseding
      // any in-flight turn) AND tears down the old box/watch/TTS, so a 2nd voice turn
      // CANCELS the old one instead of being silently dropped. Capture the epoch AFTER
      // the reset's bump — capturing before would make this new turn supersede itself.
      resetPreviousTurn();
      // A new turn supersedes any lingering voice-error capsule + its auto-close timer.
      if (voiceErrorTimeoutRef.current != null) {
        clearTimeout(voiceErrorTimeoutRef.current);
        voiceErrorTimeoutRef.current = null;
      }
      const epoch = turnEpochRef.current;
      // Approx WAV bytes from the base64 length (×3/4), so we can correlate a bad
      // transcript with what the native mic actually delivered (see the native
      // `captured audio` / `MIC LEAK` logs for held_s vs audio_s).
      const approxBytes = Math.floor((audioBase64.length * 3) / 4);
      klog('notch', 'info', 'ptt audio received', { epoch, mimeType, bytes: approxBytes });
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
        if (turnEpochRef.current !== epoch) {
          klog('notch', 'info', 'ptt turn superseded during stt', { epoch });
          return;
        }
        const transcript = result.text.trim();
        if (!transcript) {
          // Empty transcript → the brief self-dismissing voice-error capsule. Log it
          // explicitly so a recurrence is traceable to STT, not the mic-leak path.
          klog('notch', 'warn', 'ptt empty transcript → voice error capsule', {
            epoch,
            bytes: approxBytes
          });
          showVoiceError('No speech was detected. Try again and speak a little louder.');
          return;
        }
        klog('notch', 'info', 'ptt transcript ok', { epoch, transcript_len: transcript.length });
        setQuery(transcript);
        await capturePromise;
        await submitQuery(transcript, 'voice', epoch);
      } catch (error) {
        // A superseded turn's STT failure must not clobber the newer turn's UI.
        if (turnEpochRef.current !== epoch) {
          return;
        }
        const detail =
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : 'Voice transcription failed. Try again.';
        klog('notch', 'error', 'ptt transcription failed → voice error capsule', {
          epoch,
          detail
        });
        showVoiceError(detail);
      }
    },
    [nativeBridge, resetPreviousTurn, setVoicePayload, showVoiceError, submitQuery, updateVoiceCaptureState]
  );

  const startVoiceCapture = useCallback(async () => {
    stopAnswerPlayback();
    if (!globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
      showVoiceError('Microphone recording is unavailable in this runtime.');
      return;
    }

    // Capture the screen exactly when voice capture starts — async so it never
    // blocks recording. The tutor turn reuses this instead of re-capturing.
    capturedScreenRef.current = null;
    void nativeBridge
      .captureScreen()
      .then((result) => {
        capturedScreenRef.current = result;
      })
      .catch(() => {});

    try {
      const stream = await acquireMicrophoneStream();
      const { recorder, mimeType } = createVoiceRecorder(stream);
      const AudioContextConstructor = globalThis.AudioContext;
      voiceCancelledRef.current = false;
      voiceHeardSpeechRef.current = false;
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      pcmChunksRef.current = [];

      if (AudioContextConstructor) {
        const audioContext = new AudioContextConstructor();
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        const sink = audioContext.createGain();
        sink.gain.value = 0;

        pcmSampleRateRef.current = audioContext.sampleRate;
        processor.onaudioprocess = (event) => {
          if (voiceCaptureStateRef.current !== 'recording') {
            return;
          }

          const channel = event.inputBuffer.getChannelData(0);
          pcmChunksRef.current.push(new Float32Array(channel));
        };

        source.connect(processor);
        processor.connect(sink);
        sink.connect(audioContext.destination);
        void audioContext.resume().catch(() => {});

        pcmCaptureCleanupRef.current = () => {
          processor.onaudioprocess = null;
          source.disconnect();
          processor.disconnect();
          sink.disconnect();
          void audioContext.close().catch(() => {});
        };
      }

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        stopVoiceMonitor();
        stopPcmCapture();
        const wasCancelled = voiceCancelledRef.current;
        const chunks = audioChunksRef.current;
        const pcmChunks = pcmChunksRef.current;
        const pcmSampleRate = pcmSampleRateRef.current;
        const recordingMimeType = recorder.mimeType || mimeType || 'audio/webm';
        mediaRecorderRef.current = null;
        stopVoiceTracks();
        audioChunksRef.current = [];
        pcmChunksRef.current = [];

        if (wasCancelled) {
          updateVoiceCaptureState('idle');
          void emit('cursor:idle', {});
          return;
        }

        void (async () => {
          if (chunks.length === 0) {
            showVoiceError('No speech was captured. Try again and speak after the shortcut.');
            return;
          }

          // Note: we intentionally do NOT gate on the local VAD (voiceHeardSpeech)
          // here. The VAD uses an AudioContext that browsers keep suspended until
          // a user gesture, so an auto-started capture (from the shortcut, no
          // gesture) sees silence even though MediaRecorder captured real audio.
          // Always transcribe; an empty transcript below is the real "no speech".
          updateVoiceCaptureState('transcribing');
          setVoicePayload('transcribing');
          // Cursor switches from listening halo to a thinking swirl while we work.
          void emit('cursor:thinking', {});
          try {
            const uploadBlob =
              pcmChunks.length > 0
                ? encodeWavFromFloat32Chunks(pcmChunks, pcmSampleRate)
                : new Blob(chunks, { type: recordingMimeType });
            const uploadMimeType = pcmChunks.length > 0 ? 'audio/wav' : recordingMimeType;
            const audioBase64 = await blobToBase64(uploadBlob);
            const result = await nativeBridge.transcribeAudio({
              audioBase64,
              mimeType: uploadMimeType,
              filename: voiceFilenameForMimeType(uploadMimeType)
            });
            const transcript = result.text.trim();
            if (!transcript) {
              showVoiceError('No speech was detected. Try again and speak a little louder.');
              return;
            }

            setQuery(transcript);
            await submitQuery(transcript, 'voice');
          } catch (error) {
            const detail =
              error instanceof Error && error.message.trim()
                ? error.message.trim()
                : 'Voice transcription failed. Try again.';
            showVoiceError(detail);
          }
        })();
      };

      recorder.start(250);
      startVoiceMonitor(stream, recorder, !pttModeRef.current);
      updateVoiceCaptureState('recording');
      setVoicePayload('recording');
      // Cursor shows the listening state (voice-reactive halo + live core color).
      void emit('cursor:listening', {});
    } catch (error) {
      stopVoiceTracks();
      const detail =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'Check microphone access and try again.';
      showVoiceError(detail);
    }
  }, [
    nativeBridge,
    setVoicePayload,
    showVoiceError,
    startVoiceMonitor,
    stopAnswerPlayback,
    stopPcmCapture,
    stopVoiceTracks,
    stopVoiceMonitor,
    submitQuery,
    updateVoiceCaptureState
  ]);

  startVoiceCaptureRef.current = () => {
    void startVoiceCapture();
  };

  const toggleVoiceCapture = useCallback(() => {
    if (voiceCaptureStateRef.current === 'recording') {
      stopActiveRecording(false);
      return;
    }

    void startVoiceCapture();
  }, [startVoiceCapture, stopActiveRecording]);

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

  // Pre-synthesize the fallback fillers once at launch (used only if the gate's own
  // contextual filler can't be synthesized).
  // when the gate flags a screen question (no per-question TTS latency).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const line of FILLER_LINES) {
        try {
          const result = await nativeBridge.synthesizeSpeech({ text: line });
          const url = buildAudioDataUrl(result);
          if (!cancelled && url) {
            fillerAudioUrlsRef.current.push(url);
          }
        } catch {
          // Best-effort; speakFiller falls back to on-demand synth.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nativeBridge]);

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
        if (nextPayload.state === 'captured' && !mediaRecorderRef.current) {
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
        if (nextPayload.state === 'listening' && !mediaRecorderRef.current) {
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
      }),
      listen('voice:start', () => {
        if (!isMounted || isSubmittingRef.current) {
          return;
        }

        if (voiceCaptureStateRef.current === 'recording') {
          stopActiveRecording(false);
          return;
        }

        void startVoiceCapture();
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
  }, [nativeBridge, startVoiceCapture, stopActiveRecording]);

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
  // Plus the pen shortcut (⌥⇧P).
  useEffect(() => {
    const pending = Promise.all([
      listen<{ audioBase64: string; mimeType: string }>('ptt:audio', (event) => {
        void processCapturedAudio(event.payload.audioBase64, event.payload.mimeType);
      }),
      listen('pen:toggle', () => {
        void startAnnotation('pen');
      })
    ]);
    return () => {
      void pending.then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()));
    };
  }, [processCapturedAudio, startAnnotation]);

  // Single minimal status capsule (top-center). Live waveform while listening, a
  // pulse while thinking, animated bars while speaking, and it expands into the
  // input while typing (⌘⇧Space) / on an error. Idle → hidden.
  // While speaking (TTS) the capsule hides — the cursor carries the speaking state
  // (a calm pulse at the target) instead. So: listening / thinking / typing only.
  const capsuleMode: 'listening' | 'thinking' | 'typing' | 'error' | 'idle' =
    payload.state === 'listening'
      ? 'listening'
      : !isSpeaking && voiceCaptureState === 'error'
        ? 'error'
        : !isSpeaking &&
            (isSubmitting ||
              payload.state === 'thinking' ||
              voiceCaptureState === 'transcribing' ||
              detailHidden)
          ? 'thinking'
          : !isSpeaking && payload.layout === 'prompt'
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

  const statusLabel = capsuleMode === 'listening' ? 'Listening' : 'Thinking';

  return (
    <main className="kairo-capsule-shell" aria-label="Kairo status">
      {capsuleMode === 'idle' ? null : (
        <div
          ref={capsuleRef}
          className="kairo-capsule"
          data-mode={capsuleMode}
          onPointerEnter={noteCapsulePointer}
          onPointerMove={noteCapsulePointer}
          onPointerLeave={() => {
            pointerInsideNotchRef.current = false;
          }}
          onPointerDown={() => {
            lastNotchPointerAt.current = performance.now();
            noteNotchActivity();
          }}
        >
          {capsuleMode === 'typing' ? (
            <form
              className="kairo-capsule-prompt"
              onSubmit={(event) => {
                event.preventDefault();
                if (isSubmittingRef.current || query.trim().length === 0) {
                  return;
                }
                submitQuery(query, 'typed').catch(() => {
                  isSubmittingRef.current = false;
                  setIsSubmitting(false);
                });
              }}
            >
              <input
                aria-label="Ask Kairo"
                autoFocus
                data-notch-input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Ask about this screen — or hold ⌥⌃ to talk"
                value={query}
              />
              <button
                aria-label="Toggle pen"
                className="kairo-capsule-icon"
                data-active={activeAnnotationTool === 'pen' ? 'true' : 'false'}
                title="Pen (⌥⇧P)"
                type="button"
                onClick={() => startAnnotation('pen')}
              >
                <PenIcon />
              </button>
              <button
                className="kairo-capsule-ask"
                disabled={query.trim().length === 0}
                type="submit"
              >
                Ask
              </button>
              <button
                aria-label="Hide Kairo"
                className="kairo-capsule-icon"
                title="Close"
                type="button"
                onClick={hideNotch}
              >
                <CloseIcon />
              </button>
            </form>
          ) : capsuleMode === 'error' ? (
            <div className="kairo-capsule-status kairo-capsule-status-error" role="status">
              <span className="kairo-capsule-label">
                {payload.detail || "Didn't catch that — hold ⌥⌃ and speak"}
              </span>
            </div>
          ) : (
            <div className="kairo-capsule-status">
              <span className="kairo-capsule-viz" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="kairo-capsule-label">{statusLabel}</span>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
