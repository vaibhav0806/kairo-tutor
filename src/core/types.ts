export type ActiveAppContext = {
  activeApp: string;
  bundleId?: string;
  windowTitle?: string;
};

export type UserAnnotation = {
  id: string;
  type: 'circle' | 'rectangle' | 'highlight' | 'underline';
  screenRegion: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type TutorRequest = ActiveAppContext & {
  userQuery: string;
  annotations: UserAnnotation[];
};

export type VisualTarget = {
  kind: 'highlight_box' | 'ghost_cursor' | 'arrow' | 'underline';
  targetId: string;
  label: string;
  confidence: number;
};

export type TutorResponse = {
  mode: 'stuck_help' | 'guided_lesson';
  skillSlug: string;
  voiceText: string;
  screenText: string;
  visualTargets: VisualTarget[];
  expectedNextState: string;
};

export type UiLandmark = {
  description: string;
  commonLocation: string;
  visualClues: string[];
};

export type SkillPack = {
  slug: string;
  displayName: string;
  appIdentifiers: string[];
  landmarks: Record<string, UiLandmark>;
};
