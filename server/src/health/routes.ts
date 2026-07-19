import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async () => ({ ok: true }));
  // A real DB probe is wired in once the db client exists (Task 4).
  app.get('/readyz', async () => ({ ok: true }));
}
