// Kairo's onboarding voice — warm, first-person. `title` is shown; `speech` is spoken (not shown).
// Static segments carry a `cacheKey` → we ship a pre-generated audio file for them (no Sarvam call
// at runtime). Dynamic segments (with the user's name) are synthesized live.

export type StepId =
  | 'name'
  | 'signin'
  | 'source'
  | 'permissions'
  | 'learn_point'
  | 'circle'
  | 'done';

export interface Segment {
  text: (name: string) => string;
  cacheKey?: string;
}

export interface StepDef {
  id: StepId;
  title: (name: string) => string;
  speech: Segment[];
}

export const STEPS: StepDef[] = [
  {
    // Interactive: the user asks Kairo to point at something on their real screen (gate → vision).
    // Acts 1-3 (arrival/color, hearing, permissions) run BEFORE this; sign-in/source/ending are the
    // Act 5-6 components AFTER. So the legacy STEPS wizard is now just the two practice beats.
    id: 'learn_point',
    title: () => 'I point, you act',
    speech: [
      {
        cacheKey: 'learn_point',
        text: () =>
          'Now the fun part. Hold Option and Control together, and ask me to point something out on your screen — like the wifi icon, or the Apple menu. Watch me find it.',
      },
    ],
  },
  {
    // Interactive: the user circles anything on screen; Kairo describes what was circled.
    id: 'circle',
    title: () => 'Circle anything',
    speech: [
      {
        cacheKey: 'circle',
        text: () =>
          "One more trick. Hold Option and Control, then draw a circle around anything on your screen, and I'll tell you all about it.",
      },
    ],
  },
];

/** Coach-surface lines for the redesigned acts (Phase 3). Static → pre-generated + cached WAV,
 *  falling back to live Sarvam TTS if the WAV isn't shipped yet (useVoice handles the fallback). */
export const ACT_LINES: Record<string, Segment> = {
  act1_wake: { cacheKey: 'act1_wake', text: () => "Hey — I'm Kairo. I live up here, on your screen." },
  act1_color: { cacheKey: 'act1_color', text: () => 'First — pick my color. This is me, from now on.' },
  act2_primer: {
    cacheKey: 'act2_primer',
    text: () =>
      "To hear you, I'll need your mic — and permission to notice when you hold two keys. Quick and painless."
  },
  act2_drill: {
    cacheKey: 'act2_drill',
    text: () =>
      "This is how you talk to me. Hold Option and Control together, say hi, then let go — I'm listening the whole time you hold them."
  },
  act2_short: { cacheKey: 'act2_short', text: () => 'Hold them a beat longer.' },
  act2_empty: { cacheKey: 'act2_empty', text: () => "Didn't quite catch that — try again." }
} satisfies Record<string, Segment>;

/** The seeded-prompt chip shown during the Act 2 say-hi drill (master spec §8). */
export const ACT2_CHIP = "try: 'hey Kairo, what's up?'";

/** The permissions line spoken depends on what's already granted — only mention what's missing. */
export const PERMISSION_LINES: Record<'perm_both' | 'perm_screen' | 'perm_access', string> = {
  perm_both:
    'Two last things. I need Screen Recording so I can see your screen, and Accessibility so I can point things out. Grant them below.',
  // Accessibility already on → only Screen Recording missing.
  perm_screen: 'Just one more. Turn on Screen Recording so I can see your screen.',
  // Screen Recording already on → only Accessibility missing.
  perm_access: 'Almost there. Turn on Accessibility so I can point things out for you.',
};

/**
 * Act 3 — "Earn the Eyes". Two separate moments, each: why + benefit + honest privacy line.
 * Screen Recording is spoken first (it forces the relaunch); Accessibility is reframed as
 * "steer the pointer", never "control your Mac".
 */
export const ACT3_LINES: Record<'act3_screen' | 'act3_access' | 'act3_access_fallback', string> = {
  act3_screen:
    'To point things out, I need to see your screen — but only while you hold Option and Control, ' +
    "and I never save it. I look, help, and forget. Flip on Screen Recording and I'll take it from here.",
  act3_access:
    "One more — Accessibility. It's how I steer the little pointer to what I'm showing you, " +
    "not to control your Mac. Watch — I'll point right at the switch. Flip this one on.",
  act3_access_fallback:
    'Almost there — turn on Accessibility so I can steer the pointer for you. It\'s the switch next to my name.'
};

export const act3ScreenLine: Segment[] = [
  { cacheKey: 'act3_screen', text: () => ACT3_LINES.act3_screen }
];
export const act3AccessLine: Segment[] = [
  { cacheKey: 'act3_access', text: () => ACT3_LINES.act3_access }
];
export const act3AccessFallbackLine: Segment[] = [
  { cacheKey: 'act3_access_fallback', text: () => ACT3_LINES.act3_access_fallback }
];

/** Short coach-caption text pushed to the notch per Act 3 sub-step (title / detail). */
export const ACT3_COACH: Record<'screen' | 'accessibility', { title: string; detail: string }> = {
  screen: { title: 'Let me see the screen', detail: 'Only while you hold ⌥⌃ — never saved' },
  accessibility: { title: 'Steer the pointer', detail: "I'll point at the switch — flip it on" }
};

/** Which permission line to speak for the current grant state. null → both granted (say nothing). */
export function permissionSpeech(screenOk: boolean, accessibilityOk: boolean): Segment[] | null {
  if (screenOk && accessibilityOk) return null;
  const key: keyof typeof PERMISSION_LINES = accessibilityOk ? 'perm_screen' : !screenOk ? 'perm_both' : 'perm_access';
  return [{ cacheKey: key, text: () => PERMISSION_LINES[key] }];
}

/** Seeded practice prompts — 2-3 concrete phrases per mode so the mic is never blank (spec §8).
 *  Point uses ALWAYS-PRESENT targets (menu bar / status icons) so it works on any screen. */
export const SEEDED_PROMPTS: Record<'talk' | 'point' | 'circle', string[]> = {
  talk: ["hey Kairo, what's up?", 'how are you today?', 'tell me a fun fact'],
  point: ["where's the wifi icon?", 'point at the battery', "where's the Apple menu?"],
  circle: ['circle any icon and ask what it is', 'circle something and ask about it']
};

/** Pick one seeded prompt for a mode, rotating by `seed` (e.g. a per-mount counter). */
export function pickSeededPrompt(mode: 'talk' | 'point' | 'circle', seed: number): string {
  const list = SEEDED_PROMPTS[mode];
  return list[((seed % list.length) + list.length) % list.length];
}

/** Act 5a — sign in (temp panel). Static line, cached. */
export const ACT5_SIGNIN: Segment[] = [
  { cacheKey: 'act5_signin', text: () => "Almost done — let's save your setup. Sign in with Google." }
];

/** Spoken once the Google name is known (dynamic — synthesized live). */
export const act5Greeting = (name: string): Segment[] =>
  name ? [{ text: () => `Nice to meet you, ${name}.` }] : [];

/** Act 5b — source chips. Static line, cached. */
export const ACT5_SOURCE: Segment[] = [
  { cacheKey: 'act5_source', text: () => "Last thing — where'd you hear about me?" }
];

/** Act 6 — warm ending. First line personalized (live), second cached. */
export const act6Ending = (name: string): Segment[] => [
  { text: () => (name ? `You're all set, ${name}.` : "You're all set.") },
  { cacheKey: 'act6_ending', text: () => "Hold Option and Control any time — I'll be right here." }
];

/** The static lines we pre-generate + ship (consumed by scripts/gen-onboarding-audio.ts). */
export const CACHED_LINES: { key: string; text: string }[] = [
  ...STEPS.flatMap((s) => s.speech)
    .filter((seg) => seg.cacheKey)
    .map((seg) => ({ key: seg.cacheKey as string, text: seg.text('') })),
  // The permission variants aren't reachable via STEPS.speech (spoken dynamically), so add them.
  ...Object.entries(PERMISSION_LINES).map(([key, text]) => ({ key, text })),
  // Act 1-2 coach lines (Phase 3).
  ...Object.values(ACT_LINES).map((seg) => ({ key: seg.cacheKey as string, text: seg.text('') })),
  // Act 3 permission lines (Phase 4).
  ...Object.entries(ACT3_LINES).map(([key, text]) => ({ key, text })),
  // Act 5-6 lines (Phase 6) — spoken outside the STEPS wizard.
  ...[...ACT5_SIGNIN, ...ACT5_SOURCE, ...act6Ending('')]
    .filter((seg) => seg.cacheKey)
    .map((seg) => ({ key: seg.cacheKey as string, text: seg.text('') })),
];
