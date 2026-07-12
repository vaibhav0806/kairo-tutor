import { describe, expect, test, vi } from 'vitest';
import { createRuntimeTutorPlanner } from '../src/core/runtimePlanner';
import type { TutorTurnInput } from '../src/core/orchestrator';

const input: TutorTurnInput = {
  userQuery: 'What should I click?',
  activeApp: { activeApp: 'Blender' },
  annotations: [],
  screen: {
    captured: true,
    imageMimeType: 'image/png',
    imageBase64: 'abc123',
    byteLength: 6
  },
  skillSlug: 'blender',
  constraints: ['Return one short tutor step.']
};

describe('createRuntimeTutorPlanner', () => {
  test('returns a visible provider error when the native provider turn times out', async () => {
    vi.useFakeTimers();
    const runTutorTurn = vi.fn(() => new Promise<string>(() => undefined));
    const mockPlanner = {
      planNextStep: vi.fn()
    };
    const planner = createRuntimeTutorPlanner({
      aiProvider: 'openrouter',
      nativeBridge: { runTutorTurn },
      mockPlanner,
      tutorTurnTimeoutMs: 25
    });

    const result = planner(input);
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toMatchObject({
      mode: 'stuck_help',
      screenText: expect.stringContaining('Kairo could not complete the request'),
      providerMetadata: {
        confidenceState: 'low',
        warnings: [expect.stringContaining('timed out')]
      }
    });
    vi.useRealTimers();
  });

  test('uses the native provider proxy when OpenRouter is selected', async () => {
    const runTutorTurn = vi.fn(async () =>
      JSON.stringify({
        mode: 'stuck_help',
        skillSlug: 'blender',
        voiceText: 'Click the highlighted button.',
        screenText: 'Click the highlighted button.',
        visualTargets: [],
        expectedNextState: 'button_clicked'
      })
    );
    const mockPlanner = {
      planNextStep: vi.fn()
    };
    const planner = createRuntimeTutorPlanner({
      aiProvider: 'openrouter',
      nativeBridge: { runTutorTurn },
      mockPlanner
    });

    await expect(planner(input)).resolves.toMatchObject({
      voiceText: 'Click the highlighted button.',
      providerMetadata: expect.objectContaining({ confidenceState: 'medium' })
    });
    expect(runTutorTurn).toHaveBeenCalledWith(input);
    expect(mockPlanner.planNextStep).not.toHaveBeenCalled();
  });

  test('surfaces OpenRouter provider failures instead of falling back to mock guidance', async () => {
    const runTutorTurn = vi.fn(async () => {
      throw new Error('OPENROUTER_API_KEY is required for native OpenRouter tutor turns.');
    });
    const mockPlanner = {
      planNextStep: vi.fn()
    };
    const planner = createRuntimeTutorPlanner({
      aiProvider: 'openrouter',
      nativeBridge: { runTutorTurn },
      mockPlanner
    });

    await expect(planner(input)).resolves.toMatchObject({
      mode: 'stuck_help',
      skillSlug: 'blender',
      voiceText: expect.stringContaining('provider'),
      screenText: expect.stringContaining('Kairo could not complete the request'),
      expectedNextState: 'provider_configuration_required',
      providerMetadata: {
        confidenceState: 'low',
        warnings: [expect.stringContaining('OPENROUTER_API_KEY')]
      }
    });
    expect(mockPlanner.planNextStep).not.toHaveBeenCalled();
  });

  test('uses the mock planner when mock provider is selected', async () => {
    const response = {
      mode: 'stuck_help' as const,
      skillSlug: 'blender',
      voiceText: 'Mock response.',
      screenText: 'Mock response.',
      visualTargets: [],
      expectedNextState: 'user_clarifies_goal'
    };
    const mockPlanner = {
      planNextStep: vi.fn(() => response)
    };
    const planner = createRuntimeTutorPlanner({
      aiProvider: 'mock',
      nativeBridge: { runTutorTurn: vi.fn() },
      mockPlanner
    });

    await expect(planner(input)).resolves.toBe(response);
  });
});
