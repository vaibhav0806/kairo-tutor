import { activationStateToNotchPayload, tutorResponseToNotchPayload } from '../activation/activationState';
import { createMockTutorPlanner } from '../core/mockTutor';
import { createTutorOrchestrator } from '../core/orchestrator';
import { createRuntimeTutorPlanner, type RuntimeTutorProvider } from '../core/runtimePlanner';
import { createTutorRuntimeErrorResponse } from '../core/tutorErrors';
import { klog } from '../core/logger';
import type { TutorStep, UserAnnotation, VisualTarget } from '../core/types';
import type {
  NativeBridge,
  NativeContextBaseline,
  NativeOverlayDisplayBounds,
  NativeScreenCapture
} from '../native/nativeBridge';
import { routeVisualTargets, type RevealTransition } from '../overlay/targetRouting';
import type { NotchPayload } from './types';

export type AskTutorFromNotchOptions = {
  query: string;
  nativeBridge: NativeBridge;
  aiProvider: RuntimeTutorProvider;
  // Slug of the skill pack for this task ("" = let Rust resolve via the app fallback).
  skillSlug: string;
  annotations?: UserAnnotation[];
  // Screenshot captured at voice-start; reused here so the ask doesn't wait on a
  // fresh capture. Falls back to capturing now (e.g. typed input, no voice).
  screenCapture?: NativeScreenCapture | null;
  // Preformatted recent conversation for continuity (last N turns). Optional.
  recentContext?: string;
  // The line the gate already spoke aloud this turn — the tutor continues from it.
  spokenIntro?: string;
  // The user's display name (account); injected into the non-cached prompt section (§12).
  userName?: string;
};

export type AskTutorResult = {
  payload: NotchPayload;
  // The answer's steps (1 for a direct answer, more for a walkthrough). The notch
  // executor plays each step's `say` and reveals `revealStep(step)` as it starts.
  steps: TutorStep[];
  // Reveal ONE step's targets (box + companion cursor), or the annotation preview /
  // nothing when the step has no box. Called per step, exactly when its TTS starts.
  // `transition` picks draw (first box) vs glide (box slides to the next step).
  revealStep: (step: TutorStep, transition?: RevealTransition) => Promise<void>;
  // Shows the first/only step's visuals. Deferred so the notch reveals exactly when
  // TTS begins. Used by the direct (no-screen) path and as a single-step fallback.
  revealVisuals: () => Promise<void>;
  // The app the guidance points at, used to arm the context watcher. null when the
  // answer has no on-screen target to protect from going stale.
  context: NativeContextBaseline | null;
  // Unified turn (RU5): the SINGLE target the user should click, kept up after
  // narration → the notch arms the pointer-watch instead of idle-closing. null ⇒
  // today's single/steps behavior. Its box carries the click region; `wait` = settle;
  // `button` = which mouse button ('left' default | 'right' for context menus).
  awaitClick: { visualTargets: VisualTarget[]; wait: string; button: 'left' | 'right' } | null;
  // The user's goal is achieved → celebrate + no pending pointer.
  done: boolean;
  // The frame this answer was grounded on, reused to place the await_click pointer.
  displayBounds: NativeOverlayDisplayBounds | null;
};

export async function askTutorFromNotch({
  query,
  nativeBridge,
  aiProvider,
  skillSlug,
  annotations = [],
  screenCapture: providedCapture,
  recentContext,
  spokenIntro,
  userName
}: AskTutorFromNotchOptions): Promise<AskTutorResult> {
  try {
    const mockPlanner = createMockTutorPlanner();
    const planner = createRuntimeTutorPlanner({
      aiProvider,
      nativeBridge,
      mockPlanner
    });
    const orchestrator = createTutorOrchestrator({ planner });
    // Use the fast voice-start screenshot when there are no annotations. If the
    // user drew with the pen, those marks were added AFTER that capture, so
    // re-capture now (at ask time) to include them in what the tutor sees.
    const screenCapture =
      annotations.length === 0 && providedCapture?.captured
        ? providedCapture
        : await nativeBridge.captureScreen();
    // Trace whether the user's pen marks made it into the tutor's screenshot: when
    // there are annotations we re-capture NOW so the (preserved, on-screen) marks land
    // in the image the AI sees.
    klog('tutor', 'info', 'ask capture', {
      annotations: annotations.length,
      recaptured: !(annotations.length === 0 && providedCapture?.captured)
    });
    const activeApp = screenCapture.activeApp ?? (await nativeBridge.getActiveApp());
    const response = await orchestrator.runTextTurn({
      request: {
        activeApp: activeApp.activeApp,
        bundleId: activeApp.bundleId,
        windowTitle: activeApp.windowTitle,
        userQuery: query,
        annotations
      },
      screenCapture,
      skillSlug,
      recentContext,
      spokenIntro,
      userName
    });

    const displayBounds = screenCapture.displayBounds;
    const steps = response.steps ?? [];
    const anyTargets =
      Boolean(displayBounds) &&
      (steps.some((step) => step.visualTargets.length > 0) ||
        response.visualTargets.length > 0);

    // Reveal ONE step's visuals: its box + cursor, else the user's annotation
    // preview, else nothing. Built now, run later (on that step's TTS start) so the
    // box/cursor never appear before the step is spoken.
    const revealStep = async (step: TutorStep, transition: RevealTransition = 'draw') => {
      if (step.visualTargets.length > 0 && displayBounds) {
        await routeVisualTargets(nativeBridge, step.visualTargets, displayBounds, transition);
      } else if (annotations.length > 0 && displayBounds) {
        await nativeBridge.showOverlay({
          mode: 'annotation_preview',
          displayBounds,
          targets: [],
          annotations
        });
      } else {
        await nativeBridge.hideOverlay();
      }
    };

    // Single-step / direct fallback: reveal the first step, or top-level targets for
    // mock/legacy responses that don't use steps.
    const revealVisuals = async () => {
      if (steps.length > 0) {
        await revealStep(steps[0]);
        return;
      }
      if (response.visualTargets.length > 0 && displayBounds) {
        await routeVisualTargets(nativeBridge, response.visualTargets, displayBounds);
      } else if (annotations.length > 0 && displayBounds) {
        await nativeBridge.showOverlay({
          mode: 'annotation_preview',
          displayBounds,
          targets: [],
          annotations
        });
      } else {
        await nativeBridge.hideOverlay();
      }
    };

    return {
      payload:
        tutorResponseToNotchPayload(response) ?? activationStateToNotchPayload('showing_step'),
      steps,
      revealStep,
      revealVisuals,
      context: anyTargets
        ? { bundleId: activeApp.bundleId, windowTitle: activeApp.windowTitle }
        : null,
      awaitClick: response.awaitClick ?? null,
      done: response.done ?? false,
      displayBounds: displayBounds ?? null
    };
  } catch (error) {
    const response = createTutorRuntimeErrorResponse({
      skillSlug,
      error
    });
    const hideOnly = async () => {
      await nativeBridge.hideOverlay();
    };
    return {
      payload: tutorResponseToNotchPayload(response),
      steps: response.steps ?? [],
      revealStep: hideOnly,
      revealVisuals: hideOnly,
      context: null,
      awaitClick: null,
      done: false,
      displayBounds: null
    };
  }
}
