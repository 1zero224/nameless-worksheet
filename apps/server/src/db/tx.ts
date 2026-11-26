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

interface PublishTicket {
  status: 'pending' | 'committed' | 'aborted';
  events: StoredRealtimeEvent[];
}

/**
 * 按项目维护进程内发布顺序队列：
 * 虽然 PostgreSQL 事务级咨询锁保证写库与 COMMIT 顺序严格递增，
 * 但在高并发下两个并发连接的 COMMIT 响应在 Node.js 事件循环中可能乱序唤醒。
 * 在持有咨询锁期间登记 ticket，事务提交后按队列顺序 drain，确保事件总线收到严格递增的事件编号。
 */
const busPublishQueues = new WeakMap<EventBus, Map<string, PublishTicket[]>>();

function getBusQueues(bus: EventBus): Map<string, PublishTicket[]> {
  let map = busPublishQueues.get(bus);
  if (!map) {
    map = new Map<string, PublishTicket[]>();
    busPublishQueues.set(bus, map);
  }
  return map;
}

function drainPublishQueue(projectId: string, bus: EventBus): void {
  const queues = busPublishQueues.get(bus);
  const queue = queues?.get(projectId);
  if (!queues || !queue) return;

  while (queue.length > 0) {
    const head = queue[0];
    if (!head || head.status === 'pending') break;
    queue.shift();
    if (head.status === 'committed' && head.events.length > 0) {
      bus.publish(head.events);
    }
  }

  if (queue.length === 0) {
    queues.delete(projectId);
  }
}

/**
 * 统一的事务封装：
 * 1. 在事务内执行业务修改，并通过 emit() 登记待发事件。
 * 2. 若有事件，先获取按项目的事务级咨询锁，再插入 realtime_events，保证事件编号顺序等于提交顺序。
 * 3. 事务提交成功后按项目严格递增顺序通过事件总线分发；回滚则丢弃不发。
 */
export async function withTx<T>(
  db: Db,
  bus: EventBus,
  actor: TxActor,
  fn: (ctx: TxContext) => Promise<T>,
): Promise<{ result: T; events: StoredRealtimeEvent[] }> {
  const pending: PendingEvent[] = [];
  const stored: StoredRealtimeEvent[] = [];
  let ticket: PublishTicket | null = null;

  try {
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

        // 在持有咨询锁期间按严格编号顺序入队，确保后续 bus.publish 永不乱序
        ticket = { status: 'pending', events: stored };
        const queues = getBusQueues(bus);
        let queue = queues.get(actor.projectId);
        if (!queue) {
          queue = [];
          queues.set(actor.projectId, queue);
        }
        queue.push(ticket);
      }

      return out;
    });

    if (ticket) {
      (ticket as PublishTicket).status = 'committed';
      drainPublishQueue(actor.projectId, bus);
    }

    return { result, events: stored };
  } catch (err) {
    if (ticket) {
      (ticket as PublishTicket).status = 'aborted';
      drainPublishQueue(actor.projectId, bus);
    }
    throw err;
  }
}
