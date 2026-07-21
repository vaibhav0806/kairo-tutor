import type { FastifyInstance } from 'fastify';
import type { MeResponse } from '@kairo/shared';
import { requireAuth } from '../plugins/auth-verify';
import { readMe } from './service';

export async function usageRoutes(app: FastifyInstance) {
  app.get('/v1/me', { preHandler: requireAuth }, async (req, reply): Promise<MeResponse | void> => {
    const row = await readMe(req.userId!);
    if (!row) {
      reply.status(404).send({ error: 'no_user', code: 'bad_request' });
      return;
    }
    const isPro = row.plan === 'pro';
    const remaining = isPro ? null : Math.max(row.free_limit - row.used_free, 0);
    return {
      user: { id: req.userId!, email: row.email },
      plan: row.plan,
      status: (row.status ?? 'none') as MeResponse['status'],
      usage: { used: row.used_free, limit: row.free_limit, remaining },
      renews_at: row.current_period_end,
      cancel_at_period_end: row.cancel_at_period_end ?? false,
      paywalled: !isPro && remaining === 0,
      onboarded: !!row.onboarding_completed_at,
      display_name: row.display_name ?? null,
      account_name: row.name ?? null,
    };
  });
}
