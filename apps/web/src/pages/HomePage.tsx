import type { BoardResponse, MyTaskItem, StageStatus, UserListItem } from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Columns3, ListTodo, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import { BoardColumnsModal } from '@/components/board/BoardColumnsModal.js';
import { KanbanBoard } from '@/components/board/KanbanBoard.js';
import { MyTasksListContent, MyTasksRail } from '@/components/board/MyTasksRail.js';
import { KeywordSearchInput } from '@/components/search/KeywordSearchInput.js';
import { TaskDetailDrawer } from '@/components/task/TaskDetailDrawer.js';
import { WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import { Sheet, useToast } from '@/components/ui/overlays.js';
import { cn } from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';
import { useRealtimeScope } from '@/realtime/context.js';

export function HomePage() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  // 筛选状态
  const [keyword, setKeyword] = useState('');
  const [worksheetFilter, setWorksheetFilter] = useState('');
  const [workFilter, setWorkFilter] = useState<{ worksheetId: string; workId: string } | null>(
    null,
  );
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);

  // 左侧「我的任务」面板折叠状态（桌面）与移动端抽屉状态
  const [myTasksCollapsed, setMyTasksCollapsed] = useState(false);
  const [mobileMyTasksOpen, setMobileMyTasksOpen] = useState(false);

  // 管理看板列弹窗
  const [boardColsModalOpen, setBoardColsModalOpen] = useState(false);

  // 正在认领的 (taskId:columnId) 集合，防连点
  const [claimingKeys, setClaimingKeys] = useState<Set<string>>(new Set());
  // 正在更新状态的「我的任务」条目标识
  const [updatingMyTaskKey, setUpdatingMyTaskKey] = useState<string | null>(null);
  // 打开任务详情侧栏
  const [detailTarget, setDetailTarget] = useState<{
    worksheetId: string;
    taskId: string;
  } | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    }, 150);
  }, [queryClient]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useRealtimeScope(me ? { type: 'project', id: me.project.id } : null, {
    onEvent: (ev) => {
      if (
        ev.type === 'board.task_changed' ||
        ev.type === 'board_columns.changed' ||
        ev.type === 'worksheet.changed' ||
        ev.type === 'user.updated'
      ) {
        scheduleRefresh();
      }
    },
    onResync: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
  });

  const { data: board, isLoading } = useQuery<BoardResponse>({
    queryKey: queryKeys.board,
    queryFn: () => apiFetch<BoardResponse>('/api/board'),
  });

  const { data: users = [] } = useQuery<UserListItem[]>({
    queryKey: queryKeys.users,
    queryFn: () => apiFetch<UserListItem[]>('/api/users'),
  });

  const userMap = useMemo(() => new Map(users.map((u) => [u.id, u.displayName])), [users]);

  const updateMyTaskStatusMutation = useMutation({
    mutationFn: ({ item, status }: { item: MyTaskItem; status: StageStatus }) => {
      setUpdatingMyTaskKey(`${item.taskId}:${item.stageColumnId}`);
      return apiFetch(`/api/tasks/${item.taskId}/stages/${item.stageColumnId}`, {
        method: 'PATCH',
        body: { status, baseRevision: item.stageRevision, force: true },
      });
    },
    onSuccess: (_data, variables) => {
      pushToast({
        message: variables.status === 'done' ? '已标记为已完成' : '已切换为进行中',
        variant: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '操作失败',
        variant: 'error',
      });
    },
    onSettled: () => {
      setUpdatingMyTaskKey(null);
    },
  });

  const handleClaim = async (taskId: string, columnId: string, stageName: string) => {
    const key = `${taskId}:${columnId}`;
    if (claimingKeys.has(key)) return;
    setClaimingKeys((prev) => new Set(prev).add(key));
    try {
      await apiFetch(`/api/tasks/${taskId}/stages/${columnId}/claim`, { method: 'POST' });
      pushToast({ message: `已认领「${stageName}」（保持未开始）`, variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'STAGE_ALREADY_CLAIMED') {
        pushToast({ message: err.message, variant: 'error' });
      } else {
        pushToast({
          message: err instanceof ApiError ? err.message : '认领失败',
          variant: 'error',
        });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    } finally {
      setClaimingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const filteredCards = useMemo(() => {
    const all = board?.cards ?? [];
    const kw = keyword.trim().toLowerCase();
    return all.filter((card) => {
      if (worksheetFilter && card.worksheetId !== worksheetFilter) return false;
      if (
        workFilter &&
        (card.worksheetId !== workFilter.worksheetId || card.workId !== workFilter.workId)
      ) {
        return false;
      }
      if (onlyMissing && card.missingStages.length === 0) return false;
      if (onlyMine && me) {
        const isMine = card.stageAssignees.some(
          (a) => a.type === 'user' && a.userId === me.user.id,
        );
        if (!isMine) return false;
      }
      if (kw) {
        const assigneesHit = card.stageAssignees.some((a) => {
          const name = a.type === 'user' ? (userMap.get(a.userId) ?? '') : a.name;
          return name.toLowerCase().includes(kw);
        });
        const hit =
          card.taskTitle.toLowerCase().includes(kw) ||
          (card.workName ?? '').toLowerCase().includes(kw) ||
          card.divisionNote.toLowerCase().includes(kw) ||
          card.worksheetName.toLowerCase().includes(kw) ||
          assigneesHit;
        if (!hit) return false;
      }
      return true;
    });
  }, [board?.cards, worksheetFilter, workFilter, onlyMissing, onlyMine, me, keyword, userMap]);

  const availableWorks = useMemo(() => {
    const all = board?.works ?? [];
    if (!worksheetFilter) return all;
    return all.filter((w) => w.worksheetId === worksheetFilter);
  }, [board?.works, worksheetFilter]);

  const activeWorkObj = useMemo(() => {
    if (!workFilter) return null;
    return (
      board?.works.find(
        (w) => w.id === workFilter.workId && w.worksheetId === workFilter.worksheetId,
      ) ?? null
    );
  }, [workFilter, board?.works]);

  const myInProgress = board?.myInProgress ?? [];
  const myPending = board?.myPending ?? [];
  const myTotalCount = myInProgress.length + myPending.length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* 单行紧凑筛选工具栏 */}
      <div className="flex min-h-[40px] shrink-0 flex-wrap items-center gap-2 border-b border-black/[0.08] bg-white px-3 py-1.5">
        <h1 className="sr-only">首页</h1>

        {/* 窄屏「我的任务」抽屉触发按钮（桌面端由左侧竖栏直接呈现） */}
        <button
          type="button"
          data-testid="mobile-my-tasks-trigger"
          onClick={() => setMobileMyTasksOpen(true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-black/[0.1] bg-white px-2 text-xs font-medium text-zinc-700 transition-colors hover:bg-black/[0.04] cursor-pointer md:hidden"
        >
          <ListTodo className="h-3.5 w-3.5 text-zinc-500" strokeWidth={1.75} />
          <span>我的任务</span>
          <span
            className={cn(
              'rounded-full px-1.5 py-0 text-[10px] font-medium tabular-nums',
              myInProgress.length > 0 ? 'bg-amber-100 text-amber-900' : 'bg-zinc-100 text-zinc-600',
            )}
          >
            {myTotalCount}
          </span>
        </button>

        <KeywordSearchInput
          value={keyword}
          onChange={setKeyword}
          aria-label="筛选关键词"
          placeholder="筛选或跨表检索关键词…"
          className="w-40 sm:w-52"
        />

        <SelectField
          aria-label="按工作表筛选"
          size="xs"
          value={worksheetFilter}
          onValueChange={(val) => {
            setWorksheetFilter(val);
            setWorkFilter(null);
          }}
          className="w-32 sm:w-36"
          options={[
            { value: '', label: '全部工作表' },
            ...(board?.worksheets ?? []).map((ws) => ({
              value: ws.id,
              label: ws.name,
              dotClass: (WORKSHEET_COLOR_STYLES[ws.color] ?? WORKSHEET_COLOR_STYLES.sky).dot,
            })),
          ]}
        />

        <SelectField
          aria-label="按作品筛选"
          size="xs"
          value={workFilter ? `${workFilter.worksheetId}:${workFilter.workId}` : ''}
          onValueChange={(val) => {
            if (!val) {
              setWorkFilter(null);
            } else {
              const [wsId, wId] = val.split(':');
              if (wsId && wId) setWorkFilter({ worksheetId: wsId, workId: wId });
            }
          }}
          className="w-32 sm:w-36"
          options={[
            { value: '', label: '全部作品' },
            ...availableWorks.map((w) => ({
              value: `${w.worksheetId}:${w.id}`,
              label: w.name,
            })),
          ]}
        />

        <button
          type="button"
          onClick={() => setOnlyMissing((v) => !v)}
          aria-pressed={onlyMissing}
          className={cn(
            'rounded-md border px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors',
            onlyMissing
              ? 'border-zinc-900 bg-zinc-900 text-white'
              : 'border-black/[0.1] bg-white text-zinc-600 hover:bg-black/[0.04]',
          )}
        >
          仅看缺人
        </button>

        <button
          type="button"
          onClick={() => setOnlyMine((v) => !v)}
          aria-pressed={onlyMine}
          className={cn(
            'rounded-md border px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors',
            onlyMine
              ? 'border-zinc-900 bg-zinc-900 text-white'
              : 'border-black/[0.1] bg-white text-zinc-600 hover:bg-black/[0.04]',
          )}
        >
          仅看与我有关
        </button>

        {activeWorkObj && (
          <span
            data-testid="active-work-filter-chip"
            className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50/70 px-2.5 py-0.5 text-xs font-medium text-indigo-900"
          >
            作品：{activeWorkObj.name}
            <button
              type="button"
              onClick={() => setWorkFilter(null)}
              aria-label="清除作品筛选"
              className="rounded-full p-0.5 text-indigo-500 hover:bg-indigo-100 hover:text-indigo-900 cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => setBoardColsModalOpen(true)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-black/[0.1] bg-white px-2.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-black/[0.04] hover:text-zinc-950 cursor-pointer"
          >
            <Columns3 className="h-3.5 w-3.5 text-zinc-400" strokeWidth={1.75} />
            管理看板列
          </button>
        </div>
      </div>

      {/* 主画布：左侧可折叠「我的任务」竖栏 + 右侧任务流转看板 */}
      {isLoading || !board ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
          正在加载看板…
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <MyTasksRail
            myInProgress={myInProgress}
            myPending={myPending}
            updatingKey={updatingMyTaskKey}
            collapsed={myTasksCollapsed}
            onToggleCollapsed={() => setMyTasksCollapsed((v) => !v)}
            onStart={(item) => updateMyTaskStatusMutation.mutate({ item, status: 'in_progress' })}
            onComplete={(item) => updateMyTaskStatusMutation.mutate({ item, status: 'done' })}
            onOpenDetail={setDetailTarget}
          />

          <KanbanBoard
            boardColumns={board.boardColumns}
            cards={filteredCards}
            userMap={userMap}
            claimingKeys={claimingKeys}
            currentUserId={me?.user.id ?? null}
            onlyMissing={onlyMissing}
            showWorksheetSource
            onClaim={handleClaim}
            onOpenDetail={setDetailTarget}
            onSelectWorkFilter={(target) =>
              setWorkFilter((prev) =>
                prev?.workId === target.workId && prev.worksheetId === target.worksheetId
                  ? null
                  : target,
              )
            }
          />
        </div>
      )}

      {/* 移动端「我的任务」抽屉 */}
      <Sheet
        open={mobileMyTasksOpen}
        onOpenChange={setMobileMyTasksOpen}
        title={`我的任务（${myTotalCount}）`}
      >
        <MyTasksListContent
          myInProgress={myInProgress}
          myPending={myPending}
          updatingKey={updatingMyTaskKey}
          onStart={(item) => updateMyTaskStatusMutation.mutate({ item, status: 'in_progress' })}
          onComplete={(item) => updateMyTaskStatusMutation.mutate({ item, status: 'done' })}
          onOpenDetail={(target) => {
            setMobileMyTasksOpen(false);
            setDetailTarget(target);
          }}
        />
      </Sheet>

      {/* 右上角「管理看板列」弹窗 */}
      <BoardColumnsModal open={boardColsModalOpen} onOpenChange={setBoardColsModalOpen} />

      {/* 任务详情侧栏 */}
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
