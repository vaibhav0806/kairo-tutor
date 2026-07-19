import type { FastifyInstance } from 'fastify';
import { pool } from '../db/client';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true };
    } catch (e) {
      app.log.error({ e }, 'db not ready');
      return reply.status(503).send({ ok: false });
    }
  });
}
