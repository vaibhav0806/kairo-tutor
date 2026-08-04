import type { FastifyRequest } from 'fastify';
import { consumeDetailed } from '../lib/budget';
import { RateLimitedError } from './error-handler';

/**
 * Per-account limits, applied to everyone — Pro included.
 *
 * "Unmetered" was doing two jobs it should never have done together: not billed, and not bounded.
 * A subscription buys unlimited *questions*, not unlimited *request rate*, and the difference is
 * the whole attack surface once someone has any valid account. A stolen token, a client stuck in a
 * retry loop, or a resold login all look identical to a very fast user, and none of them should be
 * able to run all night.
 *
 * Two windows, because they answer different questions:
 *
 *   burst (per minute) — "is this a human working, or a script?" Sized so someone using Kairo hard
 *                        never sees it, and a loop hits it within seconds rather than after hours.
 *   daily             — "has something been wrong all day?" Far above real use; reaching it means
 *                        a retry loop or a shared account, and leaves a row saying who.
 *
 * Both refuse with 429 and `Retry-After`, never 402. 402 means "buy more", which is the wrong thing
 * to say to someone who already pays.
 *
 * The identity is the user id. That is the point of moving sign-in ahead of the paid calls: an
 * address was never a caller, because one office shares one and one attacker rents thousands.
 */
const LIMITS = {
  // The routing decision on every ask, plus text turns. A human asks a handful a minute.
  'llm-chat': { burst: 60, daily: 2_000 },
  // The expensive one. Metered for free users; this is what bounds a Pro account.
  vision: { burst: 20, daily: 1_000 },
  // Pointing runs at most once per ask, alongside a vision turn.
  'vision-point': { burst: 30, daily: 1_000 },
  // One transcription per spoken question.
  stt: { burst: 30, daily: 1_500 },
  // One or more spoken replies per answer; streaming is the common path.
  tts: { burst: 60, daily: 4_000 },
  // Auditioning voices in Settings. Cached per voice, so this is generous already.
  'voice-preview': { burst: 20, daily: 200 },
} as const satisfies Record<string, { burst: number; daily: number }>;

export const ACCOUNT_LIMITS = LIMITS;
export const BURST_WINDOW_MS = 60_000;
export const DAILY_WINDOW_MS = 24 * 60 * 60_000;

export type AccountRoute = keyof typeof LIMITS;

/**
 * Charge one call against this account's burst and daily allowances for `route`.
 *
 * Burst is checked first: it is the cheaper refusal and the one a runaway client will hit, so a
 * loop is stopped in seconds instead of quietly eating the day's allowance first.
 */
export async function chargeAccount(req: FastifyRequest, route: AccountRoute): Promise<void> {
  const userId = req.userId;
  if (!userId) return; // requireAuth runs first; nothing to charge without it.

  const { burst, daily } = LIMITS[route];

  const perMinute = await consumeDetailed(`acct:${route}:${userId}`, burst, BURST_WINDOW_MS);
  if (!perMinute.allowed) {
    req.log.warn({ route, limit: burst }, 'account exceeded its per-minute allowance');
    throw new RateLimitedError(
      'Too many requests. Please wait a moment.',
      secondsUntil(perMinute.resetAt),
      burst,
      perMinute.resetAt,
    );
  }

  const perDay = await consumeDetailed(`acctd:${route}:${userId}`, daily, DAILY_WINDOW_MS);
  if (!perDay.allowed) {
    // Loud: nobody using the product normally reaches this, so it is a retry loop or a shared
    // account, and either way someone should look.
    req.log.error({ route, limit: daily }, 'account exhausted its daily allowance');
    throw new RateLimitedError(
      'Daily limit reached. Please try again tomorrow.',
      secondsUntil(perDay.resetAt),
      daily,
      perDay.resetAt,
    );
  }
}

/** Whole seconds until `resetAt`, floored at 1 so a client never retries instantly. */
function secondsUntil(resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
}
