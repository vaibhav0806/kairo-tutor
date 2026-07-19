// Kairo's onboarding voice — warm, first-person, a little playful. Original copy (not Clicky's).

export type StepId =
  | 'welcome'
  | 'name'
  | 'signin'
  | 'source'
  | 'permissions'
  | 'learn_talk'
  | 'learn_point'
  | 'done';

export interface StepDef {
  id: StepId;
  title: (name: string) => string;
  /** Spoken aloud (Sarvam) and shown as the subtitle. */
  say: (name: string) => string;
}

export const STEPS: StepDef[] = [
  {
    id: 'welcome',
    title: () => "Hey — I'm Kairo",
    say: () =>
      "I live on your screen and help you get things done, one step at a time. Give me a minute and I'll show you how.",
  },
  {
    id: 'name',
    title: () => 'What should I call you?',
    say: () => 'Tell me your name — talk or type, your call.',
  },
  {
    id: 'signin',
    title: () => 'Save your spot',
    say: (n) => `${n ? `Nice to meet you, ${n}. ` : ''}Sign in with Google so I remember you next time.`,
  },
  {
    id: 'source',
    title: () => 'Where did you find us?',
    say: () => 'Quick one — how did you hear about Kairo?',
  },
  {
    id: 'permissions',
    title: () => 'A couple of permissions',
    say: () => 'To see your screen and point things out, I need Screen Recording and Accessibility.',
  },
  {
    id: 'learn_talk',
    title: () => 'Hold ⌥⌃ and just talk',
    say: () =>
      "Here's the one thing to remember: hold Option and Control, then ask me anything. Let go when you're done. Tap the same keys to type instead.",
  },
  {
    id: 'learn_point',
    title: () => 'I point, you act',
    say: () =>
      "I won't click for you — I'll point. Watch for my cursor and the glowing box, and you make the move.",
  },
  {
    id: 'done',
    title: (n) => (n ? `You're all set, ${n}` : "You're all set"),
    say: (n) => `${n ? `${n}, you're` : "You're"} ready. Hold Option and Control any time. Let's go.`,
  },
];
