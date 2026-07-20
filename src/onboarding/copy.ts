// Kairo's onboarding voice — warm, first-person. `title` is shown; `speech` is spoken (not shown).
// Static segments carry a `cacheKey` → we ship a pre-generated audio file for them (no Sarvam call
// at runtime). Dynamic segments (with the user's name) are synthesized live.

export type StepId =
  | 'welcome'
  | 'name'
  | 'signin'
  | 'source'
  | 'permissions'
  | 'learn_talk'
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
    id: 'welcome',
    title: () => "Hey, I'm Kairo!",
    speech: [
      {
        cacheKey: 'welcome',
        text: () =>
          "Hey, I'm Kairo. I live on your screen, and help you get things done, one step at a time.",
      },
    ],
  },
  {
    id: 'name',
    title: () => 'What should I call you?',
    speech: [{ cacheKey: 'name', text: () => 'What can we call you? You can either talk, or type it out below.' }],
  },
  {
    id: 'signin',
    title: () => 'Sign in with Google',
    speech: [
      { text: (n) => (n ? `Nice to meet you, ${n}.` : '') },
      { cacheKey: 'signin', text: () => "Let's get you signed in." },
    ],
  },
  {
    id: 'source',
    title: () => 'Where did you find us?',
    speech: [{ cacheKey: 'source', text: () => 'By the way, where did you hear about Kairo?' }],
  },
  {
    // Spoken dynamically (see permissionSpeech) so Kairo only mentions the permissions that
    // are still missing. `speech` here is a fallback only.
    id: 'permissions',
    title: () => 'A couple of permissions',
    speech: [{ text: () => PERMISSION_LINES.perm_both }],
  },
  {
    // Interactive: the user holds ⌥⌃ and actually talks; Kairo replies for real (dynamic chat).
    id: 'learn_talk',
    title: () => 'Talk to me',
    speech: [
      {
        cacheKey: 'learn_talk',
        text: () =>
          "Let's get you using Kairo for the first time. Hold Option and Control together, say something like 'hey Kairo, what's up', then let go. I'm listening.",
      },
    ],
  },
  {
    // Interactive: the user asks Kairo to point at something on their real screen (gate → vision).
    id: 'learn_point',
    title: () => 'I point, you act',
    speech: [
      {
        cacheKey: 'learn_point',
        text: () =>
          "Here's the fun part. Open any app or web page you like, then hold Option and Control and ask me to point something out — like 'where do I search?'. Watch me find it.",
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
  {
    id: 'done',
    title: (n) => (n ? `You're all set, ${n}` : "You're all set"),
    speech: [
      { text: (n) => (n ? `${n}, you're ready.` : "You're ready.") },
      { cacheKey: 'done', text: () => "Hold Option and Control any time. Let's go." },
    ],
  },
];

/** The permissions line spoken depends on what's already granted — only mention what's missing. */
export const PERMISSION_LINES: Record<'perm_both' | 'perm_screen' | 'perm_access', string> = {
  perm_both:
    'Two last things. I need Screen Recording so I can see your screen, and Accessibility so I can point things out. Grant them below.',
  // Accessibility already on → only Screen Recording missing.
  perm_screen: 'Just one more. Turn on Screen Recording so I can see your screen.',
  // Screen Recording already on → only Accessibility missing.
  perm_access: 'Almost there. Turn on Accessibility so I can point things out for you.',
};

/** Which permission line to speak for the current grant state. null → both granted (say nothing). */
export function permissionSpeech(screenOk: boolean, accessibilityOk: boolean): Segment[] | null {
  if (screenOk && accessibilityOk) return null;
  const key: keyof typeof PERMISSION_LINES = accessibilityOk ? 'perm_screen' : !screenOk ? 'perm_both' : 'perm_access';
  return [{ cacheKey: key, text: () => PERMISSION_LINES[key] }];
}

/** The static lines we pre-generate + ship (consumed by scripts/gen-onboarding-audio.ts). */
export const CACHED_LINES: { key: string; text: string }[] = [
  ...STEPS.flatMap((s) => s.speech)
    .filter((seg) => seg.cacheKey)
    .map((seg) => ({ key: seg.cacheKey as string, text: seg.text('') })),
  // The permission variants aren't reachable via STEPS.speech (spoken dynamically), so add them.
  ...Object.entries(PERMISSION_LINES).map(([key, text]) => ({ key, text })),
];
