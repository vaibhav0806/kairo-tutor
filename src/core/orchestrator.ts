import type { ActiveAppContext, TutorRequest, TutorResponse, UserAnnotation } from './types';
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
  skillSlug: string;
  constraints: string[];
  // Preformatted recent conversation for continuity (last N turns). Optional.
  recentContext?: string;
  // The line the gate already spoke aloud this turn — continue from it, don't re-greet.
  spokenIntro?: string;
  // The signed-in user's display name — appended to the NON-cached prompt section (spec §12).
  userName?: string;
};

export type TutorPlannerAdapter = (input: TutorTurnInput) => Promise<TutorResponse>;

export function buildTutorTurnInput({
  request,
  screenCapture,
  skillSlug,
  recentContext,
  spokenIntro,
  userName
}: {
  request: TutorRequest;
  screenCapture: NativeScreenCapture | null;
  skillSlug: string;
  recentContext?: string;
  spokenIntro?: string;
  userName?: string;
}): TutorTurnInput {
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
    skillSlug: skillSlug ?? '',
    constraints: [
      'Return one short tutor step.',
      'Do not invent app state that is not visible in the provided context.'
    ],
    ...(recentContext && recentContext.trim() ? { recentContext } : {}),
    ...(spokenIntro && spokenIntro.trim() ? { spokenIntro } : {}),
    ...(userName && userName.trim() ? { userName } : {})
  };
}

export function createTutorOrchestrator({ planner }: { planner: TutorPlannerAdapter }) {
  return {
    runTextTurn(args: {
      request: TutorRequest;
      screenCapture: NativeScreenCapture | null;
      skillSlug: string;
      recentContext?: string;
      spokenIntro?: string;
      userName?: string;
    }) {
      return planner(buildTutorTurnInput(args));
    }
  };
}
