import type { UserListItem } from './api.js';
import { type Assignee, normalizeText } from './worksheet.js';

export interface StageAssigneeStats {
  /** 项目用户 userId -> 在该工序名下的接单频次 */
  users: Record<string, number>;
  /** 纯文本负责人名字 -> 在该工序名下的接单频次 */
  texts: Record<string, number>;
}

export interface StageAssigneeStatsResponse {
  /** 按规范化工序名分组的负责人接单频次 */
  byStageName: Record<string, StageAssigneeStats>;
}

export interface StageAssigneeOption {
  key: string;
  assignee: Assignee;
  label: string;
  count: number;
  isCurrentUser: boolean;
}

/**
 * 构建某道工序的负责人候选列表：
 * 1. 当前登录用户始终排在最前面；
 * 2. 其余项目用户与该工序下出现过的纯文本名字按接单频次降序排列；
 * 3. 频次相同时，项目用户优先于纯文本名字，再按原有顺序排列；
 * 4. 若输入了筛选关键词，则按人名做大小写不敏感子串过滤。
 */
export function buildStageAssigneeOptions(params: {
  users: readonly Pick<UserListItem, 'id' | 'displayName'>[];
  currentUserId?: string | null;
  stageStats?: StageAssigneeStats | null;
  filterText?: string;
}): StageAssigneeOption[] {
  const { users, currentUserId, stageStats, filterText = '' } = params;
  const userCounts = stageStats?.users ?? {};
  const textCounts = stageStats?.texts ?? {};

  const userNameLowerSet = new Set<string>();
  const textCountByLower = new Map<string, number>();
  for (const [name, cnt] of Object.entries(textCounts)) {
    const key = normalizeText(name).toLowerCase();
    if (!key || cnt <= 0) continue;
    textCountByLower.set(key, (textCountByLower.get(key) ?? 0) + cnt);
  }

  const items: Array<StageAssigneeOption & { order: number }> = [];

  users.forEach((u, idx) => {
    const lower = normalizeText(u.displayName).toLowerCase();
    userNameLowerSet.add(lower);
    const count = (userCounts[u.id] ?? 0) + (textCountByLower.get(lower) ?? 0);
    items.push({
      key: `u:${u.id}`,
      assignee: { type: 'user', userId: u.id },
      label: u.displayName,
      count,
      isCurrentUser: Boolean(currentUserId && u.id === currentUserId),
      order: idx,
    });
  });

  let textOrder = users.length;
  for (const [rawName, cnt] of Object.entries(textCounts)) {
    const name = normalizeText(rawName);
    if (!name || cnt <= 0) continue;
    if (userNameLowerSet.has(name.toLowerCase())) continue;
    items.push({
      key: `t:${name}`,
      assignee: { type: 'text', name },
      label: name,
      count: cnt,
      isCurrentUser: false,
      order: textOrder++,
    });
  }

  items.sort((a, b) => {
    if (a.isCurrentUser !== b.isCurrentUser) {
      return a.isCurrentUser ? -1 : 1;
    }
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    if (a.assignee.type !== b.assignee.type) {
      return a.assignee.type === 'user' ? -1 : 1;
    }
    return a.order - b.order;
  });

  const q = normalizeText(filterText).toLowerCase();
  const filtered = q ? items.filter((item) => item.label.toLowerCase().includes(q)) : items;
  return filtered.map(({ order: _order, ...rest }) => rest);
}

/**
 * 将输入框中键入的人名解析为负责人：
 * 若精确匹配（忽略首尾空白与大小写）某个项目用户的显示名，则关联为项目用户；否则作为纯文本名字。
 */
export function resolveTypedAssignee(
  rawInput: string,
  users: readonly Pick<UserListItem, 'id' | 'displayName'>[],
): Assignee | null {
  const trimmed = normalizeText(rawInput);
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const matched = users.find((u) => normalizeText(u.displayName).toLowerCase() === lower);
  if (matched) {
    return { type: 'user', userId: matched.id };
  }
  return { type: 'text', name: trimmed };
}
