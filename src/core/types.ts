export type ActiveAppContext = {
  activeApp: string;
  bundleId?: string;
  windowTitle?: string;
};

export type UserAnnotation = {
  id: string;
  type: 'circle' | 'rectangle' | 'highlight' | 'underline' | 'pen';
  screenRegion: ScreenRegion;
  points?: ScreenPoint[];
};

export type TutorRequest = ActiveAppContext & {
  userQuery: string;
  annotations: UserAnnotation[];
};

export type VisualTarget = {
  kind: 'highlight_box' | 'ghost_cursor' | 'arrow' | 'underline' | 'spotlight';
  targetId: string;
  label: string;
  confidence: number;
  screenRegion: ScreenRegion;
};

export type ScreenRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ScreenPoint = {
  x: number;
  y: number;
};

export type ScreenDimensions = {
  width: number;
  height: number;
};

export type PercentRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type TutorResponse = {
  mode: 'idle' | 'stuck_help' | 'guided_lesson';
  skillSlug: string;
  voiceText: string;
  screenText: string;
  visualTargets: VisualTarget[];
  expectedNextState: string;
  providerMetadata?: {
    confidenceState: 'high' | 'medium' | 'low';
    warnings: string[];
  };
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
