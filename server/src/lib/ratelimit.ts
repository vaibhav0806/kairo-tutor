// Minimal in-memory per-key sliding-window limiter. Single-instance only; it just bounds abuse of
// the unauthenticated onboarding voice endpoints. Swap for @fastify/rate-limit if we scale out.
const hits = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    return false;
  }
  arr.push(now);
  hits.set(key, arr);
  return true;
}
