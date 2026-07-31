import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { MeResponse } from '@kairo/shared';
import { requireAuth } from '../plugins/auth-verify';
import { saveDisplayName } from '../onboarding/service';
import { readMe } from './service';

/** A display name is a label, not prose: bounded, single-line, and trimmed. Empty clears it. */
const DisplayNameBody = z.object({ display_name: z.string().max(80) });

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

  /**
   * Rename yourself. This must be persisted server-side: `/v1/me` is the source the desktop
   * caches from, so a rename kept only in the local marker file was overwritten by the very next
   * sync — the user renamed themselves, saw it work, and got the old name back.
   */
  app.patch('/v1/me', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = DisplayNameBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'bad_display_name', code: 'bad_request' });
    }
    // Newlines and control characters would corrupt the prompt line the name is injected into.
    const cleaned = parsed.data.display_name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    const saved = await saveDisplayName(req.userId!, cleaned);
    req.log.info({ nameChars: saved?.length ?? 0 }, 'display name updated');
    return { display_name: saved };
  });
}
