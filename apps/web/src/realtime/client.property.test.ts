import { CLOSE_UNAUTHENTICATED, type RealtimeEventMessage } from '@nw/shared';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, type WebSocketLike } from './client.js';

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
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

type StreamOp =
  | { kind: 'event'; id: number }
  | { kind: 'resync'; cursor: number }
  | { kind: 'disconnect' };

const streamOpArb: fc.Arbitrary<StreamOp> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.integer({ min: 1, max: 500 }).map((id) => ({ kind: 'event' as const, id })),
  },
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: 1, max: 600 })
      .map((cursor) => ({ kind: 'resync' as const, cursor })),
  },
  { weight: 2, arbitrary: fc.constant({ kind: 'disconnect' as const }) },
);

describe('RealtimeClient 游标单调性与断线重连属性测试（fast-check）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('在任意事件重复、乱序、断线重连与 resync 序列下，游标只进不退且重复/过期事件必被丢弃', () => {
    const scope = { type: 'diag' as const, id: '00000000-0000-7000-8000-000000000001' };

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.array(streamOpArb, { minLength: 1, maxLength: 60 }),
        (initialCursor, ops) => {
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

          const deliveredIds: bigint[] = [];
          const resyncCursors: bigint[] = [];

          client.subscribe(scope, {
            onEvent: (ev: RealtimeEventMessage) => {
              deliveredIds.push(BigInt(ev.id));
            },
            onResync: (c: string) => {
              resyncCursors.push(BigInt(c));
            },
          });

          client.start();
          let activeSock = sockets[sockets.length - 1];
          expect(activeSock).toBeDefined();
          if (!activeSock) return;

          activeSock.open();
          activeSock.receive({ t: 'hello', connId: 'c-0', protocol: 1 });
          activeSock.receive({ t: 'subscribed', scope, cursor: String(initialCursor) });

          let expectedCursor = BigInt(initialCursor);
          let expectedDelivered = 0;
          let expectedResyncs = 0;

          for (let i = 0; i < ops.length; i += 1) {
            const op = ops[i];
            if (!op) continue;

            if (op.kind === 'event') {
              const id = BigInt(op.id);
              activeSock.receive({
                t: 'event',
                id: String(op.id),
                scope,
                type: 'diag.ping',
                payload: { message: `m-${i}` },
                actorUserId: null,
                at: '2026-11-25T00:00:00Z',
              });
              if (id > expectedCursor) {
                expectedCursor = id;
                expectedDelivered += 1;
              }
              expect(deliveredIds.length).toBe(expectedDelivered);
              expect(client.getCursor(scope)).toBe(String(expectedCursor));
            } else if (op.kind === 'resync') {
              // 服务端 resync 游标不小于当前游标
              const nextCursor =
                BigInt(op.cursor) >= expectedCursor ? BigInt(op.cursor) : expectedCursor;
              activeSock.receive({ t: 'resync', scope, cursor: String(nextCursor) });
              expectedCursor = nextCursor;
              expectedResyncs += 1;
              expect(resyncCursors.length).toBe(expectedResyncs);
              expect(client.getCursor(scope)).toBe(String(expectedCursor));
            } else if (op.kind === 'disconnect') {
              activeSock.serverClose(1006, 'network drop');
              vi.advanceTimersByTime(1_000);
              const nextSock = sockets[sockets.length - 1];
              expect(nextSock).toBeDefined();
              expect(nextSock).not.toBe(activeSock);
              if (!nextSock) break;
              activeSock = nextSock;
              activeSock.open();
              activeSock.receive({ t: 'hello', connId: `c-${i + 1}`, protocol: 1 });

              // 重连时必须携带精确的最新游标重新订阅
              const lastSub = activeSock.sent[activeSock.sent.length - 1];
              expect(lastSub).toEqual({
                t: 'subscribe',
                scope,
                cursor: String(expectedCursor),
              });
              activeSock.receive({ t: 'subscribed', scope, cursor: String(expectedCursor) });
            }
          }

          // 所有已投递事件 ID 必须严格递增
          for (let k = 1; k < deliveredIds.length; k += 1) {
            const prev = deliveredIds[k - 1];
            const curr = deliveredIds[k];
            expect(prev !== undefined && curr !== undefined && curr > prev).toBe(true);
          }

          client.stop();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('任意时间点收到 4401 后立即停机，不再创建新连接且 onAuthLost 仅触发一次', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), (normalDropsBefore4401) => {
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
        for (let i = 0; i < normalDropsBefore4401; i += 1) {
          const sock = sockets[sockets.length - 1];
          if (!sock) break;
          sock.open();
          sock.receive({ t: 'hello', connId: `c-${i}`, protocol: 1 });
          sock.serverClose(1006);
          vi.advanceTimersByTime(1_000);
        }

        const countBefore4401 = sockets.length;
        const lastSock = sockets[sockets.length - 1];
        expect(lastSock).toBeDefined();
        lastSock?.serverClose(CLOSE_UNAUTHENTICATED, 'session expired');

        vi.advanceTimersByTime(120_000);
        expect(onAuthLost).toHaveBeenCalledTimes(1);
        expect(sockets.length).toBe(countBefore4401);
        expect(client.getStatus()).toBe('disconnected');
        client.stop();
      }),
      { numRuns: 30 },
    );
  });
});
