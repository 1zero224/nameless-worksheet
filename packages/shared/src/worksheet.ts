import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { z } from 'zod';
import type { SearchDocItem, WorksheetArtifactSummary } from './artifact.js';

export { generateKeyBetween, generateNKeysBetween };

// 控制字符（C0、DEL、C1）以及行分隔符、段分隔符
// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要匹配控制字符
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const charCount = (s: string) => [...s].length;

export function normalizeText(s: string): string {
  return s.normalize('NFC').trim();
}

export function isValidCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [yStr, mStr, dStr] = s.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const httpUrlCheck = z.url({ protocol: /^https?$/ });

export function isValidHttpUrl(s: string): boolean {
  if (charCount(s) > 1000) return false;
  return httpUrlCheck.safeParse(s).success;
}

function requiredTextSchema(label: string, max: number) {
  return z
    .string({ error: `请填写${label}` })
    .transform(normalizeText)
    .pipe(
      z
        .string()
        .refine((s) => charCount(s) >= 1, { error: `请填写${label}` })
        .refine((s) => charCount(s) <= max, { error: `${label}最多 ${max} 个字符` })
        .refine((s) => !CONTROL_RE.test(s), { error: `${label}不能包含控制字符` }),
    );
}

function optionalTextSchema(label: string, max: number) {
  return z
    .string()
    .transform(normalizeText)
    .pipe(
      z
        .string()
        .refine((s) => charCount(s) <= max, { error: `${label}最多 ${max} 个字符` })
        .refine((s) => !CONTROL_RE.test(s), { error: `${label}不能包含控制字符` }),
    );
}

// ---- 常量与枚举 ----

export const DEFAULT_BOARD_COLUMN_NAMES = ['时轴', '翻译', '校对', '嵌字'] as const;

export const WORKSHEET_COLORS = [
  'slate',
  'red',
  'orange',
  'amber',
  'emerald',
  'teal',
  'sky',
  'blue',
  'indigo',
  'violet',
  'pink',
  'rose',
] as const;
export const worksheetColorSchema = z.enum(WORKSHEET_COLORS, { error: '颜色无效' });
export type WorksheetColor = z.infer<typeof worksheetColorSchema>;

export const WORKSHEET_COLOR_LABELS: Record<WorksheetColor, string> = {
  slate: '灰岩',
  red: '正红',
  orange: '橙色',
  amber: '琥珀',
  emerald: '翠绿',
  teal: '青绿',
  sky: '天蓝',
  blue: '深蓝',
  indigo: '靛蓝',
  violet: '紫罗兰',
  pink: '粉红',
  rose: '玫瑰红',
};

export const COLUMN_TYPES = ['stage', 'text', 'date', 'link'] as const;
export const columnTypeSchema = z.enum(COLUMN_TYPES, { error: '列类型无效' });
export type ColumnType = z.infer<typeof columnTypeSchema>;
export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  stage: '工序列',
  text: '文本',
  date: '日期',
  link: '链接',
};

export const PRIORITIES = ['normal', 'high', 'urgent'] as const;
export const prioritySchema = z.enum(PRIORITIES, { error: '优先级无效' });
export type Priority = z.infer<typeof prioritySchema>;
export const PRIORITY_LABELS: Record<Priority, string> = {
  normal: '普通',
  high: '高',
  urgent: '紧急',
};

export const PUBLISH_STATUSES = ['unpublished', 'published'] as const;
export const publishStatusSchema = z.enum(PUBLISH_STATUSES, { error: '发布状态无效' });
export type PublishStatus = z.infer<typeof publishStatusSchema>;
export const PUBLISH_STATUS_LABELS: Record<PublishStatus, string> = {
  unpublished: '未发布',
  published: '已发布',
};

export const STAGE_STATUSES = ['not_started', 'in_progress', 'done', 'na'] as const;
export const stageStatusSchema = z.enum(STAGE_STATUSES, { error: '工序状态无效' });
export type StageStatus = z.infer<typeof stageStatusSchema>;
export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  not_started: '未开始',
  in_progress: '进行中',
  done: '已完成',
  na: '不适用',
};

export const WORKSHEET_TEMPLATE_IDS = [
  'standard_video',
  'song_translation',
  'magazine_manga',
  'blank',
] as const;
export const worksheetTemplateSchema = z.enum(WORKSHEET_TEMPLATE_IDS, { error: '模板无效' });
export type WorksheetTemplateId = z.infer<typeof worksheetTemplateSchema>;

export interface WorksheetTemplateDef {
  id: WorksheetTemplateId;
  name: string;
  description: string;
  stageNames: readonly string[];
}

export const WORKSHEET_TEMPLATES: readonly WorksheetTemplateDef[] = [
  {
    id: 'standard_video',
    name: '标准视频',
    description: '时轴、翻译、校对、嵌字',
    stageNames: ['时轴', '翻译', '校对', '嵌字'],
  },
  {
    id: 'song_translation',
    name: '歌曲翻译',
    description: '日文歌词、全曲翻译、校对、润色',
    stageNames: ['日文歌词', '全曲翻译', '校对', '润色'],
  },
  {
    id: 'magazine_manga',
    name: '杂志 / 漫画',
    description: '翻译、校对、嵌字、排版',
    stageNames: ['翻译', '校对', '嵌字', '排版'],
  },
  {
    id: 'blank',
    name: '空白工作表',
    description: '无初始工序列，自由配置',
    stageNames: [],
  },
];

export const SYSTEM_COLUMN_KEYS = [
  'title',
  'work',
  'divisionNote',
  'priority',
  'publish',
  'files',
] as const;
export type SystemColumnKey = (typeof SYSTEM_COLUMN_KEYS)[number];

export const CHANGE_LOG_ACTIONS = [
  'task.created',
  'task.updated',
  'task.deleted',
  'task.restored',
  'stage.updated',
  'worksheet.created',
  'worksheet.updated',
  'worksheet.deleted',
  'column.created',
  'column.updated',
  'column.deleted',
  'board_column.updated',
  'work.ungrouped',
  'artifact.created',
  'artifact.updated',
  'artifact.deleted',
  'artifact.restored',
  'artifact_version.created',
  'artifact_version.deleted',
  'artifact_version.restored',
  'location.created',
  'location.updated',
  'location.deleted',
  'location.restored',
] as const;
export type ChangeLogAction = (typeof CHANGE_LOG_ACTIONS)[number];

// ---- 字段级校验 Schema ----

export const shortNameSchema = (label: string) => requiredTextSchema(label, 32);
export const boardColumnNameSchema = shortNameSchema('看板列名');
export const worksheetNameSchema = shortNameSchema('工作表名');
export const columnNameSchema = shortNameSchema('列名');
export const workNameSchema = requiredTextSchema('作品名', 80);
export const taskTitleSchema = requiredTextSchema('任务标题', 200);
export const divisionNoteSchema = optionalTextSchema('分工说明', 500);
export const stageNoteSchema = optionalTextSchema('工序备注', 200);

export const columnWidthSchema = z
  .number({ error: '列宽必须是数字' })
  .int({ error: '列宽必须是整数' })
  .min(80, { error: '列宽范围为 80–600' })
  .max(600, { error: '列宽范围为 80–600' });

export const nullableDateSchema = z
  .union([z.string(), z.null()])
  .transform((v) => {
    if (v === null) return null;
    const t = normalizeText(v);
    return t === '' ? null : t;
  })
  .pipe(
    z
      .string()
      .refine(isValidCalendarDate, { error: '日期格式应为 YYYY-MM-DD 且为合法日期' })
      .nullable(),
  );

export const nullableHttpUrlSchema = z
  .union([z.string(), z.null()])
  .transform((v) => {
    if (v === null) return null;
    const t = normalizeText(v);
    return t === '' ? null : t;
  })
  .pipe(
    z
      .string()
      .refine((s) => !CONTROL_RE.test(s), { error: '链接不能包含控制字符' })
      .refine(isValidHttpUrl, {
        error: '链接需为合法的 http:// 或 https:// 地址且不超过 1000 字符',
      })
      .nullable(),
  );

export const nullableCustomTextSchema = z
  .union([z.string(), z.null()])
  .transform((v) => {
    if (v === null) return null;
    const t = normalizeText(v);
    return t === '' ? null : t;
  })
  .pipe(
    z
      .string()
      .refine((s) => charCount(s) <= 500, { error: '文本最多 500 个字符' })
      .refine((s) => !CONTROL_RE.test(s), { error: '文本不能包含控制字符' })
      .nullable(),
  );

export const assigneeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), userId: z.uuid({ error: '用户 ID 无效' }) }),
  z.object({
    type: z.literal('text'),
    name: requiredTextSchema('负责人名字', 32),
  }),
]);
export type Assignee = z.infer<typeof assigneeSchema>;

export function dedupeAssignees(list: Assignee[]): Assignee[] {
  const seenUsers = new Set<string>();
  const seenTexts = new Set<string>();
  const out: Assignee[] = [];
  for (const item of list) {
    if (item.type === 'user') {
      if (seenUsers.has(item.userId)) continue;
      seenUsers.add(item.userId);
      out.push(item);
    } else {
      if (seenTexts.has(item.name)) continue;
      seenTexts.add(item.name);
      out.push(item);
    }
  }
  return out;
}

export const assigneesSchema = z
  .array(assigneeSchema)
  .max(20, { error: '单道工序最多 20 位负责人' })
  .transform(dedupeAssignees);

const systemColWidthOnlySchema = z.object({ width: columnWidthSchema.optional() });
const systemColConfigSchema = z.object({
  width: columnWidthSchema.optional(),
  hidden: z.boolean().optional(),
});

export const systemColumnsSchema = z.object({
  title: systemColWidthOnlySchema.optional(),
  work: systemColConfigSchema.optional(),
  divisionNote: systemColConfigSchema.optional(),
  priority: systemColConfigSchema.optional(),
  publish: systemColConfigSchema.optional(),
  files: systemColConfigSchema.optional(),
});
export type SystemColumnsConfig = z.infer<typeof systemColumnsSchema>;

// ---- HTTP 请求体 Schema ----

export const createBoardColumnBodySchema = z.object({
  name: boardColumnNameSchema,
});
export const updateBoardColumnBodySchema = z.object({
  name: boardColumnNameSchema,
});
export const reorderIdsBodySchema = z.object({
  orderedIds: z.array(z.uuid()).min(1, { error: '排序列表不能为空' }),
});

export const createWorksheetBodySchema = z.object({
  name: worksheetNameSchema,
  color: worksheetColorSchema.default('sky'),
  template: worksheetTemplateSchema.default('standard_video'),
});

export const updateWorksheetBodySchema = z.object({
  name: worksheetNameSchema.optional(),
  color: worksheetColorSchema.optional(),
  systemColumns: systemColumnsSchema.optional(),
});

export const createWorkBodySchema = z.object({
  name: workNameSchema,
});
export const updateWorkBodySchema = z.object({
  name: workNameSchema,
});

export const createColumnBodySchema = z.object({
  name: columnNameSchema,
  type: columnTypeSchema,
  boardColumnId: z.uuid().nullable().optional(),
  width: columnWidthSchema.optional(),
});

export const updateColumnBodySchema = z.object({
  name: columnNameSchema.optional(),
  width: columnWidthSchema.optional(),
  hidden: z.boolean().optional(),
  boardColumnId: z.uuid().nullable().optional(),
});

const nullableWorkNameSchema = z
  .union([z.string(), z.null()])
  .transform((v) => {
    if (v === null) return null;
    const t = normalizeText(v);
    return t === '' ? null : t;
  })
  .pipe(
    z
      .string()
      .refine((s) => charCount(s) <= 80, { error: '作品名最多 80 个字符' })
      .refine((s) => !CONTROL_RE.test(s), { error: '作品名不能包含控制字符' })
      .nullable(),
  );

export const createTaskBodySchema = z.object({
  title: taskTitleSchema,
  workId: z.uuid().nullable().optional(),
  workName: nullableWorkNameSchema.optional(),
  divisionNote: divisionNoteSchema.optional(),
  priority: prioritySchema.optional(),
  afterTaskId: z.uuid().nullable().optional(),
  beforeTaskId: z.uuid().nullable().optional(),
});

export const taskEditableChangesSchema = z.object({
  title: taskTitleSchema.optional(),
  workId: z.uuid().nullable().optional(),
  workName: nullableWorkNameSchema.optional(),
  divisionNote: divisionNoteSchema.optional(),
  priority: prioritySchema.optional(),
  publishStatus: publishStatusSchema.optional(),
  publishedAt: nullableDateSchema.optional(),
  publishUrl: nullableHttpUrlSchema.optional(),
  customValues: z.record(z.uuid(), z.union([z.string(), z.null()])).optional(),
});

export const taskBaseValuesSchema = z.object({
  title: z.string().optional(),
  workId: z.uuid().nullable().optional(),
  divisionNote: z.string().optional(),
  priority: prioritySchema.optional(),
  publishStatus: publishStatusSchema.optional(),
  publishedAt: z.string().nullable().optional(),
  publishUrl: z.string().nullable().optional(),
  customValues: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
});

export const patchTaskBodySchema = z.object({
  changes: taskEditableChangesSchema,
  baseValues: taskBaseValuesSchema.optional(),
  force: z.boolean().optional(),
});

export const reorderTaskBodySchema = z.object({
  taskId: z.uuid(),
  afterTaskId: z.uuid().nullable().optional(),
  beforeTaskId: z.uuid().nullable().optional(),
});

export const patchStageCellBodySchema = z.object({
  assignees: assigneesSchema.optional(),
  status: stageStatusSchema.optional(),
  note: stageNoteSchema.optional(),
  baseRevision: z.number().int().min(0),
  force: z.boolean().optional(),
});

// ---- DTO 类型 ----

export interface BoardColumn {
  id: string;
  name: string;
  sortOrder: string;
  createdAt: string;
  updatedAt: string;
}

export interface Worksheet {
  id: string;
  name: string;
  color: WorksheetColor;
  sortOrder: string;
  systemColumns: SystemColumnsConfig;
  createdAt: string;
  updatedAt: string;
}

export interface WorksheetSummary extends Worksheet {
  totalTaskCount: number;
  unpublishedTaskCount: number;
}

export interface ColumnConfig {
  id: string;
  worksheetId: string;
  name: string;
  type: ColumnType;
  sortOrder: string;
  width: number;
  hidden: boolean;
  boardColumnId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Work {
  id: string;
  worksheetId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface StageCell {
  id: string | null;
  taskId: string;
  columnId: string;
  assignees: Assignee[];
  status: StageStatus;
  note: string;
  revision: number;
  updatedAt: string | null;
}

export interface TaskDetail {
  id: string;
  worksheetId: string;
  workId: string | null;
  title: string;
  divisionNote: string;
  priority: Priority;
  publishStatus: PublishStatus;
  publishedAt: string | null;
  publishUrl: string | null;
  customValues: Record<string, string | null>;
  sortOrder: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  stageCells: Record<string, StageCell>;
}

export interface WorksheetFullResponse {
  worksheet: Worksheet;
  columns: ColumnConfig[];
  works: Work[];
  tasks: TaskDetail[];
  boardColumns: BoardColumn[];
  artifactSummary: WorksheetArtifactSummary;
}

export interface FieldConflictItem {
  field: string;
  currentValue: unknown;
  revision: number;
  updatedByDisplayName: string | null;
}

export interface FieldConflictDetails {
  conflicts: FieldConflictItem[];
}

export interface StageConflictDetails {
  currentCell: StageCell;
  updatedByDisplayName: string | null;
}

export interface ChangeLogDiff {
  field: string;
  label: string;
  from: unknown;
  to: unknown;
}

export interface ChangeLogItem {
  id: string;
  worksheetId: string | null;
  taskId: string | null;
  artifactId?: string | null;
  actor: { id: string; displayName: string };
  action: ChangeLogAction;
  summary: string;
  changes: Record<string, unknown>;
  createdAt: string;
  canRestore?: boolean;
  wasRestored?: boolean;
}

export interface ChangeLogsResponse {
  items: ChangeLogItem[];
  nextCursor: string | null;
}

export interface BoardStageSummary {
  columnId: string;
  name: string;
  status: StageStatus;
  boardColumnId: string | null;
}

export interface BoardCard {
  boardColumnId: string;
  stageColumnId: string;
  stageColumnName: string;
  stageStatus: StageStatus;
  stageAssignees: Assignee[];
  stageNote: string;
  stageRevision: number;
  taskId: string;
  taskTitle: string;
  divisionNote: string;
  priority: Priority;
  worksheetId: string;
  worksheetName: string;
  worksheetColor: WorksheetColor;
  workId: string | null;
  workName: string | null;
  missingStages: Array<{ columnId: string; name: string }>;
  stageProgress: BoardStageSummary[];
  resourceCount?: number;
}

export interface MyTaskItem {
  taskId: string;
  taskTitle: string;
  divisionNote: string;
  priority: Priority;
  publishStatus: PublishStatus;
  worksheetId: string;
  worksheetName: string;
  worksheetColor: WorksheetColor;
  workId: string | null;
  workName: string | null;
  stageColumnId: string;
  stageColumnName: string;
  stageStatus: StageStatus;
  stageAssignees: Assignee[];
  stageNote: string;
  stageRevision: number;
  resourceCount?: number;
}

export interface BoardResponse {
  boardColumns: BoardColumn[];
  worksheets: WorksheetSummary[];
  works: Work[];
  cards: BoardCard[];
  myInProgress: MyTaskItem[];
  myPending: MyTaskItem[];
  myPendingCount: number;
}

export interface MyTasksResponse {
  inProgress: MyTaskItem[];
  notStarted: MyTaskItem[];
  completed: MyTaskItem[];
}

export interface SearchTaskItem {
  taskId: string;
  taskTitle: string;
  divisionNote: string;
  priority: Priority;
  publishStatus: PublishStatus;
  worksheetId: string;
  worksheetName: string;
  worksheetColor: WorksheetColor;
  workId: string | null;
  workName: string | null;
  stages: Array<{
    columnId: string;
    name: string;
    status: StageStatus;
    assignees: Assignee[];
    assigneeNames: string[];
    note: string;
  }>;
  matchedArtifactNames?: string[];
}

export interface SearchResponse {
  items: SearchTaskItem[];
  total: number;
  docs: SearchDocItem[];
}
