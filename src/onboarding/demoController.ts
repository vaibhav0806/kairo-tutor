// The onboarding "learn" steps run the REAL Kairo pipeline, minus the notch chrome:
// transcribe → (gate →) vision → overlay box + companion cursor + Sarvam voice. It drives
// the native commands directly and reuses the product's pure modules (streaming TTS, the
// tutor orchestrator, target routing, the gesture segmenter + compositor) so the practice
// is the actual product, not a mock. Kept deliberately small — no epoch/filler/idle-close
// machinery, since a practice step only ever runs one ask at a time.

import { emit } from '@tauri-apps/api/event';
import { createStreamingClip } from '../notch/streamingTts';
import { askTutorFromNotch } from '../notch/notchTutor';
import { segmentGesturePath, type TimedPoint } from '../notch/gestureSegmenter';
import { compositeMarks } from '../notch/compositeMarks';
import { gestureConfig } from '../config/gesture';
import { releaseVisualTargets, type RevealTransition } from '../overlay/targetRouting';
import { onboardingChat } from './backendClient';
import { klog } from '../core/logger';
import { playSound } from '../core/sound';
import type { NativeBridge } from '../native/nativeBridge';
import type { TutorStep } from '../core/types';

// The onboarding steps talk to the same provider as the shipped app.
const AI_PROVIDER = 'openrouter' as const;
const WAV = 'audio/wav';
// How long the highlight lingers after Kairo finishes speaking, so the user sees it.
const HIGHLIGHT_DWELL_MS = 1600;

export type DemoCallbacks = {
  // Kairo started thinking (STT done → working on the reply).
  onThinking?: () => void;
  // The reply's first audio is playing (drop the "thinking" state, show "speaking").
  onSpeaking?: () => void;
  // The reply text, delivered exactly when its audio starts — so a caller can show it in the notch
  // in sync with the voice (never before). Used by the Act 2 say-hi drill.
  onReply?: (text: string) => void;
  // Any line Kairo speaks (gate filler, each answer step), delivered welded to its audio start — the
  // caller mirrors it into the notch so the caption is NEVER stale during a practice turn.
  onCaption?: (text: string) => void;
};

// Outcome of one practice turn: `ok` → advance; otherwise show a retry nudge and let the user hold
// the chord again (chord-is-the-only-Next stays intact). `reason` picks the retry caption.
export type DemoResult = { ok: boolean; reason?: 'empty' | 'no_target' };

// Speak one line via streaming Sarvam TTS, driving the companion cursor's speaking pulse.
// Resolves when playback ends. `onStart` fires the instant the first audio sample plays.
async function speak(bridge: NativeBridge, text: string, onStart?: () => void): Promise<void> {
  const line = text.trim();
  if (!line) return;
  const clip = createStreamingClip(bridge, line);
  clip.onplay = () => {
    onStart?.();
    void emit('cursor:speaking');
  };
  try {
    await clip.play();
  } finally {
    void emit('cursor:idle');
  }
}

// Play each answer step, revealing its box + cursor exactly when that step starts speaking
// (welded to TTS onplay, same as the notch). The first box is drawn; later ones glide. `onStepSpeak`
// fires at the same instant with the step's text, so the notch caption tracks every line.
async function playSteps(
  bridge: NativeBridge,
  steps: TutorStep[],
  revealStep: (step: TutorStep, transition?: RevealTransition) => Promise<void>,
  opts: { onFirstSpeak?: () => void; onStepSpeak?: (text: string) => void } = {},
): Promise<void> {
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const first = i === 0;
    await speak(bridge, step.say, () => {
      void revealStep(step, first ? 'draw' : 'glide');
      if (first) opts.onFirstSpeak?.();
      opts.onStepSpeak?.(step.say);
    });
  }
}

// learn_talk: the user says anything; Kairo replies for real. No screen, no overlay.
export async function runTalkTurn(
  bridge: NativeBridge,
  audioBase64: string,
  name: string,
  cb: DemoCallbacks = {},
): Promise<{ transcriptLen: number }> {
  cb.onThinking?.();
  const { text } = await bridge.transcribeAudio({ audioBase64, mimeType: WAV });
  const transcript = (text ?? '').trim();
  klog('onboarding', 'info', 'talk turn', { transcript_len: transcript.length });
  const reply = (await onboardingChat(transcript, name)) || "I hear you! Let's keep going.";
  await speak(bridge, reply, () => {
    cb.onSpeaking?.();
    cb.onReply?.(reply); // hand the reply text up the instant its audio starts (notch caption)
  });
  return { transcriptLen: transcript.length };
}

// learn_point: the user asks Kairo to point at something on their real screen. Runs the
// actual gate → vision path, so it mirrors the shipped ask exactly.
export async function runPointTurn(
  bridge: NativeBridge,
  audioBase64: string,
  cb: DemoCallbacks = {},
): Promise<DemoResult> {
  cb.onThinking?.();
  const [{ text }, capture] = await Promise.all([
    bridge.transcribeAudio({ audioBase64, mimeType: WAV }),
    bridge.captureScreen(),
  ]);
  const query = (text ?? '').trim();
  if (!query) return { ok: false, reason: 'empty' }; // held the chord but said nothing → retry
  const active = capture.activeApp ?? (await bridge.getActiveApp());

  // Gate: decide whether to look + get a spoken filler that echoes the ask.
  let needsScreen = true;
  let filler = '';
  try {
    const gate = JSON.parse(
      await bridge.runGateTurn({
        userQuery: query,
        activeApp: active.activeApp,
        bundleId: active.bundleId,
        windowTitle: active.windowTitle,
        pointerPending: false,
      }),
    ) as { needsScreen?: boolean; voiceText?: string };
    needsScreen = gate.needsScreen !== false;
    filler = (gate.voiceText ?? '').trim();
  } catch (error) {
    klog('onboarding', 'debug', 'point gate failed → looking', { error: String(error) });
  }
  klog('onboarding', 'info', 'point turn', { transcript_len: (text ?? '').length, needsScreen });

  if (!needsScreen) {
    // Direct answer (greeting / general question) — speak the gate's reply, no overlay.
    const reply = filler || 'Got it!';
    await speak(bridge, reply, () => {
      cb.onSpeaking?.();
      cb.onCaption?.(reply);
    });
    return { ok: true };
  }

  // Vision: run the tutor turn while the filler plays, then reveal + narrate the answer.
  const visionPromise = askTutorFromNotch({
    query,
    nativeBridge: bridge,
    aiProvider: AI_PROVIDER,
    skillSlug: '',
    screenCapture: capture,
    spokenIntro: filler || undefined,
  });
  if (filler)
    await speak(bridge, filler, () => {
      cb.onSpeaking?.();
      cb.onCaption?.(filler);
    });
  const result = await visionPromise;
  // THE PEAK (§9): the instant the first box/pointer lands on the real target, fire the pet
  // celebration + the arrival cue — once, and only when there's an actual target.
  let peaked = false;
  const revealWithPeak = async (step: TutorStep, transition?: RevealTransition) => {
    await result.revealStep(step, transition);
    if (!peaked && step.visualTargets.length > 0) {
      peaked = true;
      void emit('cursor:celebrate');
      playSound('arrive');
      klog('onboarding', 'info', 'point peak', {});
    }
  };
  await playSteps(bridge, result.steps, revealWithPeak, {
    onFirstSpeak: filler ? undefined : cb.onSpeaking,
    onStepSpeak: cb.onCaption,
  });
  await new Promise((r) => setTimeout(r, HIGHLIGHT_DWELL_MS));
  await releaseVisualTargets(bridge);
  const hasTarget = result.steps.some((s) => s.visualTargets.length > 0);
  return { ok: hasTarget, reason: hasTarget ? undefined : 'no_target' };
}

// circle: the user draws around something; Kairo describes it. Gesture strokes are
// composited onto the screenshot (like the product) and the gate is bypassed → straight
// to vision.
export async function runCircleTurn(
  bridge: NativeBridge,
  audioBase64: string,
  points: TimedPoint[],
  cb: DemoCallbacks = {},
): Promise<DemoResult> {
  cb.onThinking?.();
  const [{ text }, rawCapture] = await Promise.all([
    bridge.transcribeAudio({ audioBase64, mimeType: WAV }),
    bridge.captureScreen(),
  ]);
  const strokes = segmentGesturePath(points, gestureConfig);
  const capture = await compositeMarks(rawCapture, strokes);
  const query = (text ?? '').trim() || 'What did I just circle?';
  klog('onboarding', 'info', 'circle turn', { strokes: strokes.length, transcript_len: (text ?? '').length });

  const visionPromise = askTutorFromNotch({
    query,
    nativeBridge: bridge,
    aiProvider: AI_PROVIDER,
    skillSlug: '',
    annotations: [],
    screenCapture: capture,
  });
  // Gesture path has no gate filler — cover the vision wait with a short line.
  const cover = 'Let me see what you circled.';
  await speak(bridge, cover, () => {
    cb.onSpeaking?.();
    cb.onCaption?.(cover);
  });
  const result = await visionPromise;
  await playSteps(bridge, result.steps, result.revealStep, { onStepSpeak: cb.onCaption });
  await new Promise((r) => setTimeout(r, HIGHLIGHT_DWELL_MS));
  await releaseVisualTargets(bridge);
  // The gesture carries the intent, so an empty transcript is fine — only a no-target answer retries.
  const hasTarget = result.steps.some((s) => s.visualTargets.length > 0);
  return { ok: hasTarget, reason: hasTarget ? undefined : 'no_target' };
}
