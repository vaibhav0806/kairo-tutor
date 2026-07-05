import { describe, expect, test, vi } from 'vitest';
import { buildTutorTurnInput, createTutorOrchestrator } from '../src/core/orchestrator';

const request = {
  userQuery: 'Help me animate this',
  activeApp: 'Blender',
  bundleId: 'org.blenderfoundation.blender',
  windowTitle: 'Blender',
  annotations: []
};

describe('tutor orchestrator', () => {
  test('builds provider input from screen context, app metadata, annotations, and skill pack', () => {
    const input = buildTutorTurnInput({
      request,
      screenCapture: {
        captured: true,
        imageMimeType: 'image/png',
        imageBase64: 'abc123',
        byteLength: 6,
        displayBounds: { x: 0, y: 0, width: 900, height: 600, scaleFactor: 2 }
      },
      skillSlug: 'blender'
    });

    expect(input.userQuery).toBe('Help me animate this');
    expect(input.activeApp.activeApp).toBe('Blender');
    expect(input.screen).toMatchObject({
      captured: true,
      imageMimeType: 'image/png',
      byteLength: 6
    });
    expect(input.skill.slug).toBe('blender');
    expect(input.constraints).toContain('Return one short tutor step.');
    expect(input.constraints).toContain(
      'Do not invent app state that is not visible in the provided context.'
    );
  });

  test('uses the configured planner adapter for a tutor turn', async () => {
    const response = {
      mode: 'guided_lesson' as const,
      skillSlug: 'blender',
      voiceText: 'Click the cube.',
      screenText: 'Select the cube.',
      visualTargets: [],
      expectedNextState: 'cube_selected'
    };
    const planner = vi.fn(async () => response);
    const orchestrator = createTutorOrchestrator({ planner });

    await expect(
      orchestrator.runTextTurn({
        request,
        screenCapture: null,
        skillSlug: 'blender'
      })
    ).resolves.toBe(response);

    expect(planner).toHaveBeenCalledWith(expect.objectContaining({
      userQuery: 'Help me animate this',
      skill: expect.objectContaining({ slug: 'blender' })
    }));
  });

  test('loads a skill pack when the user mentions that app even if another app is active', () => {
    const input = buildTutorTurnInput({
      request: {
        userQuery: 'How do I start with Blender?',
        activeApp: 'Chrome',
        bundleId: 'com.google.Chrome',
        windowTitle: 'Search',
        annotations: []
      },
      screenCapture: null,
      skillSlug: 'blender'
    });

    expect(input.skill.slug).toBe('blender');
  });

  test('uses a general skill fallback instead of assuming the configured default applies', () => {
    const input = buildTutorTurnInput({
      request: {
        userQuery: 'Where is the rectangle tool?',
        activeApp: 'Chrome',
        bundleId: 'com.google.Chrome',
        windowTitle: 'tldraw',
        annotations: []
      },
      screenCapture: null,
      skillSlug: 'blender'
    });

    expect(input.skill.slug).toBe('general');
    expect(input.skill.displayName).toBe('General screen');
    // Constraints are generic now — no skill-pack / mode noise leaks into the prompt.
    expect(input.constraints).not.toContain(
      'Configured default skill is blender; do not assume it applies unless the app or question matches it.'
    );
  });
});
