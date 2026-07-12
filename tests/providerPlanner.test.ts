import { describe, expect, test } from 'vitest';
import { parseTutorPlannerResponse } from '../src/server/providers/tutorPlanner';
import type { TutorTurnInput } from '../src/core/orchestrator';

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
  skillSlug: 'blender',
  constraints: ['Return one short tutor step.']
};

describe('parseTutorPlannerResponse', () => {
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
            kind: 'highlight_box',
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

    expect(response.mode).toBe('single');
    expect(response.visualTargets).toEqual([]);
    expect(response.providerMetadata?.confidenceState).toBe('low');
    expect(response.screenText).toBe('Click around and see what happens.');
    expect(response.voiceText).toBe('Click around and see what happens.');
  });

  test('defaults mode when the slim native response omits it', () => {
    const response = parseTutorPlannerResponse(
      JSON.stringify({
        voiceText: 'Click New — I have highlighted it.',
        box: [0.1, 0.2, 0.3, 0.28],
        visualTargets: [
          {
            kind: 'pointer',
            targetId: 'vision-primary',
            label: 'New',
            confidence: 0.95,
            screenRegion: { x: 100, y: 200, width: 44, height: 44 }
          }
        ]
      }),
      tutorInput
    );

    expect(response.mode).toBe('single');
    expect(response.voiceText).toBe('Click New — I have highlighted it.');
    expect(response.visualTargets).toEqual([
      expect.objectContaining({ targetId: 'vision-primary', kind: 'pointer' })
    ]);
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
