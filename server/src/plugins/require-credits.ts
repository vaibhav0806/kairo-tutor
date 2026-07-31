import type { FastifyRequest } from 'fastify';
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
  if (!(await isPaywalled(req.userId))) return;

  if (await recoveredEntitlement(req)) return;
  throw new QuotaExceededError('free limit reached');
}

/** True when Dodo says this user is entitled after all. Never throws. */
async function recoveredEntitlement(req: FastifyRequest): Promise<boolean> {
  const client = dodoClient();
  if (!client) return false;
  if (!(await claimReconcileSlot(req.userId!))) return false;

  try {
    const result = await reconcileBillingAccount(client, req.userId!);
    const recovered = result.synced && !(await isPaywalled(req.userId!));
    req.log.warn(
      { synced: result.synced, status: result.status, recovered },
      'paywall re-checked against the provider before refusing',
    );
    return recovered;
  } catch (error) {
    // A provider outage must not turn into a wrongly-granted entitlement OR a hard failure; fall
    // back to the local answer, which is what we would have used anyway.
    req.log.error(
      { errorClass: error instanceof Error ? error.name : typeof error },
      'paywall re-check failed; using local entitlement',
    );
    return false;
  }
}
