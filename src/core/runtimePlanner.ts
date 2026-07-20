import { createMockTutorPlanner } from './mockTutor';
import type { TutorPlannerAdapter, TutorTurnInput } from './orchestrator';
import { createTutorRuntimeErrorResponse } from './tutorErrors';
import type { TutorRequest } from './types';
import { parseTutorPlannerResponse } from './tutorPlanner';

export type RuntimeTutorProvider = 'mock' | 'openrouter';

export type NativeTutorTurnRunner = {
  runTutorTurn(input: TutorTurnInput): Promise<string>;
};

export type MockTutorPlanner = Pick<ReturnType<typeof createMockTutorPlanner>, 'planNextStep'>;

export const DEFAULT_TUTOR_TURN_TIMEOUT_MS = 35_000;

function withTutorTurnTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error(`Native tutor turn timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    operation.then(
      (value) => {
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

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
  mockPlanner,
  tutorTurnTimeoutMs = DEFAULT_TUTOR_TURN_TIMEOUT_MS
}: {
  aiProvider: RuntimeTutorProvider;
  nativeBridge: NativeTutorTurnRunner;
  mockPlanner: MockTutorPlanner;
  tutorTurnTimeoutMs?: number;
}): TutorPlannerAdapter {
  return async (input) => {
    if (aiProvider === 'openrouter') {
      try {
        const rawProviderResponse = await withTutorTurnTimeout(
          nativeBridge.runTutorTurn(input),
          tutorTurnTimeoutMs
        );
        return parseTutorPlannerResponse(rawProviderResponse, input);
      } catch (error) {
        return createTutorRuntimeErrorResponse({
          skillSlug: input.skillSlug,
          error
        });
      }
    }

    return mockPlanner.planNextStep(toMockRequest(input));
  };
}
