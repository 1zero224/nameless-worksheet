import { z } from 'zod';
import type { ColumnConfig, StageCell, TaskDetail, Work, Worksheet } from './worksheet.js';

export const REALTIME_PROTOCOL = 1;

/** 关闭代码 */
export const CLOSE_UNAUTHENTICATED = 4401;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_PROTOCOL_ERROR = 4400;

export const scopeSchema = z.object({
  type: z.string().min(1).max(32),
  id: z.uuid(),
});
export type Scope = z.infer<typeof scopeSchema>;

/** 事件编号与游标：十进制字符串 */
export const cursorSchema = z.string().regex(/^\d{1,19}$/);

export const presenceFocusSchema = z.object({
  taskId: z.uuid(),
  columnKey: z.string().min(1).max(64),
  editing: z.boolean(),
});
export type PresenceFocus = z.infer<typeof presenceFocusSchema>;

export interface PresencePeer {
  connId: string;
  userId: string;
  displayName: string;
  focus: PresenceFocus | null;
}

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('subscribe'), scope: scopeSchema, cursor: cursorSchema.optional() }),
  z.object({ t: z.literal('unsubscribe'), scope: scopeSchema }),
  z.object({
    t: z.literal('presence'),
    scope: scopeSchema,
    focus: presenceFocusSchema.nullable(),
  }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export interface RealtimeEventMessage {
  t: 'event';
  id: string;
  scope: Scope;
  type: string;
  payload: unknown;
  actorUserId: string | null;
  at: string;
  /** 补发得到的事件带此标记（诊断用） */
  replayed?: true;
}

export type ServerMessage =
  | { t: 'hello'; connId: string; protocol: typeof REALTIME_PROTOCOL }
  | { t: 'subscribed'; scope: Scope; cursor: string }
  | RealtimeEventMessage
  | { t: 'resync'; scope: Scope; cursor: string }
  | { t: 'error'; code: string; message: string; scope?: Scope }
  | { t: 'hb' }
  | { t: 'presence_snapshot'; scope: Scope; peers: PresencePeer[] }
  | { t: 'presence_update'; scope: Scope; peer: PresencePeer }
  | { t: 'presence_leave'; scope: Scope; connId: string };

export function scopeKey(scope: Scope): string {
  return `${scope.type}:${scope.id}`;
}

export interface UserUpdatedPayload {
  userId: string;
}
export interface DiagPingPayload {
  message: string;
  sentAt: string;
}

// ---- 阶段 2 project 范围事件 ----

export interface WorksheetChangedPayload {
  worksheetId?: string;
  action: 'created' | 'updated' | 'deleted' | 'reordered';
}

export interface BoardColumnsChangedPayload {
  action: 'created' | 'updated' | 'deleted' | 'reordered';
}

export interface BoardTaskChangedPayload {
  worksheetId: string;
  taskId?: string;
  action: string;
}

// ---- 阶段 2 worksheet 范围事件 ----

export interface TaskCreatedPayload {
  task: TaskDetail;
  work?: Work | null;
}

export interface TaskUpdatedPayload {
  taskId: string;
  revision: number;
  patch: Partial<Omit<TaskDetail, 'stageCells' | 'id' | 'worksheetId' | 'createdAt'>>;
  work?: Work | null;
  actorDisplayName: string;
}

export interface TaskDeletedPayload {
  taskId: string;
}

export interface TaskRestoredPayload {
  task: TaskDetail;
  work?: Work | null;
}

export interface TasksReorderedPayload {
  updates: Array<{ taskId: string; sortOrder: string }>;
}

export interface StageUpdatedPayload {
  taskId: string;
  columnId: string;
  cell: StageCell;
  actorDisplayName: string;
}

export interface ColumnChangedPayload {
  action: 'created' | 'updated' | 'deleted' | 'reordered';
  column?: ColumnConfig;
  columnId?: string;
  columns?: ColumnConfig[];
}

export interface WorksheetUpdatedPayload {
  worksheet: Worksheet;
}

export interface WorksheetDeletedPayload {
  worksheetId: string;
}

export interface WorkUpdatedPayload {
  work: Work;
}
