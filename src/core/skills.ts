import type { ActiveAppContext, SkillPack, UiLandmark } from './types';

const blenderLandmarks: Record<string, UiLandmark> = {
  viewport: {
    description: 'Main area where the learner sees and edits the 3D scene.',
    commonLocation: 'center',
    visualClues: ['grid floor', '3D cube', 'camera', 'light']
  },
  timeline: {
    description: 'Horizontal animation timeline used to scrub frames and playback animation.',
    commonLocation: 'bottom',
    visualClues: ['frame numbers', 'play button', 'timeline scrubber']
  },
  outliner: {
    description: 'Scene hierarchy panel listing objects such as Camera, Cube, and Light.',
    commonLocation: 'top right',
    visualClues: ['Scene Collection', 'Camera', 'Cube', 'Light']
  },
  properties_panel: {
    description: 'Panel for object, material, render, and scene settings.',
    commonLocation: 'right',
    visualClues: ['vertical tabs', 'render properties', 'object properties']
  }
};

const skillPacks: SkillPack[] = [
  {
    slug: 'blender',
    displayName: 'Blender',
    appIdentifiers: ['org.blenderfoundation.blender', 'Blender'],
    landmarks: blenderLandmarks
  }
];

export function createSkillPackRegistry(packs: SkillPack[] = skillPacks) {
  return {
    getBySlug(slug: string): SkillPack {
      const pack = packs.find((candidate) => candidate.slug === slug);
      if (!pack) {
        throw new Error(`Unknown skill pack: ${slug}`);
      }
      return pack;
    },

    matchActiveApp(context: ActiveAppContext): SkillPack | undefined {
      const activeApp = context.activeApp.toLowerCase();
      const bundleId = context.bundleId?.toLowerCase();

      return packs.find((pack) =>
        pack.appIdentifiers.some((identifier) => {
          const normalized = identifier.toLowerCase();
          return normalized === bundleId || activeApp.includes(normalized.toLowerCase());
        })
      );
    },

    list(): SkillPack[] {
      return [...packs];
    }
  };
}
