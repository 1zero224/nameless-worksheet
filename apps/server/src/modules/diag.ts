import { diagTestBodySchema } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { withTx } from '../db/tx.js';
import type { EventBus } from '../realtime/bus.js';
import { parseBody, readOriginConnId } from './helpers.js';

export function registerDiagRoutes(app: FastifyInstance, deps: { db: Db; bus: EventBus }): void {
  const { db, bus } = deps;

  app.post(
    '/api/diag/realtime-test',
    { config: { access: { permission: 'diag.realtime' } } },
    async (request) => {
      const auth = request.auth!;
      const body = parseBody(diagTestBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      const { events } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ emit }) => {
          emit({
            scope: { type: 'diag', id: auth.projectId },
            type: 'diag.ping',
            payload: {
              message: body.message,
              sentAt: new Date().toISOString(),
            },
          });
        },
      );

      return { eventId: events[0]?.id.toString() ?? '0' };
    },
  );
}
