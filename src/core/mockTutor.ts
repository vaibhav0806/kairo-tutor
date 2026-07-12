import type { TutorRequest, TutorResponse } from './types';

// Browser-preview fallback planner. Not skill-aware (real routing lives in Rust);
// it just echoes a fixed slug so the UI has something to render without a backend.
export function createMockTutorPlanner() {
  return {
    createIdleResponse(skillSlug = 'general'): TutorResponse {
      return {
        mode: 'idle',
        skillSlug,
        voiceText: 'Kairo is ready. Press the shortcut, capture your screen, then ask for help.',
        screenText: 'Ready when you are.',
        visualTargets: [],
        expectedNextState: 'user_asks_question'
      };
    },

    planNextStep(request: TutorRequest): TutorResponse {
      const skillSlug = 'general';
      const normalizedQuery = request.userQuery.toLowerCase();
      const firstAnnotation = request.annotations[0];

      if (firstAnnotation) {
        return {
          mode: 'stuck_help',
          skillSlug,
          voiceText:
            'I see your marked area. If that is the cube, click once near the center of that selection before we add the first keyframe.',
          screenText: 'Use your marked area to select the cube.',
          visualTargets: [
            {
              kind: 'highlight_box',
              targetId: firstAnnotation.id,
              label: 'Your marked area',
              confidence: 0.9,
              screenRegion: firstAnnotation.screenRegion
            }
          ],
          expectedNextState: 'cube_selected'
        };
      }

      if (normalizedQuery.includes('animation')) {
        return {
          mode: 'guided_lesson',
          skillSlug,
          voiceText:
            'I can see the app is open. We will animate the cube. First, click the cube in the center. I am highlighting it now.',
          screenText: 'Step 1: Select the cube in the viewport.',
          visualTargets: [
            {
              kind: 'highlight_box',
              targetId: 'default_cube',
              label: 'Default cube',
              confidence: 0.86,
              screenRegion: {
                x: 928,
                y: 430,
                width: 160,
                height: 160
              }
            },
            {
              kind: 'pointer',
              targetId: 'default_cube',
              label: 'AI pointer on the cube',
              confidence: 0.86,
              screenRegion: {
                x: 1008,
                y: 510,
                width: 1,
                height: 1
              }
            }
          ],
          expectedNextState: 'cube_selected'
        };
      }

      return {
        mode: 'stuck_help',
        skillSlug,
        voiceText:
          'I can answer general questions too. Ask anything, or annotate the part of the screen you want me to inspect.',
        screenText: 'Ask anything, or annotate the problem area.',
        visualTargets: [],
        expectedNextState: 'user_clarifies_goal'
      };
    }
  };
}
