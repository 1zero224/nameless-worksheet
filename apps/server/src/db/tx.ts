import { createHash } from 'node:crypto';
import type { Scope } from '@nw/shared';
import { sql } from 'drizzle-orm';
import type { EventBus, StoredRealtimeEvent } from '../realtime/bus.js';
import { type Db, schema, type Tx } from './index.js';

export interface PendingEvent {
  scope: Scope;
  type: string;
  payload: unknown;
}

export interface TxContext {
  tx: Tx;
  emit: (event: PendingEvent) => void;
}

export interface TxActor {
  projectId: string;
  userId?: string | null;
  originConnId?: string | null;
}

/** 从项目 ID 派生 64 位咨询锁键 */
export function projectAdvisoryKey(projectId: string): bigint {
  const digest = createHash('sha256').update(`realtime:${projectId}`).digest();
  return digest.readBigInt64BE(0);
}

/**
 * 统一的事务封装：
 * 1. 在事务内执行业务修改，并通过 emit() 登记待发事件。
 * 2. 若有事件，先获取按项目的事务级咨询锁，再插入 realtime_events，保证事件编号顺序等于提交顺序。
 * 3. 事务提交成功后通过事件总线分发；回滚则不发。
 */
export async function withTx<T>(
  db: Db,
  bus: EventBus,
  actor: TxActor,
  fn: (ctx: TxContext) => Promise<T>,
): Promise<{ result: T; events: StoredRealtimeEvent[] }> {
  const pending: PendingEvent[] = [];
  const stored: StoredRealtimeEvent[] = [];

  const result = await db.transaction(async (tx) => {
    const out = await fn({
      tx,
      emit: (event) => {
        pending.push(event);
      },
    });

    if (pending.length > 0) {
      const lockKey = projectAdvisoryKey(actor.projectId);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey.toString()}::bigint)`);

      const inserted = await tx
        .insert(schema.realtimeEvents)
        .values(
          pending.map((e) => ({
            projectId: actor.projectId,
            scopeType: e.scope.type,
            scopeId: e.scope.id,
            type: e.type,
            payload: e.payload,
            actorUserId: actor.userId ?? null,
            originConnId: actor.originConnId ?? null,
          })),
        )
        .returning();

      for (const row of inserted) {
        stored.push({
          id: row.id,
          projectId: row.projectId,
          scope: { type: row.scopeType, id: row.scopeId },
          type: row.type,
          payload: row.payload,
          actorUserId: row.actorUserId,
          originConnId: row.originConnId,
          createdAt: row.createdAt,
        });
      }
    }

    return out;
  });

  if (stored.length > 0) {
    bus.publish(stored);
  }

  return { result, events: stored };
}
