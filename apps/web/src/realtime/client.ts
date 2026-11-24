import {
  CLOSE_UNAUTHENTICATED,
  type RealtimeEventMessage,
  type Scope,
  type ServerMessage,
  scopeKey,
} from '@nw/shared';

export type RealtimeStatus = 'disconnected' | 'connecting' | 'connected' | 'paused';

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface ScopeHandlers {
  onSubscribed?: (cursor: string) => void;
  onEvent?: (event: RealtimeEventMessage) => void;
  onResync?: (cursor: string) => void;
  onError?: (code: string, message: string) => void;
}

export interface RealtimeClientOptions {
  url: string;
  createWebSocket?: (url: string) => WebSocketLike;
  heartbeatTimeoutMs?: number;
  backoffMs?: number[];
  jitterFn?: () => number;
  onAuthLost?: () => void;
}

interface ScopeEntry {
  scope: Scope;
  cursor: string | null;
  handlers: Set<ScopeHandlers>;
  subscribedWaiters: Array<(cursor: string) => void>;
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const WS_OPEN = 1;

export class RealtimeClient {
  private readonly url: string;
  private readonly createWs: (url: string) => WebSocketLike;
  private readonly heartbeatTimeoutMs: number;
  private readonly backoffMs: number[];
  private readonly jitterFn: () => number;
  private onAuthLost?: () => void;

  private ws: WebSocketLike | null = null;
  private status: RealtimeStatus = 'disconnected';
  private connId: string | null = null;
  private attempt = 0;
  private stopped = true;
  private paused = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly scopes = new Map<string, ScopeEntry>();
  private readonly stateListeners = new Set<() => void>();

  constructor(opts: RealtimeClientOptions) {
    this.url = opts.url;
    this.createWs = opts.createWebSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 60_000;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.jitterFn = opts.jitterFn ?? (() => Math.floor(Math.random() * 1000));
    this.onAuthLost = opts.onAuthLost;
  }

  setOnAuthLost(fn: () => void): void {
    this.onAuthLost = fn;
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  getConnId(): string | null {
    return this.connId;
  }

  getCursor(scope: Scope): string | null {
    return this.scopes.get(scopeKey(scope))?.cursor ?? null;
  }

  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  start(): void {
    this.stopped = false;
    this.paused = false;
    if (this.ws && (this.status === 'connecting' || this.status === 'connected')) return;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.paused = false;
    this.clearTimers();
    this.connId = null;
    if (this.ws) {
      const sock = this.ws;
      this.ws = null;
      sock.onclose = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onopen = null;
      try {
        sock.close(1000, 'client stop');
      } catch {
        // ignore
      }
    }
    this.setStatus('disconnected');
  }

  /** 诊断页“模拟断线”：主动断开并暂停自动重连 */
  pause(): void {
    this.paused = true;
    this.clearTimers();
    this.connId = null;
    if (this.ws) {
      const sock = this.ws;
      this.ws = null;
      sock.onclose = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onopen = null;
      try {
        sock.close(1000, 'simulated disconnect');
      } catch {
        // ignore
      }
    }
    this.setStatus('paused');
  }

  /** 诊断页“恢复连接” */
  resume(): void {
    if (this.stopped) return;
    this.paused = false;
    this.attempt = 0;
    this.connect();
  }

  /** 页面切回前台或网络恢复时立即重试 */
  retryNow(): void {
    if (this.stopped || this.paused) return;
    if (this.status === 'connected' || this.status === 'connecting') return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  subscribe(scope: Scope, handlers: ScopeHandlers): () => void {
    const key = scopeKey(scope);
    let entry = this.scopes.get(key);
    const isNew = !entry;
    if (!entry) {
      entry = { scope, cursor: null, handlers: new Set(), subscribedWaiters: [] };
      this.scopes.set(key, entry);
    }
    entry.handlers.add(handlers);

    if (isNew && this.status === 'connected' && this.ws?.readyState === WS_OPEN) {
      this.sendSubscribe(entry);
    }

    return () => {
      const current = this.scopes.get(key);
      if (!current) return;
      current.handlers.delete(handlers);
      if (current.handlers.size === 0) {
        this.scopes.delete(key);
        if (this.ws?.readyState === WS_OPEN) {
          this.ws.send(JSON.stringify({ t: 'unsubscribe', scope }));
        }
      }
    };
  }

  /** 等待某范围收到 subscribed 后再拉取 HTTP 初始数据 */
  waitForSubscribed(scope: Scope): Promise<string> {
    const key = scopeKey(scope);
    const entry = this.scopes.get(key);
    if (!entry) return Promise.resolve('0');
    if (entry.cursor !== null && this.status === 'connected') {
      return Promise.resolve(entry.cursor);
    }
    return new Promise((resolve) => {
      entry.subscribedWaiters.push(resolve);
    });
  }

  private connect(): void {
    if (this.stopped || this.paused) return;
    this.clearTimers();
    this.setStatus('connecting');

    let sock: WebSocketLike;
    try {
      sock = this.createWs(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = sock;

    sock.onopen = () => {
      if (this.ws !== sock) return;
      this.resetHeartbeatTimer();
    };

    sock.onmessage = (ev) => {
      if (this.ws !== sock) return;
      this.resetHeartbeatTimer();
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    sock.onerror = () => {
      // onclose 会紧随其后处理重连
    };

    sock.onclose = (ev) => {
      if (this.ws !== sock) return;
      this.ws = null;
      this.connId = null;
      this.clearTimers();

      if (ev.code === CLOSE_UNAUTHENTICATED) {
        this.stopped = true;
        this.setStatus('disconnected');
        this.onAuthLost?.();
        return;
      }

      if (this.paused) {
        this.setStatus('paused');
        return;
      }

      this.setStatus('disconnected');
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    };
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.t === 'hb') return;

    if (msg.t === 'hello') {
      this.connId = msg.connId;
      this.attempt = 0;
      this.setStatus('connected');
      for (const entry of this.scopes.values()) {
        this.sendSubscribe(entry);
      }
      return;
    }

    if (msg.t === 'subscribed') {
      const entry = this.scopes.get(scopeKey(msg.scope));
      if (!entry) return;
      // 首次无游标订阅时记录服务端游标；带游标补发时保持原游标，等补发事件推进
      if (entry.cursor === null) {
        entry.cursor = msg.cursor;
      }
      const waiters = entry.subscribedWaiters.splice(0);
      for (const resolve of waiters) resolve(msg.cursor);
      for (const h of entry.handlers) h.onSubscribed?.(msg.cursor);
      this.notifyState();
      return;
    }

    if (msg.t === 'event') {
      const entry = this.scopes.get(scopeKey(msg.scope));
      if (!entry) return;
      if (entry.cursor !== null && BigInt(msg.id) <= BigInt(entry.cursor)) {
        return; // 丢弃重复或过期事件
      }
      entry.cursor = msg.id;
      for (const h of entry.handlers) h.onEvent?.(msg);
      this.notifyState();
      return;
    }

    if (msg.t === 'resync') {
      const entry = this.scopes.get(scopeKey(msg.scope));
      if (!entry) return;
      entry.cursor = msg.cursor;
      for (const h of entry.handlers) h.onResync?.(msg.cursor);
      this.notifyState();
      return;
    }

    if (msg.t === 'error' && msg.scope) {
      const entry = this.scopes.get(scopeKey(msg.scope));
      if (!entry) return;
      for (const h of entry.handlers) h.onError?.(msg.code, msg.message);
    }
  }

  private sendSubscribe(entry: ScopeEntry): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    const payload =
      entry.cursor !== null
        ? { t: 'subscribe', scope: entry.scope, cursor: entry.cursor }
        : { t: 'subscribe', scope: entry.scope };
    this.ws.send(JSON.stringify(payload));
  }

  private resetHeartbeatTimer(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (!this.ws) return;
      const sock = this.ws;
      this.ws = null;
      this.connId = null;
      try {
        sock.close(4000, 'heartbeat timeout');
      } catch {
        // ignore
      }
      this.setStatus('disconnected');
      if (!this.stopped && !this.paused) {
        this.scheduleReconnect();
      }
    }, this.heartbeatTimeoutMs);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.paused) return;
    const idx = Math.min(this.attempt, this.backoffMs.length - 1);
    const base = this.backoffMs[idx] ?? 30_000;
    this.attempt += 1;
    const delay = base + this.jitterFn();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private setStatus(next: RealtimeStatus): void {
    this.status = next;
    this.notifyState();
  }

  private notifyState(): void {
    for (const listener of this.stateListeners) {
      listener();
    }
  }
}
