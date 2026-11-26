import { and, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { type Db, schema } from '../db/index.js';
import type { StorageDriver } from '../storage/driver.js';

export interface CleanupUploadsReport {
  markedExpired: number;
  cleanedSessions: number;
  deletedOrphans: number;
}

/**
 * 清理超过宽限期的过期/已取消上传会话分片，以及无数据库引用的孤立 R2 对象。
 * 硬约束：绝不删除任何仍在 `blobs` 表中的对象（包括软删版本引用的对象）。
 */
export async function cleanupExpiredUploads(
  db: Db,
  storage: StorageDriver,
  config: Pick<Config, 'uploadCleanupGraceHours' | 'uploadSessionTtlHours'>,
  logger?: FastifyBaseLogger,
  now = new Date(),
): Promise<CleanupUploadsReport> {
  // 1. 将已过期的 uploading 会话置为 expired
  const expiredRows = await db
    .update(schema.uploadSessions)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(eq(schema.uploadSessions.status, 'uploading'), lt(schema.uploadSessions.expiresAt, now)),
    )
    .returning({ id: schema.uploadSessions.id });

  const graceCutoff = new Date(now.getTime() - config.uploadCleanupGraceHours * 3600_000);

  // 2. 扫描超宽限期、尚未清理的 expired / aborted 会话
  const toClean = await db
    .select()
    .from(schema.uploadSessions)
    .where(
      and(
        isNull(schema.uploadSessions.cleanedUpAt),
        or(
          and(
            eq(schema.uploadSessions.status, 'expired'),
            lte(schema.uploadSessions.expiresAt, graceCutoff),
          ),
          and(
            eq(schema.uploadSessions.status, 'aborted'),
            lte(schema.uploadSessions.updatedAt, graceCutoff),
          ),
        ),
      ),
    )
    .limit(200);

  let cleanedSessions = 0;
  for (const session of toClean) {
    try {
      // 检查是否已被 blobs 表引用（如并发补传冲突落库的 blob）
      const [existingBlob] = await db
        .select({ id: schema.blobs.id })
        .from(schema.blobs)
        .where(eq(schema.blobs.r2Key, session.r2Key))
        .limit(1);

      if (!existingBlob) {
        if (session.isMultipart && session.r2UploadId) {
          await storage.abortMultipartUpload({
            key: session.r2Key,
            uploadId: session.r2UploadId,
          });
        } else {
          await storage.deleteObject(session.r2Key);
        }
      }

      await db
        .update(schema.uploadSessions)
        .set({ cleanedUpAt: now, updatedAt: now })
        .where(eq(schema.uploadSessions.id, session.id));
      cleanedSessions += 1;
    } catch (err) {
      logger?.warn({ err, sessionId: session.id }, 'Failed to clean up expired upload session');
    }
  }

  // 3. 孤立对象巡检（仅清理早于 sessionTtl + grace 且既不在 blobs 也不在未清理 upload_sessions 中的对象）
  const orphanCutoff = new Date(
    now.getTime() - (config.uploadSessionTtlHours + config.uploadCleanupGraceHours) * 3600_000,
  );
  let deletedOrphans = 0;

  try {
    const objects = await storage.listObjectsByPrefix('projects/');
    const oldCandidates = objects.filter((o) => o.lastModified < orphanCutoff);

    if (oldCandidates.length > 0) {
      const candidateKeys = oldCandidates.map((o) => o.key);
      const [blobRows, activeSessionRows] = await Promise.all([
        db
          .select({ r2Key: schema.blobs.r2Key })
          .from(schema.blobs)
          .where(inArray(schema.blobs.r2Key, candidateKeys)),
        db
          .select({ r2Key: schema.uploadSessions.r2Key })
          .from(schema.uploadSessions)
          .where(
            and(
              inArray(schema.uploadSessions.r2Key, candidateKeys),
              isNull(schema.uploadSessions.cleanedUpAt),
            ),
          ),
      ]);

      const referencedKeys = new Set<string>();
      for (const b of blobRows) referencedKeys.add(b.r2Key);
      for (const s of activeSessionRows) referencedKeys.add(s.r2Key);

      for (const obj of oldCandidates) {
        if (referencedKeys.has(obj.key)) continue;
        try {
          await storage.deleteObject(obj.key);
          deletedOrphans += 1;
        } catch (err) {
          logger?.warn({ err }, 'Failed to delete orphan storage object');
        }
      }
    }
  } catch (err) {
    logger?.warn({ err }, 'Failed to scan storage prefix for orphan objects');
  }

  return {
    markedExpired: expiredRows.length,
    cleanedSessions,
    deletedOrphans,
  };
}
