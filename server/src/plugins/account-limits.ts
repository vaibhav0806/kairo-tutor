import type { FastifyRequest } from 'fastify';
import { consume } from '../lib/budget';
import { QuotaExceededError } from './error-handler';

/**
 * Per-account ceilings for the routes the meter does not charge for.
 *
 * `usage_event` records the turns that cost a credit — the two vision routes — because that is
 * what billing needs. Everything else authenticated (the gate, pointing, speech-to-text, both
 * text-to-speech routes) is credit-gated but unmetered, which until now meant *unrecorded and
 * unbounded*. For a Pro subscriber, who is unmetered by design, that made "one subscription" and
 * "unlimited speech and text inference" the same thing, with no trace of it anywhere.
 *
 * These limits are deliberately far above real use — a person working through a lesson does not
 * approach them, and hitting one means something is wrong: a client stuck in a retry loop, or an
 * account being shared or resold. They exist to make "unmetered" mean "not billed" rather than
 * "unbounded", and to leave a row behind that says who did it.
 *
 * The identity is the user id, which is the whole reason sign-in moved ahead of the paid calls.
 * Bucketing by address was never a real identity: one office shares an address, and one attacker
 * rents thousands.
 */
export const ACCOUNT_DAILY_LIMITS = {
  // The every-ask routing decision plus text turns. Two or three per ask.
  'llm-chat': 2_000,
  // Pointing runs at most once per ask, alongside a vision turn.
  'vision-point': 1_000,
  // One transcription per spoken question.
  stt: 1_500,
  // One or more spoken replies per answer; streaming is the common path.
  tts: 4_000,
  // Auditioning voices in Settings. Cached per voice, so this is generous already.
  'voice-preview': 200,
} as const satisfies Record<string, number>;

export const ACCOUNT_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Charge one call against this account's daily allowance for `route`.
 *
 * Throws `QuotaExceededError` (402) when exhausted, matching what the desktop already understands
 * from the free-request path. A database failure allows the call: this bounds an anomaly, and it
 * must not become a dependency that can take the product down.
 */
export async function chargeAccount(req: FastifyRequest, route: keyof typeof ACCOUNT_DAILY_LIMITS): Promise<void> {
  const userId = req.userId;
  if (!userId) return; // requireAuth runs first; nothing to charge without it.

  const limit = ACCOUNT_DAILY_LIMITS[route];
  if (!(await consume(`acct:${route}:${userId}`, limit, ACCOUNT_WINDOW_MS))) {
    req.log.error({ route, limit }, 'account exceeded its daily allowance for an unmetered route');
    throw new QuotaExceededError('daily limit reached');
  }
}
