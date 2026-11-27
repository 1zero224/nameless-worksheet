import { describe, expect, it } from 'vitest';
import {
  buildTaskShareUrl,
  decodeShortUuid,
  encodeShortUuid,
  formatTaskShareText,
  getShareStageEmoji,
} from './task-share.js';

const TASK_ID = '0195a8f0-7c2d-7a3b-9e4f-123456789abc';
const STAGE_TIMING = '0195a8f0-7c2d-7a3b-9e4f-000000000001';
const STAGE_TRANS = '0195a8f0-7c2d-7a3b-9e4f-000000000002';
const STAGE_PROOF = '0195a8f0-7c2d-7a3b-9e4f-000000000003';
const STAGE_TYPESET = '0195a8f0-7c2d-7a3b-9e4f-000000000004';
const STAGE_HIDDEN = '0195a8f0-7c2d-7a3b-9e4f-000000000005';
const USER_A = '10000000-0000-7000-8000-000000000001';
const USER_B = '10000000-0000-7000-8000-000000000002';

describe('task-share 无状态短码编解码', () => {
  it('往返编解码多个边界 UUID 字节级无损', () => {
    const samples = [
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      TASK_ID,
      STAGE_TIMING,
      'a1b2c3d4-e5f6-4789-abcd-ef0123456789',
    ];
    for (const id of samples) {
      const code = encodeShortUuid(id);
      expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(decodeShortUuid(code)).toBe(id);
    }
  });

  it('兼容标准 UUID 输入并拒绝非法短码与非规范尾位', () => {
    expect(decodeShortUuid(TASK_ID.toUpperCase())).toBe(TASK_ID);
    expect(decodeShortUuid('')).toBeNull();
    expect(decodeShortUuid('too-short')).toBeNull();
    expect(decodeShortUuid('invalid+chars/12345678')).toBeNull();
    // 22 位最后字符低 4 位非 0（如 'B' = 1）应拒绝
    const valid = encodeShortUuid('00000000-0000-0000-0000-000000000000');
    expect(valid).toBe('AAAAAAAAAAAAAAAAAAAAAA');
    expect(decodeShortUuid('AAAAAAAAAAAAAAAAAAAAAB')).toBeNull();
  });

  it('构造任务级与工序级短链', () => {
    const taskUrl = buildTaskShareUrl({
      origin: 'https://work.example.com/',
      taskId: TASK_ID,
    });
    expect(taskUrl).toBe(`https://work.example.com/t/${encodeShortUuid(TASK_ID)}`);

    const stageUrl = buildTaskShareUrl({
      origin: 'https://work.example.com',
      taskId: TASK_ID,
      stageColumnId: STAGE_TRANS,
    });
    expect(stageUrl).toBe(
      `https://work.example.com/t/${encodeShortUuid(TASK_ID)}/${encodeShortUuid(STAGE_TRANS)}`,
    );
  });
});

describe('task-share 文本格式化', () => {
  const userMap = new Map<string, string>([
    [USER_A, '张三'],
    [USER_B, '李四'],
  ]);

  it('按 5 态圆点居行首格式化整条任务分享（省略不适用与隐藏列）', () => {
    expect(getShareStageEmoji('done', 1)).toBe('🟢');
    expect(getShareStageEmoji('in_progress', 1)).toBe('🟠');
    expect(getShareStageEmoji('not_started', 1)).toBe('⚪');
    expect(getShareStageEmoji('not_started', 0)).toBe('🔴');

    const url = buildTaskShareUrl({ origin: 'https://work.example.com', taskId: TASK_ID });
    const text = formatTaskShareText({
      workName: '5th 演唱会',
      taskTitle: 'P1 00:00-15:00',
      userMap,
      url,
      stages: [
        {
          columnId: STAGE_TIMING,
          name: '时轴',
          status: 'done',
          assignees: [{ type: 'user', userId: USER_A }],
        },
        {
          columnId: STAGE_TRANS,
          name: '翻译',
          status: 'in_progress',
          assignees: [
            { type: 'user', userId: USER_B },
            { type: 'text', name: '外援小王' },
          ],
        },
        {
          columnId: STAGE_PROOF,
          name: '校对',
          status: 'not_started',
          assignees: [],
        },
        {
          columnId: STAGE_TYPESET,
          name: '嵌字',
          status: 'not_started',
          assignees: [{ type: 'user', userId: USER_A }],
        },
        {
          columnId: STAGE_HIDDEN,
          name: '隐藏工序',
          status: 'not_started',
          assignees: [],
          hidden: true,
        },
        {
          columnId: '0195a8f0-7c2d-7a3b-9e4f-000000000006',
          name: '压制',
          status: 'na',
          assignees: [],
        },
      ],
    });

    expect(text).toBe(
      [
        '5th 演唱会 - P1 00:00-15:00',
        '🟢 时轴：张三',
        '🟠 翻译：李四、外援小王',
        '🔴 校对：空缺',
        '⚪ 嵌字：张三',
        `🔗 查看任务：${url}`,
      ].join('\n'),
    );
  });

  it('格式化指定工序分享并突出本次分享与资源数', () => {
    const url = buildTaskShareUrl({
      origin: 'https://work.example.com',
      taskId: TASK_ID,
      stageColumnId: STAGE_TIMING,
    });
    const text = formatTaskShareText({
      workName: null,
      taskTitle: '单曲 MV',
      userMap,
      url,
      focusStageColumnId: STAGE_TIMING,
      stages: [
        {
          columnId: STAGE_TIMING,
          name: '时轴',
          status: 'done',
          assignees: [{ type: 'user', userId: USER_A }],
          artifactCount: 2,
        },
        {
          columnId: STAGE_TRANS,
          name: '翻译',
          status: 'not_started',
          assignees: [],
        },
      ],
    });

    expect(text).toBe(
      [
        '单曲 MV · 时轴',
        '🟢 时轴：张三（本次分享 · 2 个资源）',
        '🔴 翻译：空缺',
        `📎 查看「时轴」工序资源：${url}`,
      ].join('\n'),
    );
  });
});
