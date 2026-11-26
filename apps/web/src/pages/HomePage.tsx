import type { BoardResponse, MyTaskItem, UserListItem } from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Columns3, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import { BoardColumnsModal } from '@/components/board/BoardColumnsModal.js';
import { KanbanBoard } from '@/components/board/KanbanBoard.js';
import { KeywordSearchInput } from '@/components/search/KeywordSearchInput.js';
import { TaskDetailDrawer } from '@/components/task/TaskDetailDrawer.js';
import { WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import { useToast } from '@/components/ui/overlays.js';
import { Button, cn } from '@/components/ui/primitives.js';
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

  // 管理看板列弹窗
  const [boardColsModalOpen, setBoardColsModalOpen] = useState(false);

  // 正在认领的 (taskId:columnId) 集合，防连点
  const [claimingKeys, setClaimingKeys] = useState<Set<string>>(new Set());
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

  const markDoneMutation = useMutation({
    mutationFn: (item: MyTaskItem) =>
      apiFetch(`/api/tasks/${item.taskId}/stages/${item.stageColumnId}`, {
        method: 'PATCH',
        body: { status: 'done', baseRevision: item.stageRevision, force: true },
      }),
    onSuccess: () => {
      pushToast({ message: '已标记为已完成', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '操作失败',
        variant: 'error',
      });
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* 紧凑工具栏（融合筛选、跨表资源检索与看板列管理） */}
      <div className="flex min-h-[40px] shrink-0 flex-wrap items-center gap-2 border-b border-black/[0.08] bg-white px-3 py-1.5">
        <h1 className="sr-only">首页</h1>

        <KeywordSearchInput
          value={keyword}
          onChange={setKeyword}
          aria-label="筛选关键词"
          placeholder="筛选或跨表检索关键词…"
          className="w-44 sm:w-56"
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

      {/* 顶部紧凑“我进行中的任务”快捷条 */}
      {board && (
        <section
          data-testid="my-in-progress-bar"
          className="shrink-0 border-b border-black/[0.08] bg-[#fafafa] px-3 py-1.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-900">我进行中的任务</span>
              <span className="rounded-full bg-white px-1.5 py-0 text-[11px] font-medium tabular-nums text-zinc-600 ring-1 ring-black/[0.08]">
                {board.myInProgress.length}
              </span>
              {board.myInProgress.length === 0 && (
                <span className="text-xs text-zinc-400">当前没有进行中的工序</span>
              )}
            </div>
            {board.myPendingCount > 0 && (
              <span className="text-xs text-zinc-500">
                另有 <strong className="font-medium text-zinc-700">{board.myPendingCount}</strong>{' '}
                项已认领待开始
              </span>
            )}
          </div>

          {board.myInProgress.length > 0 && (
            <div className="no-scrollbar mt-1.5 flex gap-2 overflow-x-auto pb-0.5">
              {board.myInProgress.map((item) => {
                const wsColor =
                  WORKSHEET_COLOR_STYLES[item.worksheetColor] ?? WORKSHEET_COLOR_STYLES.sky;
                return (
                  <div
                    key={`${item.taskId}:${item.stageColumnId}`}
                    data-testid={`my-in-progress-item-${item.taskId}-${item.stageColumnId}`}
                    className="flex shrink-0 items-center gap-1.5 rounded-md border border-black/[0.08] bg-white px-2.5 py-1 text-xs shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
                  >
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', wsColor.dot)} />
                    <span className="text-[11px] text-zinc-400">{item.worksheetName}</span>
                    {item.workName && (
                      <span className="rounded bg-indigo-50 px-1.5 py-0.25 text-[11px] font-medium text-indigo-800">
                        {item.workName}
                      </span>
                    )}
                    <span className="font-medium text-zinc-950">{item.taskTitle}</span>
                    <span className="rounded bg-[#EFF6FF] px-1.5 py-0.25 text-[11px] font-medium text-blue-700">
                      {item.stageColumnName}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="h-5 px-1.5 text-[11px]"
                      disabled={markDoneMutation.isPending}
                      onClick={() => markDoneMutation.mutate(item)}
                    >
                      <Check className="mr-0.5 h-3 w-3" />
                      完成
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1.5 text-[11px]"
                      onClick={() =>
                        setDetailTarget({
                          worksheetId: item.worksheetId,
                          taskId: item.taskId,
                        })
                      }
                    >
                      详情
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* 公共 Teable 风格作品聚合看板 */}
      {isLoading || !board ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
          正在加载看板…
        </div>
      ) : (
        <KanbanBoard
          boardColumns={board.boardColumns}
          cards={filteredCards}
          userMap={userMap}
          claimingKeys={claimingKeys}
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
      )}

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
