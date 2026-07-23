// Kairo's onboarding voice — warm, first-person. `title` is shown; `speech` is spoken (not shown).
// Static segments carry a `cacheKey` → we ship a pre-generated audio file for them (no Sarvam call
// at runtime). Dynamic segments (with the user's name) are synthesized live.

export type StepId = 'learn_point' | 'circle';

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
          'Now the fun part. Hold Option and Control together, and ask me to point something out on your screen — like the battery, or the time. Watch me find it.',
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
  // Names the notch so "up here" is concrete (the user should look at the top of their screen).
  act1_wake: {
    cacheKey: 'act1_wake',
    text: () => "Hey — I'm Kairo. See that notch at the top of your screen? That's where I live!"
  },
  // Step 1 of 2 — mic only. Spoken first; we wait for the grant before the second ask.
  act2_mic: {
    cacheKey: 'act2_mic',
    text: () => "First up — I'll need your mic. That's how I hear you. Just hit Allow on the pop-up."
  },
  act2_drill: {
    cacheKey: 'act2_drill',
    text: () =>
      "Here's how you can talk to me. Hold Option and Control together, say something, then let go. I'm listening the whole time you're holding them."
  },
  act2_short: { cacheKey: 'act2_short', text: () => 'Hold the keys slightly longer for me.' },
  act2_empty: { cacheKey: 'act2_empty', text: () => "Hmm, didn't catch that — give it another go." }
} satisfies Record<string, Segment>;

/** The seeded-prompt chip shown during the Act 2 say-hi drill (master spec §8). */
export const ACT2_CHIP = "try: 'hey Kairo, what's up?'";

/** Act 0 — the split "front door" hero. Locked copy (v2 spec §6). Strings live here so the founder
 *  can tweak wording without touching layout/logic. `confirm` is also the color-step CTA (Act 1). */
export const HERO_COPY = {
  wordmark: 'Kairo',
  h1: 'Meet Kairo',
  sub: 'Your screen-native tutor.',
  value: 'Points right at what you need.', // serif, over the demo
  cta: 'Get started →',
  legal: 'By continuing you agree to our Terms and Privacy Policy.',
  confirm: "Let's get started", // color-step lock-in CTA (Act 1)
} as const;

/**
 * Act 3 — "Earn the Eyes". Two separate moments, each: why + benefit + honest privacy line.
 * Screen Recording is spoken first (it forces the relaunch); Accessibility is reframed as
 * "steer the pointer", never "control your Mac".
 */
// ONE line per permission (why + do-it-now in a single audio). Prompt-only: the spoken line points
// the user at the OS pop-up's "Open System Settings" button — we never open Settings ourselves.
// Instruction is FRONT-LOADED — the "a box is popping up now" + what-to-do lands in the first ~2.5s,
// because we fire the OS pop-up 2.5s in (not after the whole line), so the user can act immediately
// while the why/reassurance keeps playing. See BOX_DELAY_MS in Act3Permissions.
export const ACT3_LINES: Record<'act3_screen' | 'act3_access', string> = {
  act3_screen:
    'Time to earn my eyes. A box is popping up now — tap “Open System Settings,” then flip Kairo ' +
    'Tutor on. I only see your screen while you hold Option and Control, and I never save it. ' +
    'macOS may restart me — totally normal.',
  act3_access:
    'Last one — a box is popping up now for Accessibility. Tap “Open System Settings,” then flip ' +
    'Kairo Tutor on. It just lets me nudge the pointer to whatever I’m showing you. That’s everything.'
};

export const act3ScreenLine: Segment[] = [
  { cacheKey: 'act3_screen', text: () => ACT3_LINES.act3_screen }
];
export const act3AccessLine: Segment[] = [
  { cacheKey: 'act3_access', text: () => ACT3_LINES.act3_access }
];

/** Seeded practice prompts — 2-3 concrete phrases per mode so the mic is never blank (spec §8).
 *  Point uses ALWAYS-PRESENT targets (menu bar / status icons) so it works on any screen. */
export const SEEDED_PROMPTS: Record<'talk' | 'point' | 'circle', string[]> = {
  talk: ["hey Kairo, what's up?", 'how are you today?', 'tell me a fun fact'],
  point: ["where's the battery?", 'point at the time', "where's the clock?"],
  circle: ['circle any icon and ask what it is', 'circle something and ask about it']
};

/** Pick one seeded prompt for a mode, rotating by `seed` (e.g. a per-mount counter). */
export function pickSeededPrompt(mode: 'talk' | 'point' | 'circle', seed: number): string {
  const list = SEEDED_PROMPTS[mode];
  return list[((seed % list.length) + list.length) % list.length];
}

/** Spoken retry nudges for a practice beat (chord stays the only Next). Live-synthesised (rare). */
export const PRACTICE_RETRY: Record<'empty' | 'no_target', Segment[]> = {
  empty: [{ text: () => "Didn’t catch that — hold Option and Control and ask me again." }],
  no_target: [
    { text: () => "Hmm, I couldn’t spot that one. Hold Option and Control and try another thing." }
  ]
};

/** Act 5a — sign in (temp panel). Static line, cached. */
export const ACT5_SIGNIN: Segment[] = [
  { cacheKey: 'act5_signin', text: () => "Almost there — let's save your setup. Sign in with Google and we're good." }
];

/** Spoken once the Google name is known (dynamic — synthesized live). */
export const act5Greeting = (name: string): Segment[] =>
  name ? [{ text: () => `Nice to meet you, ${name}.` }] : [];

/** Act 5b — source chips. Static line, cached. */
export const ACT5_SOURCE: Segment[] = [
  { cacheKey: 'act5_source', text: () => "Last thing, I'm curious — where'd you hear about me?" }
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
  // Act 1-2 coach lines (Phase 3).
  ...Object.values(ACT_LINES).map((seg) => ({ key: seg.cacheKey as string, text: seg.text('') })),
  // Act 3 permission lines (Phase 4).
  ...Object.entries(ACT3_LINES).map(([key, text]) => ({ key, text })),
  // Act 5-6 lines (Phase 6) — spoken outside the STEPS wizard.
  ...[...ACT5_SIGNIN, ...ACT5_SOURCE, ...act6Ending('')]
    .filter((seg) => seg.cacheKey)
    .map((seg) => ({ key: seg.cacheKey as string, text: seg.text('') })),
];
