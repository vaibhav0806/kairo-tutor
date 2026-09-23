import { klog } from './logger';
import { createMockTutorPlanner } from './mockTutor';
import type { TutorPlannerAdapter, TutorTurnInput } from './orchestrator';
import { createTutorRuntimeErrorResponse } from './tutorErrors';
import { StepStreamReader } from './stepStream';
import type { TutorRequest } from './types';
import { parseTutorPlannerResponse } from './tutorPlanner';

export type RuntimeTutorProvider = 'mock' | 'openrouter';

export type NativeTutorTurnRunner = {
  runTutorTurn(input: TutorTurnInput): Promise<string>;
  runTutorTurnStream?(input: TutorTurnInput, onDelta: (text: string) => void): Promise<string>;
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
  tutorTurnTimeoutMs = DEFAULT_TUTOR_TURN_TIMEOUT_MS,
  onEarlyStep
}: {
  aiProvider: RuntimeTutorProvider;
  nativeBridge: NativeTutorTurnRunner;
  mockPlanner: MockTutorPlanner;
  tutorTurnTimeoutMs?: number;
  /**
   * Called with each step as soon as its object is COMPLETE in the streamed response — never with
   * a half-written one, so a caller can start speaking without the pointer lagging behind. Omit it
   * and the turn runs exactly as it always has.
   */
  onEarlyStep?: (step: unknown, index: number) => void;
}): TutorPlannerAdapter {
  return async (input) => {
    if (aiProvider === 'openrouter') {
      try {
        const rawProviderResponse = await withTutorTurnTimeout(
          runTurn(nativeBridge, input, onEarlyStep),
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

/**
 * Run the turn, streaming when both the bridge and the caller support it.
 *
 * The streamed text is only ever used to announce early steps; the promise still resolves with the
 * complete response, which stays the single thing that gets parsed. That keeps a malformed or
 * truncated stream indistinguishable from the buffered path as far as the answer is concerned.
 */
function runTurn(
  nativeBridge: NativeTutorTurnRunner,
  input: TutorTurnInput,
  onEarlyStep?: (step: unknown, index: number) => void
): Promise<string> {
  if (!onEarlyStep || !nativeBridge.runTutorTurnStream) {
    return nativeBridge.runTutorTurn(input).catch((error) => {
      // Keep this: a turn that fails instantly used to be silent, which made a provider error
      // indistinguishable from a hang.
      klog('tutor', 'error', 'tutor turn failed', { error: String(error) });
      throw error;
    });
  }
  const reader = new StepStreamReader();
  let accumulated = '';
  let announced = 0;
  return nativeBridge
    .runTutorTurnStream!(input, (text) => {
      accumulated += text;
      for (const step of reader.read(accumulated)) {
        onEarlyStep!(step, announced);
        announced += 1;
      }
    })
    .catch((error) => {
      klog('tutor', 'error', 'tutor turn failed', { error: String(error) });
      throw error;
    });
}
