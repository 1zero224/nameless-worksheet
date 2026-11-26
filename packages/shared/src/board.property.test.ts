import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type BoardComputeInput,
  type BoardTaskInput,
  type BoardWorksheetInput,
  computeBoardData,
  computeMyTasks,
  getEffectiveStageCell,
  isUserAssigned,
} from './board.js';
import {
  type Assignee,
  type BoardColumn,
  type ColumnConfig,
  generateKeyBetween,
  generateNKeysBetween,
  PRIORITIES,
  PUBLISH_STATUSES,
  STAGE_STATUSES,
  type StageCell,
  WORKSHEET_COLORS,
  WORKSHEET_KINDS,
  type Work,
} from './worksheet.js';

const NOW = '2026-11-25T00:00:00.000Z';
const USERS = [
  '10000000-0000-7000-8000-000000000001',
  '10000000-0000-7000-8000-000000000002',
  '10000000-0000-7000-8000-000000000003',
] as const;

const assigneeArb: fc.Arbitrary<Assignee> = fc.oneof(
  fc.constantFrom(...USERS).map((userId) => ({ type: 'user' as const, userId })),
  fc.constantFrom('外援甲', '官中', '字幕组乙').map((name) => ({ type: 'text' as const, name })),
);

/**
 * 构造符合领域约束的随机看板世界（同工作表内每个看板列最多映射一个工序列）。
 */
const boardWorldArb: fc.Arbitrary<BoardComputeInput> = fc
  .record({
    boardColCount: fc.integer({ min: 0, max: 5 }),
    wsCount: fc.integer({ min: 1, max: 3 }),
    currentUserId: fc.constantFrom(...USERS),
  })
  .chain(({ boardColCount, wsCount, currentUserId }) => {
    const boardKeys = generateNKeysBetween(null, null, boardColCount);
    const boardColumns: BoardColumn[] = boardKeys.map((sortOrder, idx) => ({
      id: `bc-${idx}`,
      name: `看板列${idx}`,
      sortOrder,
      createdAt: NOW,
      updatedAt: NOW,
    }));

    const wsKeys = generateNKeysBetween(null, null, wsCount);

    return fc
      .tuple(
        fc.array(fc.constantFrom(...WORKSHEET_COLORS), { minLength: wsCount, maxLength: wsCount }),
        fc.array(fc.constantFrom(...WORKSHEET_KINDS), { minLength: wsCount, maxLength: wsCount }),
        fc.array(fc.integer({ min: 0, max: 6 }), { minLength: wsCount, maxLength: wsCount }),
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: wsCount, maxLength: wsCount }),
        fc.array(fc.integer({ min: 0, max: 2 }), { minLength: wsCount, maxLength: wsCount }),
      )
      .chain(([colors, kinds, stageCounts, taskCounts, workCounts]) => {
        const worksheets: BoardWorksheetInput[] = wsKeys.map((sortOrder, i) => ({
          id: `ws-${i}`,
          name: `工作表${i}`,
          color: colors[i] ?? 'sky',
          kind: kinds[i] ?? 'task',
          sortOrder,
        }));

        const works: Work[] = [];
        for (let wi = 0; wi < wsCount; wi += 1) {
          const wc = workCounts[wi] ?? 0;
          for (let k = 0; k < wc; k += 1) {
            works.push({
              id: `work-${wi}-${k}`,
              worksheetId: `ws-${wi}`,
              name: `作品${wi}-${k}`,
              createdAt: NOW,
              updatedAt: NOW,
            });
          }
        }

        // 为每张工作表随机分配工序列与 1:1 看板列映射（含不上看板的 null 列和自定义非 stage 列）
        const wsStageConfigArbs = worksheets.map((ws, wi) => {
          const sc = stageCounts[wi] ?? 0;
          return fc
            .tuple(
              fc.shuffledSubarray(
                boardColumns.map((b) => b.id),
                { minLength: 0, maxLength: Math.min(sc, boardColumns.length) },
              ),
              fc.boolean(),
            )
            .map(([mappedIds, addTextCol]) => {
              const colKeys = generateNKeysBetween(null, null, sc + (addTextCol ? 1 : 0));
              const cols: ColumnConfig[] = [];
              for (let c = 0; c < sc; c += 1) {
                cols.push({
                  id: `col-${wi}-${c}`,
                  worksheetId: ws.id,
                  name: `工序${wi}-${c}`,
                  type: 'stage',
                  sortOrder: colKeys[c] ?? 'a0',
                  width: 160,
                  hidden: false,
                  boardColumnId: mappedIds[c] ?? null,
                  createdAt: NOW,
                  updatedAt: NOW,
                });
              }
              if (addTextCol) {
                cols.push({
                  id: `col-text-${wi}`,
                  worksheetId: ws.id,
                  name: '备注列',
                  type: 'text',
                  sortOrder: colKeys[sc] ?? 'z0',
                  width: 150,
                  hidden: false,
                  boardColumnId: null,
                  createdAt: NOW,
                  updatedAt: NOW,
                });
              }
              return cols;
            });
        });

        return fc.tuple(...wsStageConfigArbs).chain((colsPerWs) => {
          const stageColumns = colsPerWs.flat();

          const taskArbs: Array<fc.Arbitrary<BoardTaskInput>> = [];
          for (let wi = 0; wi < wsCount; wi += 1) {
            const wsId = `ws-${wi}`;
            const wsCols = (colsPerWs[wi] ?? []).filter((c) => c.type === 'stage');
            const wsWorks = works.filter((w) => w.worksheetId === wsId);
            const tc = taskCounts[wi] ?? 0;
            const taskKeys = generateNKeysBetween(null, null, tc);

            for (let ti = 0; ti < tc; ti += 1) {
              const taskId = `task-${wi}-${ti}`;
              const cellArbs = wsCols.map(() =>
                fc.option(
                  fc.record({
                    status: fc.constantFrom(...STAGE_STATUSES),
                    assignees: fc.array(assigneeArb, { maxLength: 3 }),
                    note: fc.constantFrom('', '初校', '需重压'),
                    revision: fc.integer({ min: 1, max: 10 }),
                  }),
                  { nil: undefined },
                ),
              );

              const workIdArb =
                wsWorks.length > 0
                  ? fc.option(fc.constantFrom(...wsWorks.map((w) => w.id)), { nil: null })
                  : fc.constant(null);

              taskArbs.push(
                fc
                  .record({
                    workId: workIdArb,
                    priority: fc.constantFrom(...PRIORITIES),
                    publishStatus: fc.constantFrom(...PUBLISH_STATUSES),
                    cells: cellArbs.length > 0 ? fc.tuple(...cellArbs) : fc.constant([]),
                  })
                  .map(({ workId, priority, publishStatus, cells }) => {
                    const stageCells: Record<string, StageCell> = {};
                    wsCols.forEach((col, idx) => {
                      const raw = cells[idx];
                      if (!raw) return; // 测试惰性缺省单元格
                      stageCells[col.id] = {
                        id: `cell-${taskId}-${col.id}`,
                        taskId,
                        columnId: col.id,
                        assignees: raw.assignees,
                        status: raw.status,
                        note: raw.note,
                        revision: raw.revision,
                        updatedAt: NOW,
                      };
                    });
                    return {
                      id: taskId,
                      worksheetId: wsId,
                      workId,
                      title: `任务${wi}-${ti}`,
                      divisionNote: ti % 2 === 0 ? 'P1' : '',
                      priority,
                      publishStatus,
                      sortOrder: taskKeys[ti] ?? 'a0',
                      stageCells,
                    };
                  }),
              );
            }
          }

          const allTasksArb: fc.Arbitrary<BoardTaskInput[]> =
            taskArbs.length > 0 ? fc.tuple(...taskArbs) : fc.constant<BoardTaskInput[]>([]);
          return allTasksArb.map((tasks) => ({
            boardColumns,
            worksheets,
            stageColumns,
            works,
            tasks,
            currentUserId,
          }));
        });
      });
  });

/**
 * 独立朴素参考实现（Differential Oracle）：直接按产品规则逐条计算期望卡片与“我的任务”键集合。
 */
function naiveBoardOracle(input: BoardComputeInput): {
  cardKeys: Set<string>;
  myInProgressKeys: Set<string>;
  myPendingCount: number;
} {
  const boardColOrder = [...input.boardColumns].sort((a, b) =>
    a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : a.id.localeCompare(b.id),
  );
  const boardColIds = new Set(boardColOrder.map((c) => c.id));
  const wsMap = new Map(input.worksheets.map((w) => [w.id, w]));

  const cardKeys = new Set<string>();
  const myInProgressKeys = new Set<string>();
  let myPendingCount = 0;

  for (const task of input.tasks) {
    const ws = wsMap.get(task.worksheetId);
    if (!ws || ws.kind === 'free') continue;
    if (task.publishStatus === 'published' || task.publishStatus === 'shelved') continue;

    const wsStages = input.stageColumns.filter(
      (c) => c.worksheetId === task.worksheetId && c.type === 'stage',
    );

    for (const col of wsStages) {
      const cell = getEffectiveStageCell(task, col.id);
      if (cell.status === 'na') continue;
      if (isUserAssigned(cell.assignees, input.currentUserId)) {
        if (cell.status === 'in_progress') myInProgressKeys.add(`${task.id}::${col.id}`);
        if (cell.status === 'not_started') myPendingCount += 1;
      }
    }

    const mappedInBoardOrder = boardColOrder
      .map((bc) => wsStages.find((s) => s.boardColumnId === bc.id))
      .filter((col): col is ColumnConfig => Boolean(col))
      .map((col) => ({ col, cell: getEffectiveStageCell(task, col.id) }))
      .filter(({ cell }) => cell.status !== 'na');

    const firstIncomplete = mappedInBoardOrder.find(({ cell }) => cell.status !== 'done');
    if (!firstIncomplete) continue;

    for (const item of mappedInBoardOrder) {
      const bcId = item.col.boardColumnId;
      if (!bcId || !boardColIds.has(bcId)) continue;
      if (item.cell.status === 'in_progress' || item === firstIncomplete) {
        cardKeys.add(`${task.id}::${bcId}`);
      }
    }
  }

  return { cardKeys, myInProgressKeys, myPendingCount };
}

describe('board.ts 看板与我的任务属性测试 + 差分 Oracle（fast-check）', () => {
  it('在任意随机工作表/看板列/工序组合下满足全部领域不变量并与独立 Oracle 一致', () => {
    fc.assert(
      fc.property(boardWorldArb, (world) => {
        const board = computeBoardData(world);
        const myTasks = computeMyTasks({
          worksheets: world.worksheets,
          stageColumns: world.stageColumns,
          works: world.works,
          tasks: world.tasks,
          currentUserId: world.currentUserId,
        });
        const oracle = naiveBoardOracle(world);

        const taskMap = new Map(world.tasks.map((t) => [t.id, t]));
        const wsMap = new Map(world.worksheets.map((w) => [w.id, w]));
        const colMap = new Map(world.stageColumns.map((c) => [c.id, c]));
        const boardColIds = new Set(world.boardColumns.map((b) => b.id));

        // 1. 卡片无重复且与独立朴素 Oracle 完全一致
        const actualCardKeys = new Set<string>();
        for (const card of board.cards) {
          const key = `${card.taskId}::${card.boardColumnId}`;
          expect(actualCardKeys.has(key)).toBe(false);
          actualCardKeys.add(key);

          // 2. 已发布/已搁置任务与自由表格绝不上看板
          const task = taskMap.get(card.taskId);
          expect(task?.publishStatus).toBe('unpublished');
          expect(wsMap.get(card.worksheetId)?.kind).not.toBe('free');

          // 3. 卡片必对应本工作表存在的有效映射工序列，且该工序既非 na 也非 done
          expect(boardColIds.has(card.boardColumnId)).toBe(true);
          const col = colMap.get(card.stageColumnId);
          expect(col?.type).toBe('stage');
          expect(col?.worksheetId).toBe(card.worksheetId);
          expect(col?.boardColumnId).toBe(card.boardColumnId);
          expect(card.stageStatus).not.toBe('na');
          expect(card.stageStatus).not.toBe('done');

          // 4. 缺人标签精确等价于：本表全部适用工序（含不上看板）中 status !== 'done' 且无负责人
          const expectedMissing = world.stageColumns
            .filter((c) => c.worksheetId === card.worksheetId && c.type === 'stage')
            .filter((c) => {
              const cell = task ? getEffectiveStageCell(task, c.id) : null;
              return (
                cell !== null &&
                cell.status !== 'na' &&
                cell.status !== 'done' &&
                cell.assignees.length === 0
              );
            })
            .map((c) => c.id)
            .sort();
          expect(card.missingStages.map((m) => m.columnId).sort()).toEqual(expectedMissing);
        }
        expect(actualCardKeys).toEqual(oracle.cardKeys);

        // 5. computeBoardData 与 computeMyTasks 跨函数等价性
        const boardMyInProgKeys = new Set(
          board.myInProgress.map((i) => `${i.taskId}::${i.stageColumnId}`),
        );
        const myTasksInProgKeys = new Set(
          myTasks.inProgress.map((i) => `${i.taskId}::${i.stageColumnId}`),
        );
        expect(boardMyInProgKeys).toEqual(oracle.myInProgressKeys);
        expect(myTasksInProgKeys).toEqual(boardMyInProgKeys);
        expect(board.myPendingCount).toBe(oracle.myPendingCount);
        expect(myTasks.notStarted.length).toBe(board.myPendingCount);

        // 6. “我的任务”绝不混入纯文本负责人、na 工序、自由表格或已搁置任务，且已发布任务只落入 completed
        for (const item of [...myTasks.inProgress, ...myTasks.notStarted, ...myTasks.completed]) {
          expect(isUserAssigned(item.stageAssignees, world.currentUserId)).toBe(true);
          expect(item.stageStatus).not.toBe('na');
          expect(item.publishStatus).not.toBe('shelved');
          expect(wsMap.get(item.worksheetId)?.kind).not.toBe('free');
        }
        for (const item of [...myTasks.inProgress, ...myTasks.notStarted]) {
          expect(item.publishStatus).toBe('unpublished');
        }
      }),
      { numRuns: 200 },
    );
  });
});

type OrderOp =
  | { type: 'insertHead' }
  | { type: 'insertTail' }
  | { type: 'insertAt'; ratio: number }
  | { type: 'move'; fromRatio: number; toRatio: number }
  | { type: 'rebalance' };

const orderOpArb: fc.Arbitrary<OrderOp> = fc.oneof(
  fc.constant({ type: 'insertHead' as const }),
  fc.constant({ type: 'insertTail' as const }),
  fc.double({ min: 0, max: 1, noNaN: true }).map((ratio) => ({ type: 'insertAt' as const, ratio })),
  fc
    .record({
      fromRatio: fc.double({ min: 0, max: 1, noNaN: true }),
      toRatio: fc.double({ min: 0, max: 1, noNaN: true }),
    })
    .map(({ fromRatio, toRatio }) => ({ type: 'move' as const, fromRatio, toRatio })),
  fc.constant({ type: 'rebalance' as const }),
);

describe('fractional-indexing 任意插入与拖动重排等价性（fast-check）', () => {
  it('任意顺序操作后，sortOrder 严格唯一递增且排序结果与朴素数组模型完全一致', () => {
    fc.assert(
      fc.property(fc.array(orderOpArb, { minLength: 1, maxLength: 60 }), (ops) => {
        const refOrder: string[] = [];
        const keys = new Map<string, string>();
        let nextId = 1;

        const keyOf = (id: string | undefined): string | null => {
          if (id === undefined) return null;
          return keys.get(id) ?? null;
        };

        const rebalance = () => {
          const fresh = generateNKeysBetween(null, null, refOrder.length);
          refOrder.forEach((id, idx) => {
            const k = fresh[idx];
            if (k !== undefined) keys.set(id, k);
          });
        };

        const insertAtIndex = (index: number) => {
          const id = `item-${nextId}`;
          nextId += 1;
          const prevKey = keyOf(refOrder[index - 1]);
          const nextKey = keyOf(refOrder[index]);
          refOrder.splice(index, 0, id);
          try {
            keys.set(id, generateKeyBetween(prevKey, nextKey));
          } catch {
            rebalance();
          }
        };

        for (const op of ops) {
          if (op.type === 'insertHead') {
            insertAtIndex(0);
          } else if (op.type === 'insertTail') {
            insertAtIndex(refOrder.length);
          } else if (op.type === 'insertAt') {
            const idx = Math.floor(op.ratio * (refOrder.length + 1));
            insertAtIndex(Math.min(idx, refOrder.length));
          } else if (op.type === 'move' && refOrder.length >= 2) {
            const from = Math.min(Math.floor(op.fromRatio * refOrder.length), refOrder.length - 1);
            const [moved] = refOrder.splice(from, 1);
            if (moved !== undefined) {
              const to = Math.min(Math.floor(op.toRatio * (refOrder.length + 1)), refOrder.length);
              const prevKey = keyOf(refOrder[to - 1]);
              const nextKey = keyOf(refOrder[to]);
              refOrder.splice(to, 0, moved);
              try {
                keys.set(moved, generateKeyBetween(prevKey, nextKey));
              } catch {
                rebalance();
              }
            }
          } else if (op.type === 'rebalance') {
            rebalance();
          }

          // 每步执行后校验严格字典序等价性与唯一性
          const sortedByKey = [...keys.entries()]
            .sort(([, ka], [, kb]) => (ka < kb ? -1 : ka > kb ? 1 : 0))
            .map(([id]) => id);
          expect(sortedByKey).toEqual(refOrder);
          expect(new Set(keys.values()).size).toBe(refOrder.length);
        }
      }),
      { numRuns: 150 },
    );
  });
});
