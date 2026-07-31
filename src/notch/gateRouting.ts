export type AskSource = 'voice' | 'typed';

export type GatePlan = {
  /** Whether to run the text gate at all. */
  gateRan: boolean;
  /** Whether this turn must take the screenshot path. */
  needsScreen: boolean;
};

/**
 * Decide how an ask is routed, and — separately — whether the gate speaks first.
 *
 * These are two different questions that used to be collapsed into one. The gate answers
 * "does this need a screenshot?", but it also produces the sentence Kairo says immediately,
 * which is what covers the multi-second vision turn. A turn with pen marks already knows the
 * routing answer, so the gate was skipped entirely — and with it went the speech, leaving the
 * user in silence for the whole vision call.
 *
 * So: run the gate for every voice ask, and treat its routing opinion as advisory. Marks or a
 * typed ask force the screen path no matter what it says.
 */
export function planGate(input: {
  source: AskSource;
  annotationCount: number;
  hasGestureMarks: boolean;
  gateNeedsScreen: boolean;
}): GatePlan {
  const marked = input.annotationCount > 0 || input.hasGestureMarks;
  return {
    // Typed asks are already explicit text; they route screen-first with no gate.
    gateRan: input.source === 'voice',
    needsScreen: input.source === 'typed' || marked || input.gateNeedsScreen,
  };
}
