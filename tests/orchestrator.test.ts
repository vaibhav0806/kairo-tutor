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
  test('builds provider input from screen context, app metadata, annotations, and skill slug', () => {
    const input = buildTutorTurnInput({
      request,
      screenCapture: {
        captured: true,
        imageMimeType: 'image/png',
        imageBase64: 'abc123',
        byteLength: 6,
        displayBounds: { x: 0, y: 0, width: 900, height: 600, scaleFactor: 2 }
      },
      skillSlug: 'figma-first-animation'
    });

    expect(input.userQuery).toBe('Help me animate this');
    expect(input.activeApp.activeApp).toBe('Blender');
    expect(input.screen).toMatchObject({
      captured: true,
      imageMimeType: 'image/png',
      byteLength: 6
    });
    expect(input.skillSlug).toBe('figma-first-animation');
    expect(input.constraints).toContain('Return one short tutor step.');
    expect(input.constraints).toContain(
      'Do not invent app state that is not visible in the provided context.'
    );
  });

  test('carries the skill slug through verbatim (routing lives in Rust, not here)', () => {
    const input = buildTutorTurnInput({ request, screenCapture: null, skillSlug: 'anything' });
    expect(input.skillSlug).toBe('anything');
  });

  test('defaults an empty slug to "" so Rust resolves via the app fallback', () => {
    const input = buildTutorTurnInput({ request, screenCapture: null, skillSlug: '' });
    expect(input.skillSlug).toBe('');
  });

  test('uses the configured planner adapter for a tutor turn', async () => {
    const response = {
      mode: 'guided_lesson' as const,
      skillSlug: 'figma-first-animation',
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
        skillSlug: 'figma-first-animation'
      })
    ).resolves.toBe(response);

    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({
        userQuery: 'Help me animate this',
        skillSlug: 'figma-first-animation'
      })
    );
  });
});
