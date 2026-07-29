// The busy label, as a function of how long Kairo has actually been busy.
//
// A single frozen word for eight seconds reads as "hung". A vision round-trip on a dense screen
// genuinely can take that long, so the label acknowledges the wait instead of pretending it isn't
// happening: the playful gerund carries the first couple of seconds (that is the charm, and most
// turns never leave this tier), and after that the copy admits what is going on.
//
// Pure and data-driven so the thresholds are testable and tunable without touching NotchApp.

export type ThinkingTier = {
  /** Show this tier once the spell has been running for at least this long. */
  fromMs: number;
  /** `verb` is the gerund picked once per spell (thinkingVerbs.ts). */
  label: (verb: string) => string;
};

/**
 * A turn that genuinely captured the screen. Naming what Kairo is doing is reassuring precisely
 * because it is TRUE — so this set is only ever used when a capture actually happened.
 */
export const THINKING_TIERS: readonly ThinkingTier[] = [
  { fromMs: 0, label: (verb) => verb },
  { fromMs: 3000, label: () => 'Reading the screen' },
  { fromMs: 7000, label: () => 'Still going — this one is dense' },
  { fromMs: 13000, label: () => 'Almost there' }
];

/**
 * A turn that never touches the screen: the onboarding say-hi drill is transcribe → chat → speak,
 * with no capture anywhere in it (demoController.runTalkTurn). Claiming to read the screen there is
 * a lie the user can catch, and it is confusing during the one act that is teaching them what Kairo
 * even does.
 */
export const THINKING_TIERS_OFFSCREEN: readonly ThinkingTier[] = [
  { fromMs: 0, label: (verb) => verb },
  { fromMs: 3000, label: () => 'Still with you' },
  { fromMs: 7000, label: () => 'Taking a little longer' },
  { fromMs: 13000, label: () => 'Almost there' }
];

/**
 * The label for a spell that began `elapsedMs` ago. `readsScreen` picks the tier set — pass false
 * for anything that is not a vision turn.
 */
export function thinkingLabel(verb: string, elapsedMs: number, readsScreen = true): string {
  const tiers = readsScreen ? THINKING_TIERS : THINKING_TIERS_OFFSCREEN;
  let current = tiers[0];
  for (const tier of tiers) {
    if (elapsedMs >= tier.fromMs) current = tier;
  }
  return current.label(verb);
}

/**
 * Milliseconds until the label would next change, or null if it never will again. Lets the notch
 * schedule one timeout per tier instead of ticking every second for a state that usually lasts
 * under two.
 */
export function msUntilNextTier(elapsedMs: number): number | null {
  const next = THINKING_TIERS.find((tier) => tier.fromMs > elapsedMs);
  return next ? next.fromMs - elapsedMs : null;
}
