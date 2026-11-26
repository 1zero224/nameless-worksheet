import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type Assignee,
  DEFAULT_BOARD_COLUMN_NAMES,
  generateKeyBetween,
  generateNKeysBetween,
  sanitizeFilename,
} from '@nw/shared';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { type Db, schema } from '../db/index.js';
import { ascC } from '../modules/helpers.js';
import { buildBlobObjectKey, type StorageDriver } from '../storage/driver.js';
import { buildImportPlan, type ImportPlan } from './sheet-rules.js';
import { readXlsxWorkbook } from './xlsx-reader.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ImportSheetReport {
  name: string;
  kind: 'task' | 'free';
  placement: 'topbar' | 'docs';
  worksCount: number;
  rowsTotal: number;
  rowsInserted: number;
  rowsSkipped: number;
  publishedCount: number;
  shelvedCount: number;
  unpublishedCount: number;
  workArtifactsInserted: number;
}

export interface ImportWorkbookReport {
  dryRun: boolean;
  batchId: string | null;
  sourceFilename: string;
  sourceSha256: string;
  backupR2Key: string | null;
  adminDisplayName: string;
  usersCreated: string[];
  usersReused: string[];
  sheets: ImportSheetReport[];
  backupDocCreated: boolean;
  warnings: string[];
}

async function uploadBufferViaDriver(
  storage: StorageDriver,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const putUrl = await storage.signPutObject({
    key,
    contentType,
    contentLength: bytes.byteLength,
    expiresInSec: 600,
  });
  const res = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: Buffer.from(bytes),
  });
  if (!res.ok) {
    throw new Error(`上传备份文件到存储驱动失败（HTTP ${res.status}）`);
  }
}

export async function importWorkbook(opts: {
  db: Db;
  storage?: StorageDriver;
  projectId: string;
  filePath?: string;
  fileBuffer?: Uint8Array;
  sourceFilename?: string;
  adminDisplayName: string;
  dryRun?: boolean;
  skipBackupDoc?: boolean;
}): Promise<{ plan: ImportPlan; report: ImportWorkbookReport }> {
  const bytes = opts.fileBuffer
    ? opts.fileBuffer
    : opts.filePath
      ? new Uint8Array(readFileSync(opts.filePath))
      : (() => {
          throw new Error('必须提供 filePath 或 fileBuffer');
        })();
  const sourceFilename =
    opts.sourceFilename ?? (opts.filePath ? path.basename(opts.filePath) : 'workbook.xlsx');
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');

  const wb = readXlsxWorkbook(bytes);
  const plan = buildImportPlan(wb);

  // 读取已有用户与管理员
  const existingMembers = await opts.db
    .select({
      id: schema.users.id,
      displayName: schema.users.displayName,
      loginName: schema.users.loginName,
      claimedAt: schema.users.claimedAt,
      role: schema.memberships.role,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(eq(schema.memberships.projectId, opts.projectId));

  const adminRow =
    existingMembers.find(
      (m) => m.displayName.toLowerCase() === opts.adminDisplayName.trim().toLowerCase(),
    ) ?? existingMembers.find((m) => m.role === 'admin');
  if (!adminRow) {
    throw new Error(`项目中找不到管理员账号（期望显示名：${opts.adminDisplayName}）`);
  }

  const existingUserByLower = new Map(existingMembers.map((m) => [m.displayName.toLowerCase(), m]));

  if (opts.dryRun) {
    const usersCreated: string[] = [];
    const usersReused: string[] = [];
    for (const name of plan.userDisplayNames) {
      if (existingUserByLower.has(name.toLowerCase())) {
        usersReused.push(name);
      } else {
        usersCreated.push(name);
      }
    }

    const sheets: ImportSheetReport[] = plan.worksheets.map((ws) => ({
      name: ws.name,
      kind: ws.kind,
      placement: ws.placement,
      worksCount: ws.works.length,
      rowsTotal: ws.tasks.length,
      rowsInserted: ws.tasks.length,
      rowsSkipped: 0,
      publishedCount: ws.tasks.filter((t) => t.publishStatus === 'published').length,
      shelvedCount: ws.tasks.filter((t) => t.publishStatus === 'shelved').length,
      unpublishedCount: ws.tasks.filter((t) => t.publishStatus === 'unpublished').length,
      workArtifactsInserted: ws.workArtifacts.length,
    }));

    return {
      plan,
      report: {
        dryRun: true,
        batchId: null,
        sourceFilename,
        sourceSha256,
        backupR2Key: null,
        adminDisplayName: adminRow.displayName,
        usersCreated,
        usersReused,
        sheets,
        backupDocCreated: false,
        warnings: [...plan.warnings],
      },
    };
  }

  // 先检查本次 sourceSha256 是否已留存过原版备份与 /docs 备份资源
  const [existingBackupBatch] = await opts.db
    .select({ id: schema.importBatches.id, backupR2Key: schema.importBatches.backupR2Key })
    .from(schema.importBatches)
    .where(
      and(
        eq(schema.importBatches.projectId, opts.projectId),
        eq(schema.importBatches.sourceSha256, sourceSha256),
      ),
    )
    .limit(1);

  const backupDocSourceKey = `import:workbook-backup:${sourceSha256}`;
  const [existingBackupDoc] = await opts.db
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.projectId, opts.projectId),
        eq(schema.artifacts.importSourceKey, backupDocSourceKey),
        isNull(schema.artifacts.deletedAt),
      ),
    )
    .limit(1);

  const pendingBatchId = randomUUID();
  const safeName = sanitizeFilename(sourceFilename);
  let backupR2Key =
    existingBackupBatch?.backupR2Key ??
    `projects/${opts.projectId}/imports/${pendingBatchId}/${safeName}`;
  let backupDocBlobKey: string | null = null;

  // 在事务外执行存储驱动上传，避免长事务
  if (opts.storage) {
    if (!existingBackupBatch) {
      await uploadBufferViaDriver(opts.storage, backupR2Key, bytes, XLSX_MIME);
    }
    if (!opts.skipBackupDoc && !existingBackupDoc) {
      backupDocBlobKey = buildBlobObjectKey(opts.projectId, randomUUID());
      await uploadBufferViaDriver(opts.storage, backupDocBlobKey, bytes, XLSX_MIME);
    }
  } else {
    // 若未注入 StorageDriver（极少数离线干跑场景），仅记录逻辑路径
    backupR2Key = `local-unbacked/${opts.projectId}/imports/${pendingBatchId}/${safeName}`;
  }

  const usersCreated: string[] = [];
  const usersReused: string[] = [];
  const sheetReports: ImportSheetReport[] = [];
  let backupDocCreated = false;

  const batchId = await opts.db.transaction(async (tx) => {
    // 1. 预创建或复用用户（带标准显示名）
    const userIdByLower = new Map<string, string>();
    for (const m of existingMembers) {
      userIdByLower.set(m.displayName.toLowerCase(), m.id);
    }

    for (const displayName of plan.userDisplayNames) {
      const lower = displayName.toLowerCase();
      if (userIdByLower.has(lower)) {
        usersReused.push(displayName);
        continue;
      }
      // 也查全局 users 表（防御并发或跨查询）
      const [existingUser] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.displayName, displayName))
        .limit(1);

      if (existingUser) {
        userIdByLower.set(lower, existingUser.id);
        usersReused.push(displayName);
        continue;
      }

      const [created] = await tx
        .insert(schema.users)
        .values({
          loginName: null,
          displayName,
          passwordHash: null,
          claimedAt: null,
        })
        .returning({ id: schema.users.id });
      if (!created) throw new Error(`创建待认领用户失败：${displayName}`);

      await tx.insert(schema.memberships).values({
        projectId: opts.projectId,
        userId: created.id,
        role: 'user',
      });
      userIdByLower.set(lower, created.id);
      usersCreated.push(displayName);
    }

    // 2. 创建本次 import_batches 记录（若同一文件首次导入，或即使重跑也记录审计或复用）
    let effectiveBatchId = existingBackupBatch?.id;
    if (!effectiveBatchId) {
      const [batchRow] = await tx
        .insert(schema.importBatches)
        .values({
          projectId: opts.projectId,
          sourceFilename,
          sourceSha256,
          backupR2Key,
          actorUserId: adminRow.id,
          summary: { status: 'in_progress' },
        })
        .returning({ id: schema.importBatches.id });
      if (!batchRow) throw new Error('写入 import_batches 失败');
      effectiveBatchId = batchRow.id;
    }

    // 3. 加载项目看板列映射
    const boardCols = await tx
      .select()
      .from(schema.boardColumns)
      .where(eq(schema.boardColumns.projectId, opts.projectId));
    const boardColByName = new Map(boardCols.map((b) => [b.name, b.id]));

    // 获取当前已有工作表末尾排序键
    const existingWsRows = await tx
      .select()
      .from(schema.worksheets)
      .where(
        and(eq(schema.worksheets.projectId, opts.projectId), isNull(schema.worksheets.deletedAt)),
      )
      .orderBy(ascC(schema.worksheets.sortOrder), asc(schema.worksheets.id));

    let lastWsSortKey = existingWsRows[existingWsRows.length - 1]?.sortOrder ?? null;

    // 4. 逐表幂等导入
    for (const plannedWs of plan.worksheets) {
      let [wsRow] = await tx
        .select()
        .from(schema.worksheets)
        .where(
          and(
            eq(schema.worksheets.projectId, opts.projectId),
            eq(schema.worksheets.importSourceKey, plannedWs.sourceKey),
            isNull(schema.worksheets.deletedAt),
          ),
        )
        .limit(1);

      if (!wsRow) {
        lastWsSortKey = generateKeyBetween(lastWsSortKey, null);
        const [insertedWs] = await tx
          .insert(schema.worksheets)
          .values({
            projectId: opts.projectId,
            name: plannedWs.name,
            color: plannedWs.color,
            kind: plannedWs.kind,
            placement: plannedWs.placement,
            sortOrder: lastWsSortKey,
            importSourceKey: plannedWs.sourceKey,
          })
          .returning();
        if (!insertedWs) throw new Error(`创建工作表失败：${plannedWs.name}`);
        wsRow = insertedWs;
      }

      // 确保全部列存在
      const existingCols = await tx
        .select()
        .from(schema.columnConfigs)
        .where(
          and(
            eq(schema.columnConfigs.projectId, opts.projectId),
            eq(schema.columnConfigs.worksheetId, wsRow.id),
            isNull(schema.columnConfigs.deletedAt),
          ),
        )
        .orderBy(ascC(schema.columnConfigs.sortOrder), asc(schema.columnConfigs.id));

      const colByName = new Map(existingCols.map((c) => [c.name, c]));
      const colIdByKey = new Map<string, string>();
      let lastColKey = existingCols[existingCols.length - 1]?.sortOrder ?? null;
      const usedBoardIds = new Set(
        existingCols.map((c) => c.boardColumnId).filter((x): x is string => x !== null),
      );

      for (const colDef of plannedWs.columns) {
        const existingCol = colByName.get(colDef.name);
        if (existingCol) {
          colIdByKey.set(colDef.key, existingCol.id);
          continue;
        }
        lastColKey = generateKeyBetween(lastColKey, null);
        let boardColumnId: string | null = null;
        if (colDef.type === 'stage' && colDef.boardColumnName) {
          const candidate = boardColByName.get(colDef.boardColumnName) ?? null;
          if (candidate && !usedBoardIds.has(candidate)) {
            boardColumnId = candidate;
            usedBoardIds.add(candidate);
          }
        }
        const [createdCol] = await tx
          .insert(schema.columnConfigs)
          .values({
            projectId: opts.projectId,
            worksheetId: wsRow.id,
            name: colDef.name,
            type: colDef.type,
            sortOrder: lastColKey,
            width: colDef.width,
            hidden: false,
            boardColumnId,
          })
          .returning();
        if (!createdCol) throw new Error(`创建列失败：${plannedWs.name}.${colDef.name}`);
        colIdByKey.set(colDef.key, createdCol.id);
      }

      // 确保全部作品存在
      const existingWorks = await tx
        .select()
        .from(schema.works)
        .where(
          and(eq(schema.works.projectId, opts.projectId), eq(schema.works.worksheetId, wsRow.id)),
        );
      const workIdByName = new Map(existingWorks.map((w) => [w.name, w.id]));

      for (const workName of plannedWs.works) {
        if (workIdByName.has(workName)) continue;
        const [createdWork] = await tx
          .insert(schema.works)
          .values({
            projectId: opts.projectId,
            worksheetId: wsRow.id,
            name: workName,
          })
          .returning({ id: schema.works.id });
        if (!createdWork) throw new Error(`创建作品失败：${workName}`);
        workIdByName.set(workName, createdWork.id);
      }

      // 加载本表已有任务的 importSourceKey 与末尾排序键
      const existingTasks = await tx
        .select({
          id: schema.tasks.id,
          importSourceKey: schema.tasks.importSourceKey,
          sortOrder: schema.tasks.sortOrder,
        })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.projectId, opts.projectId),
            eq(schema.tasks.worksheetId, wsRow.id),
            isNull(schema.tasks.deletedAt),
          ),
        )
        .orderBy(ascC(schema.tasks.sortOrder), asc(schema.tasks.id));

      const existingTaskKeys = new Set(
        existingTasks.map((t) => t.importSourceKey).filter((k): k is string => k !== null),
      );
      let lastTaskKey = existingTasks[existingTasks.length - 1]?.sortOrder ?? null;

      let rowsInserted = 0;
      let rowsSkipped = 0;

      const toInsertTasks = plannedWs.tasks.filter((t) => {
        if (existingTaskKeys.has(t.sourceKey)) {
          rowsSkipped++;
          return false;
        }
        return true;
      });

      const taskSortKeys =
        toInsertTasks.length > 0
          ? generateNKeysBetween(lastTaskKey, null, toInsertTasks.length)
          : [];

      for (let i = 0; i < toInsertTasks.length; i++) {
        const pt = toInsertTasks[i]!;
        const sortOrder = taskSortKeys[i]!;
        lastTaskKey = sortOrder;

        const mappedCustomValues: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(pt.customValues)) {
          const cid = colIdByKey.get(k);
          if (cid && v !== null) {
            mappedCustomValues[cid] = v;
          }
        }

        const workId = pt.workName ? (workIdByName.get(pt.workName) ?? null) : null;
        const [insertedTask] = await tx
          .insert(schema.tasks)
          .values({
            projectId: opts.projectId,
            worksheetId: wsRow.id,
            workId,
            title: pt.title,
            divisionNote: pt.divisionNote,
            priority: 'normal',
            publishStatus: pt.publishStatus,
            publishedAt: pt.publishedAt,
            publishUrl: pt.publishUrl,
            customValues: mappedCustomValues,
            sortOrder,
            importBatchId: effectiveBatchId,
            importSourceKey: pt.sourceKey,
          })
          .returning({ id: schema.tasks.id });

        if (!insertedTask) throw new Error(`写入任务失败：${pt.sourceKey}`);
        rowsInserted++;

        // 写入工序格（跳过完全空且 not_started 的默认单元格，保持与在线编辑惰性创建一致）
        const cellsToInsert: Array<typeof schema.stageCells.$inferInsert> = [];
        for (const sc of pt.stageCells) {
          const colId = colIdByKey.get(sc.columnKey);
          if (!colId) continue;

          const assignees: Assignee[] = [];
          for (const dn of sc.userDisplayNames) {
            const uid = userIdByLower.get(dn.toLowerCase());
            if (uid) {
              assignees.push({ type: 'user', userId: uid });
            } else {
              assignees.push({ type: 'text', name: dn });
            }
          }
          for (const tn of sc.textAssignees) {
            assignees.push({ type: 'text', name: tn });
          }

          if (assignees.length === 0 && sc.status === 'not_started' && !sc.note) {
            continue;
          }

          cellsToInsert.push({
            projectId: opts.projectId,
            worksheetId: wsRow.id,
            taskId: insertedTask.id,
            columnId: colId,
            assignees,
            status: sc.status,
            note: sc.note,
            revision: 1,
          });
        }

        if (cellsToInsert.length > 0) {
          await tx.insert(schema.stageCells).values(cellsToInsert);
        }
      }

      // 写入作品共用网盘资源（如长视频全熟的 2 条百度网盘分享）
      let workArtifactsInserted = 0;
      for (const wa of plannedWs.workArtifacts) {
        const workId = workIdByName.get(wa.workName);
        if (!workId) continue;

        const [existingArt] = await tx
          .select({ id: schema.artifacts.id })
          .from(schema.artifacts)
          .where(
            and(
              eq(schema.artifacts.projectId, opts.projectId),
              eq(schema.artifacts.importSourceKey, wa.sourceKey),
              isNull(schema.artifacts.deletedAt),
            ),
          )
          .limit(1);
        if (existingArt) continue;

        const [art] = await tx
          .insert(schema.artifacts)
          .values({
            projectId: opts.projectId,
            worksheetId: wsRow.id,
            workId,
            taskId: null,
            stageColumnId: null,
            name: wa.name,
            createdBy: adminRow.id,
            importBatchId: effectiveBatchId,
            importSourceKey: wa.sourceKey,
          })
          .returning({ id: schema.artifacts.id });
        if (!art) continue;

        const [ver] = await tx
          .insert(schema.artifactVersions)
          .values({
            projectId: opts.projectId,
            artifactId: art.id,
            versionNumber: 1,
            note: wa.note,
            createdBy: adminRow.id,
          })
          .returning({ id: schema.artifactVersions.id });
        if (!ver) continue;

        await tx
          .update(schema.artifacts)
          .set({ latestVersionId: ver.id })
          .where(eq(schema.artifacts.id, art.id));

        await tx.insert(schema.resourceLocations).values({
          projectId: opts.projectId,
          artifactId: art.id,
          versionId: ver.id,
          type: 'cloud_link',
          provider: wa.provider,
          url: wa.url,
          extractCode: wa.extractCode,
          isFolder: false,
          note: wa.note,
          createdBy: adminRow.id,
        });
        workArtifactsInserted++;
      }

      sheetReports.push({
        name: plannedWs.name,
        kind: plannedWs.kind,
        placement: plannedWs.placement,
        worksCount: plannedWs.works.length,
        rowsTotal: plannedWs.tasks.length,
        rowsInserted,
        rowsSkipped,
        publishedCount: plannedWs.tasks.filter((t) => t.publishStatus === 'published').length,
        shelvedCount: plannedWs.tasks.filter((t) => t.publishStatus === 'shelved').length,
        unpublishedCount: plannedWs.tasks.filter((t) => t.publishStatus === 'unpublished').length,
        workArtifactsInserted,
      });
    }

    // 5. 将原版 .xlsx 作为 /docs「公共文件」留底（仅首次且启用存储驱动时）
    if (!opts.skipBackupDoc && !existingBackupDoc && backupDocBlobKey) {
      const [blob] = await tx
        .insert(schema.blobs)
        .values({
          projectId: opts.projectId,
          r2Key: backupDocBlobKey,
          sizeBytes: bytes.byteLength,
          mimeType: XLSX_MIME,
          sha256: sourceSha256,
          createdBy: adminRow.id,
        })
        .returning({ id: schema.blobs.id });

      if (blob) {
        const [art] = await tx
          .insert(schema.artifacts)
          .values({
            projectId: opts.projectId,
            worksheetId: null,
            workId: null,
            taskId: null,
            stageColumnId: null,
            name: `原版工作簿备份（${sourceFilename}）`,
            createdBy: adminRow.id,
            importBatchId: effectiveBatchId,
            importSourceKey: backupDocSourceKey,
          })
          .returning({ id: schema.artifacts.id });

        if (art) {
          const [ver] = await tx
            .insert(schema.artifactVersions)
            .values({
              projectId: opts.projectId,
              artifactId: art.id,
              versionNumber: 1,
              note: '阶段 5 历史工作簿迁移自动留存原版只读备份',
              originalFilename: safeName,
              sizeBytes: bytes.byteLength,
              mimeType: XLSX_MIME,
              createdBy: adminRow.id,
            })
            .returning({ id: schema.artifactVersions.id });

          if (ver) {
            await tx
              .update(schema.artifacts)
              .set({ latestVersionId: ver.id })
              .where(eq(schema.artifacts.id, art.id));

            await tx.insert(schema.resourceLocations).values({
              projectId: opts.projectId,
              artifactId: art.id,
              versionId: ver.id,
              type: 'r2',
              blobId: blob.id,
              provider: null,
              url: null,
              extractCode: null,
              isFolder: false,
              note: '原版历史工作簿备份',
              createdBy: adminRow.id,
            });
            backupDocCreated = true;
          }
        }
      }
    }

    // 更新 import_batches 摘要（仅首次写入或更新汇总）
    if (!existingBackupBatch) {
      await tx
        .update(schema.importBatches)
        .set({
          summary: {
            usersCreatedCount: usersCreated.length,
            usersReusedCount: usersReused.length,
            sheets: sheetReports,
            backupDocCreated,
            warnings: plan.warnings,
          },
        })
        .where(eq(schema.importBatches.id, effectiveBatchId));
    }

    return effectiveBatchId;
  });

  return {
    plan,
    report: {
      dryRun: false,
      batchId,
      sourceFilename,
      sourceSha256,
      backupR2Key,
      adminDisplayName: adminRow.displayName,
      usersCreated,
      usersReused,
      sheets: sheetReports,
      backupDocCreated,
      warnings: [...plan.warnings],
    },
  };
}

/**
 * 安全清空测试项目业务数据，仅保留项目实体、默认 4 个看板列与指定管理员账号。
 */
export async function resetProjectData(opts: {
  db: Db;
  keepAdminLoginName: string;
}): Promise<{ projectId: string; keptAdminId: string; keptAdminDisplayName: string }> {
  const loginLower = opts.keepAdminLoginName.trim().toLowerCase();
  return opts.db.transaction(async (tx) => {
    const [admin] = await tx
      .select({
        userId: schema.users.id,
        displayName: schema.users.displayName,
        claimedAt: schema.users.claimedAt,
        projectId: schema.memberships.projectId,
        role: schema.memberships.role,
      })
      .from(schema.users)
      .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
      .where(eq(schema.users.loginName, loginLower))
      .limit(1);

    if (!admin || admin.role !== 'admin') {
      throw new Error(`找不到可保留的管理员账号：${opts.keepAdminLoginName}`);
    }

    const { projectId, userId: adminId } = admin;
    const now = new Date();

    // 确保保留管理员 claimed_at 非空
    if (!admin.claimedAt) {
      await tx
        .update(schema.users)
        .set({ claimedAt: now, updatedAt: now })
        .where(eq(schema.users.id, adminId));
    }

    // 按外键依赖从叶子表到父表清空该项目全部测试业务数据
    await tx.delete(schema.uploadSessions).where(eq(schema.uploadSessions.projectId, projectId));
    await tx
      .delete(schema.resourceLocations)
      .where(eq(schema.resourceLocations.projectId, projectId));
    await tx
      .update(schema.artifacts)
      .set({ latestVersionId: null })
      .where(eq(schema.artifacts.projectId, projectId));
    await tx
      .delete(schema.artifactVersions)
      .where(eq(schema.artifactVersions.projectId, projectId));
    await tx.delete(schema.changeLogs).where(eq(schema.changeLogs.projectId, projectId));
    await tx.delete(schema.artifacts).where(eq(schema.artifacts.projectId, projectId));
    await tx.delete(schema.blobs).where(eq(schema.blobs.projectId, projectId));
    await tx.delete(schema.stageCells).where(eq(schema.stageCells.projectId, projectId));
    await tx.delete(schema.tasks).where(eq(schema.tasks.projectId, projectId));
    await tx.delete(schema.works).where(eq(schema.works.projectId, projectId));
    await tx.delete(schema.columnConfigs).where(eq(schema.columnConfigs.projectId, projectId));
    await tx.delete(schema.worksheets).where(eq(schema.worksheets.projectId, projectId));
    await tx.delete(schema.importBatches).where(eq(schema.importBatches.projectId, projectId));
    await tx.delete(schema.realtimeEvents).where(eq(schema.realtimeEvents.projectId, projectId));
    await tx.delete(schema.invites).where(eq(schema.invites.projectId, projectId));
    await tx.delete(schema.accountClaims).where(eq(schema.accountClaims.projectId, projectId));

    // 清理其他用户的会话、重置链接、成员关系与用户记录
    const otherMembers = await tx
      .select({ userId: schema.memberships.userId })
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.projectId, projectId), ne(schema.memberships.userId, adminId)),
      );

    for (const om of otherMembers) {
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, om.userId));
      await tx.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, om.userId));
      await tx
        .delete(schema.memberships)
        .where(
          and(
            eq(schema.memberships.projectId, projectId),
            eq(schema.memberships.userId, om.userId),
          ),
        );
      await tx.delete(schema.users).where(eq(schema.users.id, om.userId));
    }

    // 重置默认 4 个看板列
    await tx.delete(schema.boardColumns).where(eq(schema.boardColumns.projectId, projectId));
    const boardKeys = generateNKeysBetween(null, null, DEFAULT_BOARD_COLUMN_NAMES.length);
    await tx.insert(schema.boardColumns).values(
      DEFAULT_BOARD_COLUMN_NAMES.map((name, i) => ({
        projectId,
        name,
        sortOrder: boardKeys[i] ?? `a${i}`,
      })),
    );

    // 重置 realtimePrunedThrough
    await tx
      .update(schema.projects)
      .set({ realtimePrunedThrough: 0n })
      .where(eq(schema.projects.id, projectId));

    return {
      projectId,
      keptAdminId: adminId,
      keptAdminDisplayName: admin.displayName,
    };
  });
}
