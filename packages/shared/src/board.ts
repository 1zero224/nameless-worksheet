import type {
  Assignee,
  BoardCard,
  BoardColumn,
  BoardStageSummary,
  ColumnConfig,
  MyTaskItem,
  MyTasksResponse,
  Priority,
  PublishStatus,
  StageCell,
  StageStatus,
  Work,
  WorksheetColor,
} from './worksheet.js';

export interface BoardWorksheetInput {
  id: string;
  name: string;
  color: WorksheetColor;
  sortOrder: string;
}

export interface BoardTaskInput {
  id: string;
  worksheetId: string;
  workId: string | null;
  title: string;
  divisionNote: string;
  priority: Priority;
  publishStatus: PublishStatus;
  sortOrder: string;
  stageCells: Record<string, StageCell>;
}

export interface BoardComputeInput {
  boardColumns: BoardColumn[];
  worksheets: BoardWorksheetInput[];
  stageColumns: ColumnConfig[];
  works: Work[];
  tasks: BoardTaskInput[];
  currentUserId: string;
}

export function isTaskPublished(task: { publishStatus: PublishStatus }): boolean {
  return task.publishStatus === 'published';
}

export function makeDefaultStageCell(taskId: string, columnId: string): StageCell {
  return {
    id: null,
    taskId,
    columnId,
    assignees: [],
    status: 'not_started',
    note: '',
    revision: 0,
    updatedAt: null,
  };
}

export function getEffectiveStageCell(
  task: { id: string; stageCells: Record<string, StageCell> },
  columnId: string,
): StageCell {
  return task.stageCells[columnId] ?? makeDefaultStageCell(task.id, columnId);
}

export function isUserAssigned(assignees: Assignee[], userId: string): boolean {
  return assignees.some((a) => a.type === 'user' && a.userId === userId);
}

function cmpOrder(aOrder: string, aId: string, bOrder: string, bId: string): number {
  if (aOrder < bOrder) return -1;
  if (aOrder > bOrder) return 1;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * 首页看板推导纯函数（第 5.2 节 & 5.4 节）：
 * 不写死任何工序名称，完全按 boardColumns / stageColumns / stageCells 实时推导。
 */
export function computeBoardData(input: BoardComputeInput): {
  cards: BoardCard[];
  myInProgress: MyTaskItem[];
  myPending: MyTaskItem[];
  myPendingCount: number;
} {
  const sortedBoardCols = [...input.boardColumns].sort((a, b) =>
    cmpOrder(a.sortOrder, a.id, b.sortOrder, b.id),
  );
  const boardColRank = new Map<string, number>();
  sortedBoardCols.forEach((bc, idx) => {
    boardColRank.set(bc.id, idx);
  });

  const wsMap = new Map<string, BoardWorksheetInput>();
  for (const ws of input.worksheets) {
    wsMap.set(ws.id, ws);
  }

  const workMap = new Map<string, Work>();
  for (const w of input.works) {
    workMap.set(w.id, w);
  }

  // 每个工作表的工序列按列 sortOrder 升序
  const stagesByWs = new Map<string, ColumnConfig[]>();
  for (const col of input.stageColumns) {
    if (col.type !== 'stage') continue;
    let arr = stagesByWs.get(col.worksheetId);
    if (!arr) {
      arr = [];
      stagesByWs.set(col.worksheetId, arr);
    }
    arr.push(col);
  }
  for (const arr of stagesByWs.values()) {
    arr.sort((a, b) => cmpOrder(a.sortOrder, a.id, b.sortOrder, b.id));
  }

  // 任务按工作表顺序 + 任务顺序稳定排序
  const wsRank = new Map<string, number>();
  [...input.worksheets]
    .sort((a, b) => cmpOrder(a.sortOrder, a.id, b.sortOrder, b.id))
    .forEach((ws, idx) => {
      wsRank.set(ws.id, idx);
    });

  const sortedTasks = [...input.tasks].sort((a, b) => {
    const wa = wsRank.get(a.worksheetId) ?? 0;
    const wb = wsRank.get(b.worksheetId) ?? 0;
    if (wa !== wb) return wa - wb;
    return cmpOrder(a.sortOrder, a.id, b.sortOrder, b.id);
  });

  const cards: BoardCard[] = [];
  const myInProgress: MyTaskItem[] = [];
  const myPending: MyTaskItem[] = [];

  for (const task of sortedTasks) {
    const ws = wsMap.get(task.worksheetId);
    if (!ws) continue;
    if (isTaskPublished(task)) continue;

    const wsStages = stagesByWs.get(ws.id) ?? [];
    const work = task.workId ? (workMap.get(task.workId) ?? null) : null;

    // 1. 适用工序（过滤 status === 'na'）
    const applicable: Array<{ col: ColumnConfig; cell: StageCell }> = [];
    for (const col of wsStages) {
      const cell = getEffectiveStageCell(task, col.id);
      if (cell.status === 'na') continue;
      applicable.push({ col, cell });

      // 顺便统计首页“我的任务”进行中与已认领待开始
      if (isUserAssigned(cell.assignees, input.currentUserId)) {
        if (cell.status === 'in_progress' || cell.status === 'not_started') {
          const item: MyTaskItem = {
            taskId: task.id,
            taskTitle: task.title,
            divisionNote: task.divisionNote,
            priority: task.priority,
            publishStatus: task.publishStatus,
            worksheetId: ws.id,
            worksheetName: ws.name,
            worksheetColor: ws.color,
            workId: work?.id ?? null,
            workName: work?.name ?? null,
            stageColumnId: col.id,
            stageColumnName: col.name,
            stageStatus: cell.status,
            stageAssignees: cell.assignees,
            stageNote: cell.note,
            stageRevision: cell.revision,
          };
          if (cell.status === 'in_progress') {
            myInProgress.push(item);
          } else {
            myPending.push(item);
          }
        }
      }
    }

    // 2. 上看板适用工序（按目标 BoardColumn.sortOrder 升序）
    const boardMapped = applicable
      .filter(({ col }) => col.boardColumnId !== null && boardColRank.has(col.boardColumnId))
      .sort((a, b) => {
        const ra = boardColRank.get(a.col.boardColumnId!) ?? 0;
        const rb = boardColRank.get(b.col.boardColumnId!) ?? 0;
        return ra - rb;
      });

    if (boardMapped.length === 0) continue;
    const firstIncomplete = boardMapped.find(({ cell }) => cell.status !== 'done');
    if (!firstIncomplete) continue; // 所有上看板适用工序均已完成 -> 离开看板

    // 缺人标签：遍历全部适用工序（含不上看板工序）
    const missingStages = applicable
      .filter(({ cell }) => cell.status !== 'done' && cell.assignees.length === 0)
      .map(({ col }) => ({ columnId: col.id, name: col.name }));

    const stageProgress: BoardStageSummary[] = applicable.map(({ col, cell }) => ({
      columnId: col.id,
      name: col.name,
      status: cell.status,
      boardColumnId: col.boardColumnId,
    }));

    // 3. 收集满足条件 A (in_progress) 或条件 B (第一个 status !== done) 的上看板适用工序
    for (const item of boardMapped) {
      const hitA = item.cell.status === 'in_progress';
      const hitB = item === firstIncomplete;
      if (!hitA && !hitB) continue;

      cards.push({
        boardColumnId: item.col.boardColumnId!,
        stageColumnId: item.col.id,
        stageColumnName: item.col.name,
        stageStatus: item.cell.status,
        stageAssignees: item.cell.assignees,
        stageNote: item.cell.note,
        stageRevision: item.cell.revision,
        taskId: task.id,
        taskTitle: task.title,
        divisionNote: task.divisionNote,
        priority: task.priority,
        worksheetId: ws.id,
        worksheetName: ws.name,
        worksheetColor: ws.color,
        workId: work?.id ?? null,
        workName: work?.name ?? null,
        missingStages,
        stageProgress,
      });
    }
  }

  return { cards, myInProgress, myPending, myPendingCount: myPending.length };
}

/**
 * `/my-tasks` 页面分组纯函数（第 5.4 节）
 * 只匹配当前用户账号负责的工序（排除纯文本负责人与不适用工序）。
 */
export function computeMyTasks(input: Omit<BoardComputeInput, 'boardColumns'>): MyTasksResponse {
  const wsMap = new Map<string, BoardWorksheetInput>();
  for (const ws of input.worksheets) {
    wsMap.set(ws.id, ws);
  }

  const workMap = new Map<string, Work>();
  for (const w of input.works) {
    workMap.set(w.id, w);
  }

  const stagesByWs = new Map<string, ColumnConfig[]>();
  for (const col of input.stageColumns) {
    if (col.type !== 'stage') continue;
    let arr = stagesByWs.get(col.worksheetId);
    if (!arr) {
      arr = [];
      stagesByWs.set(col.worksheetId, arr);
    }
    arr.push(col);
  }
  for (const arr of stagesByWs.values()) {
    arr.sort((a, b) => cmpOrder(a.sortOrder, a.id, b.sortOrder, b.id));
  }

  const wsRank = new Map<string, number>();
  [...input.worksheets]
    .sort((a, b) => cmpOrder(a.sortOrder, a.id, b.sortOrder, b.id))
    .forEach((ws, idx) => {
      wsRank.set(ws.id, idx);
    });

  const sortedTasks = [...input.tasks].sort((a, b) => {
    const wa = wsRank.get(a.worksheetId) ?? 0;
    const wb = wsRank.get(b.worksheetId) ?? 0;
    if (wa !== wb) return wa - wb;
    return cmpOrder(a.sortOrder, a.id, b.sortOrder, b.id);
  });

  const inProgress: MyTaskItem[] = [];
  const notStarted: MyTaskItem[] = [];
  const completed: MyTaskItem[] = [];

  for (const task of sortedTasks) {
    const ws = wsMap.get(task.worksheetId);
    if (!ws) continue;
    const wsStages = stagesByWs.get(ws.id) ?? [];
    const work = task.workId ? (workMap.get(task.workId) ?? null) : null;
    const published = isTaskPublished(task);

    for (const col of wsStages) {
      const cell = getEffectiveStageCell(task, col.id);
      if (cell.status === 'na') continue;
      if (!isUserAssigned(cell.assignees, input.currentUserId)) continue;

      const item: MyTaskItem = {
        taskId: task.id,
        taskTitle: task.title,
        divisionNote: task.divisionNote,
        priority: task.priority,
        publishStatus: task.publishStatus,
        worksheetId: ws.id,
        worksheetName: ws.name,
        worksheetColor: ws.color,
        workId: work?.id ?? null,
        workName: work?.name ?? null,
        stageColumnId: col.id,
        stageColumnName: col.name,
        stageStatus: cell.status,
        stageAssignees: cell.assignees,
        stageNote: cell.note,
        stageRevision: cell.revision,
      };

      if (published || cell.status === 'done') {
        completed.push(item);
      } else if (cell.status === 'in_progress') {
        inProgress.push(item);
      } else if (cell.status === 'not_started') {
        notStarted.push(item);
      }
    }
  }

  return { inProgress, notStarted, completed };
}
