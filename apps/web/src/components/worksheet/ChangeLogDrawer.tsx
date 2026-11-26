import type { ChangeLogDiff, ChangeLogItem, ChangeLogsResponse } from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { invalidateArtifactQueries } from '@/components/artifact/utils.js';
import { Sheet, useToast } from '@/components/ui/overlays.js';
import { Badge, Button } from '@/components/ui/primitives.js';

function formatVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '（空）';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

type RestoreTarget =
  | { kind: 'task'; id: string }
  | { kind: 'artifact'; id: string }
  | { kind: 'version'; id: string };

function getRestoreTarget(item: ChangeLogItem): RestoreTarget | null {
  if (item.action === 'task.deleted' && item.taskId) {
    return { kind: 'task', id: item.taskId };
  }
  if (item.action === 'artifact.deleted') {
    const id =
      item.artifactId ??
      (typeof item.changes?.artifactId === 'string' ? item.changes.artifactId : null);
    if (id) return { kind: 'artifact', id };
  }
  if (item.action === 'artifact_version.deleted') {
    const id = typeof item.changes?.versionId === 'string' ? item.changes.versionId : null;
    if (id) return { kind: 'version', id };
  }
  return null;
}

export function ChangeLogDrawer({
  worksheetId,
  mode = 'worksheet',
  open,
  onOpenChange,
}: {
  worksheetId?: string;
  mode?: 'worksheet' | 'docs';
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [extraItems, setExtraItems] = useState<ChangeLogItem[]>([]);
  const [extraCursor, setExtraCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const isDocsMode = mode === 'docs';
  const baseUrl = isDocsMode
    ? '/api/docs/change-logs'
    : `/api/worksheets/${worksheetId ?? ''}/change-logs`;

  const { data, isLoading, refetch } = useQuery<ChangeLogsResponse>({
    queryKey: isDocsMode
      ? queryKeys.docsChangeLogs
      : queryKeys.changeLogs(worksheetId ?? 'none', null),
    queryFn: async () => {
      setExtraItems([]);
      setExtraCursor(null);
      return apiFetch<ChangeLogsResponse>(`${baseUrl}?limit=50`);
    },
    enabled: Boolean(open && (isDocsMode || worksheetId)),
  });

  const restoreMutation = useMutation({
    mutationFn: (target: RestoreTarget) => {
      if (target.kind === 'task') {
        return apiFetch(`/api/tasks/${target.id}/restore`, { method: 'POST' });
      }
      if (target.kind === 'artifact') {
        return apiFetch(`/api/artifacts/${target.id}/restore`, { method: 'POST' });
      }
      return apiFetch(`/api/artifact-versions/${target.id}/restore`, { method: 'POST' });
    },
    onSuccess: (_res, target) => {
      const label =
        target.kind === 'task'
          ? '任务已从修改记录恢复'
          : target.kind === 'artifact'
            ? '资源已从修改记录恢复'
            : '版本已从修改记录恢复';
      pushToast({ message: label, variant: 'success' });
      if (worksheetId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.worksheet(worksheetId) });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
      invalidateArtifactQueries(queryClient, { worksheetId: worksheetId ?? null });
      void refetch();
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '恢复失败',
        variant: 'error',
      });
    },
  });

  const allItems = [...(data?.items ?? []), ...extraItems];
  const nextCursor = extraItems.length > 0 ? extraCursor : (data?.nextCursor ?? null);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await apiFetch<ChangeLogsResponse>(`${baseUrl}?limit=50&cursor=${nextCursor}`);
      setExtraItems((prev) => [...prev, ...res.items]);
      setExtraCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={isDocsMode ? '通用文档修改记录' : '修改记录'}
    >
      {isLoading ? (
        <div className="py-10 text-center text-sm text-slate-500">正在加载修改记录…</div>
      ) : allItems.length === 0 ? (
        <div className="py-10 text-center text-sm text-slate-500">暂无修改记录</div>
      ) : (
        <div className="space-y-3" data-testid="change-log-list">
          {allItems.map((item) => {
            const diffs = Array.isArray(item.changes?.diffs)
              ? (item.changes.diffs as ChangeLogDiff[])
              : [];
            const snapshot =
              item.action === 'task.deleted' && item.changes?.snapshot
                ? (item.changes.snapshot as {
                    workName?: string | null;
                    task?: { divisionNote?: string };
                  })
                : null;
            const restoreTarget = getRestoreTarget(item);

            return (
              <div
                key={item.id}
                data-testid={`change-log-item-${item.action}`}
                className="rounded-lg border border-slate-200 bg-white p-3 text-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="font-medium text-slate-900">{item.actor.displayName}</span>
                    <span className="ml-2 text-xs text-slate-400">
                      {new Date(item.createdAt).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  {restoreTarget && (
                    <div>
                      {item.canRestore ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          data-testid={`change-log-restore-${item.id}`}
                          disabled={restoreMutation.isPending}
                          onClick={() => restoreMutation.mutate(restoreTarget)}
                        >
                          <RotateCcw className="mr-1 h-3 w-3" />
                          恢复
                        </Button>
                      ) : item.wasRestored ? (
                        <Badge variant="success">已恢复</Badge>
                      ) : null}
                    </div>
                  )}
                </div>

                <div className="mt-1 text-slate-800">{item.summary}</div>

                {diffs.length > 0 && (
                  <div className="mt-2 space-y-1 rounded bg-slate-50 p-2 text-xs">
                    {diffs.map((d) => (
                      <div
                        key={`${d.field}-${d.label}`}
                        className="flex flex-wrap items-baseline gap-1"
                      >
                        <span className="font-medium text-slate-600">{d.label}：</span>
                        <span className="text-slate-500 line-through">{formatVal(d.from)}</span>
                        <span className="text-slate-400">→</span>
                        <span className="font-medium text-slate-900">{formatVal(d.to)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {snapshot && (
                  <div className="mt-2 rounded bg-red-50/50 p-2 text-xs text-slate-600">
                    {snapshot.workName && <div>作品：{snapshot.workName}</div>}
                    {snapshot.task?.divisionNote && (
                      <div>分工说明：{snapshot.task.divisionNote}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {nextCursor && (
            <div className="pt-2 text-center">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? '加载中…' : '加载更多'}
              </Button>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
