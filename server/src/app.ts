import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import { env } from './config/env';
import { auth } from './auth/better-auth';
import { ownedAuthRoutes } from './auth/routes';
import { usageRoutes } from './usage/routes';
import { llmRoutes } from './proxy/llm';
import { speechRoutes } from './proxy/speech';
import { billingRoutes } from './billing/routes';
import { dodoWebhookRoutes } from './billing/webhook';
import { onboardingRoutes } from './onboarding/routes';
import { downloadRoutes } from './download/routes';
import { registerErrorHandler } from './plugins/error-handler';
import { healthRoutes } from './health/routes';
import { requestPath } from './logging';

/**
 * Origins allowed to make credentialed cross-origin calls.
 *
 * The desktop webview is the real caller (`tauri://localhost`), and requests with no `Origin` at
 * all — the Rust proxy, curl, the updater — are not browser cross-origin requests and were never
 * what CORS is protecting. What is NOT allowed any more is reflecting an arbitrary website's
 * origin back with `credentials: true`, which is what `origin: true` did: it let any page a signed-
 * in user visited make credentialed requests to this API and read the answers. The desktop routes
 * carry a bearer token rather than a cookie, and Better Auth's cookies are `SameSite=Lax`, so this
 * was hardening rather than an open door — but "two other things happen to stop it" is not a reason
 * to leave the door itself open.
 */
const ALLOWED_ORIGINS = new Set([
  'tauri://localhost', // packaged macOS app
  'http://localhost:5273', // vite dev server
  'http://127.0.0.1:5273',
]);

function allowedOrigin(
  origin: string | undefined,
  cb: (err: Error | null, allow: boolean) => void,
): void {
  // No Origin header: not a browser cross-origin request. Nothing to authorise.
  if (!origin) return cb(null, true);
  if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
  // The site's own origin, so the download and billing return pages keep working if they ever
  // need to call the API from the browser.
  if (origin === env.PUBLIC_BASE_URL) return cb(null, true);
  cb(null, false);
}

/** Build the Fastify instance. Returned (not started) so tests can `app.inject(...)`. */
export async function buildApp(): Promise<FastifyInstance> {
  // 16MB body limit: base64 screenshots (~80KB) and WAV (~48KB) plus headroom for hi-DPI captures.
  const app = Fastify({
    logger: {
      level: 'info',
      serializers: {
        req(request: {
          method?: string;
          url?: string;
          headers?: { host?: string };
          socket?: { remoteAddress?: string; remotePort?: number };
        }) {
          return {
            method: request.method,
            url: requestPath(request.url),
            host: request.headers?.host,
            remoteAddress: request.socket?.remoteAddress,
            remotePort: request.socket?.remotePort,
          };
        },
      },
    },
    bodyLimit: 16 * 1024 * 1024,
    /**
     * One proxy hop: Caddy, on the same host, is the only thing that can reach this container.
     *
     * Without this every per-IP limiter in the service was a single global bucket, because `req.ip`
     * was the Docker bridge gateway for every request on earth — the onboarding limits neither
     * isolated an attacker nor left room for real users, who collided with each other instead.
     *
     * A hop count rather than `true`: `true` trusts whatever `X-Forwarded-For` arrives, so anyone
     * who could reach the container directly would pick their own rate-limit bucket. Counting one
     * hop takes the address Caddy appended and ignores any the caller invented. This must be
     * revisited if a CDN is ever put in front (api.meetkairo.xyz is DNS-only on Cloudflare today,
     * so Caddy is genuinely the only hop).
     */
    trustProxy: 1,
  });

  registerErrorHandler(app);
  await app.register(cors, { origin: allowedOrigin, credentials: true });
  await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024 } });
  await app.register(healthRoutes);
  registerBetterAuth(app);
  await app.register(ownedAuthRoutes);
  await app.register(usageRoutes);
  await app.register(llmRoutes);
  await app.register(speechRoutes);
  await app.register(billingRoutes);
  await app.register(dodoWebhookRoutes);
  await app.register(onboardingRoutes);
  await app.register(downloadRoutes);

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
