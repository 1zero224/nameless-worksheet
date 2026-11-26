import type { ChangeLogDiff, ChangeLogItem, ChangeLogsResponse } from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { invalidateArtifactQueries } from '@/components/artifact/utils.js';
import { Sheet, useToast } from '@/components/ui/overlays.js';
import { Badge, Button, cn } from '@/components/ui/primitives.js';

export type CellChangeLogColumnKind =
  | 'title'
  | 'stage'
  | 'work'
  | 'priority'
  | 'publish'
  | 'files'
  | 'divisionNote'
  | 'custom';

export interface CellChangeLogScope {
  taskId: string;
  taskTitle: string;
  columnKey: string | null;
  columnKind: CellChangeLogColumnKind | null;
  columnName: string | null;
}

function matchCellChangeLog(
  item: ChangeLogItem,
  scope: CellChangeLogScope,
): { matched: boolean; diffs: ChangeLogDiff[] } {
  const rawDiffs = Array.isArray(item.changes?.diffs)
    ? (item.changes.diffs as ChangeLogDiff[])
    : [];

  if (!scope.columnKey || !scope.columnKind) {
    return { matched: true, diffs: rawDiffs };
  }

  if (scope.columnKind === 'stage') {
    if (item.action === 'stage.updated' && item.changes?.columnId === scope.columnKey) {
      return { matched: true, diffs: rawDiffs };
    }
    if (
      (item.action.startsWith('artifact.') ||
        item.action.startsWith('artifact_version.') ||
        item.action.startsWith('location.')) &&
      (item.changes?.stageColumnId === scope.columnKey ||
        item.changes?.columnId === scope.columnKey)
    ) {
      return { matched: true, diffs: rawDiffs };
    }
    return { matched: false, diffs: [] };
  }

  if (scope.columnKind === 'files') {
    const isResourceAction =
      item.action.startsWith('artifact.') ||
      item.action.startsWith('artifact_version.') ||
      item.action.startsWith('location.');
    return { matched: isResourceAction, diffs: isResourceAction ? rawDiffs : [] };
  }

  if (scope.columnKind === 'title' && item.action === 'task.created') {
    return { matched: true, diffs: [] };
  }

  if (item.action !== 'task.updated') {
    return { matched: false, diffs: [] };
  }

  const fieldMatches = (field: string): boolean => {
    if (scope.columnKind === 'title') return field === 'title';
    if (scope.columnKind === 'work') return field === 'workId';
    if (scope.columnKind === 'divisionNote') return field === 'divisionNote';
    if (scope.columnKind === 'priority') return field === 'priority';
    if (scope.columnKind === 'publish') {
      return field === 'publishStatus' || field === 'publishedAt' || field === 'publishUrl';
    }
    if (scope.columnKind === 'custom') return field === `custom:${scope.columnKey}`;
    return false;
  };

  const matchedDiffs = rawDiffs.filter((d) => fieldMatches(d.field));
  return { matched: matchedDiffs.length > 0, diffs: matchedDiffs };
}

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
  cellScope = null,
  open,
  onOpenChange,
}: {
  worksheetId?: string;
  mode?: 'worksheet' | 'docs';
  cellScope?: CellChangeLogScope | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [extraItems, setExtraItems] = useState<ChangeLogItem[]>([]);
  const [extraCursor, setExtraCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [scopeFilterMode, setScopeFilterMode] = useState<'cell' | 'task'>('cell');

  useEffect(() => {
    setScopeFilterMode(cellScope?.columnKey ? 'cell' : 'task');
  }, [cellScope]);

  const isDocsMode = mode === 'docs';
  const scopedTaskId = !isDocsMode && cellScope ? cellScope.taskId : null;
  const baseUrl = isDocsMode
    ? '/api/docs/change-logs'
    : `/api/worksheets/${worksheetId ?? ''}/change-logs`;
  const listLimit = scopedTaskId ? 100 : 50;
  const taskQuerySuffix = scopedTaskId ? `&taskId=${scopedTaskId}` : '';

  const { data, isLoading, refetch } = useQuery<ChangeLogsResponse>({
    queryKey: isDocsMode
      ? queryKeys.docsChangeLogs
      : queryKeys.changeLogs(worksheetId ?? 'none', scopedTaskId),
    queryFn: async () => {
      setExtraItems([]);
      setExtraCursor(null);
      return apiFetch<ChangeLogsResponse>(`${baseUrl}?limit=${listLimit}${taskQuerySuffix}`);
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
      const res = await apiFetch<ChangeLogsResponse>(
        `${baseUrl}?limit=${listLimit}${taskQuerySuffix}&cursor=${nextCursor}`,
      );
      setExtraItems((prev) => [...prev, ...res.items]);
      setExtraCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  const isCellFiltered = Boolean(cellScope?.columnKey && scopeFilterMode === 'cell');
  const displayEntries = allItems.flatMap((item) => {
    if (isCellFiltered && cellScope) {
      const res = matchCellChangeLog(item, cellScope);
      if (!res.matched) return [];
      return [{ item, diffs: res.diffs }];
    }
    const rawDiffs = Array.isArray(item.changes?.diffs)
      ? (item.changes.diffs as ChangeLogDiff[])
      : [];
    return [{ item, diffs: rawDiffs }];
  });

  const drawerTitle = isDocsMode
    ? '通用文档修改记录'
    : cellScope
      ? isCellFiltered && cellScope.columnName
        ? '单元格修改记录'
        : '任务修改记录'
      : '修改记录';

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={drawerTitle}>
      {cellScope && !isDocsMode && (
        <div
          data-testid="cell-history-scope-bar"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-black/[0.06] bg-[#fafafa] px-2.5 py-2"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="inline-flex max-w-[180px] truncate rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200/90">
              {cellScope.taskTitle}
            </span>
            {cellScope.columnName && (
              <>
                <ChevronRight className="h-3 w-3 shrink-0 text-zinc-300" />
                <span className="inline-flex max-w-[140px] truncate rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200/90">
                  {cellScope.columnName}
                </span>
              </>
            )}
          </div>
          {cellScope.columnKey && (
            <div className="inline-flex shrink-0 items-center rounded-md border border-black/[0.08] bg-white p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setScopeFilterMode('cell')}
                className={cn(
                  'rounded px-2 py-0.5 font-medium transition-colors cursor-pointer',
                  scopeFilterMode === 'cell'
                    ? 'bg-zinc-900 text-white'
                    : 'text-zinc-500 hover:text-zinc-900',
                )}
              >
                当前单元格
              </button>
              <button
                type="button"
                onClick={() => setScopeFilterMode('task')}
                className={cn(
                  'rounded px-2 py-0.5 font-medium transition-colors cursor-pointer',
                  scopeFilterMode === 'task'
                    ? 'bg-zinc-900 text-white'
                    : 'text-zinc-500 hover:text-zinc-900',
                )}
              >
                整条任务
              </button>
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="py-10 text-center text-sm text-slate-500">正在加载修改记录…</div>
      ) : displayEntries.length === 0 ? (
        <div className="space-y-2.5 py-10 text-center text-sm text-slate-500">
          <div>{isCellFiltered ? '该单元格暂无修改记录' : '暂无修改记录'}</div>
          {isCellFiltered && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setScopeFilterMode('task')}
            >
              查看整条任务的修改记录
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3" data-testid="change-log-list">
          {displayEntries.map(({ item, diffs }) => {
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
