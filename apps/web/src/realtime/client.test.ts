import { CLOSE_UNAUTHENTICATED, type RealtimeEventMessage } from '@nw/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, type WebSocketLike } from './client.js';

class FakeWebSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  sent: unknown[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

describe('RealtimeClient 单元测试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('心跳超时触发重连，退避序列按 1/2/5/10/30 秒递增', () => {
    const sockets: FakeWebSocket[] = [];
    const client = new RealtimeClient({
      url: 'ws://test/api/realtime',
      createWebSocket: () => {
        const s = new FakeWebSocket();
        sockets.push(s);
        return s;
      },
      heartbeatTimeoutMs: 60_000,
      jitterFn: () => 0,
    });

    client.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    sockets[0]!.receive({ t: 'hello', connId: 'c1', protocol: 1 });
    expect(client.getStatus()).toBe('connected');

    // 60 秒无消息触发心跳超时关闭并计划 1s 后重连
    vi.advanceTimersByTime(60_000);
    expect(sockets[0]!.closedWith?.reason).toBe('heartbeat timeout');
    expect(client.getStatus()).toBe('disconnected');

    // 退避 1s -> 第 2 次连接
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.serverClose(1006);

    // 退避 2s -> 第 3 次连接
    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    sockets[2]!.serverClose(1006);

    // 退避 5s -> 第 4 次连接
    vi.advanceTimersByTime(5_000);
    expect(sockets).toHaveLength(4);
    sockets[3]!.serverClose(1006);

    // 退避 10s -> 第 5 次连接
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(5);
    sockets[4]!.serverClose(1006);

    // 退避 30s -> 第 6 次连接
    vi.advanceTimersByTime(30_000);
    expect(sockets).toHaveLength(6);

    client.stop();
  });

  it('重连后带游标重新订阅，丢弃重复事件，resync 触发回调并更新游标', () => {
    const sockets: FakeWebSocket[] = [];
    const client = new RealtimeClient({
      url: 'ws://test/api/realtime',
      createWebSocket: () => {
        const s = new FakeWebSocket();
        sockets.push(s);
        return s;
      },
      jitterFn: () => 0,
    });

    const scope = { type: 'diag', id: '00000000-0000-7000-8000-000000000001' };
    const received: RealtimeEventMessage[] = [];
    const resyncs: string[] = [];

    client.subscribe(scope, {
      onEvent: (ev) => received.push(ev),
      onResync: (c) => resyncs.push(c),
    });

    client.start();
    sockets[0]!.open();
    sockets[0]!.receive({ t: 'hello', connId: 'c1', protocol: 1 });
    expect(sockets[0]!.sent[0]).toEqual({ t: 'subscribe', scope });

    sockets[0]!.receive({ t: 'subscribed', scope, cursor: '10' });
    // 收到事件 11 和重复的 11（应丢弃）
    sockets[0]!.receive({
      t: 'event',
      id: '11',
      scope,
      type: 'diag.ping',
      payload: { message: 'a' },
      actorUserId: null,
      at: '2026-11-15T00:00:00Z',
    });
    sockets[0]!.receive({
      t: 'event',
      id: '11',
      scope,
      type: 'diag.ping',
      payload: { message: 'dup' },
      actorUserId: null,
      at: '2026-11-15T00:00:00Z',
    });
    expect(received).toHaveLength(1);
    expect(client.getCursor(scope)).toBe('11');

    // 断线重连后应带游标 11 重新订阅
    sockets[0]!.serverClose(1006);
    vi.advanceTimersByTime(1_000);
    sockets[1]!.open();
    sockets[1]!.receive({ t: 'hello', connId: 'c2', protocol: 1 });
    expect(sockets[1]!.sent[0]).toEqual({ t: 'subscribe', scope, cursor: '11' });

    // 收到 resync
    sockets[1]!.receive({ t: 'resync', scope, cursor: '999' });
    expect(resyncs).toEqual(['999']);
    expect(client.getCursor(scope)).toBe('999');

    client.stop();
  });

  it('收到 4401 后不再重连并触发 onAuthLost', () => {
    const sockets: FakeWebSocket[] = [];
    const onAuthLost = vi.fn();
    const client = new RealtimeClient({
      url: 'ws://test/api/realtime',
      createWebSocket: () => {
        const s = new FakeWebSocket();
        sockets.push(s);
        return s;
      },
      jitterFn: () => 0,
      onAuthLost,
    });

    client.start();
    sockets[0]!.open();
    sockets[0]!.serverClose(CLOSE_UNAUTHENTICATED, '会话已失效');

    expect(onAuthLost).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('支持工作表在线状态（presence）发送与 snapshot/update/leave 回调', () => {
    const sockets: FakeWebSocket[] = [];
    const client = new RealtimeClient({
      url: 'ws://test/api/realtime',
      createWebSocket: () => {
        const s = new FakeWebSocket();
        sockets.push(s);
        return s;
      },
      jitterFn: () => 0,
    });

    const scope = { type: 'worksheet', id: '00000000-0000-7000-8000-000000000009' };
    const snapshots: unknown[] = [];
    const updates: unknown[] = [];
    const leaves: string[] = [];

    client.subscribe(scope, {
      onPresenceSnapshot: (peers) => snapshots.push(peers),
      onPresenceUpdate: (peer) => updates.push(peer),
      onPresenceLeave: (connId) => leaves.push(connId),
    });

    client.start();
    sockets[0]!.open();
    sockets[0]!.receive({ t: 'hello', connId: 'c1', protocol: 1 });
    sockets[0]!.receive({ t: 'subscribed', scope, cursor: '1' });

    const focus = {
      taskId: '00000000-0000-7000-8000-000000000010',
      columnKey: 'title',
      editing: true,
    };
    client.sendPresence(scope, focus);
    expect(sockets[0]!.sent[1]).toEqual({ t: 'presence', scope, focus });

    const peer = {
      connId: 'c2',
      userId: '00000000-0000-7000-8000-000000000020',
      displayName: '小陈',
      focus,
    };
    sockets[0]!.receive({ t: 'presence_snapshot', scope, peers: [peer] });
    sockets[0]!.receive({ t: 'presence_update', scope, peer: { ...peer, focus: null } });
    sockets[0]!.receive({ t: 'presence_leave', scope, connId: 'c2' });

    expect(snapshots).toEqual([[peer]]);
    expect(updates).toEqual([{ ...peer, focus: null }]);
    expect(leaves).toEqual(['c2']);

    client.stop();
  });
});
