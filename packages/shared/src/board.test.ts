import { describe, expect, it } from 'vitest';
import { type BoardTaskInput, computeBoardData, computeMyTasks, isTaskPublished } from './board.js';
import {
  assigneesSchema,
  type BoardColumn,
  type ColumnConfig,
  isValidCalendarDate,
  isValidHttpUrl,
  nullableDateSchema,
  nullableHttpUrlSchema,
  type StageCell,
  type StageStatus,
  type Work,
} from './worksheet.js';

const NOW = '2026-11-25T00:00:00.000Z';

const BC_TIMING: BoardColumn = {
  id: '00000000-0000-7000-8000-000000000001',
  name: '时轴',
  sortOrder: 'a0',
  createdAt: NOW,
  updatedAt: NOW,
};
const BC_TRANS: BoardColumn = {
  id: '00000000-0000-7000-8000-000000000002',
  name: '翻译',
  sortOrder: 'a1',
  createdAt: NOW,
  updatedAt: NOW,
};
const BC_PROOF: BoardColumn = {
  id: '00000000-0000-7000-8000-000000000003',
  name: '校对',
  sortOrder: 'a2',
  createdAt: NOW,
  updatedAt: NOW,
};
const BC_TYPESET: BoardColumn = {
  id: '00000000-0000-7000-8000-000000000004',
  name: '嵌字',
  sortOrder: 'a3',
  createdAt: NOW,
  updatedAt: NOW,
};

const USER_1 = '10000000-0000-7000-8000-000000000001';
const USER_2 = '10000000-0000-7000-8000-000000000002';

function makeCol(
  id: string,
  worksheetId: string,
  name: string,
  sortOrder: string,
  boardColumnId: string | null,
): ColumnConfig {
  return {
    id,
    worksheetId,
    name,
    type: 'stage',
    sortOrder,
    width: 160,
    hidden: false,
    boardColumnId,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeCell(
  taskId: string,
  columnId: string,
  status: StageStatus,
  assignees: StageCell['assignees'] = [],
  note = '',
): StageCell {
  return {
    id: `cell-${taskId}-${columnId}`,
    taskId,
    columnId,
    assignees,
    status,
    note,
    revision: 1,
    updatedAt: NOW,
  };
}

describe('worksheet 字段规则校验', () => {
  it('校验合法日历日期与 http/https 链接', () => {
    expect(isValidCalendarDate('2026-02-28')).toBe(true);
    expect(isValidCalendarDate('2026-02-29')).toBe(false);
    expect(isValidCalendarDate('2024-02-29')).toBe(true);
    expect(isValidCalendarDate('2026-13-01')).toBe(false);
    expect(nullableDateSchema.parse('')).toBeNull();
    expect(nullableDateSchema.parse(' 2026-11-25 ')).toBe('2026-11-25');

    expect(isValidHttpUrl('https://example.com/v1')).toBe(true);
    expect(isValidHttpUrl('http://example.com')).toBe(true);
    expect(isValidHttpUrl('javascript:alert(1)')).toBe(false);
    expect(nullableHttpUrlSchema.parse('  ')).toBeNull();
  });

  it('负责人列表按用户和文本自动去重', () => {
    const parsed = assigneesSchema.parse([
      { type: 'user', userId: USER_1 },
      { type: 'user', userId: USER_1 },
      { type: 'text', name: ' 外援小王 ' },
      { type: 'text', name: '外援小王' },
    ]);
    expect(parsed).toEqual([
      { type: 'user', userId: USER_1 },
      { type: 'text', name: '外援小王' },
    ]);
  });
});

describe('board.ts 看板与我的任务推导（A22/A23/A28）', () => {
  const WS_VIDEO = '20000000-0000-7000-8000-000000000001';
  const WS_NO_PROOF = '20000000-0000-7000-8000-000000000002';

  const C_V_TIMING = '30000000-0000-7000-8000-000000000001';
  const C_V_TRANS = '30000000-0000-7000-8000-000000000002';
  const C_V_PROOF = '30000000-0000-7000-8000-000000000003';
  const C_V_TYPESET = '30000000-0000-7000-8000-000000000004';
  const C_V_ENCODE = '30000000-0000-7000-8000-000000000005'; // 不上看板工序

  const C_NP_TRANS = '30000000-0000-7000-8000-000000000011';
  const C_NP_TYPESET = '30000000-0000-7000-8000-000000000012';

  const WORK_1: Work = {
    id: '40000000-0000-7000-8000-000000000001',
    worksheetId: WS_VIDEO,
    name: '5th 演唱会花絮',
    createdAt: NOW,
    updatedAt: NOW,
  };

  const baseInput = () => ({
    boardColumns: [BC_TIMING, BC_TRANS, BC_PROOF, BC_TYPESET],
    worksheets: [
      { id: WS_VIDEO, name: '视频', color: 'sky' as const, sortOrder: 'a0' },
      { id: WS_NO_PROOF, name: '短片无校对', color: 'emerald' as const, sortOrder: 'a1' },
    ],
    stageColumns: [
      makeCol(C_V_TIMING, WS_VIDEO, '时轴', 'a0', BC_TIMING.id),
      makeCol(C_V_TRANS, WS_VIDEO, '翻译', 'a1', BC_TRANS.id),
      makeCol(C_V_PROOF, WS_VIDEO, '校对', 'a2', BC_PROOF.id),
      makeCol(C_V_TYPESET, WS_VIDEO, '嵌字', 'a3', BC_TYPESET.id),
      makeCol(C_V_ENCODE, WS_VIDEO, '压制', 'a4', null),
      makeCol(C_NP_TRANS, WS_NO_PROOF, '翻译', 'a0', BC_TRANS.id),
      makeCol(C_NP_TYPESET, WS_NO_PROOF, '嵌字', 'a1', BC_TYPESET.id),
    ],
    works: [WORK_1],
    currentUserId: USER_1,
  });

  it('未开始任务落在第一个未完成上看板适用工序列；含不上看板工序的缺人标签', () => {
    const res = computeBoardData({
      ...baseInput(),
      tasks: [
        {
          id: 't1',
          worksheetId: WS_VIDEO,
          workId: WORK_1.id,
          title: '全未开始',
          divisionNote: 'P1',
          priority: 'high',
          publishStatus: 'unpublished',
          sortOrder: 'a0',
          stageCells: {},
        },
      ],
    });

    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]?.boardColumnId).toBe(BC_TIMING.id);
    expect(res.cards[0]?.workName).toBe('5th 演唱会花絮');
    // 包含不上看板的“压制”
    expect(res.cards[0]?.missingStages.map((m) => m.name)).toEqual([
      '时轴',
      '翻译',
      '校对',
      '嵌字',
      '压制',
    ]);
  });

  it('并行进行中的任务同时出现在多个看板列（A22）', () => {
    const res = computeBoardData({
      ...baseInput(),
      tasks: [
        {
          id: 't-parallel',
          worksheetId: WS_VIDEO,
          workId: null,
          title: '并行任务',
          divisionNote: '',
          priority: 'normal',
          publishStatus: 'unpublished',
          sortOrder: 'a0',
          stageCells: {
            [C_V_TIMING]: makeCell('t-parallel', C_V_TIMING, 'in_progress', [
              { type: 'user', userId: USER_1 },
            ]),
            [C_V_TRANS]: makeCell('t-parallel', C_V_TRANS, 'in_progress', [
              { type: 'user', userId: USER_2 },
            ]),
          },
        },
      ],
    });

    expect(res.cards.map((c) => c.boardColumnId)).toEqual([BC_TIMING.id, BC_TRANS.id]);
  });

  it('后续工序先开始进行中时，首个未完成列与进行中列同时出现', () => {
    const res = computeBoardData({
      ...baseInput(),
      tasks: [
        {
          id: 't-later-in-prog',
          worksheetId: WS_VIDEO,
          workId: null,
          title: '先做嵌字',
          divisionNote: '',
          priority: 'normal',
          publishStatus: 'unpublished',
          sortOrder: 'a0',
          stageCells: {
            [C_V_TYPESET]: makeCell('t-later-in-prog', C_V_TYPESET, 'in_progress', [
              { type: 'user', userId: USER_1 },
            ]),
          },
        },
      ],
    });

    // 条件 B 命中时轴（首个未完成），条件 A 命中嵌字（进行中）
    expect(res.cards.map((c) => c.boardColumnId)).toEqual([BC_TIMING.id, BC_TYPESET.id]);
  });

  it('标“不适用”的工序自动跳过，且不出缺人标签；已发布或上看板适用工序全完成后离开看板', () => {
    const res = computeBoardData({
      ...baseInput(),
      tasks: [
        {
          id: 't-skip-na',
          worksheetId: WS_VIDEO,
          workId: null,
          title: '跳过时轴',
          divisionNote: '',
          priority: 'normal',
          publishStatus: 'unpublished',
          sortOrder: 'a0',
          stageCells: {
            [C_V_TIMING]: makeCell('t-skip-na', C_V_TIMING, 'na'),
            [C_V_ENCODE]: makeCell('t-skip-na', C_V_ENCODE, 'na'),
          },
        },
        {
          id: 't-published',
          worksheetId: WS_VIDEO,
          workId: null,
          title: '已发布任务',
          divisionNote: '',
          priority: 'normal',
          publishStatus: 'published',
          sortOrder: 'a1',
          stageCells: {
            [C_V_TIMING]: makeCell('t-published', C_V_TIMING, 'in_progress', [
              { type: 'user', userId: USER_1 },
            ]),
          },
        },
        {
          id: 't-all-board-done',
          worksheetId: WS_VIDEO,
          workId: null,
          title: '上看板工序全完成',
          divisionNote: '',
          priority: 'normal',
          publishStatus: 'unpublished',
          sortOrder: 'a2',
          stageCells: {
            [C_V_TIMING]: makeCell('t-all-board-done', C_V_TIMING, 'done'),
            [C_V_TRANS]: makeCell('t-all-board-done', C_V_TRANS, 'done'),
            [C_V_PROOF]: makeCell('t-all-board-done', C_V_PROOF, 'done'),
            [C_V_TYPESET]: makeCell('t-all-board-done', C_V_TYPESET, 'done'),
            // 压制不上看板且未完成，仍离开看板
          },
        },
      ],
    });

    expect(isTaskPublished({ publishStatus: 'published' })).toBe(true);
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]?.taskId).toBe('t-skip-na');
    expect(res.cards[0]?.boardColumnId).toBe(BC_TRANS.id);
    expect(res.cards[0]?.missingStages.map((m) => m.name)).toEqual(['翻译', '校对', '嵌字']);
    // 已发布任务的进行中不进入 myInProgress
    expect(res.myInProgress).toHaveLength(0);
  });

  it('A28: 工作表没有校对列时不落在校对列、不显示缺校对，已有上看板工序完成后离开看板', () => {
    const res1 = computeBoardData({
      ...baseInput(),
      tasks: [
        {
          id: 't-np-1',
          worksheetId: WS_NO_PROOF,
          workId: null,
          title: '无校对任务',
          divisionNote: '',
          priority: 'normal',
          publishStatus: 'unpublished',
          sortOrder: 'a0',
          stageCells: {
            [C_NP_TRANS]: makeCell('t-np-1', C_NP_TRANS, 'done', [
              { type: 'user', userId: USER_1 },
            ]),
          },
        },
      ],
    });
    expect(res1.cards).toHaveLength(1);
    expect(res1.cards[0]?.boardColumnId).toBe(BC_TYPESET.id);
    expect(res1.cards[0]?.missingStages.map((m) => m.name)).toEqual(['嵌字']);

    const res2 = computeBoardData({
      ...baseInput(),
      tasks: [
        {
          id: 't-np-2',
          worksheetId: WS_NO_PROOF,
          workId: null,
          title: '无校对全完成',
          divisionNote: '',
          priority: 'normal',
          publishStatus: 'unpublished',
          sortOrder: 'a0',
          stageCells: {
            [C_NP_TRANS]: makeCell('t-np-2', C_NP_TRANS, 'done'),
            [C_NP_TYPESET]: makeCell('t-np-2', C_NP_TYPESET, 'done'),
          },
        },
      ],
    });
    expect(res2.cards).toHaveLength(0);
  });

  it('我进行中的任务与 /my-tasks：仅匹配当前用户账号，排除纯文本名字', () => {
    const tasks: BoardTaskInput[] = [
      {
        id: 't-my',
        worksheetId: WS_VIDEO,
        workId: WORK_1.id,
        title: '我的任务',
        divisionNote: '',
        priority: 'urgent' as const,
        publishStatus: 'unpublished' as const,
        sortOrder: 'a0',
        stageCells: {
          [C_V_TIMING]: makeCell('t-my', C_V_TIMING, 'in_progress', [
            { type: 'user', userId: USER_1 },
          ]),
          [C_V_TRANS]: makeCell('t-my', C_V_TRANS, 'not_started', [
            { type: 'user', userId: USER_1 },
          ]),
          [C_V_PROOF]: makeCell('t-my', C_V_PROOF, 'done', [{ type: 'user', userId: USER_1 }]),
          [C_V_TYPESET]: makeCell('t-my', C_V_TYPESET, 'in_progress', [
            { type: 'text', name: '管理员_1' },
          ]),
        },
      },
      {
        id: 't-my-pub',
        worksheetId: WS_VIDEO,
        workId: null,
        title: '已发布的我的任务',
        divisionNote: '',
        priority: 'normal' as const,
        publishStatus: 'published' as const,
        sortOrder: 'a1',
        stageCells: {
          [C_V_TIMING]: makeCell('t-my-pub', C_V_TIMING, 'in_progress', [
            { type: 'user', userId: USER_1 },
          ]),
        },
      },
    ];

    const board = computeBoardData({ ...baseInput(), tasks });
    expect(board.myInProgress).toHaveLength(1);
    expect(board.myInProgress[0]?.stageColumnName).toBe('时轴');
    expect(board.myPending).toHaveLength(1);
    expect(board.myPending[0]?.stageColumnName).toBe('翻译');
    expect(board.myPendingCount).toBe(1);

    const mine = computeMyTasks({ ...baseInput(), tasks });
    expect(mine.inProgress).toHaveLength(1);
    expect(mine.notStarted).toHaveLength(1);
    expect(mine.completed).toHaveLength(2); // done + published
  });
});
