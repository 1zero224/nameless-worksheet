import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';

export function registerHealthRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/health', { config: { access: 'public' } }, async () => {
    return { status: 'ok' };
  });

  app.get('/api/health/ready', { config: { access: 'public' } }, async (_request, reply) => {
    try {
      await db.execute(sql`SELECT 1`);
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'error' });
    }
  });
}
