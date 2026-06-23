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
  test('sends screenshot context and annotation guidance through an OpenAI-compatible message payload', async () => {
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
    expect(JSON.stringify(userMessage.content)).toContain('annotationSummary');
    expect(JSON.stringify(userMessage.content)).toContain('orange user markup');
    expect(JSON.stringify(userMessage.content)).toContain('visual attention guidance');
    expect(JSON.stringify(userMessage.content)).not.toContain('annotation-1');
    expect(JSON.stringify(userMessage.content)).not.toContain('User annotations: exactly 1');
  });

  test('instructs providers to answer general questions instead of treating Blender as the only scope', async () => {
    const chat = vi.fn(async () =>
      JSON.stringify({
        mode: 'stuck_help',
        skillSlug: 'blender',
        voiceText: 'General questions are allowed.',
        screenText: 'General questions are allowed.',
        visualTargets: [],
        expectedNextState: 'user_reads_answer'
      })
    );
    const planner = createOpenRouterTutorPlanner({ chat });

    await planner({ ...tutorInput, userQuery: 'What is the capital of France?' });

    const messages = (chat.mock.calls as unknown as Array<[OpenRouterMessage[]]>)[0][0];
    expect(String(messages[0].content)).toContain('Answer general user questions directly');
    expect(String(messages[0].content)).toContain('Selected skill context, when relevant: Blender');
    expect(String(messages[0].content)).toContain('Annotation IDs are internal coordinate references only');
    expect(String(messages[0].content)).toContain('Treat orange drawings, arrows, circles, and doodles as visual attention guides');
    expect(String(messages[0].content)).not.toContain('Skill: Blender');
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

  test('surfaces provider prose when provider output is not valid JSON', () => {
    const response = parseTutorPlannerResponse('Click around and see what happens.', tutorInput);

    expect(response.mode).toBe('stuck_help');
    expect(response.visualTargets).toEqual([]);
    expect(response.providerMetadata?.confidenceState).toBe('low');
    expect(response.screenText).toBe('Click around and see what happens.');
    expect(response.voiceText).toBe('Click around and see what happens.');
  });

  test('uses voice text when provider returns valid JSON with empty screen text', () => {
    const response = parseTutorPlannerResponse(
      JSON.stringify({
        mode: 'idle',
        skillSlug: 'blender',
        voiceText: 'Hi there. What would you like to learn today?',
        screenText: '',
        visualTargets: [],
        expectedNextState: 'user_asks_goal'
      }),
      tutorInput
    );

    expect(response.mode).toBe('idle');
    expect(response.screenText).toBe('Hi there. What would you like to learn today?');
    expect(response.voiceText).toBe('Hi there. What would you like to learn today?');
  });

  test('does not expose internal annotation IDs in user-facing answer text', () => {
    const response = parseTutorPlannerResponse(
      JSON.stringify({
        mode: 'stuck_help',
        skillSlug: 'browser',
        voiceText: 'They are labeled annotation-1.',
        screenText: 'I see annotation-1 on the screen.',
        visualTargets: [],
        expectedNextState: 'user_reads_answer'
      }),
      tutorInput
    );

    expect(response.screenText).toBe('I see first marked area on the screen.');
    expect(response.voiceText).toBe('They are labeled first marked area.');
    expect(response.screenText).not.toContain('annotation-1');
    expect(response.voiceText).not.toContain('annotation-1');
  });

  test('normalizes nullable provider fields instead of surfacing raw JSON', () => {
    const rawContent = JSON.stringify({
      mode: 'stuck_help',
      skillSlug: null,
      voiceText: 'Yes, I see 5 annotations on the screen.',
      screenText: 'Yes, I see 5 annotations on the screen.',
      visualTargets: null,
      expectedNextState: null
    });

    const response = parseTutorPlannerResponse(rawContent, tutorInput);

    expect(response.skillSlug).toBe('blender');
    expect(response.screenText).toBe('Yes, I see 5 annotations on the screen.');
    expect(response.voiceText).toBe('Yes, I see 5 annotations on the screen.');
    expect(response.visualTargets).toEqual([]);
    expect(response.expectedNextState).toBe('user_next_action');
  });

  test('normalizes provider JSON with incomplete visual target fields instead of surfacing raw JSON', () => {
    const response = parseTutorPlannerResponse(
      JSON.stringify({
        mode: 'idle',
        skillSlug: 'blender',
        voiceText: 'Hello. Open Blender to get started.',
        screenText: '',
        visualTargets: [
          {
            kind: 'highlight_box',
            screenRegion: { x: 550, y: 940, width: 50, height: 42 }
          }
        ],
        expectedNextState: 'user_opens_blender'
      }),
      tutorInput
    );

    expect(response.screenText).toBe('Hello. Open Blender to get started.');
    expect(response.visualTargets).toEqual([
      expect.objectContaining({
        targetId: 'provider-target-1',
        label: 'Suggested target',
        confidence: 0.5
      })
    ]);
  });
});
