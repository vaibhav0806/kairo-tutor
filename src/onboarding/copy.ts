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
    title: () => "Hey — I'm Kairo",
    speech: [
      {
        cacheKey: 'welcome',
        text: () =>
          "Hey, I'm Kairo. I live on your screen and help you get things done, one step at a time. Give me a minute, and I'll show you how.",
      },
    ],
  },
  {
    id: 'name',
    title: () => 'What should I call you?',
    speech: [{ cacheKey: 'name', text: () => 'Tell me your name — you can talk, or type. Your call.' }],
  },
  {
    id: 'signin',
    title: () => 'Save your spot',
    speech: [
      { text: (n) => (n ? `Nice to meet you, ${n}.` : '') },
      { cacheKey: 'signin', text: () => 'Sign in with Google, so I remember you next time.' },
    ],
  },
  {
    id: 'source',
    title: () => 'Where did you find us?',
    speech: [{ cacheKey: 'source', text: () => 'Quick one — how did you hear about Kairo?' }],
  },
  {
    id: 'permissions',
    title: () => 'A couple of permissions',
    speech: [
      {
        cacheKey: 'permissions',
        text: () => 'To see your screen and point things out, I need Screen Recording and Accessibility.',
      },
    ],
  },
  {
    id: 'learn_talk',
    title: () => 'Hold ⌥⌃ and just talk',
    speech: [
      {
        cacheKey: 'learn_talk',
        text: () =>
          "Here's the one thing to remember: hold Option and Control, then ask me anything. Let go when you're done. Tap the same keys to type instead.",
      },
    ],
  },
  {
    id: 'learn_point',
    title: () => 'I point, you act',
    speech: [
      {
        cacheKey: 'learn_point',
        text: () => "I won't click for you — I'll point. Watch for my cursor and the glowing box, and you make the move.",
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

/** The static lines we pre-generate + ship (consumed by scripts/gen-onboarding-audio.ts). */
export const CACHED_LINES: { key: string; text: string }[] = STEPS.flatMap((s) => s.speech)
  .filter((seg) => seg.cacheKey)
  .map((seg) => ({ key: seg.cacheKey as string, text: seg.text('') }));
