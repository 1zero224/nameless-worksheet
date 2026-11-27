import { describe, expect, it } from 'vitest';
import { buildStageAssigneeOptions, resolveTypedAssignee } from './stage-assignees.js';

describe('buildStageAssigneeOptions', () => {
  const users = [
    { id: 'u1', displayName: '小爱' },
    { id: 'u2', displayName: '小羽' },
    { id: 'u3', displayName: '阿明' },
    { id: 'u4', displayName: '大白' },
  ];

  it('当前用户永远排在最前面，其余按该工序接单频次降序排列', () => {
    const opts = buildStageAssigneeOptions({
      users,
      currentUserId: 'u4',
      stageStats: {
        users: { u1: 2, u2: 7, u3: 5, u4: 0 },
        texts: { 外援小王: 6, 外援老李: 1 },
      },
    });

    expect(opts.map((o) => [o.label, o.count, o.isCurrentUser])).toEqual([
      ['大白', 0, true],
      ['小羽', 7, false],
      ['外援小王', 6, false],
      ['阿明', 5, false],
      ['小爱', 2, false],
      ['外援老李', 1, false],
    ]);
  });

  it('同名纯文本频次合并到对应项目用户中，不重复展示', () => {
    const opts = buildStageAssigneeOptions({
      users,
      currentUserId: 'u1',
      stageStats: {
        users: { u2: 2 },
        texts: { 小羽: 3 },
      },
    });

    expect(opts.map((o) => [o.label, o.count])).toEqual([
      ['小爱', 0],
      ['小羽', 5],
      ['阿明', 0],
      ['大白', 0],
    ]);
  });

  it('支持按输入关键词做大小写不敏感子串过滤', () => {
    const opts = buildStageAssigneeOptions({
      users: [
        { id: 'u1', displayName: 'Alice' },
        { id: 'u2', displayName: '小爱' },
      ],
      currentUserId: 'u2',
      filterText: 'ali',
    });

    expect(opts.map((o) => o.label)).toEqual(['Alice']);
  });
});

describe('resolveTypedAssignee', () => {
  const users = [
    { id: 'u1', displayName: '小爱' },
    { id: 'u2', displayName: 'Alice' },
  ];

  it('精确匹配项目用户显示名时解析为 user 负责人', () => {
    expect(resolveTypedAssignee('  alice ', users)).toEqual({ type: 'user', userId: 'u2' });
    expect(resolveTypedAssignee('小爱', users)).toEqual({ type: 'user', userId: 'u1' });
  });

  it('未匹配项目用户时解析为 text 负责人，空字符串返回 null', () => {
    expect(resolveTypedAssignee('外援小王', users)).toEqual({ type: 'text', name: '外援小王' });
    expect(resolveTypedAssignee('   ', users)).toBeNull();
  });
});
