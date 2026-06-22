import { createMockTutorPlanner } from './mockTutor';
import type { TutorPlannerAdapter, TutorTurnInput } from './orchestrator';
import type { TutorRequest } from './types';
import { parseTutorPlannerResponse } from '../server/providers/tutorPlanner';

export type RuntimeTutorProvider = 'mock' | 'openrouter';

export type NativeTutorTurnRunner = {
  runTutorTurn(input: TutorTurnInput): Promise<string | null>;
};

export type MockTutorPlanner = Pick<ReturnType<typeof createMockTutorPlanner>, 'planNextStep'>;

function toMockRequest(input: TutorTurnInput): TutorRequest {
  return {
    ...input.activeApp,
    userQuery: input.userQuery,
    annotations: input.annotations
  };
}

export function createRuntimeTutorPlanner({
  aiProvider,
  nativeBridge,
  mockPlanner
}: {
  aiProvider: RuntimeTutorProvider;
  nativeBridge: NativeTutorTurnRunner;
  mockPlanner: MockTutorPlanner;
}): TutorPlannerAdapter {
  return async (input) => {
    if (aiProvider === 'openrouter') {
      const rawProviderResponse = await nativeBridge.runTutorTurn(input);
      if (rawProviderResponse) {
        return parseTutorPlannerResponse(rawProviderResponse, input);
      }
    }

    return mockPlanner.planNextStep(toMockRequest(input));
  };
}
