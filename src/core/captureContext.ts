/** The identity of whatever was frontmost when a screenshot was taken. */
export type FrontmostApp = {
  activeApp?: string;
  bundleId?: string | null;
};

/** Our own bundle id — the interactive overlay can take key, which fronts Kairo itself. */
export const KAIRO_BUNDLE_ID = 'com.kairo.tutor';

/**
 * Whether a visual target drawn now would still land on the screen it was computed from.
 *
 * The native capture guard only covers the ~170ms the screenshot itself takes, which no human can
 * hit. The gap that actually bites is the several seconds between capture and speaking a step: the
 * user switches app while waiting, and the box is then drawn over whatever is in front now, which
 * is not what the model looked at. Pointing confidently at the wrong window is worse than not
 * pointing at all, so callers suppress the box and keep the spoken answer.
 *
 * Kairo becoming frontmost does NOT count as a change. The annotation overlay must be able to
 * become key, so drawing can front our own app; treating that as a switch would suppress the very
 * boxes we just drew. The user's app is still underneath.
 */
export function shouldSuppressVisualTargets(
  captured: FrontmostApp | null | undefined,
  current: FrontmostApp | null | undefined,
): boolean {
  if (!captured || !current) return false; // Unknown identity is not evidence of a change.
  if (isKairo(current)) return false;

  const capturedId = normalize(captured.bundleId);
  const currentId = normalize(current.bundleId);
  if (capturedId && currentId) return capturedId !== currentId;

  // No bundle id on one side (AppleScript fallback): compare the names we do have.
  const capturedName = normalize(captured.activeApp);
  const currentName = normalize(current.activeApp);
  if (!capturedName || !currentName) return false;
  return capturedName !== currentName;
}

function isKairo(app: FrontmostApp): boolean {
  return normalize(app.bundleId) === KAIRO_BUNDLE_ID;
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}
