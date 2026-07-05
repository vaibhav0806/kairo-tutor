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
  // Only two render today: a pointer (companion-cursor click point) and a
  // highlight_box (the rectangle drawn around the target).
  kind: 'pointer' | 'highlight_box';
  targetId: string;
  // Kept for logs/debug only — the overlay no longer renders on-screen labels.
  label: string;
  confidence: number;
  screenRegion: ScreenRegion;
  // Vibrant accent hex derived from the background behind the target. Optional —
  // the OCR fallback path and tests omit it, in which case the default theme wins.
  color?: string;
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
