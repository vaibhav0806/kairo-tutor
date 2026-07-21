// One source of truth for the OS "Reduce Motion" preference, shared by the notch morph, the pet
// cursor, and the onboarding orchestrator so all three dampen together. matchMedia is absent in
// tests/browser-preview → default to "not reduced".
let cached: MediaQueryList | undefined;

function mq(): MediaQueryList | undefined {
  if (cached) return cached;
  cached = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  return cached;
}

export function prefersReducedMotion(): boolean {
  return mq()?.matches ?? false;
}

/** Subscribe to changes; returns an unlisten. No-op where matchMedia is unavailable. */
export function onReducedMotionChange(cb: (reduced: boolean) => void): () => void {
  const query = mq();
  if (!query) return () => {};
  const handler = (event: MediaQueryListEvent) => cb(event.matches);
  query.addEventListener?.('change', handler);
  return () => query.removeEventListener?.('change', handler);
}
