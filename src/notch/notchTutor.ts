import { activationStateToNotchPayload, tutorResponseToNotchPayload } from '../activation/activationState';
import { createMockTutorPlanner } from '../core/mockTutor';
import { createTutorOrchestrator } from '../core/orchestrator';
import { createRuntimeTutorPlanner, type RuntimeTutorProvider } from '../core/runtimePlanner';
import { createTutorRuntimeErrorResponse } from '../core/tutorErrors';
import type { UserAnnotation } from '../core/types';
import type { NativeBridge, NativeScreenCapture } from '../native/nativeBridge';
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

export async function askTutorFromNotch({
  query,
  nativeBridge,
  aiProvider,
  defaultSkill,
  annotations = [],
  screenCapture: providedCapture
}: AskTutorFromNotchOptions): Promise<NotchPayload> {
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

    if (annotations.length > 0 && screenCapture.displayBounds) {
      await nativeBridge.showOverlay({
        mode: 'annotation_preview',
        displayBounds: screenCapture.displayBounds,
        targets: [],
        annotations
      });
    } else if (response.visualTargets.length > 0 && screenCapture.displayBounds) {
      await nativeBridge.showOverlay({
        displayBounds: screenCapture.displayBounds,
        targets: response.visualTargets
      });
    } else {
      await nativeBridge.hideOverlay();
    }

    return tutorResponseToNotchPayload(response) ?? activationStateToNotchPayload('showing_step');
  } catch (error) {
    const response = createTutorRuntimeErrorResponse({
      skillSlug: defaultSkill,
      error
    });
    return tutorResponseToNotchPayload(response);
  }
}
