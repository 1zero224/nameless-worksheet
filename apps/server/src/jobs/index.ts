import { and, eq, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { PgBoss } from 'pg-boss';
import type { Config } from '../config.js';
import { type Db, schema } from '../db/index.js';

const JOB_CLEANUP_EXPIRED = 'cleanup-expired';
const JOB_PRUNE_REALTIME = 'prune-realtime-events';

/** 清理已过期的会话、邀请和重置记录 */
export async function cleanupExpired(db: Db, now = new Date()): Promise<void> {
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now));
  // 过期超过 7 天的重置记录可清理；邀请保留用于界面展示历史，不物理删除
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  await db.delete(schema.passwordResets).where(lt(schema.passwordResets.expiresAt, sevenDaysAgo));
}

/** 按项目清理早于保留时长的实时事件，并在同一事务中更新 realtime_pruned_through（只增不减） */
export async function pruneRealtimeEvents(
  db: Db,
  retentionHours: number,
  now = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - retentionHours * 60 * 60 * 1000);
  const allProjects = await db.select({ id: schema.projects.id }).from(schema.projects);

  for (const project of allProjects) {
    await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(schema.realtimeEvents)
        .where(
          and(
            eq(schema.realtimeEvents.projectId, project.id),
            lt(schema.realtimeEvents.createdAt, cutoff),
          ),
        )
        .returning({ id: schema.realtimeEvents.id });

      if (deleted.length === 0) return;
      let maxId = 0n;
      for (const row of deleted) {
        if (row.id > maxId) maxId = row.id;
      }

      await tx
        .update(schema.projects)
        .set({
          realtimePrunedThrough: sql`GREATEST(${schema.projects.realtimePrunedThrough}, ${maxId.toString()}::bigint)`,
        })
        .where(eq(schema.projects.id, project.id));
    });
  }
}

export async function startJobs(
  db: Db,
  config: Config,
  logger: FastifyBaseLogger,
): Promise<{ stop: () => Promise<void> }> {
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    schema: 'pgboss',
  });

  boss.on('error', (err) => {
    logger.error({ err }, 'pg-boss error');
  });

  await boss.start();

  await boss.createQueue(JOB_CLEANUP_EXPIRED);
  await boss.createQueue(JOB_PRUNE_REALTIME);

  await boss.schedule(JOB_CLEANUP_EXPIRED, '0 * * * *');
  await boss.schedule(JOB_PRUNE_REALTIME, '15 * * * *');

  await boss.work(JOB_CLEANUP_EXPIRED, async () => {
    await cleanupExpired(db);
  });

  await boss.work(JOB_PRUNE_REALTIME, async () => {
    await pruneRealtimeEvents(db, config.realtimeRetentionHours);
  });

  return {
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 5_000 });
    },
  };
}
