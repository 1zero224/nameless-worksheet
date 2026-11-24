import { z } from 'zod';

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

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('subscribe'), scope: scopeSchema, cursor: cursorSchema.optional() }),
  z.object({ t: z.literal('unsubscribe'), scope: scopeSchema }),
  z.looseObject({ t: z.literal('presence') }),
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
  | { t: 'hb' };

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
