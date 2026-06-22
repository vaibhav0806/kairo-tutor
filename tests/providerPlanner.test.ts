import { describe, expect, test, vi } from 'vitest';
import {
  createOpenRouterTutorPlanner,
  parseTutorPlannerResponse
} from '../src/server/providers/tutorPlanner';
import type { TutorTurnInput } from '../src/core/orchestrator';
import type { OpenRouterMessage } from '../src/server/providers/openRouter';

const tutorInput: TutorTurnInput = {
  userQuery: 'Help me make my first animation',
  activeApp: {
    activeApp: 'Blender',
    bundleId: 'org.blenderfoundation.blender',
    windowTitle: 'Blender'
  },
  annotations: [
    {
      id: 'annotation-1',
      type: 'rectangle',
      screenRegion: { x: 100, y: 120, width: 160, height: 100 }
    }
  ],
  screen: {
    captured: true,
    imageMimeType: 'image/png',
    imageBase64: 'abc123',
    byteLength: 6,
    displayBounds: { x: 0, y: 0, width: 900, height: 600, scaleFactor: 2 }
  },
  skill: {
    slug: 'blender',
    displayName: 'Blender',
    appIdentifiers: ['org.blenderfoundation.blender'],
    landmarks: {
      viewport: {
        description: '3D viewport',
        commonLocation: 'center',
        visualClues: ['cube']
      }
    }
  },
  constraints: ['Return one short tutor step.']
};

describe('OpenRouter tutor planner adapter', () => {
  test('sends screenshot context and annotations through an OpenAI-compatible message payload', async () => {
    const chat = vi.fn(async () =>
      JSON.stringify({
        mode: 'guided_lesson',
        skillSlug: 'blender',
        voiceText: 'Click the cube once.',
        screenText: 'Select the cube.',
        visualTargets: [
          {
            kind: 'highlight_box',
            targetId: 'cube',
            label: 'Cube',
            confidence: 0.88,
            screenRegion: { x: 900, y: 420, width: 180, height: 180 }
          }
        ],
        expectedNextState: 'cube_selected'
      })
    );
    const planner = createOpenRouterTutorPlanner({ chat });

    await expect(planner(tutorInput)).resolves.toMatchObject({
      mode: 'guided_lesson',
      visualTargets: [expect.objectContaining({ confidence: 0.88 })],
      providerMetadata: expect.objectContaining({ confidenceState: 'high' })
    });

    const messages = (chat.mock.calls as unknown as Array<[OpenRouterMessage[]]>)[0][0];
    const userMessage = messages[1];
    expect(userMessage.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text' }),
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,abc123' }
        }
      ])
    );
    expect(JSON.stringify(userMessage.content)).toContain('annotation-1');
  });

  test('sanitizes unsafe provider targets and marks low-confidence responses', () => {
    const response = parseTutorPlannerResponse(
      JSON.stringify({
        mode: 'guided_lesson',
        skillSlug: 'blender',
        voiceText: 'Try selecting the object.',
        screenText: 'Select the visible object.',
        visualTargets: [
          {
            kind: 'highlight_box',
            targetId: 'bad-region',
            label: 'Bad region',
            confidence: 2,
            screenRegion: { x: 10, y: 10, width: -20, height: 40 }
          },
          {
            kind: 'spotlight',
            targetId: 'valid-region',
            label: 'Valid region',
            confidence: 0.3,
            screenRegion: { x: 20, y: 20, width: 80, height: 80 }
          }
        ],
        expectedNextState: 'object_selected'
      }),
      tutorInput
    );

    expect(response.visualTargets).toEqual([
      expect.objectContaining({
        targetId: 'valid-region',
        confidence: 0.3
      })
    ]);
    expect(response.providerMetadata).toEqual({
      confidenceState: 'low',
      warnings: ['Dropped 1 unsafe visual target.']
    });
  });

  test('falls back to a safe clarification response when provider output is not valid JSON', () => {
    const response = parseTutorPlannerResponse('Click around and see what happens.', tutorInput);

    expect(response.mode).toBe('stuck_help');
    expect(response.visualTargets).toEqual([]);
    expect(response.providerMetadata?.confidenceState).toBe('low');
    expect(response.voiceText).toContain('could not read');
  });
});
