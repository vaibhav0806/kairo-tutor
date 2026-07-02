import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { activationStateToNotchPayload } from '../activation/activationState';
import { loadBrowserEnv } from '../config/env';
import type { UserAnnotation } from '../core/types';
import {
  createNativeBridge,
  type NativeContextBaseline,
  type NativeScreenCapture
} from '../native/nativeBridge';
import { type NotchAnnotationTool } from './annotationActions';
import { buildAudioDataUrl } from './audioPlayback';
import { subscribeToNotchPayload } from './notchEvents';
import { askTutorFromNotch } from './notchTutor';
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

// After the answer finishes speaking, close the notch this long after the user
// stops interacting with it (also clears the box + companion cursor).
const NOTCH_IDLE_CLOSE_MS = 3000;
// Body copy shown under the title while the answer is being synthesized to speech,
// after the LLM has replied but before playback (and the visuals) begin.
const PREPARING_NEXT_STEP_TEXT = 'Preparing the next step';

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
  const [query, setQuery] = useState('');
  const [annotations, setAnnotations] = useState<UserAnnotation[]>([]);
  const [activeAnnotationTool, setActiveAnnotationTool] = useState<NotchAnnotationTool | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [voiceCaptureState, setVoiceCaptureState] = useState<VoiceCaptureState>('idle');
  const isSubmittingRef = useRef(false);
  const voiceCaptureStateRef = useRef<VoiceCaptureState>('idle');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const answerAudioRef = useRef<HTMLAudioElement | null>(null);
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
  // Auto-listen: start voice capture as soon as the screen is captured after a
  // shortcut activation. `started` dedupes repeat captured payloads for one
  // activation; `suppressed` skips auto-listen when returning from annotating.
  const autoListenStartedRef = useRef(false);
  const autoListenSuppressedRef = useRef(false);
  // Call the latest startVoiceCapture without making it an effect dependency
  // (otherwise the payload subscription re-subscribes on every render and loops).
  const startVoiceCaptureRef = useRef<() => void>(() => {});
  // True while a push-to-talk (⌥⌃ hold) capture is in flight, so the monitor keeps
  // recording until release instead of auto-stopping on silence.
  const pttModeRef = useRef(false);
  // Screenshot taken at voice-start, reused by the tutor turn so the ask doesn't
  // wait on a fresh capture.
  const capturedScreenRef = useRef<NativeScreenCapture | null>(null);
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
      stopAnswerPlayback();
      const trimmedText = text.trim();
      if (!trimmedText) {
        // Nothing to speak: reveal immediately so the answer isn't left hidden.
        onSpeechStart?.();
        onSettled?.();
        return;
      }

      try {
        const result = await nativeBridge.synthesizeSpeech({ text: trimmedText });
        const audioUrl = buildAudioDataUrl(result);
        if (!audioUrl) {
          onSpeechStart?.();
          onSettled?.();
          return;
        }

        const audio = new Audio(audioUrl);
        answerAudioRef.current = audio;
        // Reveal the answer text + teaching visuals the instant speech begins.
        audio.onplay = () => {
          onSpeechStart?.();
          // Backstop: guarantee the answer settles (so auto-close can run) even if
          // 'ended' never fires. Cleared by 'ended' or a new turn (stopAnswerPlayback).
          if (settleFallbackRef.current) {
            clearTimeout(settleFallbackRef.current);
          }
          settleFallbackRef.current = setTimeout(() => onSettled?.(), 60000);
        };
        audio.onended = () => {
          if (settleFallbackRef.current) {
            clearTimeout(settleFallbackRef.current);
            settleFallbackRef.current = null;
          }
          onSettled?.();
        };
        await audio.play();
      } catch {
        // Speech playback is best-effort; reveal the text anyway so a silent
        // answer is never left invisible.
        onSpeechStart?.();
        onSettled?.();
      }
    },
    [nativeBridge, stopAnswerPlayback]
  );

  const submitQuery = useCallback(
    async (nextQuery: string) => {
      const trimmedQuery = nextQuery.trim();
      if (!trimmedQuery || isSubmittingRef.current) {
        return;
      }

      const thinkingPayload = activationStateToNotchPayload('thinking');
      stopAnswerPlayback();
      // A new turn supersedes the last answer: mark it unsettled (blocks auto-close)
      // and stop watching the old target.
      answerSettledRef.current = false;
      void nativeBridge.disarmContextWatch();
      // Release any lingering pointing so the cursor shadows the mouse while the
      // new answer is computed; it flies again only if the answer has a target.
      void nativeBridge.cursorRelease();
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
        const { payload: answerPayload, revealVisuals, context } = await askTutorFromNotch({
          query: trimmedQuery,
          nativeBridge,
          aiProvider: env.aiProvider,
          defaultSkill: env.defaultSkill,
          annotations,
          screenCapture: capturedScreenRef.current
        });

        // Hold the box + cursor until speech starts; reveal them together with the
        // text so nothing points at the screen while the notch is still silent.
        revealVisualsRef.current = revealVisuals;
        contextBaselineRef.current = context;

        setPayload(answerPayload);
        // Body shows "Preparing the next step" (detailHidden) until speech begins.
        setDetailHidden(true);
        setQuery('');
        setAnnotations([]);
        setActiveAnnotationTool(null);
        void nativeBridge.showNotch(answerPayload);
        void playAnswerAudio(
          answerPayload.detail,
          () => {
            // Speech is starting: reveal text + visuals, then watch for the user
            // moving on (app/tab switch, scroll, click) so the box doesn't go stale.
            setDetailHidden(false);
            // Clear the thinking swirl; revealVisuals may then send the cursor pointing.
            void emit('cursor:idle', {});
            void revealVisualsRef.current().then(() => {
              if (contextBaselineRef.current) {
                void nativeBridge.armContextWatch(contextBaselineRef.current);
              }
            });
          },
          () => {
            // Playback finished (or there was none): allow the idle-close to begin.
            markAnswerSettled();
          }
        );
      } finally {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [
      annotations,
      markAnswerSettled,
      env.aiProvider,
      env.defaultSkill,
      nativeBridge,
      playAnswerAudio,
      stopAnswerPlayback,
      updateVoiceCaptureState
    ]
  );

  const startAnnotation = useCallback(
    async (tool: NotchAnnotationTool) => {
      // Tapping the already-active tool toggles it off: stop drawing and let the
      // overlay become click-through preview (drawn marks stay visible).
      if (activeAnnotationTool === tool) {
        setActiveAnnotationTool(null);
        void emit('annotation:finish', {});
        return;
      }
      setActiveAnnotationTool(tool);
      // Show the drawing overlay from the notch (the main window's webview is
      // hidden/suspended, so its listener can't be relied on). Reuse the
      // voice-start screenshot's bounds, else fetch the display bounds natively.
      const bounds =
        capturedScreenRef.current?.displayBounds ?? (await nativeBridge.getDisplayBounds());
      await nativeBridge.showAnnotationOverlay(bounds, tool);
    },
    [activeAnnotationTool, nativeBridge]
  );

  const finishAnnotation = useCallback(() => {
    setActiveAnnotationTool(null);
    void emit('annotation:finish', {});
  }, []);

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
    // Re-arm auto-listen so the next activation opens the mic again.
    autoListenStartedRef.current = false;
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
      if (
        !answerSettledRef.current ||
        isSubmittingRef.current ||
        voiceCaptureStateRef.current !== 'idle' ||
        queryRef.current.trim().length > 0
      ) {
        return;
      }
      const now = performance.now();
      const pointerHolding =
        pointerInsideNotchRef.current && now - lastNotchPointerAt.current < 4000;
      if (pointerHolding) {
        return;
      }
      if (now - lastNotchActivityAt.current >= NOTCH_IDLE_CLOSE_MS) {
        hideNotch();
      }
    }, 350);
    return () => clearInterval(id);
  }, [hideNotch]);

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
    const pending = listen('context:changed', () => {
      void nativeBridge.hideOverlay();
      void nativeBridge.cursorRelease();
      void nativeBridge.disarmContextWatch();
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [nativeBridge]);

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

  const showVoiceError = useCallback(
    (detail: string) => {
      const nextPayload: NotchPayload = {
        state: 'captured',
        layout: 'prompt',
        title: 'Voice unavailable',
        detail
      };
      updateVoiceCaptureState('error');
      setPayload(nextPayload);
      void nativeBridge.showNotch(nextPayload);
      void emit('cursor:idle', {});
    },
    [nativeBridge, updateVoiceCaptureState]
  );

  // Transcribe captured audio and run the tutor turn. Shared by the WebView
  // recorder.onstop path and the native push-to-talk `ptt:audio` event.
  const processCapturedAudio = useCallback(
    async (audioBase64: string, mimeType: string) => {
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
        const transcript = result.text.trim();
        if (!transcript) {
          showVoiceError('No speech was detected. Try again and speak a little louder.');
          return;
        }
        setQuery(transcript);
        await capturePromise;
        await submitQuery(transcript);
      } catch (error) {
        const detail =
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : 'Voice transcription failed. Try again.';
        showVoiceError(detail);
      }
    },
    [nativeBridge, setVoicePayload, showVoiceError, submitQuery, updateVoiceCaptureState]
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
            await submitQuery(transcript);
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

  // Warm the mic device once on mount (acquire + immediately release) so the first
  // WebView capture isn't cold. Push-to-talk uses NATIVE capture, so this no longer
  // needs to stay open — the mic (and its indicator) is only active during a capture.
  useEffect(() => {
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
      return;
    }
    void (async () => {
      try {
        const stream = await acquireMicrophoneStream();
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        // Permission denied / unavailable — real capture will surface errors.
      }
    })();
  }, []);

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
        }
        if (nextPayload.state === 'listening' && !mediaRecorderRef.current) {
          isSubmittingRef.current = false;
          setAnnotations([]);
          setActiveAnnotationTool(null);
          setIsSubmitting(false);
          updateVoiceCaptureState('idle');
          // Clear any leftover annotation overlay from a previous session. The
          // notch drives this (not the hidden/suspended main window) so a fresh
          // shortcut press is a reliable reset even if the overlay was orphaned.
          void nativeBridge.hideOverlay();
          void nativeBridge.cursorRelease();
          // New activation: re-arm auto-listen for the upcoming captured state.
          autoListenStartedRef.current = false;
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
  }, [nativeBridge, updateVoiceCaptureState]);

  useEffect(() => {
    let isMounted = true;
    const unlisteners: Array<() => void> = [];

    void Promise.all([
      listen<UserAnnotation>('annotation:add', (event) => {
        if (!isMounted) {
          return;
        }

        setAnnotations((currentAnnotations) => [...currentAnnotations, event.payload]);
      }),
      listen<UserAnnotation[]>('annotation:sync', (event) => {
        if (!isMounted) {
          return;
        }

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
        // Returning from annotating should not re-open the mic.
        autoListenSuppressedRef.current = true;
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

  // Minimal: the notch card only shows for typing (⌘⇧Space) + errors (layout
  // 'prompt'). During the voice flow (listening / thinking / answer + TTS) render
  // nothing — only the cursor effects + box — while the panel stays alive so its
  // webview can still run the transcribe → answer → TTS pipeline.
  const showCard = payload.layout === 'prompt';

  return (
    <main className="notch-shell" aria-label="Kairo assistant status">
      {showCard ? (
        <section
        aria-busy={isSubmitting || payload.state === 'thinking'}
        className="notch-card"
        data-busy={isSubmitting ? 'true' : 'false'}
        data-layout={payload.layout}
        data-state={payload.state}
        data-voice-state={voiceCaptureState}
        onPointerEnter={() => {
          pointerInsideNotchRef.current = true;
          lastNotchPointerAt.current = performance.now();
          noteNotchActivity();
        }}
        onPointerMove={() => {
          pointerInsideNotchRef.current = true;
          lastNotchPointerAt.current = performance.now();
          noteNotchActivity();
        }}
        onPointerLeave={() => {
          pointerInsideNotchRef.current = false;
        }}
        onPointerDown={() => {
          lastNotchPointerAt.current = performance.now();
          noteNotchActivity();
        }}
      >
        <header className="notch-header">
          <div className="notch-orb" aria-hidden="true" />
          <div className="notch-copy">
            <strong>{payload.title}</strong>
            <span>{detailHidden ? PREPARING_NEXT_STEP_TEXT : payload.detail}</span>
          </div>
          <button
            aria-label="Hide Kairo"
            className="notch-close"
            type="button"
            onClick={hideNotch}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="notch-body">
          <form
            className="notch-prompt"
            data-visible={interaction.promptVisible ? 'true' : 'false'}
            onSubmit={(event) => {
              event.preventDefault();
              if (isSubmittingRef.current) {
                return;
              }

              if (voiceCaptureStateRef.current === 'recording') {
                stopActiveRecording(false);
                return;
              }

              submitQuery(query).catch(() => {
                isSubmittingRef.current = false;
                setIsSubmitting(false);
              });
            }}
          >
            <input
              aria-label="Ask Kairo"
              autoFocus
              disabled={!interaction.canUsePrompt}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={promptPlaceholder(payload)}
              value={query}
            />
            <button
              aria-label={voiceCaptureState === 'recording' ? 'Stop voice input' : 'Start voice input'}
              className="notch-voice-button"
              data-recording={voiceCaptureState === 'recording' ? 'true' : 'false'}
              disabled={!interaction.canUseVoice}
              title={voiceCaptureState === 'recording' ? 'Stop voice input' : 'Start voice input'}
              type="button"
              onClick={toggleVoiceCapture}
            >
              {voiceCaptureState === 'recording' ? <StopIcon /> : <MicIcon />}
            </button>
            <button disabled={!canSubmitCurrent} type="submit">
              {interaction.submitMode === 'voice' ? 'Done' : 'Ask'}
            </button>
          </form>

          <div className="notch-tool-row" aria-label="Annotation tools" role="toolbar">
            {annotations.length > 0 ? (
              <span className="notch-tool-count" aria-live="polite">
                {annotationCountText(annotations.length)}
              </span>
            ) : null}
            <div className="notch-tools">
              {annotationTools.map((option) => (
                <button
                  aria-label={`${option.label} annotation tool`}
                  aria-pressed={activeAnnotationTool === option.tool}
                  data-active={activeAnnotationTool === option.tool ? 'true' : 'false'}
                  disabled={!interaction.canAnnotate}
                  key={option.tool}
                  title={activeAnnotationTool === option.tool ? `${option.label} (on)` : option.label}
                  type="button"
                  onClick={() => startAnnotation(option.tool)}
                >
                  <span aria-hidden="true">{option.icon}</span>
                  {activeAnnotationTool === option.tool ? (
                    <span className="notch-tool-label">{option.label}</span>
                  ) : null}
                </button>
              ))}
              <button
                aria-label="Undo last annotation"
                disabled={!interaction.canAnnotate || annotations.length === 0}
                title="Undo"
                type="button"
                onClick={undoAnnotation}
              >
                <UndoIcon />
              </button>
              <button
                aria-label="Clear annotations"
                disabled={!interaction.canAnnotate || annotations.length === 0}
                title="Clear"
                type="button"
                onClick={clearAnnotations}
              >
                <ClearIcon />
              </button>
              <button
                aria-label="Finish annotations"
                className="notch-tool-done"
                disabled={!interaction.canAnnotate || (!activeAnnotationTool && annotations.length === 0)}
                title="Done"
                type="button"
                onClick={finishAnnotation}
              >
                <DoneIcon />
              </button>
            </div>
          </div>
        </div>
      </section>
      ) : null}
    </main>
  );
}
