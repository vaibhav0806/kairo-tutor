import type { FastifyInstance } from 'fastify';
import type { OnboardingBody } from '@kairo/shared';
import { requireAuth } from '../plugins/auth-verify';
import { saveProfile } from './service';

/**
 * Onboarding's server surface is now a single authenticated route.
 *
 * There used to be seven more: unauthenticated `/v1/onboarding/*` siblings for TTS, STT, chat,
 * extract, gate and vision, existing only because onboarding ran before sign-in and those turns
 * still needed a provider. No user, no meter, no credit gate — the caller's request was forwarded
 * to OpenRouter or Anthropic on our account. Everything we built around them (model allowlists,
 * token clamps, per-IP buckets, a global daily fuse) was scaffolding to make an open door
 * survivable rather than to close it.
 *
 * Sign-in now happens immediately after the colour step, before anything costs money, so the door
 * is simply gone. Every provider call in the product is authenticated, attributable to a user, and
 * subject to the ordinary quota. Nothing here needs rate limiting because nothing here spends.
 */
export async function onboardingRoutes(app: FastifyInstance) {
  // Save onboarding answers. Authed, like everything else now.
  app.post<{ Body: OnboardingBody }>('/v1/onboarding', { preHandler: requireAuth }, async (req, reply) => {
    const displayName = (req.body?.displayName ?? '').trim().slice(0, 80);
    const source = (req.body?.source ?? '').trim().slice(0, 120);
    // Accent is optional; only persist a well-formed #rrggbb hex, else null.
    const rawAccent = (req.body?.accent ?? '').trim();
    const accent = /^#[0-9a-fA-F]{6}$/.test(rawAccent) ? rawAccent.toLowerCase() : null;
    if (!displayName) return reply.status(400).send({ error: 'name_required', code: 'bad_request' });
    await saveProfile(req.userId!, displayName, source, accent);
    return { ok: true };
  });
}
