import { createSkillPackRegistry } from './skills';
import type { TutorRequest, TutorResponse } from './types';

export function createMockTutorPlanner() {
  const registry = createSkillPackRegistry();

  return {
    planNextStep(request: TutorRequest): TutorResponse {
      const skill = registry.matchActiveApp(request) ?? registry.getBySlug('blender');
      const normalizedQuery = request.userQuery.toLowerCase();

      if (skill.slug === 'blender' && normalizedQuery.includes('animation')) {
        return {
          mode: 'guided_lesson',
          skillSlug: skill.slug,
          voiceText:
            'I can see Blender is open. We will animate the cube. First, click the cube in the center. I am highlighting it now.',
          screenText: 'Step 1: Select the cube in the viewport.',
          visualTargets: [
            {
              kind: 'highlight_box',
              targetId: 'default_cube',
              label: 'Default cube',
              confidence: 0.86
            },
            {
              kind: 'ghost_cursor',
              targetId: 'default_cube',
              label: 'AI pointer on the cube',
              confidence: 0.86
            }
          ],
          expectedNextState: 'cube_selected'
        };
      }

      return {
        mode: 'stuck_help',
        skillSlug: skill.slug,
        voiceText:
          'I can help with this screen. Tell me what you are trying to do, or circle the part that is confusing.',
        screenText: 'Ask a specific question or annotate the problem area.',
        visualTargets: [],
        expectedNextState: 'user_clarifies_goal'
      };
    }
  };
}
