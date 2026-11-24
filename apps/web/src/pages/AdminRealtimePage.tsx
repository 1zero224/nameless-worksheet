import type { DiagPingPayload } from '@nw/shared';
import { useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { useMe } from '@/app/AuthContext.js';
import { Alert, Badge, Button, Card, Input } from '@/components/ui/primitives.js';
import {
  useRealtimeClient,
  useRealtimeCursor,
  useRealtimeScope,
  useRealtimeStatus,
} from '@/realtime/context.js';

interface DiagLogEntry {
  key: string;
  kind: 'event' | 'resync';
  id: string;
  type: string;
  content: string;
  actorUserId: string | null;
  replayed: boolean;
  at: string;
}

const STATUS_LABELS = {
  connected: { label: '已连接', variant: 'success' as const },
  connecting: { label: '连接中', variant: 'warning' as const },
  disconnected: { label: '已断开', variant: 'danger' as const },
  paused: { label: '已模拟断线', variant: 'muted' as const },
};

export function AdminRealtimePage() {
  const { data: me } = useMe();
  const client = useRealtimeClient();
  const { status, connId } = useRealtimeStatus();
  const scope = me ? { type: 'diag', id: me.project.id } : null;
  const cursor = useRealtimeCursor(scope);

  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'error' | 'info'; text: string } | null>(null);
  const [logs, setLogs] = useState<DiagLogEntry[]>([]);

  useRealtimeScope(scope, {
    onEvent: (ev) => {
      const payload = ev.payload as Partial<DiagPingPayload> | null;
      setLogs((prev) => [
        {
          key: `ev-${ev.id}`,
          kind: 'event',
          id: ev.id,
          type: ev.type,
          content: payload?.message ?? JSON.stringify(ev.payload),
          actorUserId: ev.actorUserId,
          replayed: Boolean(ev.replayed),
          at: ev.at,
        },
        ...prev,
      ]);
    },
    onResync: (nextCursor) => {
      setLogs((prev) => [
        {
          key: `resync-${Date.now()}-${nextCursor}`,
          kind: 'resync',
          id: nextCursor,
          type: 'resync',
          content: `收到整体刷新指令，游标已重置为 ${nextCursor}`,
          actorUserId: null,
          replayed: false,
          at: new Date().toISOString(),
        },
        ...prev,
      ]);
    },
  });

  const onSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) return;
    setSending(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ eventId: string }>('/api/diag/realtime-test', {
        method: 'POST',
        body: { message: trimmed },
      });
      setMessage('');
      setFeedback({ type: 'info', text: `已发送测试事件（编号 #${res.eventId}）` });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : '发送失败',
      });
    } finally {
      setSending(false);
    }
  };

  const badge = STATUS_LABELS[status];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">实时通道诊断</h1>

      <Card className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <div className="text-xs text-slate-500">连接状态</div>
            <div className="mt-1">
              <Badge variant={badge.variant}>{badge.label}</Badge>
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">连接标识（connId）</div>
            <div className="mt-1 font-mono text-xs text-slate-800" data-testid="diag-conn-id">
              {connId ?? '-'}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">diag 范围当前游标</div>
            <div className="mt-1 font-mono text-xs text-slate-800" data-testid="diag-cursor">
              {cursor ?? '-'}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => client.pause()} disabled={status === 'paused'}>
            模拟断线
          </Button>
          <Button variant="primary" onClick={() => client.resume()} disabled={status !== 'paused'}>
            恢复连接
          </Button>
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-base font-medium text-slate-900">发送测试事件</h2>
        {feedback && <Alert variant={feedback.type}>{feedback.text}</Alert>}
        <form onSubmit={onSend} className="flex flex-col gap-2 sm:flex-row">
          <Input
            placeholder="输入测试消息（1–200 字符）"
            maxLength={200}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            aria-label="测试事件内容"
          />
          <Button type="submit" disabled={sending || !message.trim()} className="shrink-0">
            {sending ? '发送中…' : '发送测试事件'}
          </Button>
        </form>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-base font-medium text-slate-900">事件日志（倒序）</h2>
        {logs.length === 0 ? (
          <p className="text-sm text-slate-500">尚未收到实时事件</p>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="diag-event-log">
            {logs.map((item) => (
              <li
                key={item.key}
                className={
                  item.kind === 'resync'
                    ? 'my-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900'
                    : 'py-2.5 text-sm'
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-slate-700">#{item.id}</span>
                  <Badge variant={item.kind === 'resync' ? 'warning' : 'default'}>
                    {item.type}
                  </Badge>
                  {item.replayed && <Badge variant="success">补发</Badge>}
                  <span className="text-xs text-slate-400">
                    {new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })}
                  </span>
                </div>
                <div className="mt-1 text-slate-900">{item.content}</div>
                {item.actorUserId && (
                  <div className="mt-0.5 font-mono text-xs text-slate-400">
                    发送人：{item.actorUserId}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
