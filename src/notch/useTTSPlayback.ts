//! All notch audio playback in one hook: the answer clip, the "let me look" filler
//! (with its queue), multi-step walkthrough narration, and the mid-guide follow clip.
//! Owns every playback ref (answer/filler/follow slots, the playback epoch, the narration
//! + filler done-signals, the settle backstop) so the turn machine just calls functions
//! instead of threading ~11 refs. The turn machine's supersede check rides the caller's
//! AbortSignal; this hook's OWN interruption uses a separate `playbackEpoch` (a new turn
//! bumps it via stopAnswerPlayback and every await bails), kept internal.

import { useCallback, useEffect, useRef, useState } from 'react';
import { emit } from '@tauri-apps/api/event';
import type { TutorStep } from '../core/types';
import type { RevealTransition } from '../overlay/targetRouting';
import { buildAudioDataUrl } from './audioPlayback';
import { createBufferedClip, createStreamingClip, type SpeechClip } from './streamingTts';
import { createNativeBridge } from '../native/nativeBridge';
import { FILLER_FALLBACK, STEP_GAP_MS, STEP_SYNTH_TIMEOUT_MS } from './notchConstants';

type NativeBridge = ReturnType<typeof createNativeBridge>;

export type TTSPlayback = {
  // True while the answer is actually being spoken (drives the "Speaking" capsule state).
  isSpeaking: boolean;
  stopAnswerPlayback: () => void;
  playAnswerAudio: (
    text: string,
    onSpeechStart?: () => void,
    onSettled?: () => void
  ) => Promise<void>;
  playSteps: (
    steps: TutorStep[],
    revealStep: (step: TutorStep, transition?: RevealTransition) => Promise<void>,
    onFirstSpeechStart?: () => void,
    onSettled?: () => void,
    onStepStart?: (index: number, step: TutorStep) => void
  ) => Promise<void>;
  speakFiller: (text: string, signal: AbortSignal) => Promise<void>;
  speakFollowClip: (text: string) => Promise<void>;
  speakFollowClipDone: (text: string, signal: AbortSignal) => Promise<void>;
  // Play a pre-synthesized buffered clip AS the answer (the paywall upgrade line). Owns
  // the answer slot so a later stopAnswerPlayback cuts it; reveals speaking status.
  playBufferedAnswer: (url: string, signal: AbortSignal, onSettled: () => void) => Promise<void>;
  // The currently-playing narration's done-signal — a click-turn awaits it to queue behind.
  getNarrationDone: () => Promise<void>;
  // Open the filler-done gate WITHOUT playing a clip (the click-turn's no-cut queue); the
  // caller resolves it manually via the returned resolver. Returns that resolver.
  openFillerGate: () => () => void;
};

export function useTTSPlayback(nativeBridge: NativeBridge): TTSPlayback {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const answerAudioRef = useRef<SpeechClip | null>(null);
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
  // Resolves when the CURRENTLY-playing narration (playSteps / playAnswerAudio) finishes,
  // whether it ends naturally or is cut. A click-turn captures this so its next-step audio
  // can queue BEHIND the current line instead of cutting it (no-cut UX). Starts resolved.
  const narrationDoneRef = useRef<Promise<void>>(Promise.resolve());
  const narrationDoneResolveRef = useRef<() => void>(() => {});
  // Bumped on every stopAnswerPlayback so a queued answer can detect it was
  // superseded by a newer turn while waiting for the filler, and not play stale.
  const playbackEpochRef = useRef(0);
  // A DEDICATED clip slot for the mid-guide ack ("nice, one sec") so it never
  // collides with the turn's filler/answer clip. Cut by stopAnswerPlayback.
  const followClipRef = useRef<SpeechClip | null>(null);
  // Backstop so the answer always "settles" even if the audio 'ended' event misfires.
  const settleFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopAnswerPlayback = useCallback(() => {
    setIsSpeaking(false);
    // Any new playback supersedes a pending gate filler.
    fillerCancelRef.current = true;
    // Supersede anything queued behind the filler (see playAnswerAudio).
    playbackEpochRef.current += 1;
    // Also stop any in-flight follow-along step speech so a new turn's audio never
    // overlaps it. No-op (ref null) outside an active follow-along.
    if (followClipRef.current) {
      try {
        followClipRef.current.pause();
      } catch {
        // ignore
      }
      followClipRef.current = null;
    }
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

  // Narration lifecycle: playSteps/playAnswerAudio call beginNarration when they start
  // speaking and endNarration when they finish (naturally or cut). narrationDoneRef then
  // always reflects the currently-playing line — a click-turn awaits it to queue behind.
  const beginNarration = useCallback(() => {
    let resolve: () => void = () => {};
    narrationDoneRef.current = new Promise<void>((r) => {
      resolve = r;
    });
    narrationDoneResolveRef.current = resolve;
  }, []);
  const endNarration = useCallback(() => {
    narrationDoneResolveRef.current();
    narrationDoneResolveRef.current = () => {};
  }, []);

  const playAnswerAudio = useCallback(
    // `onSpeechStart` fires when playback actually begins (reveal the text +
    // visuals then); `onSettled` fires when playback ends, or immediately when
    // there is nothing to play, so the notch auto-close countdown can begin.
    async (text: string, onSpeechStart?: () => void, onSettled?: () => void) => {
      beginNarration();
      const trimmedText = text.trim();
      if (!trimmedText) {
        stopAnswerPlayback();
        // Nothing to speak: reveal immediately so the answer isn't left hidden.
        onSpeechStart?.();
        onSettled?.();
        endNarration();
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
        endNarration();
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
        endNarration();
      };
      // Cut mid-play (barge-in via stopAnswerPlayback) → unblock any click-turn waiting.
      audio.onpause = () => {
        setIsSpeaking(false);
        endNarration();
      };
      try {
        await audio.play();
      } catch {
        // Playback is best-effort; reveal + settle so nothing is left hidden.
        onSpeechStart?.();
        onSettled?.();
        endNarration();
      }
    },
    [nativeBridge, stopAnswerPlayback, beginNarration, endNarration]
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
      beginNarration();
      if (steps.length === 0) {
        onFirstSpeechStart?.();
        onSettled?.();
        endNarration();
        return;
      }

      // Each step is a STREAMING clip: constructing it kicks off synthesis right away
      // (so it's effectively prefetched) and playback begins at first byte. A clip's
      // own buffered fallback covers a failed stream, so no step is left silent.
      // null = empty text (nothing to speak).
      const clips: Array<SpeechClip | null | undefined> = new Array(steps.length);
      // Called only at superseded/cut exits (always followed by return) — so it also
      // ends the narration, unblocking a click-turn queued behind this line.
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
        endNarration();
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
      endNarration();
    },
    [nativeBridge, stopAnswerPlayback, beginNarration, endNarration]
  );

  // Speak the mid-guide ack ("nice, one sec") on the DEDICATED follow clip slot so it
  // never collides with the turn's filler/answer clip. A new line cuts the prior one;
  // stopAnswerPlayback (a new turn / the answer starting) also cuts it. Drives the
  // speaking status exactly like the normal path.
  const speakFollowClip = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      if (followClipRef.current) {
        try {
          followClipRef.current.pause();
        } catch {
          // ignore
        }
        followClipRef.current = null;
      }
      const clip = createStreamingClip(nativeBridge, trimmed, STEP_SYNTH_TIMEOUT_MS);
      followClipRef.current = clip;
      const clearSpeaking = () => setIsSpeaking(false);
      clip.onplay = () => {
        setIsSpeaking(true);
        void emit('cursor:speaking', {});
      };
      clip.onended = clearSpeaking;
      clip.onpause = clearSpeaking;
      clip.onerror = clearSpeaking;
      try {
        await clip.play();
      } catch {
        setIsSpeaking(false);
      } finally {
        if (followClipRef.current === clip) {
          followClipRef.current = null;
        }
      }
    },
    [nativeBridge]
  );

  // Like speakFollowClip, but resolves only when the ack clip FINISHES (ends, is cut, or
  // errors) — used by the click-turn so the next answer can queue BEHIND the ack. Plays
  // on the same follow-clip slot, so a voice barge-in (stopAnswerPlayback) cuts it.
  const speakFollowClipDone = useCallback(
    async (text: string, signal: AbortSignal) => {
      const trimmed = text.trim();
      if (!trimmed || signal.aborted) {
        return;
      }
      if (followClipRef.current) {
        try {
          followClipRef.current.pause();
        } catch {
          // ignore
        }
        followClipRef.current = null;
      }
      const clip = createStreamingClip(nativeBridge, trimmed, STEP_SYNTH_TIMEOUT_MS);
      followClipRef.current = clip;
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          setIsSpeaking(false);
          if (followClipRef.current === clip) {
            followClipRef.current = null;
          }
          resolve();
        };
        clip.onplay = () => {
          setIsSpeaking(true);
          void emit('cursor:speaking', {});
        };
        clip.onended = finish;
        clip.onpause = finish; // a barge-in cut resolves it too
        clip.onerror = finish;
        void clip.play().catch(finish);
      });
    },
    [nativeBridge]
  );

  // Speak the gate's "let me look" filler while the vision turn runs. Guarded so a
  // slow synth never plays over the real answer.
  const speakFiller = useCallback(
    async (text: string, signal: AbortSignal) => {
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
        if (fillerCancelRef.current || signal.aborted) {
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
      if (cached.length > 0 && !fillerCancelRef.current && !signal.aborted) {
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

  const playBufferedAnswer = useCallback(
    async (url: string, signal: AbortSignal, onSettled: () => void) => {
      const clip = createBufferedClip(url);
      answerAudioRef.current = clip;
      clip.onplay = () => {
        if (signal.aborted) return;
        setIsSpeaking(true);
        void emit('cursor:speaking');
      };
      const settle = () => {
        setIsSpeaking(false);
        void emit('cursor:idle');
        onSettled();
      };
      clip.onended = settle;
      clip.onerror = settle;
      try {
        await clip.play();
      } catch {
        settle();
      }
    },
    []
  );

  const getNarrationDone = useCallback(() => narrationDoneRef.current, []);

  const openFillerGate = useCallback(() => {
    fillerCancelRef.current = false;
    let resolve: () => void = () => {};
    fillerDoneRef.current = new Promise<void>((r) => {
      resolve = r;
    });
    fillerResolveRef.current = resolve; // a voice barge-in (stopAnswerPlayback) unblocks it too
    return resolve;
  }, []);

  // Pre-synthesize the fallback fillers once at launch (used only if the gate's own
  // contextual filler can't be synthesized), so there's no per-question TTS latency
  // when the gate flags a screen question.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const line of FILLER_FALLBACK) {
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

  return {
    isSpeaking,
    stopAnswerPlayback,
    playAnswerAudio,
    playSteps,
    speakFiller,
    speakFollowClip,
    speakFollowClipDone,
    playBufferedAnswer,
    getNarrationDone,
    openFillerGate
  };
}
