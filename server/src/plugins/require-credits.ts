import type { FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { isPaywalled } from '../usage/service';
import { claimReconcileSlot } from '../billing/entitlement';
import { dodoClient, reconcileBillingAccount } from '../billing/routes';
import { QuotaExceededError } from './error-handler';

/**
 * preHandler (runs AFTER requireAuth): refuse a paywalled user BEFORE any provider call, so we
 * never spend a cent on someone out of free requests — on ANY provider route (gate, STT, TTS,
 * pointing, vision), not just the metered one. Throws QuotaExceededError -> 402.
 *
 * Before refusing, confirm with Dodo. Entitlement lives in `usage_counter.plan` and is written
 * only by a webhook or an explicit sync, so one missed delivery — a failed send, exhausted
 * retries, a restart during a deploy — leaves a paying customer on `free` with nothing to heal
 * it. Reading local state alone means that person is told to upgrade something they already
 * bought, on every request, forever.
 *
 * This is the right place for that check and the wrong place for a blanket one: we only reach
 * here when we are about to say no, which is both the moment correctness matters most and a tiny
 * fraction of traffic. A cooldown bounds the repeat case (see `claimReconcileSlot`), and any
 * provider failure leaves the original local answer standing — billing must never become a
 * dependency that can take the product down.
 */
export async function requireCredits(req: FastifyRequest): Promise<void> {
  if (!req.userId) return;

  // A Pro record whose period has elapsed is the mirror of the case below, and the more expensive
  // one: nothing paywalls that user, so nothing would ever re-check them. Left alone, a
  // cancellation whose webhook went missing serves Pro forever, for free. Confirm with the
  // provider once the local record says the period is over.
  if (await hasLapsedProRecord(req.userId)) {
    await recheckWithProvider(req, 'lapsed pro record');
  }

  if (!(await isPaywalled(req.userId))) return;
  if (await recoveredEntitlement(req)) return;
  throw new QuotaExceededError('free limit reached');
}

/** True when we still hold a Pro-shaped subscription whose paid period has already ended. */
async function hasLapsedProRecord(userId: string): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT status, current_period_end FROM subscription WHERE user_id = ${userId}`);
  const row = r.rows[0] as { status: string; current_period_end: string | null } | undefined;
  if (!row || !row.current_period_end) return false;
  if (!['active', 'on_hold'].includes(row.status)) return false;
  return new Date(row.current_period_end).getTime() <= Date.now();
}

/** True when Dodo says this user is entitled after all. Never throws. */
async function recoveredEntitlement(req: FastifyRequest): Promise<boolean> {
  if (!(await recheckWithProvider(req, 'paywall'))) return false;
  return !(await isPaywalled(req.userId!));
}

/** Ask Dodo for authoritative state, at most once per cooldown. Never throws. Returns whether it ran. */
async function recheckWithProvider(req: FastifyRequest, reason: string): Promise<boolean> {
  const client = dodoClient();
  if (!client) return false;
  if (!(await claimReconcileSlot(req.userId!))) return false;

  try {
    const result = await reconcileBillingAccount(client, req.userId!);
    req.log.warn(
      { reason, synced: result.synced, status: result.status },
      'billing state re-checked against the provider',
    );
    return true;
  } catch (error) {
    // A provider outage must not turn into a wrongly-granted entitlement OR a hard failure; fall
    // back to the local answer, which is what we would have used anyway.
    req.log.error(
      { errorClass: error instanceof Error ? error.name : typeof error },
      'billing re-check failed; using local entitlement',
    );
    return false;
  }
}
