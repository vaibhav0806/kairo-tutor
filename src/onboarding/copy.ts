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
    title: () => "Hey, I'm Kairo!",
    speech: [
      {
        cacheKey: 'welcome',
        text: () =>
          "Hey, I'm Kairo. I live on your screen, and help you get things done, one step at a time. Give me a minute, and I'll show you how.",
      },
    ],
  },
  {
    id: 'name',
    title: () => 'What should I call you?',
    speech: [{ cacheKey: 'name', text: () => 'What can we call you? You can talk, or type it out below. Your call!' }],
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
    // Interactive: the user actually talks; Kairo responds (RESPONSES.talk_done).
    id: 'learn_talk',
    title: () => 'Your turn — talk to me',
    speech: [
      {
        cacheKey: 'learn_talk',
        text: () => "Now, you try! Tap the mic below, and say anything at all — I'm listening.",
      },
    ],
  },
  {
    // Interactive: Kairo points (a glowing dot); the user clicks it (RESPONSES.point_done).
    id: 'learn_point',
    title: () => 'I point, you act',
    speech: [
      {
        cacheKey: 'learn_point',
        text: () => "See that glowing dot? That's me, pointing. Go on — give it a click.",
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

/** Kairo's spoken replies to the interactive practice steps (also pre-generated + shipped). */
export const RESPONSES: Record<string, string> = {
  talk_done: "Perfect — that's all there is to it! In the app, just hold Option and Control instead of tapping. You've got it.",
  point_done: 'Nailed it! I point, you act. That is the whole idea.',
};

/** The static lines we pre-generate + ship (consumed by scripts/gen-onboarding-audio.ts). */
export const CACHED_LINES: { key: string; text: string }[] = [
  ...STEPS.flatMap((s) => s.speech)
    .filter((seg) => seg.cacheKey)
    .map((seg) => ({ key: seg.cacheKey as string, text: seg.text('') })),
  ...Object.entries(RESPONSES).map(([key, text]) => ({ key, text })),
];
