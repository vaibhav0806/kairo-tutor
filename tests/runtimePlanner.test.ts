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
  skill: {
    slug: 'blender',
    displayName: 'Blender',
    appIdentifiers: ['org.blenderfoundation.blender'],
    landmarks: {}
  },
  constraints: ['Return one short tutor step.']
};

describe('createRuntimeTutorPlanner', () => {
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
