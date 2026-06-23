import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { activationStateToNotchPayload } from '../activation/activationState';
import { loadBrowserEnv } from '../config/env';
import type { UserAnnotation } from '../core/types';
import { createNativeBridge } from '../native/nativeBridge';
import { createAnnotationStartPayload, type NotchAnnotationTool } from './annotationActions';
import { buildAudioDataUrl } from './audioPlayback';
import { subscribeToNotchPayload } from './notchEvents';
import { askTutorFromNotch } from './notchTutor';
import {
  isNotchDismissKey,
  isNotchPromptVisible,
  waitForNotchPaint
} from './prompt';
import type { NotchPayload } from './types';
import {
  blobToBase64,
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

const annotationTools: Array<{ label: string; icon: string; tool: NotchAnnotationTool }> = [
  { label: 'Pen', icon: '✎', tool: 'pen' },
  { label: 'Rectangle', icon: '□', tool: 'rectangle' },
  { label: 'Circle', icon: '○', tool: 'circle' },
  { label: 'Highlight', icon: '◐', tool: 'highlight' },
  { label: 'Underline', icon: '_', tool: 'underline' }
];

function promptPlaceholder(payload: NotchPayload) {
  return payload.state === 'showing_step' ? 'Ask a follow-up' : 'Ask about this screen';
}

function annotationCountText(count: number) {
  if (count === 0) {
    return 'No marks';
  }

  return `${count} mark${count === 1 ? '' : 's'}`;
}

export function NotchApp() {
  const [payload, setPayload] = useState<NotchPayload>(defaultPayload);
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
  const voiceMonitorCleanupRef = useRef<(() => void) | null>(null);
  const pcmCaptureCleanupRef = useRef<(() => void) | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const pcmSampleRateRef = useRef<number>(24_000);
  const audioChunksRef = useRef<Blob[]>([]);
  const voiceCancelledRef = useRef(false);
  const nativeBridge = useMemo(() => createNativeBridge(), []);
  const env = loadBrowserEnv();
  const isPromptVisible =
    isNotchPromptVisible(payload) || voiceCaptureState === 'recording' || voiceCaptureState === 'error';
  const canUsePrompt = isPromptVisible && !isSubmitting && payload.state !== 'thinking';
  const canUseVoice =
    voiceCaptureState === 'recording' ||
    (isPromptVisible && !isSubmitting && payload.state !== 'thinking' && voiceCaptureState !== 'transcribing');

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
    if (!answerAudioRef.current) {
      return;
    }

    answerAudioRef.current.pause();
    answerAudioRef.current.src = '';
    answerAudioRef.current = null;
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
    (stream: MediaStream, recorder: MediaRecorder) => {
      stopVoiceMonitor();

      const AudioContextConstructor = globalThis.AudioContext;
      if (!AudioContextConstructor || !globalThis.requestAnimationFrame) {
        const timeout = window.setTimeout(() => {
          if (recorder.state !== 'inactive') {
            recorder.stop();
          }
        }, 18_000);
        voiceMonitorCleanupRef.current = () => window.clearTimeout(timeout);
        return;
      }

      const audioContext = new AudioContextConstructor();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      const data = new Uint8Array(analyser.fftSize);
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      let heardSpeech = false;
      let silenceStartedAt: number | null = null;
      const startedAt = performance.now();
      let frame = 0;
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
        if (rms >= 0.018) {
          heardSpeech = true;
          silenceStartedAt = null;
        } else if (heardSpeech && silenceStartedAt === null) {
          silenceStartedAt = now;
        }

        const silenceMs = silenceStartedAt === null ? 0 : now - silenceStartedAt;
        if (
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
    async (text: string) => {
      stopAnswerPlayback();
      const trimmedText = text.trim();
      if (!trimmedText) {
        return;
      }

      try {
        const result = await nativeBridge.synthesizeSpeech({ text: trimmedText });
        const audioUrl = buildAudioDataUrl(result);
        if (!audioUrl) {
          return;
        }

        const audio = new Audio(audioUrl);
        answerAudioRef.current = audio;
        await audio.play();
      } catch {
        // Speech playback is best-effort; the answer should remain visible if audio fails.
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
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      updateVoiceCaptureState('idle');
      setPayload(thinkingPayload);
      setQuery('');
      void nativeBridge.showNotch(thinkingPayload);
      await waitForNotchPaint();

      try {
        const answerPayload = await askTutorFromNotch({
          query: trimmedQuery,
          nativeBridge,
          aiProvider: env.aiProvider,
          defaultSkill: env.defaultSkill,
          annotations
        });

        setPayload(answerPayload);
        setQuery('');
        setAnnotations([]);
        setActiveAnnotationTool(null);
        void nativeBridge.showNotch(answerPayload);
        void playAnswerAudio(answerPayload.detail);
      } finally {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [
      annotations,
      env.aiProvider,
      env.defaultSkill,
      nativeBridge,
      playAnswerAudio,
      stopAnswerPlayback,
      updateVoiceCaptureState
    ]
  );

  const startAnnotation = useCallback((tool: NotchAnnotationTool) => {
    setActiveAnnotationTool(tool);
    void emit('annotation:start', createAnnotationStartPayload(tool));
  }, []);

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
    voiceCancelledRef.current = true;
    stopActiveRecording(true);
    mediaRecorderRef.current = null;
    stopPcmCapture();
    stopVoiceMonitor();
    stopVoiceTracks();
    isSubmittingRef.current = false;
    setIsSubmitting(false);
    updateVoiceCaptureState('idle');
    setPayload(defaultPayload);
    setQuery('');
    setAnnotations([]);
    setActiveAnnotationTool(null);
    void nativeBridge.hideOverlay();
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
    },
    [nativeBridge, updateVoiceCaptureState]
  );

  const startVoiceCapture = useCallback(async () => {
    stopAnswerPlayback();
    if (!globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
      showVoiceError('Microphone recording is unavailable in this runtime.');
      return;
    }

    try {
      const stream = await globalThis.navigator.mediaDevices.getUserMedia({ audio: true });
      const { recorder, mimeType } = createVoiceRecorder(stream);
      const AudioContextConstructor = globalThis.AudioContext;
      voiceCancelledRef.current = false;
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
          return;
        }

        void (async () => {
          if (chunks.length === 0) {
            showVoiceError('No speech was captured. Try again and speak after the shortcut.');
            return;
          }

          updateVoiceCaptureState('transcribing');
          setVoicePayload('transcribing');
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
      startVoiceMonitor(stream, recorder);
      updateVoiceCaptureState('recording');
      setVoicePayload('recording');
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

  useEffect(() => {
    let isMounted = true;
    let unlisten: (() => void) | undefined;

    void subscribeToNotchPayload({
      listen,
      readCurrentPayload: () => nativeBridge.getCurrentNotchPayload(),
      onPayload: (nextPayload) => {
        if (isMounted) {
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
          }
          setPayload(nextPayload);
        }
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

  return (
    <main className="notch-shell" aria-label="Kairo assistant status">
      <section
        aria-busy={isSubmitting || payload.state === 'thinking'}
        className="notch-card"
        data-busy={isSubmitting ? 'true' : 'false'}
        data-layout={payload.layout}
        data-state={payload.state}
        data-voice-state={voiceCaptureState}
      >
        <header className="notch-header">
          <div className="notch-orb" aria-hidden="true" />
          <div className="notch-copy">
            <strong>{payload.title}</strong>
            <span>{payload.detail}</span>
          </div>
          <button
            aria-label="Hide Kairo"
            className="notch-close"
            type="button"
            onClick={hideNotch}
          >
            x
          </button>
        </header>

        <div className="notch-body">
          <form
            className="notch-prompt"
            data-visible={isPromptVisible ? 'true' : 'false'}
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
              disabled={!canUsePrompt}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={promptPlaceholder(payload)}
              value={query}
            />
            <button
              aria-label={voiceCaptureState === 'recording' ? 'Stop voice input' : 'Start voice input'}
              className="notch-voice-button"
              data-recording={voiceCaptureState === 'recording' ? 'true' : 'false'}
              disabled={!canUseVoice}
              type="button"
              onClick={toggleVoiceCapture}
            >
              <span aria-hidden="true" className="notch-voice-icon" />
            </button>
            <button disabled={voiceCaptureState !== 'recording' && !canUsePrompt} type="submit">
              {voiceCaptureState === 'recording' ? 'Send voice' : 'Ask'}
            </button>
          </form>

          <div className="notch-tool-row" aria-label="Annotation tools" role="toolbar">
            <span className="notch-tool-count" aria-live="polite">
              {annotationCountText(annotations.length)}
            </span>
            <div className="notch-tools">
              {annotationTools.map((option) => (
                <button
                  aria-label={`${option.label} annotation tool`}
                  aria-pressed={activeAnnotationTool === option.tool}
                  disabled={isSubmitting}
                  key={option.tool}
                  type="button"
                  onClick={() => startAnnotation(option.tool)}
                >
                  <span aria-hidden="true">{option.icon}</span>
                </button>
              ))}
              <button
                aria-label="Undo last annotation"
                disabled={isSubmitting || annotations.length === 0}
                type="button"
                onClick={undoAnnotation}
              >
                <span aria-hidden="true">↶</span>
              </button>
              <button
                aria-label="Clear annotations"
                disabled={isSubmitting || annotations.length === 0}
                type="button"
                onClick={clearAnnotations}
              >
                <span aria-hidden="true">×</span>
              </button>
              <button
                aria-label="Finish annotations"
                className="notch-tool-done"
                disabled={isSubmitting || (!activeAnnotationTool && annotations.length === 0)}
                type="button"
                onClick={finishAnnotation}
              >
                <span aria-hidden="true">✓</span>
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
