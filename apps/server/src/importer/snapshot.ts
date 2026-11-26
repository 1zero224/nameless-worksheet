import { and, asc, eq, isNull } from 'drizzle-orm';
import { type Db, schema } from '../db/index.js';
import { ascC } from '../modules/helpers.js';

export interface SnapshotStageCell {
  columnName: string;
  assignees: string[];
  status: string;
  note: string;
}

export interface SnapshotTask {
  importSourceKey: string | null;
  workName: string | null;
  title: string;
  divisionNote: string;
  publishStatus: string;
  publishedAt: string | null;
  publishUrl: string | null;
  customValues: Record<string, string | null>;
  stageCells: SnapshotStageCell[];
}

export interface SnapshotArtifact {
  importSourceKey: string | null;
  scopeKind: string;
  worksheetName: string | null;
  workName: string | null;
  name: string;
  locations: Array<{
    type: string;
    provider: string | null;
    url: string | null;
    hasExtractCode: boolean;
    originalFilename: string | null;
  }>;
}

export interface SnapshotWorksheet {
  importSourceKey: string | null;
  name: string;
  kind: string;
  placement: string;
  columns: Array<{ name: string; type: string; boardColumnName: string | null }>;
  works: string[];
  tasks: SnapshotTask[];
}

export interface ProjectSnapshot {
  users: Array<{ displayName: string; role: string; claimed: boolean }>;
  worksheets: SnapshotWorksheet[];
  artifacts: SnapshotArtifact[];
}

/**
 * 导出项目结构化快照（不含随机 UUID/时间戳/明文提取码/签名 URL），
 * 用于阶段 5 差分测试 Oracle 比对与幂等零漂移断言。
 */
export async function exportProjectSnapshot(db: Db, projectId: string): Promise<ProjectSnapshot> {
  const [
    memberRows,
    boardCols,
    wsRows,
    colRows,
    workRows,
    taskRows,
    cellRows,
    artifactRows,
    versionRows,
    locRows,
  ] = await Promise.all([
    db
      .select({
        id: schema.users.id,
        displayName: schema.users.displayName,
        claimedAt: schema.users.claimedAt,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
      .where(eq(schema.memberships.projectId, projectId))
      .orderBy(asc(schema.users.displayName)),
    db
      .select({ id: schema.boardColumns.id, name: schema.boardColumns.name })
      .from(schema.boardColumns)
      .where(eq(schema.boardColumns.projectId, projectId)),
    db
      .select()
      .from(schema.worksheets)
      .where(and(eq(schema.worksheets.projectId, projectId), isNull(schema.worksheets.deletedAt)))
      .orderBy(ascC(schema.worksheets.sortOrder), asc(schema.worksheets.id)),
    db
      .select()
      .from(schema.columnConfigs)
      .where(
        and(eq(schema.columnConfigs.projectId, projectId), isNull(schema.columnConfigs.deletedAt)),
      )
      .orderBy(ascC(schema.columnConfigs.sortOrder), asc(schema.columnConfigs.id)),
    db
      .select()
      .from(schema.works)
      .where(eq(schema.works.projectId, projectId))
      .orderBy(asc(schema.works.createdAt), asc(schema.works.id)),
    db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.projectId, projectId), isNull(schema.tasks.deletedAt)))
      .orderBy(ascC(schema.tasks.sortOrder), asc(schema.tasks.id)),
    db.select().from(schema.stageCells).where(eq(schema.stageCells.projectId, projectId)),
    db
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.projectId, projectId), isNull(schema.artifacts.deletedAt)))
      .orderBy(asc(schema.artifacts.importSourceKey), asc(schema.artifacts.name)),
    db
      .select()
      .from(schema.artifactVersions)
      .where(
        and(
          eq(schema.artifactVersions.projectId, projectId),
          isNull(schema.artifactVersions.deletedAt),
        ),
      ),
    db
      .select()
      .from(schema.resourceLocations)
      .where(
        and(
          eq(schema.resourceLocations.projectId, projectId),
          isNull(schema.resourceLocations.deletedAt),
        ),
      )
      .orderBy(asc(schema.resourceLocations.createdAt), asc(schema.resourceLocations.id)),
  ]);

  const userNameById = new Map(memberRows.map((u) => [u.id, u.displayName]));
  const boardColNameById = new Map(boardCols.map((b) => [b.id, b.name]));
  const wsNameById = new Map(wsRows.map((w) => [w.id, w.name]));
  const workNameById = new Map(workRows.map((w) => [w.id, w.name]));
  const verById = new Map(versionRows.map((v) => [v.id, v]));

  const colsByWs = new Map<string, typeof colRows>();
  for (const c of colRows) {
    const arr = colsByWs.get(c.worksheetId) ?? [];
    arr.push(c);
    colsByWs.set(c.worksheetId, arr);
  }

  const worksByWs = new Map<string, string[]>();
  for (const w of workRows) {
    const arr = worksByWs.get(w.worksheetId) ?? [];
    arr.push(w.name);
    worksByWs.set(w.worksheetId, arr);
  }

  const cellsByTask = new Map<string, Map<string, (typeof cellRows)[number]>>();
  for (const c of cellRows) {
    let m = cellsByTask.get(c.taskId);
    if (!m) {
      m = new Map();
      cellsByTask.set(c.taskId, m);
    }
    m.set(c.columnId, c);
  }

  const tasksByWs = new Map<string, typeof taskRows>();
  for (const t of taskRows) {
    const arr = tasksByWs.get(t.worksheetId) ?? [];
    arr.push(t);
    tasksByWs.set(t.worksheetId, arr);
  }

  const worksheets: SnapshotWorksheet[] = wsRows.map((ws) => {
    const cols = colsByWs.get(ws.id) ?? [];
    const colNameById = new Map(cols.map((c) => [c.id, c.name]));
    const stageCols = cols.filter((c) => c.type === 'stage');
    const wsTasks = tasksByWs.get(ws.id) ?? [];

    return {
      importSourceKey: ws.importSourceKey,
      name: ws.name,
      kind: ws.kind,
      placement: ws.placement,
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type,
        boardColumnName: c.boardColumnId ? (boardColNameById.get(c.boardColumnId) ?? null) : null,
      })),
      works: worksByWs.get(ws.id) ?? [],
      tasks: wsTasks.map((t) => {
        const namedCustom: Record<string, string | null> = {};
        for (const c of cols) {
          if (c.type === 'stage') continue;
          const v = t.customValues?.[c.id] ?? null;
          if (v !== null) {
            namedCustom[colNameById.get(c.id) ?? c.id] = v;
          }
        }
        const taskCells = cellsByTask.get(t.id);
        const stageCells: SnapshotStageCell[] = [];
        for (const sc of stageCols) {
          const cell = taskCells?.get(sc.id);
          if (!cell) continue;
          const assignees = (cell.assignees ?? []).map((a) =>
            a.type === 'user' ? `user:${userNameById.get(a.userId) ?? '?'}` : `text:${a.name}`,
          );
          stageCells.push({
            columnName: sc.name,
            assignees,
            status: cell.status,
            note: cell.note,
          });
        }
        return {
          importSourceKey: t.importSourceKey,
          workName: t.workId ? (workNameById.get(t.workId) ?? null) : null,
          title: t.title,
          divisionNote: t.divisionNote,
          publishStatus: t.publishStatus,
          publishedAt: t.publishedAt,
          publishUrl: t.publishUrl,
          customValues: namedCustom,
          stageCells,
        };
      }),
    };
  });

  const locsByArtifact = new Map<string, typeof locRows>();
  for (const l of locRows) {
    const arr = locsByArtifact.get(l.artifactId) ?? [];
    arr.push(l);
    locsByArtifact.set(l.artifactId, arr);
  }

  const artifacts: SnapshotArtifact[] = artifactRows.map((a) => {
    const scopeKind = a.stageColumnId ? 'stage' : a.taskId ? 'task' : a.workId ? 'work' : 'doc';
    const locs = locsByArtifact.get(a.id) ?? [];
    return {
      importSourceKey: a.importSourceKey,
      scopeKind,
      worksheetName: a.worksheetId ? (wsNameById.get(a.worksheetId) ?? null) : null,
      workName: a.workId ? (workNameById.get(a.workId) ?? null) : null,
      name: a.name,
      locations: locs.map((l) => ({
        type: l.type,
        provider: l.provider,
        url: l.url,
        hasExtractCode: l.extractCode !== null,
        originalFilename: verById.get(l.versionId)?.originalFilename ?? null,
      })),
    };
  });

  return {
    users: memberRows.map((u) => ({
      displayName: u.displayName,
      role: u.role,
      claimed: u.claimedAt !== null,
    })),
    worksheets,
    artifacts,
  };
}
