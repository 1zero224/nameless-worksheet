import { randomBytes } from 'node:crypto';
import {
  CLOSE_PROTOCOL_ERROR,
  CLOSE_UNAUTHENTICATED,
  clientMessageSchema,
  REALTIME_PROTOCOL,
  type RealtimeEventMessage,
  type Role,
  type Scope,
  type ServerMessage,
  scopeKey,
} from '@nw/shared';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import type WebSocket from 'ws';
import { isSessionValid } from '../auth/session.js';
import type { Config } from '../config.js';
import { type Db, schema } from '../db/index.js';
import type { EventBus, StoredRealtimeEvent } from './bus.js';
import type { ScopeRegistry } from './scopes.js';

interface ScopeSubscriptionState {
  scope: Scope;
  buffering: boolean;
  buffer: StoredRealtimeEvent[];
}

interface ClientConnection {
  connId: string;
  socket: WebSocket;
  userId: string;
  projectId: string;
  sessionId: string;
  role: Role;
  subscriptions: Map<string, ScopeSubscriptionState>;
  closed: boolean;
}

export interface RealtimeHubOptions {
  heartbeatIntervalMs?: number;
}

export class RealtimeHub {
  private readonly connections = new Map<string, ClientConnection>();
  private readonly bySession = new Map<string, Set<ClientConnection>>();
  private readonly byUser = new Map<string, Set<ClientConnection>>();
  private readonly byScope = new Map<string, Set<ClientConnection>>();
  private readonly unsubBus: () => void;
  private readonly heartbeatTimer: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    bus: EventBus,
    private readonly scopes: ScopeRegistry,
    private readonly config: Config,
    opts: RealtimeHubOptions = {},
  ) {
    this.unsubBus = bus.subscribe((events) => {
      this.onEvents(events);
    });

    const intervalMs = opts.heartbeatIntervalMs ?? 25_000;
    this.heartbeatTimer = setInterval(() => {
      void this.runHeartbeat();
    }, intervalMs);
    this.heartbeatTimer.unref();
  }

  registerConnection(
    socket: WebSocket,
    auth: { userId: string; projectId: string; sessionId: string; role: Role },
  ): string {
    const connId = randomBytes(12).toString('base64url');
    const conn: ClientConnection = {
      connId,
      socket,
      userId: auth.userId,
      projectId: auth.projectId,
      sessionId: auth.sessionId,
      role: auth.role,
      subscriptions: new Map(),
      closed: false,
    };

    this.connections.set(connId, conn);
    addToMapSet(this.bySession, auth.sessionId, conn);
    addToMapSet(this.byUser, auth.userId, conn);

    socket.on('message', (raw) => {
      void this.handleMessage(conn, raw);
    });
    socket.on('close', () => {
      this.removeConnection(conn);
    });
    socket.on('error', () => {
      this.removeConnection(conn);
    });

    this.send(conn, { t: 'hello', connId, protocol: REALTIME_PROTOCOL });
    return connId;
  }

  closeSessions(sessionIds: string[]): void {
    for (const sid of sessionIds) {
      const conns = this.bySession.get(sid);
      if (!conns) continue;
      for (const conn of [...conns]) {
        this.closeConn(conn, CLOSE_UNAUTHENTICATED, '会话已失效');
      }
    }
  }

  async revalidateUser(userId: string, newRole: Role): Promise<void> {
    const conns = this.byUser.get(userId);
    if (!conns) return;
    for (const conn of [...conns]) {
      conn.role = newRole;
      for (const [key, state] of [...conn.subscriptions]) {
        const ok = await this.scopes.authorize(
          { userId: conn.userId, projectId: conn.projectId, role: conn.role },
          state.scope.type,
          state.scope.id,
        );
        if (!ok) {
          this.unsubscribeInternal(conn, key);
          this.send(conn, {
            t: 'error',
            code: 'FORBIDDEN',
            message: '无权订阅该范围',
            scope: state.scope,
          });
        }
      }
    }
  }

  closeAll(): void {
    clearInterval(this.heartbeatTimer);
    this.unsubBus();
    for (const conn of [...this.connections.values()]) {
      this.closeConn(conn, 1001, '服务关闭');
    }
  }

  private async runHeartbeat(): Promise<void> {
    const sessionIds = [...this.bySession.keys()];
    for (const sid of sessionIds) {
      let valid = false;
      try {
        valid = await isSessionValid(this.db, sid);
      } catch {
        // 数据库临时不可用时不误踢连接
        continue;
      }
      const conns = this.bySession.get(sid);
      if (!conns) continue;
      if (!valid) {
        for (const conn of [...conns]) {
          this.closeConn(conn, CLOSE_UNAUTHENTICATED, '会话已过期');
        }
      } else {
        for (const conn of conns) {
          this.send(conn, { t: 'hb' });
        }
      }
    }
  }

  private async handleMessage(conn: ClientConnection, raw: WebSocket.RawData): Promise<void> {
    if (conn.closed) return;
    let parsed: unknown;
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      parsed = JSON.parse(text);
    } catch {
      this.closeConn(conn, CLOSE_PROTOCOL_ERROR, '消息无法解析');
      return;
    }

    const msg = clientMessageSchema.safeParse(parsed);
    if (!msg.success) {
      this.closeConn(conn, CLOSE_PROTOCOL_ERROR, '协议错误');
      return;
    }

    const data = msg.data;
    if (data.t === 'presence') {
      // 阶段 2 使用，阶段 1 忽略
      return;
    }

    if (data.t === 'unsubscribe') {
      this.unsubscribeInternal(conn, scopeKey(data.scope));
      return;
    }

    if (data.t === 'subscribe') {
      await this.handleSubscribe(conn, data.scope, data.cursor);
    }
  }

  private async handleSubscribe(
    conn: ClientConnection,
    scope: Scope,
    cursorStr?: string,
  ): Promise<void> {
    const allowed = await this.scopes.authorize(
      { userId: conn.userId, projectId: conn.projectId, role: conn.role },
      scope.type,
      scope.id,
    );
    if (!allowed) {
      this.send(conn, {
        t: 'error',
        code: 'FORBIDDEN',
        message: '无权订阅该范围',
        scope,
      });
      return;
    }

    const key = scopeKey(scope);
    // 先把连接登记为订阅者并进入缓冲状态，避免查询与实时分发之间的竞态
    const state: ScopeSubscriptionState = {
      scope,
      buffering: true,
      buffer: [],
    };
    conn.subscriptions.set(key, state);
    addToMapSet(this.byScope, key, conn);

    try {
      const [projectRow] = await this.db
        .select({ prunedThrough: schema.projects.realtimePrunedThrough })
        .from(schema.projects)
        .where(eq(schema.projects.id, conn.projectId))
        .limit(1);

      const prunedThrough = projectRow?.prunedThrough ?? 0n;

      const [latestRow] = await this.db
        .select({ id: schema.realtimeEvents.id })
        .from(schema.realtimeEvents)
        .where(
          and(
            eq(schema.realtimeEvents.projectId, conn.projectId),
            eq(schema.realtimeEvents.scopeType, scope.type),
            eq(schema.realtimeEvents.scopeId, scope.id),
          ),
        )
        .orderBy(desc(schema.realtimeEvents.id))
        .limit(1);

      const head = latestRow ? latestRow.id : prunedThrough;
      let sentMaxId = head;

      if (conn.closed || conn.subscriptions.get(key) !== state) return;

      if (cursorStr === undefined) {
        this.send(conn, { t: 'subscribed', scope, cursor: head.toString() });
      } else {
        const cursor = BigInt(cursorStr);
        if (cursor < prunedThrough) {
          this.send(conn, { t: 'subscribed', scope, cursor: head.toString() });
          this.send(conn, { t: 'resync', scope, cursor: head.toString() });
        } else {
          const limit = this.config.realtimeReplayLimit;
          const rows = await this.db
            .select()
            .from(schema.realtimeEvents)
            .where(
              and(
                eq(schema.realtimeEvents.projectId, conn.projectId),
                eq(schema.realtimeEvents.scopeType, scope.type),
                eq(schema.realtimeEvents.scopeId, scope.id),
                gt(schema.realtimeEvents.id, cursor),
              ),
            )
            .orderBy(asc(schema.realtimeEvents.id))
            .limit(limit + 1);

          if (conn.closed || conn.subscriptions.get(key) !== state) return;

          if (rows.length > limit) {
            this.send(conn, { t: 'subscribed', scope, cursor: head.toString() });
            this.send(conn, { t: 'resync', scope, cursor: head.toString() });
          } else {
            this.send(conn, { t: 'subscribed', scope, cursor: head.toString() });
            sentMaxId = cursor;
            for (const row of rows) {
              if (row.originConnId && row.originConnId === conn.connId) {
                if (row.id > sentMaxId) sentMaxId = row.id;
                continue;
              }
              this.send(conn, toEventMessage(row, true));
              if (row.id > sentMaxId) sentMaxId = row.id;
            }
          }
        }
      }

      // 退出缓冲状态，把暂存的事件按编号升序发出，跳过 <= sentMaxId 的
      state.buffering = false;
      const buffered = state.buffer.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      state.buffer = [];
      for (const ev of buffered) {
        if (ev.id <= sentMaxId) continue;
        if (ev.originConnId && ev.originConnId === conn.connId) continue;
        this.send(conn, toStoredEventMessage(ev));
        sentMaxId = ev.id;
      }
    } catch {
      this.unsubscribeInternal(conn, key);
      this.send(conn, {
        t: 'error',
        code: 'INTERNAL',
        message: '订阅失败',
        scope,
      });
    }
  }

  private onEvents(events: StoredRealtimeEvent[]): void {
    for (const ev of events) {
      const key = scopeKey(ev.scope);
      const conns = this.byScope.get(key);
      if (!conns) continue;
      for (const conn of conns) {
        if (conn.closed) continue;
        if (conn.projectId !== ev.projectId) continue;
        if (ev.originConnId && ev.originConnId === conn.connId) continue;
        const state = conn.subscriptions.get(key);
        if (!state) continue;
        if (state.buffering) {
          state.buffer.push(ev);
        } else {
          this.send(conn, toStoredEventMessage(ev));
        }
      }
    }
  }

  private unsubscribeInternal(conn: ClientConnection, key: string): void {
    conn.subscriptions.delete(key);
    removeFromMapSet(this.byScope, key, conn);
  }

  private removeConnection(conn: ClientConnection): void {
    if (conn.closed) return;
    conn.closed = true;
    this.connections.delete(conn.connId);
    removeFromMapSet(this.bySession, conn.sessionId, conn);
    removeFromMapSet(this.byUser, conn.userId, conn);
    for (const key of conn.subscriptions.keys()) {
      removeFromMapSet(this.byScope, key, conn);
    }
    conn.subscriptions.clear();
  }

  private closeConn(conn: ClientConnection, code: number, reason: string): void {
    this.removeConnection(conn);
    try {
      if (
        conn.socket.readyState === conn.socket.OPEN ||
        conn.socket.readyState === conn.socket.CONNECTING
      ) {
        conn.socket.close(code, reason);
      }
    } catch {
      // ignore close errors
    }
  }

  private send(conn: ClientConnection, msg: ServerMessage): void {
    if (conn.closed || conn.socket.readyState !== conn.socket.OPEN) return;
    try {
      conn.socket.send(JSON.stringify(msg));
    } catch {
      this.removeConnection(conn);
    }
  }
}

function toEventMessage(
  row: typeof schema.realtimeEvents.$inferSelect,
  replayed: boolean,
): RealtimeEventMessage {
  return {
    t: 'event',
    id: row.id.toString(),
    scope: { type: row.scopeType, id: row.scopeId },
    type: row.type,
    payload: row.payload,
    actorUserId: row.actorUserId,
    at: row.createdAt.toISOString(),
    ...(replayed ? { replayed: true as const } : {}),
  };
}

function toStoredEventMessage(ev: StoredRealtimeEvent): RealtimeEventMessage {
  return {
    t: 'event',
    id: ev.id.toString(),
    scope: ev.scope,
    type: ev.type,
    payload: ev.payload,
    actorUserId: ev.actorUserId,
    at: ev.createdAt.toISOString(),
  };
}

function addToMapSet<K, V>(map: Map<K, Set<V>>, key: K, val: V): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(val);
}

function removeFromMapSet<K, V>(map: Map<K, Set<V>>, key: K, val: V): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(val);
  if (set.size === 0) map.delete(key);
}
