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
      targetId: 'default_cube'
    });
  });
});
