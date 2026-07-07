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

// One step of a tutor answer: a spoken line + the (optional) targets Kairo points
// at while it's spoken. `single` answers have one step; walkthroughs have several,
// played one at a time.
export type TutorStep = {
  say: string;
  visualTargets: VisualTarget[];
};

export type TutorResponse = {
  mode: 'single' | 'steps' | 'idle' | 'stuck_help' | 'guided_lesson';
  skillSlug: string;
  voiceText: string;
  screenText: string;
  // Legacy/first-step targets (main-window preview). The live notch path drives the
  // overlay from `steps` instead.
  visualTargets: VisualTarget[];
  // Sequential steps for the notch executor. Absent for mock/legacy responses,
  // which the notch treats as a single voiceText answer.
  steps?: TutorStep[];
  // Unified turn (RU1/RU5): the SINGLE thing the user should click, kept up after
  // narration so the notch arms the pointer-watch instead of idle-closing. null (or
  // absent) ⇒ exactly today's single/steps behavior. `wait` is how long the screen
  // takes to settle AFTER the click ('instant'|'ui-settle'|'page-load'|'network').
  awaitClick?: { visualTargets: VisualTarget[]; wait: string } | null;
  // The user's goal is achieved — celebrate + no pending pointer. Defaults false.
  done?: boolean;
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
