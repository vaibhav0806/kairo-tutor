import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isInvited } from '../access/service';
import { env } from '../config/env';
import { clientBucket, consume } from '../lib/budget';
import {
  issueDownloadToken,
  looksLikeEmail,
  recordDownloadRequest,
  verifyDownloadToken,
} from './service';

const RequestBody = z.object({ email: z.string().min(3).max(254) });
const DownloadQuery = z.object({ token: z.string().min(10).max(512) });

/**
 * The DMG lives on this box, not on a public URL, precisely so that "download Kairo" can require an
 * invited email. R2 still hosts the updater artifacts — those are fetched by apps that are already
 * installed, so gating them would only break updates for people who are already in.
 */
export async function downloadRoutes(app: FastifyInstance) {
  // "Am I allowed to download?" — the only public entry point.
  app.post<{ Body: { email?: string } }>('/v1/download/request', async (req, reply) => {
    if (!(await consume(`dlreq:${clientBucket(req.ip)}`, 10, 60_000))) {
      return reply.status(429).send({ error: 'rate_limited', code: 'bad_request' });
    }
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success || !looksLikeEmail(parsed.data.email)) {
      return reply.status(400).send({ error: 'bad_email', code: 'bad_request' });
    }

    const email = parsed.data.email;
    const invited = await isInvited(email);
    await recordDownloadRequest(email, invited);
    // Never log the address itself — only whether it cleared the gate.
    req.log.info({ invited }, 'download requested');

    if (!invited) return reply.send({ invited: false });
    return reply.send({ invited: true, url: `/v1/download/dmg?token=${issueDownloadToken(email)}` });
  });

  // Serves the actual bytes. The token is short-lived and email-bound, so a shared link dies fast.
  app.get<{ Querystring: { token?: string } }>('/v1/download/dmg', async (req, reply) => {
    const parsed = DownloadQuery.safeParse(req.query);
    const email = parsed.success ? verifyDownloadToken(parsed.data.token) : null;
    if (!email) {
      req.log.info('download refused: bad or expired token');
      return reply.status(403).send({ error: 'bad_token', code: 'unauthenticated' });
    }

    // Re-check the list at download time: an invite pulled between request and click must not
    // still hand over a build.
    if (!(await isInvited(email))) {
      return reply.status(403).send({ error: 'not_invited', code: 'unauthenticated' });
    }

    const dir = resolve(env.KAIRO_RELEASES_DIR);
    const file = join(dir, env.KAIRO_RELEASE_DMG_NAME);
    // `dir` and the filename are both server config, never user input, but resolve+prefix check
    // keeps it that way if either ever becomes dynamic.
    if (!file.startsWith(`${dir}/`)) return reply.status(500).send({ error: 'bad_path', code: 'provider_error' });

    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      req.log.error({ dir }, 'release DMG missing on disk');
      return reply.status(503).send({ error: 'no_build', code: 'provider_error' });
    }

    reply
      .header('content-type', 'application/x-apple-diskimage')
      .header('content-length', info.size)
      .header('content-disposition', `attachment; filename="${env.KAIRO_RELEASE_DMG_NAME}"`)
      .header('cache-control', 'no-store');
    return reply.send(createReadStream(file));
  });
}
