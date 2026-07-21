import type { FastifyRequest } from 'fastify';
import { isPaywalled } from '../usage/service';
import { QuotaExceededError } from './error-handler';

/**
 * preHandler (runs AFTER requireAuth): refuse a paywalled user BEFORE any provider call, so we
 * never spend a cent on someone out of free requests — on ANY provider route (gate, STT, TTS,
 * pointing, vision), not just the metered one. Throws QuotaExceededError -> 402.
 */
export async function requireCredits(req: FastifyRequest): Promise<void> {
  if (req.userId && (await isPaywalled(req.userId))) {
    throw new QuotaExceededError('free limit reached');
  }
}
