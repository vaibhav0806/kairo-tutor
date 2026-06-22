import { describe, expect, test } from 'vitest';
import { createSkillPackRegistry } from '../src/core/skills';

describe('createSkillPackRegistry', () => {
  test('loads the Blender skill pack and its UI landmarks', () => {
    const registry = createSkillPackRegistry();
    const blender = registry.getBySlug('blender');

    expect(blender.slug).toBe('blender');
    expect(blender.displayName).toBe('Blender');
    expect(blender.landmarks.timeline.commonLocation).toBe('bottom');
  });

  test('selects Blender from active app metadata', () => {
    const registry = createSkillPackRegistry();

    expect(
      registry.matchActiveApp({
        activeApp: 'Blender',
        bundleId: 'org.blenderfoundation.blender',
        windowTitle: 'Blender'
      })?.slug
    ).toBe('blender');
  });
});
