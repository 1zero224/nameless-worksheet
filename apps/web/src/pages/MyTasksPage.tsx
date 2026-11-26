import {
  type MyTaskItem,
  type MyTasksResponse,
  PUBLISH_STATUS_LABELS,
  STAGE_STATUS_LABELS,
  type StageStatus,
} from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, MapPin } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import { TaskDetailDrawer } from '@/components/task/TaskDetailDrawer.js';
import { STAGE_STATUS_STYLES } from '@/components/ui/colors.js';
import { useToast } from '@/components/ui/overlays.js';
import { Button, Card } from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';
import { useRealtimeScope } from '@/realtime/context.js';

export function MyTasksPage() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [completedOpen, setCompletedOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<{
    worksheetId: string;
    taskId: string;
  } | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.myTasks });
    }, 150);
  }, [queryClient]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useRealtimeScope(me ? { type: 'project', id: me.project.id } : null, {
    onEvent: (ev) => {
      if (ev.type === 'board.task_changed' || ev.type === 'worksheet.changed') {
        scheduleRefresh();
      }
    },
    onResync: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.myTasks });
    },
  });

  const { data, isLoading } = useQuery<MyTasksResponse>({
    queryKey: queryKeys.myTasks,
    queryFn: () => apiFetch<MyTasksResponse>('/api/my-tasks'),
  });

  const updateStatusMutation = useMutation({
    mutationFn: ({ item, nextStatus }: { item: MyTaskItem; nextStatus: StageStatus }) =>
      apiFetch(`/api/tasks/${item.taskId}/stages/${item.stageColumnId}`, {
        method: 'PATCH',
        body: { status: nextStatus, baseRevision: item.stageRevision, force: true },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.myTasks });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '更新状态失败',
        variant: 'error',
      });
    },
  });

  const renderItem = (item: MyTaskItem) => {
    return (
      <div
        key={`${item.taskId}:${item.stageColumnId}`}
        data-testid={`my-task-row-${item.taskId}-${item.stageColumnId}`}
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/[0.08] bg-white px-3.5 py-2.5"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center rounded-md border border-black/[0.08] bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-700">
              {item.worksheetName}
            </span>
            {item.workName && (
              <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700">
                {item.workName}
              </span>
            )}
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">
              {item.stageColumnName}
            </span>
            {item.publishStatus === 'published' && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                {PUBLISH_STATUS_LABELS.published}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-baseline gap-2">
            <button
              type="button"
              onClick={() =>
                setDetailTarget({ worksheetId: item.worksheetId, taskId: item.taskId })
              }
              className="text-sm font-medium text-slate-900 hover:underline cursor-pointer text-left"
            >
              {item.taskTitle}
            </button>
            {item.divisionNote && (
              <span className="text-xs text-slate-500">{item.divisionNote}</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <SelectField
            aria-label={`${item.taskTitle} ${item.stageColumnName} 状态`}
            variant="pill"
            size="sm"
            align="end"
            value={item.stageStatus}
            disabled={updateStatusMutation.isPending}
            onValueChange={(next) =>
              updateStatusMutation.mutate({
                item,
                nextStatus: next as StageStatus,
              })
            }
            className={STAGE_STATUS_STYLES[item.stageStatus].cell}
            options={(['not_started', 'in_progress', 'done'] as const).map((s) => ({
              value: s,
              label: STAGE_STATUS_LABELS[s],
              dotClass: STAGE_STATUS_STYLES[s].dot,
            }))}
          />

          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setDetailTarget({ worksheetId: item.worksheetId, taskId: item.taskId })}
          >
            详情
          </Button>
          <Link
            to={`/worksheets/${item.worksheetId}?taskId=${item.taskId}`}
            title="在工作表中定位"
            className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            aria-label={`在工作表中定位 ${item.taskTitle}`}
          >
            <MapPin className="h-4 w-4" />
          </Link>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">我的任务</h1>
        <p className="mt-1 text-sm text-slate-500">
          汇总所有工作表中由您账号负责的工序，快捷切换进度。
        </p>
      </div>

      {isLoading || !data ? (
        <div className="py-12 text-center text-sm text-slate-500">正在加载…</div>
      ) : (
        <>
          <Card>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-base font-semibold text-slate-900">进行中</h2>
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800">
                {data.inProgress.length}
              </span>
            </div>
            <div className="space-y-2" data-testid="my-tasks-in-progress">
              {data.inProgress.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">暂无进行中的工序</p>
              ) : (
                data.inProgress.map(renderItem)
              )}
            </div>
          </Card>

          <Card>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-base font-semibold text-slate-900">未开始</h2>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                {data.notStarted.length}
              </span>
            </div>
            <div className="space-y-2" data-testid="my-tasks-not-started">
              {data.notStarted.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">暂无待开始的工序</p>
              ) : (
                data.notStarted.map(renderItem)
              )}
            </div>
          </Card>

          {/* 底部默认折叠的“我已完成” */}
          <div
            data-testid="my-tasks-completed"
            className="overflow-hidden rounded-lg border border-slate-200 bg-white"
          >
            <button
              type="button"
              onClick={() => setCompletedOpen((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
            >
              <span className="inline-flex items-center gap-1.5">
                {completedOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                我已完成（{data.completed.length} 条）
              </span>
              <span className="text-xs font-normal text-slate-500">
                {completedOpen ? '点击收起' : '点击展开回顾'}
              </span>
            </button>
            {completedOpen && (
              <div className="space-y-2 border-t border-slate-200 p-4">
                {data.completed.length === 0 ? (
                  <p className="py-3 text-center text-sm text-slate-400">暂无已完成条目</p>
                ) : (
                  data.completed.map(renderItem)
                )}
              </div>
            )}
          </div>
        </>
      )}

      <TaskDetailDrawer
        worksheetId={detailTarget?.worksheetId ?? null}
        taskId={detailTarget?.taskId ?? null}
        open={Boolean(detailTarget)}
        onClose={() => setDetailTarget(null)}
        showLocateButton
      />
    </div>
  );
}
