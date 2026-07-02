import { createSkillPackRegistry } from './skills';
import type { ActiveAppContext, SkillPack, TutorRequest, TutorResponse, UserAnnotation } from './types';
import type { NativeScreenCapture } from '../native/nativeBridge';

export type TutorScreenInput = {
  captured: boolean;
  reason?: string;
  imageMimeType?: string;
  imageBase64?: string;
  byteLength?: number;
  displayBounds?: NativeScreenCapture['displayBounds'];
};

export type TutorTurnInput = {
  userQuery: string;
  activeApp: ActiveAppContext;
  annotations: UserAnnotation[];
  screen: TutorScreenInput;
  skill: SkillPack;
  constraints: string[];
};

export type TutorPlannerAdapter = (input: TutorTurnInput) => Promise<TutorResponse>;

export function buildTutorTurnInput({
  request,
  screenCapture,
  skillSlug
}: {
  request: TutorRequest;
  screenCapture: NativeScreenCapture | null;
  skillSlug: string;
}): TutorTurnInput {
  const registry = createSkillPackRegistry();
  const skill =
    registry.matchUserQuery(request.userQuery) ??
    registry.matchActiveApp(request) ??
    registry.getGeneral();

  return {
    userQuery: request.userQuery,
    activeApp: {
      activeApp: request.activeApp,
      bundleId: request.bundleId,
      windowTitle: request.windowTitle,
      url: request.url
    },
    annotations: request.annotations,
    screen: screenCapture
      ? {
          captured: screenCapture.captured,
          reason: screenCapture.reason,
          imageMimeType: screenCapture.imageMimeType,
          imageBase64: screenCapture.imageBase64,
          byteLength: screenCapture.byteLength,
          displayBounds: screenCapture.displayBounds
        }
      : {
          captured: false,
          reason: 'No screen capture is available for this turn.'
        },
    skill,
    constraints: [
      'Return one short tutor step.',
      'Answer general user questions directly, even when they are not related to the selected skill pack.',
      'Use a named skill pack only when the active app or user question makes it relevant.',
      `Configured default skill is ${skillSlug}; do not assume it applies unless the app or question matches it.`,
      'After a user question, use idle only when no answer is needed; otherwise use stuck_help or guided_lesson.',
      'Use screen coordinates only when a visual target is useful.',
      'Do not invent app state that is not visible in the provided context.'
    ]
  };
}

export function createTutorOrchestrator({ planner }: { planner: TutorPlannerAdapter }) {
  return {
    runTextTurn(args: {
      request: TutorRequest;
      screenCapture: NativeScreenCapture | null;
      skillSlug: string;
    }) {
      return planner(buildTutorTurnInput(args));
    }
  };
}
