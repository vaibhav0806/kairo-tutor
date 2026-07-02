import { activationStateToNotchPayload, tutorResponseToNotchPayload } from '../activation/activationState';
import { createMockTutorPlanner } from '../core/mockTutor';
import { createTutorOrchestrator } from '../core/orchestrator';
import { createRuntimeTutorPlanner, type RuntimeTutorProvider } from '../core/runtimePlanner';
import { createTutorRuntimeErrorResponse } from '../core/tutorErrors';
import type { UserAnnotation } from '../core/types';
import type {
  NativeBridge,
  NativeContextBaseline,
  NativeScreenCapture
} from '../native/nativeBridge';
import { routeVisualTargets } from '../overlay/targetRouting';
import type { NotchPayload } from './types';

export type AskTutorFromNotchOptions = {
  query: string;
  nativeBridge: NativeBridge;
  aiProvider: RuntimeTutorProvider;
  defaultSkill: string;
  annotations?: UserAnnotation[];
  // Screenshot captured at voice-start; reused here so the ask doesn't wait on a
  // fresh capture. Falls back to capturing now (e.g. typed input, no voice).
  screenCapture?: NativeScreenCapture | null;
};

export type AskTutorResult = {
  payload: NotchPayload;
  // Shows the box + companion cursor. Deferred (not run inside this call) so the
  // notch can reveal the visuals exactly when TTS playback starts — never while
  // the answer is still being synthesized and the notch is silent.
  revealVisuals: () => Promise<void>;
  // The app the guidance points at, used to arm the context watcher. null when the
  // answer has no on-screen target to protect from going stale.
  context: NativeContextBaseline | null;
};

export async function askTutorFromNotch({
  query,
  nativeBridge,
  aiProvider,
  defaultSkill,
  annotations = [],
  screenCapture: providedCapture
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
      skillSlug: defaultSkill
    });

    const displayBounds = screenCapture.displayBounds;
    const hasTargets = response.visualTargets.length > 0 && Boolean(displayBounds);
    const hasAnnotationPreview =
      !hasTargets && annotations.length > 0 && Boolean(displayBounds);

    // Built now, run later (on TTS start) so the box/cursor never appear before the
    // answer is spoken. The companion cursor is released after playback (+grace) or
    // when the context watcher detects the user moving on.
    const revealVisuals = async () => {
      if (hasTargets && displayBounds) {
        await routeVisualTargets(nativeBridge, response.visualTargets, displayBounds);
      } else if (hasAnnotationPreview && displayBounds) {
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
      revealVisuals,
      context: hasTargets
        ? { bundleId: activeApp.bundleId, windowTitle: activeApp.windowTitle }
        : null
    };
  } catch (error) {
    const response = createTutorRuntimeErrorResponse({
      skillSlug: defaultSkill,
      error
    });
    return {
      payload: tutorResponseToNotchPayload(response),
      revealVisuals: async () => {
        await nativeBridge.hideOverlay();
      },
      context: null
    };
  }
}
