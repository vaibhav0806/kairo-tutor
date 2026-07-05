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
  imageGeometry?: NativeScreenCapture['imageGeometry'];
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
      windowTitle: request.windowTitle
    },
    annotations: request.annotations,
    screen: screenCapture
      ? {
          captured: screenCapture.captured,
          reason: screenCapture.reason,
          imageMimeType: screenCapture.imageMimeType,
          imageBase64: screenCapture.imageBase64,
          byteLength: screenCapture.byteLength,
          displayBounds: screenCapture.displayBounds,
          imageGeometry: screenCapture.imageGeometry
        }
      : {
          captured: false,
          reason: 'No screen capture is available for this turn.'
        },
    skill,
    constraints: [
      'Return one short tutor step.',
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
