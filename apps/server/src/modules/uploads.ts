import { randomUUID } from 'node:crypto';
import {
  type AbortUploadResponse,
  type ArtifactScope,
  type CompleteUploadResponse,
  createUploadSessionBodySchema,
  type ListUploadPartsResponse,
  MAX_MULTIPART_PARTS,
  normalizeMimeType,
  promoteUploadToVersionBodySchema,
  type SignUploadPartResponse,
  signUploadPartBodySchema,
  TEXT_PREVIEW_MAX_BYTES,
  type UploadConfigResponse,
  type UploadSessionDetail,
  type UploadSessionInitResponse,
} from '@nw/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { type Db, type Queryable, schema } from '../db/index.js';
import { withTx } from '../db/tx.js';
import { AppError, notFound, uniqueViolation } from '../errors.js';
import type { EventBus } from '../realtime/bus.js';
import {
  buildBlobObjectKey,
  type ListedPart,
  type StorageDriver,
  StorageNoSuchUploadError,
} from '../storage/driver.js';
import {
  deriveScopeKind,
  emitArtifactChanged,
  ensureArtifactParentActive,
  hydrateArtifacts,
  resolveAndValidateScope,
} from './artifacts.js';
import { recordChangeLog } from './change-logs.js';
import { parseBody, parseUuidParam, readOriginConnId } from './helpers.js';

function computePartSize(sizeBytes: number, configuredPartSize: number): number {
  const minForParts = Math.ceil(sizeBytes / MAX_MULTIPART_PARTS);
  return Math.max(configuredPartSize, minForParts);
}

function expectedPartLength(sizeBytes: number, partSizeBytes: number, partNumber: number): number {
  const totalParts = Math.ceil(sizeBytes / partSizeBytes);
  if (partNumber < 1 || partNumber > totalParts) return -1;
  if (partNumber < totalParts) return partSizeBytes;
  return sizeBytes - (totalParts - 1) * partSizeBytes;
}

function scopeFromSession(session: typeof schema.uploadSessions.$inferSelect): ArtifactScope {
  if (session.scopeKind === 'stage' && session.taskId && session.stageColumnId) {
    return { kind: 'stage', taskId: session.taskId, stageColumnId: session.stageColumnId };
  }
  if (session.scopeKind === 'task' && session.taskId) {
    return { kind: 'task', taskId: session.taskId };
  }
  if (session.scopeKind === 'work' && session.workId) {
    return { kind: 'work', workId: session.workId };
  }
  return { kind: 'doc' };
}

async function buildCompletedResponse(
  db: Queryable,
  projectId: string,
  session: typeof schema.uploadSessions.$inferSelect,
): Promise<CompleteUploadResponse> {
  if (
    !session.resultArtifactId ||
    !session.resultVersionId ||
    !session.resultLocationId ||
    !session.resultBlobId
  ) {
    throw new AppError('INTERNAL');
  }
  const [artifactRow] = await db
    .select()
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.projectId, projectId),
        eq(schema.artifacts.id, session.resultArtifactId),
      ),
    )
    .limit(1);
  if (!artifactRow) throw notFound();
  const [detail] = await hydrateArtifacts(db, projectId, [artifactRow]);
  if (!detail) throw new AppError('INTERNAL');
  return {
    artifact: detail,
    versionId: session.resultVersionId,
    locationId: session.resultLocationId,
    blobId: session.resultBlobId,
  };
}

export function registerUploadRoutes(
  app: FastifyInstance,
  deps: { db: Db; bus: EventBus; config: Config; storage: StorageDriver },
): void {
  const { db, bus, config, storage } = deps;

  // GET /api/uploads/config
  app.get('/api/uploads/config', { config: { access: 'authenticated' } }, async () => {
    const res: UploadConfigResponse = {
      maxFileBytes: config.r2MaxFileBytes,
      multipartThresholdBytes: config.r2MultipartThresholdBytes,
      partSizeBytes: config.r2PartSizeBytes,
      concurrency: config.r2UploadConcurrency,
      textPreviewMaxBytes: TEXT_PREVIEW_MAX_BYTES,
    };
    return res;
  });

  // POST /api/uploads/sessions
  app.post(
    '/api/uploads/sessions',
    { config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = request.auth!;
      const body = parseBody(createUploadSessionBodySchema, request.body);

      if (body.sizeBytes > config.r2MaxFileBytes) {
        throw new AppError(
          'VALIDATION_FAILED',
          `文件体积超过上限（最大 ${Math.round(config.r2MaxFileBytes / (1024 * 1024 * 1024))} GiB），请改用网盘链接`,
        );
      }

      const now = new Date();
      const mimeType = normalizeMimeType(body.mimeType, body.filename);

      // 1. 幂等键去重检查
      const [existingByIdem] = await db
        .select()
        .from(schema.uploadSessions)
        .where(
          and(
            eq(schema.uploadSessions.projectId, auth.projectId),
            eq(schema.uploadSessions.idempotencyKey, body.idempotencyKey),
          ),
        )
        .limit(1);

      if (existingByIdem) {
        if (existingByIdem.createdBy !== auth.userId) {
          throw new AppError('CONFLICT', '上传请求幂等键冲突');
        }
        if (existingByIdem.status === 'completed') {
          throw new AppError('CONFLICT', '该上传会话已完成');
        }
        if (existingByIdem.status !== 'uploading' || existingByIdem.expiresAt <= now) {
          throw new AppError('UPLOAD_SESSION_EXPIRED');
        }
        if (existingByIdem.isMultipart && existingByIdem.r2UploadId) {
          try {
            const uploadedParts = await storage.listParts({
              key: existingByIdem.r2Key,
              uploadId: existingByIdem.r2UploadId,
            });
            const res: UploadSessionInitResponse = {
              sessionId: existingByIdem.id,
              mode: existingByIdem.mode,
              resumed: true,
              isMultipart: true,
              partSizeBytes: existingByIdem.partSizeBytes,
              concurrency: config.r2UploadConcurrency,
              maxFileBytes: config.r2MaxFileBytes,
              mimeType: existingByIdem.mimeType,
              originalFilename: existingByIdem.originalFilename,
              expiresAt: existingByIdem.expiresAt.toISOString(),
              uploadedParts,
            };
            return reply.code(200).send(res);
          } catch (err) {
            if (err instanceof StorageNoSuchUploadError) {
              await db
                .update(schema.uploadSessions)
                .set({ status: 'expired', updatedAt: now })
                .where(eq(schema.uploadSessions.id, existingByIdem.id));
              throw new AppError('UPLOAD_SESSION_EXPIRED');
            }
            throw err;
          }
        }
        const singlePutUrl = await storage.signPutObject({
          key: existingByIdem.r2Key,
          contentType: existingByIdem.mimeType,
          contentLength: existingByIdem.sizeBytes,
          expiresInSec: config.r2UploadSignTtlSec,
        });
        const res: UploadSessionInitResponse = {
          sessionId: existingByIdem.id,
          mode: existingByIdem.mode,
          resumed: false,
          isMultipart: false,
          partSizeBytes: null,
          concurrency: config.r2UploadConcurrency,
          maxFileBytes: config.r2MaxFileBytes,
          mimeType: existingByIdem.mimeType,
          originalFilename: existingByIdem.originalFilename,
          expiresAt: existingByIdem.expiresAt.toISOString(),
          singlePutUrl,
        };
        return reply.code(200).send(res);
      }

      // 2. 校验目标挂载点与归属
      let scopeKind: string | null = null;
      let worksheetId: string | null = null;
      let workId: string | null = null;
      let taskId: string | null = null;
      let stageColumnId: string | null = null;
      let artifactId: string | null = null;
      let versionId: string | null = null;
      let artifactName: string | null = null;
      let versionNote = '';

      if (body.mode === 'create_artifact') {
        const resolved = await resolveAndValidateScope(db, auth.projectId, body.scope);
        scopeKind = resolved.scopeKind;
        worksheetId = resolved.worksheetId;
        workId = resolved.workId;
        taskId = resolved.taskId;
        stageColumnId = resolved.stageColumnId;
        artifactName = body.name;
        versionNote = body.versionNote ?? '';
      } else if (body.mode === 'create_version') {
        const [art] = await db
          .select()
          .from(schema.artifacts)
          .where(
            and(
              eq(schema.artifacts.projectId, auth.projectId),
              eq(schema.artifacts.id, body.artifactId),
              isNull(schema.artifacts.deletedAt),
            ),
          )
          .limit(1);
        if (!art) throw notFound();
        await ensureArtifactParentActive(db, auth.projectId, art);
        artifactId = art.id;
        worksheetId = art.worksheetId;
        workId = art.workId;
        taskId = art.taskId;
        stageColumnId = art.stageColumnId;
        versionNote = body.versionNote ?? '';
      } else {
        const [ver] = await db
          .select()
          .from(schema.artifactVersions)
          .where(
            and(
              eq(schema.artifactVersions.projectId, auth.projectId),
              eq(schema.artifactVersions.id, body.versionId),
              isNull(schema.artifactVersions.deletedAt),
            ),
          )
          .limit(1);
        if (!ver) throw notFound();

        const [art] = await db
          .select()
          .from(schema.artifacts)
          .where(
            and(
              eq(schema.artifacts.projectId, auth.projectId),
              eq(schema.artifacts.id, ver.artifactId),
              isNull(schema.artifacts.deletedAt),
            ),
          )
          .limit(1);
        if (!art) throw notFound();
        await ensureArtifactParentActive(db, auth.projectId, art);

        const [existingR2] = await db
          .select({ id: schema.resourceLocations.id })
          .from(schema.resourceLocations)
          .where(
            and(
              eq(schema.resourceLocations.projectId, auth.projectId),
              eq(schema.resourceLocations.versionId, ver.id),
              eq(schema.resourceLocations.type, 'r2'),
              isNull(schema.resourceLocations.deletedAt),
            ),
          )
          .limit(1);
        if (existingR2) {
          throw new AppError(
            'VERSION_ALREADY_HAS_FILE',
            '该版本已有文件，请使用「更新版本」上传新版本',
          );
        }

        artifactId = art.id;
        versionId = ver.id;
        worksheetId = art.worksheetId;
        workId = art.workId;
        taskId = art.taskId;
        stageColumnId = art.stageColumnId;
      }

      const isMultipart = body.sizeBytes > config.r2MultipartThresholdBytes;
      const partSizeBytes = isMultipart
        ? computePartSize(body.sizeBytes, config.r2PartSizeBytes)
        : null;
      const fingerprintSha256 =
        isMultipart && !body.skipResume ? (body.fingerprintSha256 ?? null) : null;

      // 3. 大文件指纹断点复用检查
      if (isMultipart && !body.skipResume && fingerprintSha256) {
        const candidates = await db
          .select()
          .from(schema.uploadSessions)
          .where(
            and(
              eq(schema.uploadSessions.projectId, auth.projectId),
              eq(schema.uploadSessions.createdBy, auth.userId),
              eq(schema.uploadSessions.status, 'uploading'),
              eq(schema.uploadSessions.isMultipart, true),
              eq(schema.uploadSessions.mode, body.mode),
              eq(schema.uploadSessions.fingerprintSha256, fingerprintSha256),
              eq(schema.uploadSessions.sizeBytes, body.sizeBytes),
              gt(schema.uploadSessions.expiresAt, now),
            ),
          )
          .orderBy(desc(schema.uploadSessions.createdAt))
          .limit(10);

        for (const cand of candidates) {
          const sameTarget =
            body.mode === 'create_artifact'
              ? cand.scopeKind === scopeKind &&
                cand.worksheetId === worksheetId &&
                cand.workId === workId &&
                cand.taskId === taskId &&
                cand.stageColumnId === stageColumnId
              : body.mode === 'create_version'
                ? cand.artifactId === artifactId
                : cand.versionId === versionId;

          if (!sameTarget || !cand.r2UploadId) continue;

          try {
            const uploadedParts = await storage.listParts({
              key: cand.r2Key,
              uploadId: cand.r2UploadId,
            });
            const res: UploadSessionInitResponse = {
              sessionId: cand.id,
              mode: cand.mode,
              resumed: true,
              isMultipart: true,
              partSizeBytes: cand.partSizeBytes,
              concurrency: config.r2UploadConcurrency,
              maxFileBytes: config.r2MaxFileBytes,
              mimeType: cand.mimeType,
              originalFilename: cand.originalFilename,
              expiresAt: cand.expiresAt.toISOString(),
              uploadedParts,
            };
            return reply.code(200).send(res);
          } catch (err) {
            if (err instanceof StorageNoSuchUploadError) {
              // R2 侧分片已失效：自动作废旧会话，继续创建新会话
              await db
                .update(schema.uploadSessions)
                .set({ status: 'expired', updatedAt: now })
                .where(eq(schema.uploadSessions.id, cand.id));
              continue;
            }
            throw err;
          }
        }
      }

      // 4. 创建全新会话
      const r2Key = buildBlobObjectKey(auth.projectId, randomUUID());
      let r2UploadId: string | null = null;
      if (isMultipart) {
        const created = await storage.createMultipartUpload({
          key: r2Key,
          contentType: mimeType,
        });
        r2UploadId = created.uploadId;
      }

      const expiresAt = new Date(now.getTime() + config.uploadSessionTtlHours * 3600_000);
      let sessionRow: typeof schema.uploadSessions.$inferSelect | undefined;
      try {
        const rows = await db
          .insert(schema.uploadSessions)
          .values({
            projectId: auth.projectId,
            mode: body.mode,
            scopeKind,
            worksheetId,
            workId,
            taskId,
            stageColumnId,
            artifactId,
            versionId,
            artifactName,
            versionNote,
            originalFilename: body.filename,
            sizeBytes: body.sizeBytes,
            mimeType,
            isMultipart,
            partSizeBytes,
            r2Key,
            r2UploadId,
            fingerprintSha256,
            idempotencyKey: body.idempotencyKey,
            status: 'uploading',
            createdBy: auth.userId,
            expiresAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        sessionRow = rows[0];
      } catch (err) {
        if (r2UploadId) {
          await storage.abortMultipartUpload({ key: r2Key, uploadId: r2UploadId }).catch(() => {});
        }
        if (uniqueViolation(err) === 'upload_sessions_project_idempotency_key') {
          throw new AppError('CONFLICT', '重复的上传初始化请求，请重试');
        }
        throw err;
      }
      if (!sessionRow) throw new AppError('INTERNAL');

      if (isMultipart) {
        const res: UploadSessionInitResponse = {
          sessionId: sessionRow.id,
          mode: sessionRow.mode,
          resumed: false,
          isMultipart: true,
          partSizeBytes: sessionRow.partSizeBytes,
          concurrency: config.r2UploadConcurrency,
          maxFileBytes: config.r2MaxFileBytes,
          mimeType: sessionRow.mimeType,
          originalFilename: sessionRow.originalFilename,
          expiresAt: sessionRow.expiresAt.toISOString(),
          uploadedParts: [],
        };
        return reply.code(201).send(res);
      }

      const singlePutUrl = await storage.signPutObject({
        key: sessionRow.r2Key,
        contentType: sessionRow.mimeType,
        contentLength: sessionRow.sizeBytes,
        expiresInSec: config.r2UploadSignTtlSec,
      });

      const res: UploadSessionInitResponse = {
        sessionId: sessionRow.id,
        mode: sessionRow.mode,
        resumed: false,
        isMultipart: false,
        partSizeBytes: null,
        concurrency: config.r2UploadConcurrency,
        maxFileBytes: config.r2MaxFileBytes,
        mimeType: sessionRow.mimeType,
        originalFilename: sessionRow.originalFilename,
        expiresAt: sessionRow.expiresAt.toISOString(),
        singlePutUrl,
      };
      return reply.code(201).send(res);
    },
  );

  // GET /api/uploads/sessions/:id
  app.get<{ Params: { id: string } }>(
    '/api/uploads/sessions/:id',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const sessionId = parseUuidParam(request.params.id);

      const [session] = await db
        .select()
        .from(schema.uploadSessions)
        .where(
          and(
            eq(schema.uploadSessions.projectId, auth.projectId),
            eq(schema.uploadSessions.id, sessionId),
          ),
        )
        .limit(1);

      if (!session || session.createdBy !== auth.userId) {
        throw notFound();
      }

      const now = new Date();
      let status = session.status;
      let expired = status === 'expired' || (status === 'uploading' && session.expiresAt <= now);
      let uploadedParts: ListedPart[] = [];

      if (status === 'uploading' && expired) {
        status = 'expired';
        await db
          .update(schema.uploadSessions)
          .set({ status: 'expired', updatedAt: now })
          .where(eq(schema.uploadSessions.id, session.id));
      } else if (status === 'uploading' && session.isMultipart && session.r2UploadId) {
        try {
          uploadedParts = await storage.listParts({
            key: session.r2Key,
            uploadId: session.r2UploadId,
          });
        } catch (err) {
          if (err instanceof StorageNoSuchUploadError) {
            status = 'expired';
            expired = true;
            await db
              .update(schema.uploadSessions)
              .set({ status: 'expired', updatedAt: now })
              .where(eq(schema.uploadSessions.id, session.id));
          } else {
            throw err;
          }
        }
      }

      const res: UploadSessionDetail = {
        sessionId: session.id,
        mode: session.mode,
        status,
        expired,
        isMultipart: session.isMultipart,
        partSizeBytes: session.partSizeBytes,
        sizeBytes: session.sizeBytes,
        originalFilename: session.originalFilename,
        mimeType: session.mimeType,
        fingerprintSha256: session.fingerprintSha256,
        expiresAt: session.expiresAt.toISOString(),
        uploadedParts,
      };
      return res;
    },
  );

  // POST /api/uploads/sessions/:id/parts/:partNumber/sign
  app.post<{ Params: { id: string; partNumber: string } }>(
    '/api/uploads/sessions/:id/parts/:partNumber/sign',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const sessionId = parseUuidParam(request.params.id);
      const rawPart = request.params.partNumber;
      if (!/^\d+$/.test(rawPart)) {
        throw new AppError('VALIDATION_FAILED', '分片编号无效');
      }
      const partNumber = Number(rawPart);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_MULTIPART_PARTS) {
        throw new AppError('VALIDATION_FAILED', '分片编号超出范围');
      }
      const body = parseBody(signUploadPartBodySchema, request.body);

      const [session] = await db
        .select()
        .from(schema.uploadSessions)
        .where(
          and(
            eq(schema.uploadSessions.projectId, auth.projectId),
            eq(schema.uploadSessions.id, sessionId),
          ),
        )
        .limit(1);
      if (!session || session.createdBy !== auth.userId) {
        throw notFound();
      }
      if (!session.isMultipart || !session.r2UploadId || !session.partSizeBytes) {
        throw new AppError('VALIDATION_FAILED', '该会话不是分片上传会话');
      }
      const now = new Date();
      if (
        session.status === 'expired' ||
        (session.status === 'uploading' && session.expiresAt <= now)
      ) {
        if (session.status === 'uploading') {
          await db
            .update(schema.uploadSessions)
            .set({ status: 'expired', updatedAt: now })
            .where(eq(schema.uploadSessions.id, session.id));
        }
        throw new AppError('UPLOAD_SESSION_EXPIRED');
      }
      if (session.status !== 'uploading') {
        throw new AppError('CONFLICT', '上传会话已结束，无法继续签发分片');
      }

      const expectedLen = expectedPartLength(session.sizeBytes, session.partSizeBytes, partNumber);
      if (expectedLen < 1) {
        throw new AppError('VALIDATION_FAILED', '分片编号超出总分片数');
      }
      if (body.contentLength !== expectedLen) {
        throw new AppError('VALIDATION_FAILED', '分片大小与会话声明不符');
      }

      const url = await storage.signUploadPart({
        key: session.r2Key,
        uploadId: session.r2UploadId,
        partNumber,
        contentLength: expectedLen,
        expiresInSec: config.r2UploadSignTtlSec,
      });

      const res: SignUploadPartResponse = {
        url,
        expiresAt: new Date(Date.now() + config.r2UploadSignTtlSec * 1000).toISOString(),
        partNumber,
      };
      return res;
    },
  );

  // GET /api/uploads/sessions/:id/parts
  app.get<{ Params: { id: string } }>(
    '/api/uploads/sessions/:id/parts',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const sessionId = parseUuidParam(request.params.id);

      const [session] = await db
        .select()
        .from(schema.uploadSessions)
        .where(
          and(
            eq(schema.uploadSessions.projectId, auth.projectId),
            eq(schema.uploadSessions.id, sessionId),
          ),
        )
        .limit(1);
      if (!session || session.createdBy !== auth.userId) {
        throw notFound();
      }
      const now = new Date();
      if (
        session.status === 'expired' ||
        (session.status === 'uploading' && session.expiresAt <= now)
      ) {
        if (session.status === 'uploading') {
          await db
            .update(schema.uploadSessions)
            .set({ status: 'expired', updatedAt: now })
            .where(eq(schema.uploadSessions.id, session.id));
        }
        throw new AppError('UPLOAD_SESSION_EXPIRED');
      }
      if (session.status !== 'uploading') {
        throw new AppError('CONFLICT', '上传会话已结束');
      }
      if (!session.isMultipart || !session.r2UploadId) {
        const empty: ListUploadPartsResponse = { parts: [] };
        return empty;
      }

      try {
        const parts = await storage.listParts({
          key: session.r2Key,
          uploadId: session.r2UploadId,
        });
        const res: ListUploadPartsResponse = { parts };
        return res;
      } catch (err) {
        if (err instanceof StorageNoSuchUploadError) {
          await db
            .update(schema.uploadSessions)
            .set({ status: 'expired', updatedAt: now })
            .where(eq(schema.uploadSessions.id, session.id));
          throw new AppError('UPLOAD_SESSION_EXPIRED');
        }
        throw err;
      }
    },
  );

  // POST /api/uploads/sessions/:id/complete
  app.post<{ Params: { id: string } }>(
    '/api/uploads/sessions/:id/complete',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const sessionId = parseUuidParam(request.params.id);
      const originConnId = readOriginConnId(request);

      // 服务端绝不信任请求体中的 key/ETag/size/parts，全部以 upload_sessions 与 R2 实际核验为准
      const [session] = await db
        .select()
        .from(schema.uploadSessions)
        .where(
          and(
            eq(schema.uploadSessions.projectId, auth.projectId),
            eq(schema.uploadSessions.id, sessionId),
          ),
        )
        .limit(1);

      if (!session || session.createdBy !== auth.userId) {
        throw notFound();
      }

      if (session.status === 'completed') {
        return buildCompletedResponse(db, auth.projectId, session);
      }
      if (session.status === 'aborted') {
        throw new AppError('CONFLICT', '该上传会话已取消');
      }
      const now = new Date();
      if (session.status === 'expired' || session.expiresAt <= now) {
        if (session.status === 'uploading') {
          await db
            .update(schema.uploadSessions)
            .set({ status: 'expired', updatedAt: now })
            .where(eq(schema.uploadSessions.id, session.id));
        }
        throw new AppError('UPLOAD_SESSION_EXPIRED');
      }

      // 存储核验与合并放在事务外，避免长事务占用连接
      if (!session.resultBlobId) {
        if (session.isMultipart) {
          if (!session.r2UploadId || !session.partSizeBytes) {
            throw new AppError('INTERNAL');
          }
          // 先检查对象是否已在并发重试中被合并落盘
          const existingObj = await storage.headObject(session.r2Key);
          if (!existingObj || existingObj.contentLength !== session.sizeBytes) {
            let parts: ListedPart[];
            try {
              parts = await storage.listParts({
                key: session.r2Key,
                uploadId: session.r2UploadId,
              });
            } catch (err) {
              if (err instanceof StorageNoSuchUploadError) {
                const afterHead = await storage.headObject(session.r2Key);
                if (!afterHead || afterHead.contentLength !== session.sizeBytes) {
                  throw new AppError('VALIDATION_FAILED', '分片上传未完成或已失效，请重新上传');
                }
                parts = [];
              } else {
                throw err;
              }
            }

            if (parts.length > 0 || !existingObj) {
              const totalParts = Math.ceil(session.sizeBytes / session.partSizeBytes);
              if (parts.length !== totalParts) {
                throw new AppError(
                  'VALIDATION_FAILED',
                  `分片不完整（已上传 ${parts.length}/${totalParts} 片），请继续上传后再保存`,
                );
              }
              let sumSize = 0;
              for (let idx = 0; idx < totalParts; idx++) {
                const expectedNum = idx + 1;
                const p = parts[idx];
                const expLen = expectedPartLength(
                  session.sizeBytes,
                  session.partSizeBytes,
                  expectedNum,
                );
                if (!p || p.partNumber !== expectedNum || p.size !== expLen) {
                  throw new AppError('VALIDATION_FAILED', '分片序号或大小核验失败，请重试上传');
                }
                sumSize += p.size;
              }
              if (sumSize !== session.sizeBytes) {
                throw new AppError('VALIDATION_FAILED', '分片总大小与声明大小不符');
              }

              try {
                await storage.completeMultipartUpload({
                  key: session.r2Key,
                  uploadId: session.r2UploadId,
                  parts: parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
                });
              } catch (err) {
                if (err instanceof StorageNoSuchUploadError) {
                  const reHead = await storage.headObject(session.r2Key);
                  if (!reHead || reHead.contentLength !== session.sizeBytes) {
                    throw new AppError('VALIDATION_FAILED', '分片合并失败，请重新上传');
                  }
                } else {
                  throw err;
                }
              }
            }
          }
        }

        // 双关卡第二关：HeadObject 严格核对存在与真实字节大小
        const head = await storage.headObject(session.r2Key);
        if (!head) {
          throw new AppError('VALIDATION_FAILED', '云端未找到已上传的文件，请重新上传');
        }
        if (head.contentLength !== session.sizeBytes) {
          throw new AppError('VALIDATION_FAILED', '文件大小核验失败，与声明大小不一致');
        }
      }

      // 原子落库事务
      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({
          tx,
          emit,
        }): Promise<{ kind: 'ok'; data: CompleteUploadResponse } | { kind: 'attach_conflict' }> => {
          const [locked] = await tx
            .select()
            .from(schema.uploadSessions)
            .where(
              and(
                eq(schema.uploadSessions.projectId, auth.projectId),
                eq(schema.uploadSessions.id, sessionId),
              ),
            )
            .for('update')
            .limit(1);
          if (!locked || locked.createdBy !== auth.userId) throw notFound();

          if (locked.status === 'completed') {
            return { kind: 'ok', data: await buildCompletedResponse(tx, auth.projectId, locked) };
          }
          if (locked.status === 'aborted') {
            throw new AppError('CONFLICT', '该上传会话已取消');
          }
          if (locked.status === 'expired') {
            throw new AppError('UPLOAD_SESSION_EXPIRED');
          }

          const txNow = new Date();
          let blobId = locked.resultBlobId;
          if (!blobId) {
            const [blob] = await tx
              .insert(schema.blobs)
              .values({
                projectId: auth.projectId,
                r2Key: locked.r2Key,
                sizeBytes: locked.sizeBytes,
                mimeType: locked.mimeType,
                sha256: locked.fingerprintSha256,
                createdBy: auth.userId,
                createdAt: txNow,
              })
              .returning();
            if (!blob) throw new AppError('INTERNAL');
            blobId = blob.id;
          }

          if (locked.mode === 'create_artifact') {
            const scope = scopeFromSession(locked);
            const resolved = await resolveAndValidateScope(tx, auth.projectId, scope);
            const name = locked.artifactName ?? locked.originalFilename;

            const [artifact] = await tx
              .insert(schema.artifacts)
              .values({
                projectId: auth.projectId,
                worksheetId: resolved.worksheetId,
                workId: resolved.workId,
                taskId: resolved.taskId,
                stageColumnId: resolved.stageColumnId,
                name,
                createdBy: auth.userId,
                createdAt: txNow,
                updatedAt: txNow,
              })
              .returning();
            if (!artifact) throw new AppError('INTERNAL');

            const [v1] = await tx
              .insert(schema.artifactVersions)
              .values({
                projectId: auth.projectId,
                artifactId: artifact.id,
                versionNumber: 1,
                note: locked.versionNote,
                originalFilename: locked.originalFilename,
                sizeBytes: locked.sizeBytes,
                mimeType: locked.mimeType,
                createdBy: auth.userId,
                createdAt: txNow,
              })
              .returning();
            if (!v1) throw new AppError('INTERNAL');

            const [updatedArt] = await tx
              .update(schema.artifacts)
              .set({ latestVersionId: v1.id, updatedAt: txNow })
              .where(
                and(
                  eq(schema.artifacts.projectId, auth.projectId),
                  eq(schema.artifacts.id, artifact.id),
                ),
              )
              .returning();
            if (!updatedArt) throw new AppError('INTERNAL');

            const [loc] = await tx
              .insert(schema.resourceLocations)
              .values({
                projectId: auth.projectId,
                artifactId: artifact.id,
                versionId: v1.id,
                type: 'r2',
                blobId,
                provider: null,
                url: null,
                extractCode: null,
                isFolder: false,
                expiresAt: null,
                note: '',
                createdBy: auth.userId,
                createdAt: txNow,
                updatedAt: txNow,
              })
              .returning();
            if (!loc) throw new AppError('INTERNAL');

            await tx
              .update(schema.uploadSessions)
              .set({
                status: 'completed',
                resultBlobId: blobId,
                resultArtifactId: artifact.id,
                resultVersionId: v1.id,
                resultLocationId: loc.id,
                completedAt: txNow,
                updatedAt: txNow,
              })
              .where(eq(schema.uploadSessions.id, locked.id));

            await recordChangeLog(tx, {
              projectId: auth.projectId,
              worksheetId: resolved.worksheetId,
              taskId: resolved.taskId,
              artifactId: artifact.id,
              actorUserId: auth.userId,
              action: 'artifact.created',
              summary: `在${resolved.label}上传了资源「${artifact.name}」`,
              changes: {
                artifactId: artifact.id,
                versionId: v1.id,
                locationId: loc.id,
                name: artifact.name,
                scopeKind: resolved.scopeKind,
                versionNumber: 1,
                originalFilename: locked.originalFilename,
                sizeBytes: locked.sizeBytes,
                storageType: 'r2',
                ...(resolved.stageColumnId ? { stageColumnId: resolved.stageColumnId } : {}),
              },
            });

            emitArtifactChanged(emit, auth.projectId, {
              scopeKind: resolved.scopeKind,
              action: 'artifact.created',
              artifactId: artifact.id,
              worksheetId: resolved.worksheetId,
              workId: resolved.workId,
              taskId: resolved.taskId,
              stageColumnId: resolved.stageColumnId,
            });

            const [detail] = await hydrateArtifacts(tx, auth.projectId, [updatedArt]);
            if (!detail) throw new AppError('INTERNAL');
            return {
              kind: 'ok',
              data: { artifact: detail, versionId: v1.id, locationId: loc.id, blobId },
            };
          }

          if (locked.mode === 'create_version') {
            if (!locked.artifactId) throw notFound();
            const [artifact] = await tx
              .select()
              .from(schema.artifacts)
              .where(
                and(
                  eq(schema.artifacts.projectId, auth.projectId),
                  eq(schema.artifacts.id, locked.artifactId),
                  isNull(schema.artifacts.deletedAt),
                ),
              )
              .for('update')
              .limit(1);
            if (!artifact) throw notFound();
            await ensureArtifactParentActive(tx, auth.projectId, artifact);

            const [maxRow] = await tx
              .select({
                maxVer: sql<number>`COALESCE(MAX(${schema.artifactVersions.versionNumber}), 0)::int`,
              })
              .from(schema.artifactVersions)
              .where(
                and(
                  eq(schema.artifactVersions.projectId, auth.projectId),
                  eq(schema.artifactVersions.artifactId, artifact.id),
                ),
              );
            const nextVersionNumber = (maxRow?.maxVer ?? 0) + 1;

            const [ver] = await tx
              .insert(schema.artifactVersions)
              .values({
                projectId: auth.projectId,
                artifactId: artifact.id,
                versionNumber: nextVersionNumber,
                note: locked.versionNote,
                originalFilename: locked.originalFilename,
                sizeBytes: locked.sizeBytes,
                mimeType: locked.mimeType,
                createdBy: auth.userId,
                createdAt: txNow,
              })
              .returning();
            if (!ver) throw new AppError('INTERNAL');

            const [loc] = await tx
              .insert(schema.resourceLocations)
              .values({
                projectId: auth.projectId,
                artifactId: artifact.id,
                versionId: ver.id,
                type: 'r2',
                blobId,
                provider: null,
                url: null,
                extractCode: null,
                isFolder: false,
                expiresAt: null,
                note: '',
                createdBy: auth.userId,
                createdAt: txNow,
                updatedAt: txNow,
              })
              .returning();
            if (!loc) throw new AppError('INTERNAL');

            const [updatedArt] = await tx
              .update(schema.artifacts)
              .set({ latestVersionId: ver.id, updatedAt: txNow })
              .where(
                and(
                  eq(schema.artifacts.projectId, auth.projectId),
                  eq(schema.artifacts.id, artifact.id),
                ),
              )
              .returning();
            if (!updatedArt) throw new AppError('INTERNAL');

            await tx
              .update(schema.uploadSessions)
              .set({
                status: 'completed',
                resultBlobId: blobId,
                resultArtifactId: artifact.id,
                resultVersionId: ver.id,
                resultLocationId: loc.id,
                completedAt: txNow,
                updatedAt: txNow,
              })
              .where(eq(schema.uploadSessions.id, locked.id));

            await recordChangeLog(tx, {
              projectId: auth.projectId,
              worksheetId: artifact.worksheetId,
              taskId: artifact.taskId,
              artifactId: artifact.id,
              actorUserId: auth.userId,
              action: 'artifact_version.created',
              summary: `为资源「${artifact.name}」上传了 v${ver.versionNumber}`,
              changes: {
                artifactId: artifact.id,
                versionId: ver.id,
                locationId: loc.id,
                name: artifact.name,
                versionNumber: ver.versionNumber,
                originalFilename: locked.originalFilename,
                sizeBytes: locked.sizeBytes,
                storageType: 'r2',
              },
            });

            emitArtifactChanged(emit, auth.projectId, {
              scopeKind: deriveScopeKind(artifact),
              action: 'version.created',
              artifactId: artifact.id,
              worksheetId: artifact.worksheetId,
              workId: artifact.workId,
              taskId: artifact.taskId,
              stageColumnId: artifact.stageColumnId,
            });

            const [detail] = await hydrateArtifacts(tx, auth.projectId, [updatedArt]);
            if (!detail) throw new AppError('INTERNAL');
            return {
              kind: 'ok',
              data: { artifact: detail, versionId: ver.id, locationId: loc.id, blobId },
            };
          }

          // mode === 'attach_version'
          if (!locked.versionId || !locked.artifactId) throw notFound();
          const [ver] = await tx
            .select()
            .from(schema.artifactVersions)
            .where(
              and(
                eq(schema.artifactVersions.projectId, auth.projectId),
                eq(schema.artifactVersions.id, locked.versionId),
                isNull(schema.artifactVersions.deletedAt),
              ),
            )
            .for('update')
            .limit(1);
          if (!ver) throw notFound();

          const [artifact] = await tx
            .select()
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, ver.artifactId),
                isNull(schema.artifacts.deletedAt),
              ),
            )
            .limit(1);
          if (!artifact) throw notFound();
          await ensureArtifactParentActive(tx, auth.projectId, artifact);

          const [existingR2] = await tx
            .select({ id: schema.resourceLocations.id })
            .from(schema.resourceLocations)
            .where(
              and(
                eq(schema.resourceLocations.projectId, auth.projectId),
                eq(schema.resourceLocations.versionId, ver.id),
                eq(schema.resourceLocations.type, 'r2'),
                isNull(schema.resourceLocations.deletedAt),
              ),
            )
            .limit(1);

          if (existingR2) {
            // 并发补传冲突（Q9）：落库 blob 并挂到 session.resultBlobId，不浪费已传字节，允许一键转存新版本
            await tx
              .update(schema.uploadSessions)
              .set({ resultBlobId: blobId, updatedAt: txNow })
              .where(eq(schema.uploadSessions.id, locked.id));
            return { kind: 'attach_conflict' };
          }

          const [loc] = await tx
            .insert(schema.resourceLocations)
            .values({
              projectId: auth.projectId,
              artifactId: artifact.id,
              versionId: ver.id,
              type: 'r2',
              blobId,
              provider: null,
              url: null,
              extractCode: null,
              isFolder: false,
              expiresAt: null,
              note: '',
              createdBy: auth.userId,
              createdAt: txNow,
              updatedAt: txNow,
            })
            .returning();
          if (!loc) throw new AppError('INTERNAL');

          await tx
            .update(schema.artifactVersions)
            .set({
              originalFilename: locked.originalFilename,
              sizeBytes: locked.sizeBytes,
              mimeType: locked.mimeType,
            })
            .where(
              and(
                eq(schema.artifactVersions.projectId, auth.projectId),
                eq(schema.artifactVersions.id, ver.id),
              ),
            );

          const [updatedArt] = await tx
            .update(schema.artifacts)
            .set({ updatedAt: txNow })
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, artifact.id),
              ),
            )
            .returning();
          if (!updatedArt) throw new AppError('INTERNAL');

          await tx
            .update(schema.uploadSessions)
            .set({
              status: 'completed',
              resultBlobId: blobId,
              resultArtifactId: artifact.id,
              resultVersionId: ver.id,
              resultLocationId: loc.id,
              completedAt: txNow,
              updatedAt: txNow,
            })
            .where(eq(schema.uploadSessions.id, locked.id));

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: artifact.worksheetId,
            taskId: artifact.taskId,
            artifactId: artifact.id,
            actorUserId: auth.userId,
            action: 'location.created',
            summary: `为资源「${artifact.name}」(v${ver.versionNumber}) 补传了文件`,
            changes: {
              artifactId: artifact.id,
              versionId: ver.id,
              locationId: loc.id,
              name: artifact.name,
              versionNumber: ver.versionNumber,
              originalFilename: locked.originalFilename,
              sizeBytes: locked.sizeBytes,
              storageType: 'r2',
            },
          });

          emitArtifactChanged(emit, auth.projectId, {
            scopeKind: deriveScopeKind(artifact),
            action: 'location.created',
            artifactId: artifact.id,
            worksheetId: artifact.worksheetId,
            workId: artifact.workId,
            taskId: artifact.taskId,
            stageColumnId: artifact.stageColumnId,
          });

          const [detail] = await hydrateArtifacts(tx, auth.projectId, [updatedArt]);
          if (!detail) throw new AppError('INTERNAL');
          return {
            kind: 'ok',
            data: { artifact: detail, versionId: ver.id, locationId: loc.id, blobId },
          };
        },
      );

      if (result.kind === 'attach_conflict') {
        throw new AppError(
          'VERSION_ALREADY_HAS_FILE',
          '该版本已由他人上传文件，可将本次已传文件改存为新版本',
          undefined,
          { sessionId: session.id, canPromoteToVersion: true },
        );
      }

      return result.data;
    },
  );

  // POST /api/uploads/sessions/:id/promote-to-version
  app.post<{ Params: { id: string } }>(
    '/api/uploads/sessions/:id/promote-to-version',
    { config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = request.auth!;
      const sessionId = parseUuidParam(request.params.id);
      const body = parseBody(promoteUploadToVersionBodySchema, request.body ?? {});
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }): Promise<CompleteUploadResponse> => {
          const [locked] = await tx
            .select()
            .from(schema.uploadSessions)
            .where(
              and(
                eq(schema.uploadSessions.projectId, auth.projectId),
                eq(schema.uploadSessions.id, sessionId),
              ),
            )
            .for('update')
            .limit(1);
          if (!locked || locked.createdBy !== auth.userId) throw notFound();

          if (locked.status === 'completed') {
            return buildCompletedResponse(tx, auth.projectId, locked);
          }
          if (
            locked.mode !== 'attach_version' ||
            locked.status !== 'uploading' ||
            !locked.resultBlobId ||
            !locked.artifactId
          ) {
            throw new AppError('CONFLICT', '该上传会话不支持转存为新版本');
          }

          const [artifact] = await tx
            .select()
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, locked.artifactId),
                isNull(schema.artifacts.deletedAt),
              ),
            )
            .for('update')
            .limit(1);
          if (!artifact) throw notFound();
          await ensureArtifactParentActive(tx, auth.projectId, artifact);

          const [maxRow] = await tx
            .select({
              maxVer: sql<number>`COALESCE(MAX(${schema.artifactVersions.versionNumber}), 0)::int`,
            })
            .from(schema.artifactVersions)
            .where(
              and(
                eq(schema.artifactVersions.projectId, auth.projectId),
                eq(schema.artifactVersions.artifactId, artifact.id),
              ),
            );
          const nextVersionNumber = (maxRow?.maxVer ?? 0) + 1;
          const txNow = new Date();

          const [ver] = await tx
            .insert(schema.artifactVersions)
            .values({
              projectId: auth.projectId,
              artifactId: artifact.id,
              versionNumber: nextVersionNumber,
              note: body.note ?? locked.versionNote,
              originalFilename: locked.originalFilename,
              sizeBytes: locked.sizeBytes,
              mimeType: locked.mimeType,
              createdBy: auth.userId,
              createdAt: txNow,
            })
            .returning();
          if (!ver) throw new AppError('INTERNAL');

          const [loc] = await tx
            .insert(schema.resourceLocations)
            .values({
              projectId: auth.projectId,
              artifactId: artifact.id,
              versionId: ver.id,
              type: 'r2',
              blobId: locked.resultBlobId,
              provider: null,
              url: null,
              extractCode: null,
              isFolder: false,
              expiresAt: null,
              note: '',
              createdBy: auth.userId,
              createdAt: txNow,
              updatedAt: txNow,
            })
            .returning();
          if (!loc) throw new AppError('INTERNAL');

          const [updatedArt] = await tx
            .update(schema.artifacts)
            .set({ latestVersionId: ver.id, updatedAt: txNow })
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, artifact.id),
              ),
            )
            .returning();
          if (!updatedArt) throw new AppError('INTERNAL');

          await tx
            .update(schema.uploadSessions)
            .set({
              status: 'completed',
              resultArtifactId: artifact.id,
              resultVersionId: ver.id,
              resultLocationId: loc.id,
              completedAt: txNow,
              updatedAt: txNow,
            })
            .where(eq(schema.uploadSessions.id, locked.id));

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: artifact.worksheetId,
            taskId: artifact.taskId,
            artifactId: artifact.id,
            actorUserId: auth.userId,
            action: 'artifact_version.created',
            summary: `为资源「${artifact.name}」上传了 v${ver.versionNumber}`,
            changes: {
              artifactId: artifact.id,
              versionId: ver.id,
              locationId: loc.id,
              name: artifact.name,
              versionNumber: ver.versionNumber,
              originalFilename: locked.originalFilename,
              sizeBytes: locked.sizeBytes,
              storageType: 'r2',
            },
          });

          emitArtifactChanged(emit, auth.projectId, {
            scopeKind: deriveScopeKind(artifact),
            action: 'version.created',
            artifactId: artifact.id,
            worksheetId: artifact.worksheetId,
            workId: artifact.workId,
            taskId: artifact.taskId,
            stageColumnId: artifact.stageColumnId,
          });

          const [detail] = await hydrateArtifacts(tx, auth.projectId, [updatedArt]);
          if (!detail) throw new AppError('INTERNAL');
          return {
            artifact: detail,
            versionId: ver.id,
            locationId: loc.id,
            blobId: locked.resultBlobId,
          };
        },
      );

      return reply.code(201).send(result);
    },
  );

  // POST /api/uploads/sessions/:id/abort
  app.post<{ Params: { id: string } }>(
    '/api/uploads/sessions/:id/abort',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const sessionId = parseUuidParam(request.params.id);

      const [session] = await db
        .select()
        .from(schema.uploadSessions)
        .where(
          and(
            eq(schema.uploadSessions.projectId, auth.projectId),
            eq(schema.uploadSessions.id, sessionId),
          ),
        )
        .limit(1);

      if (!session || session.createdBy !== auth.userId) {
        throw notFound();
      }
      if (session.status === 'completed') {
        throw new AppError('CONFLICT', '该上传会话已完成，无法取消');
      }
      if (session.status === 'aborted') {
        const already: AbortUploadResponse = { aborted: true };
        return already;
      }

      // 若是 attach_version 冲突留下的未绑定 blob，确认无引用后释放
      let shouldDeleteUnreferencedBlobId: string | null = null;
      if (session.resultBlobId) {
        const [ref] = await db
          .select({ id: schema.resourceLocations.id })
          .from(schema.resourceLocations)
          .where(eq(schema.resourceLocations.blobId, session.resultBlobId))
          .limit(1);
        if (!ref) {
          shouldDeleteUnreferencedBlobId = session.resultBlobId;
        }
      }

      try {
        if (session.isMultipart && session.r2UploadId && !session.resultBlobId) {
          await storage.abortMultipartUpload({
            key: session.r2Key,
            uploadId: session.r2UploadId,
          });
        } else if (!session.resultBlobId || shouldDeleteUnreferencedBlobId) {
          await storage.deleteObject(session.r2Key);
        }
      } catch (err) {
        request.log.warn({ err, sessionId: session.id }, 'Failed to abort upload in storage');
        throw new AppError('STORAGE_ERROR', '云端取消失败，请点击重试取消');
      }

      const now = new Date();
      await db.transaction(async (tx) => {
        await tx
          .update(schema.uploadSessions)
          .set({
            status: 'aborted',
            resultBlobId: shouldDeleteUnreferencedBlobId ? null : session.resultBlobId,
            abortedAt: now,
            cleanedUpAt: now,
            updatedAt: now,
          })
          .where(eq(schema.uploadSessions.id, session.id));

        if (shouldDeleteUnreferencedBlobId) {
          await tx.delete(schema.blobs).where(eq(schema.blobs.id, shouldDeleteUnreferencedBlobId));
        }
      });

      const res: AbortUploadResponse = { aborted: true };
      return res;
    },
  );
}
