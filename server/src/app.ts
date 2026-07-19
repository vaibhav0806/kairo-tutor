import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './config/env';
import { auth } from './auth/better-auth';
import { ownedAuthRoutes } from './auth/routes';
import { usageRoutes } from './usage/routes';
import { registerErrorHandler } from './plugins/error-handler';
import { healthRoutes } from './health/routes';

/** Build the Fastify instance. Returned (not started) so tests can `app.inject(...)`. */
export async function buildApp(): Promise<FastifyInstance> {
  // 16MB body limit: base64 screenshots (~80KB) and WAV (~48KB) plus headroom for hi-DPI captures.
  const app = Fastify({ logger: { level: 'info' }, bodyLimit: 16 * 1024 * 1024 });

  registerErrorHandler(app);
  await app.register(healthRoutes);
  registerBetterAuth(app);
  await app.register(ownedAuthRoutes);
  await app.register(usageRoutes);

  return app;
}

/**
 * Mount Better Auth on a catch-all. Fastify already parses the JSON body, so we re-serialize it
 * into the Web `Request` the handler expects (drop content-length so fetch recomputes it).
 * The Dodo webhook (Plan 3) needs the exact raw bytes — that route gets its own raw parser.
 */
function registerBetterAuth(app: FastifyInstance) {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const url = new URL(req.url, env.PUBLIC_BASE_URL);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (key === 'content-length' || key === 'transfer-encoding') continue;
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(', '));
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const res = await auth.handler(
        new Request(url, {
          method: req.method,
          headers,
          body: hasBody && req.body != null ? JSON.stringify(req.body) : undefined,
        }),
      );
      reply.status(res.status);
      res.headers.forEach((value, key) => {
        // Drop content-length: it's stale after our re-serialization; Fastify recomputes it.
        if (key !== 'content-length') reply.header(key, value);
      });
      // Auth responses are small JSON / redirects — buffering is simpler and reliable than streaming.
      reply.send(await res.text());
    },
  });
}
