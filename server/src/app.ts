import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandler } from './plugins/error-handler';
import { healthRoutes } from './health/routes';

/** Build the Fastify instance. Returned (not started) so tests can `app.inject(...)`. */
export async function buildApp(): Promise<FastifyInstance> {
  // 16MB body limit: base64 screenshots (~80KB) and WAV (~48KB) plus headroom for hi-DPI captures.
  const app = Fastify({ logger: { level: 'info' }, bodyLimit: 16 * 1024 * 1024 });

  registerErrorHandler(app);
  await app.register(healthRoutes);

  return app;
}
