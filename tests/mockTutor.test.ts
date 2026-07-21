import { describe, expect, test } from 'vitest';
import { createMockTutorPlanner } from '../src/core/mockTutor';

describe('createMockTutorPlanner', () => {
  test('returns the first Blender animation step with voice and visual target', () => {
    const planner = createMockTutorPlanner();
    const response = planner.planNextStep({
      userQuery: 'Help me make my first animation',
      activeApp: 'Blender',
      bundleId: 'org.blenderfoundation.blender',
      windowTitle: 'Blender',
      annotations: []
    });

    expect(response.mode).toBe('guided_lesson');
    expect(response.voiceText).toContain('click the cube');
    expect(response.visualTargets[0]).toMatchObject({
      kind: 'highlight_box',
      targetId: 'default_cube',
      screenRegion: {
        x: 928,
        y: 430,
        width: 160,
        height: 160
      }
    });
  });

  test('references user annotations in the next tutor response', () => {
    const planner = createMockTutorPlanner();
    const response = planner.planNextStep({
      userQuery: 'Is this the cube?',
      activeApp: 'Blender',
      bundleId: 'org.blenderfoundation.blender',
      windowTitle: 'Blender',
      annotations: [
        {
          id: 'annotation-1',
          type: 'rectangle',
          screenRegion: {
            x: 900,
            y: 420,
            width: 220,
            height: 180
          }
        }
      ]
    });

    expect(response.voiceText).toContain('your marked area');
    expect(response.visualTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'highlight_box',
          targetId: 'annotation-1',
          label: 'Your marked area'
        })
      ])
    );
  });

  test('does not refuse general questions in the mock fallback', () => {
    const planner = createMockTutorPlanner();
    const response = planner.planNextStep({
      userQuery: 'Can you answer general questions?',
      activeApp: 'Chrome',
      bundleId: 'com.google.Chrome',
      windowTitle: 'Search',
      annotations: []
    });

    expect(response.voiceText).toContain('answer general questions');
    expect(response.screenText).toContain('Ask anything');
  });
});
