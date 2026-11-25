import {
  type BoardCard,
  type BoardResponse,
  type MyTaskItem,
  PRIORITY_LABELS,
  STAGE_STATUS_LABELS,
  type UserListItem,
} from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Columns3, Hand, SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { SidebarExpandButton } from '@/app/AppShell.js';
import { useMe } from '@/app/AuthContext.js';
import { BoardColumnsModal } from '@/components/board/BoardColumnsModal.js';
import { TaskDetailDrawer } from '@/components/task/TaskDetailDrawer.js';
import {
  PRIORITY_STYLES,
  STAGE_STATUS_STYLES,
  WORKSHEET_COLOR_STYLES,
} from '@/components/ui/colors.js';
import { useToast } from '@/components/ui/overlays.js';
import { Button, cn } from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';
import { useRealtimeScope } from '@/realtime/context.js';

export function HomePage() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  // 筛选状态
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.myTasks });
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.myTasks });
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
      return true;
    });
  }, [board?.cards, worksheetFilter, workFilter, onlyMissing, onlyMine, me]);

  const cardsByBoardCol = useMemo(() => {
    const map = new Map<string, BoardCard[]>();
    for (const bc of board?.boardColumns ?? []) {
      map.set(bc.id, []);
    }
    for (const card of filteredCards) {
      const list = map.get(card.boardColumnId);
      if (list) list.push(card);
    }
    return map;
  }, [board?.boardColumns, filteredCards]);

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

  const formatAssignees = (assignees: BoardCard['stageAssignees']) =>
    assignees
      .map((a) => (a.type === 'user' ? (userMap.get(a.userId) ?? '未知用户') : a.name))
      .join('、');

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* 极简顶栏（44px） */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-slate-200/80 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarExpandButton />
          <h1 className="truncate text-[15px] font-semibold text-slate-900">首页</h1>
          <span className="hidden text-xs text-slate-400 sm:inline">· 跨工作表任务流转看板</span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setBoardColsModalOpen(true)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 cursor-pointer"
          >
            <Columns3 className="h-3.5 w-3.5 text-slate-400" />
            管理看板列
          </button>
          <Link
            to="/worksheets"
            className="hidden h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 sm:inline-flex"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            工作表总览
          </Link>
        </div>
      </div>

      {/* 顶部紧凑“我进行中的任务”横条 */}
      {board && (
        <section
          data-testid="my-in-progress-bar"
          className="shrink-0 border-b border-slate-200/80 bg-sky-50/35 px-3 py-1.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-800">我进行中的任务</span>
              <span className="rounded-full bg-sky-100 px-1.5 py-0 text-[11px] font-medium text-sky-800">
                {board.myInProgress.length}
              </span>
              {board.myInProgress.length === 0 && (
                <span className="text-xs text-slate-400">当前没有进行中的工序</span>
              )}
            </div>
            <Link
              to="/my-tasks"
              className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:underline"
            >
              {board.myPendingCount > 0
                ? `另有 ${board.myPendingCount} 项已认领待开始 · 前往我的任务`
                : '前往我的任务'}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>

          {board.myInProgress.length > 0 && (
            <div className="mt-1.5 flex gap-2 overflow-x-auto pb-0.5">
              {board.myInProgress.map((item) => {
                const wsColor =
                  WORKSHEET_COLOR_STYLES[item.worksheetColor] ?? WORKSHEET_COLOR_STYLES.sky;
                return (
                  <div
                    key={`${item.taskId}:${item.stageColumnId}`}
                    data-testid={`my-in-progress-item-${item.taskId}-${item.stageColumnId}`}
                    className="flex shrink-0 items-center gap-1.5 rounded-md border border-slate-200/90 bg-white px-2.5 py-1 text-xs shadow-2xs"
                  >
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', wsColor.dot)} />
                    <span className="text-[11px] text-slate-500">{item.worksheetName}</span>
                    {item.workName && (
                      <span className="rounded bg-indigo-50 px-1.5 py-0.25 text-[11px] font-medium text-indigo-700">
                        {item.workName}
                      </span>
                    )}
                    <span className="font-medium text-slate-900">{item.taskTitle}</span>
                    <span className="rounded bg-sky-100 px-1.5 py-0.25 text-[11px] font-medium text-sky-800">
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

      {/* 紧凑单行筛选栏 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200/80 bg-slate-50/40 px-3 py-1.5">
        <SelectField
          aria-label="按工作表筛选"
          size="xs"
          value={worksheetFilter}
          onValueChange={(val) => {
            setWorksheetFilter(val);
            setWorkFilter(null);
          }}
          className="w-36"
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
          className="w-36"
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
              ? 'border-amber-500 bg-amber-50 text-amber-900'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
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
              ? 'border-sky-500 bg-sky-50 text-sky-900'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
          )}
        >
          仅看与我有关
        </button>

        {activeWorkObj && (
          <span
            data-testid="active-work-filter-chip"
            className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-800"
          >
            作品：{activeWorkObj.name}
            <button
              type="button"
              onClick={() => setWorkFilter(null)}
              aria-label="清除作品筛选"
              className="rounded-full p-0.5 hover:bg-indigo-200 cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>

      {/* 看板主体（撑满剩余高度，各列独立纵向滚动） */}
      {isLoading || !board ? (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
          正在加载看板…
        </div>
      ) : (
        <div
          data-testid="board-columns"
          className="flex min-h-0 flex-1 gap-3 overflow-x-auto bg-slate-50/50 p-3"
        >
          {board.boardColumns.map((bc) => {
            const colCards = cardsByBoardCol.get(bc.id) ?? [];
            return (
              <div
                key={bc.id}
                data-testid={`board-col-${bc.id}`}
                data-board-column-name={bc.name}
                className="flex h-full min-h-0 w-72 shrink-0 flex-col rounded-lg border border-slate-200/80 bg-slate-100/70 sm:w-[300px]"
              >
                <div className="flex shrink-0 items-center justify-between px-3 py-2">
                  <h2 className="text-[13px] font-semibold text-slate-800">{bc.name}</h2>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200/70">
                    {colCards.length}
                  </span>
                </div>

                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2.5">
                  {colCards.length === 0 ? (
                    <div className="rounded-md border border-dashed border-slate-300/80 py-8 text-center text-xs text-slate-400">
                      暂无任务
                    </div>
                  ) : (
                    colCards.map((card) => {
                      const wsColor =
                        WORKSHEET_COLOR_STYLES[card.worksheetColor] ?? WORKSHEET_COLOR_STYLES.sky;
                      const assigneesText = formatAssignees(card.stageAssignees);
                      return (
                        <div
                          key={`${card.taskId}:${card.boardColumnId}`}
                          data-testid={`board-card-${card.taskId}-${card.boardColumnId}`}
                          className="rounded-lg border border-slate-200/90 bg-white p-2.5 shadow-2xs transition-colors hover:border-slate-300"
                        >
                          {/* 顶部标签行 */}
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.25 text-[11px] font-medium',
                                wsColor.badge,
                              )}
                            >
                              <span className={cn('h-1.5 w-1.5 rounded-full', wsColor.dot)} />
                              {card.worksheetName}
                            </span>

                            {card.workId && card.workName && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setWorkFilter((prev) =>
                                    prev?.workId === card.workId &&
                                    prev.worksheetId === card.worksheetId
                                      ? null
                                      : {
                                          worksheetId: card.worksheetId,
                                          workId: card.workId!,
                                        },
                                  );
                                }}
                                className="rounded bg-indigo-50 px-1.5 py-0.25 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 cursor-pointer"
                              >
                                {card.workName}
                              </button>
                            )}

                            {card.priority !== 'normal' && (
                              <span
                                className={cn(
                                  'rounded-full px-1.5 py-0.25 text-[11px] font-medium',
                                  PRIORITY_STYLES[card.priority],
                                )}
                              >
                                {PRIORITY_LABELS[card.priority]}
                              </span>
                            )}
                          </div>

                          {/* 标题与分工说明（点击打开详情侧栏） */}
                          <button
                            type="button"
                            onClick={() =>
                              setDetailTarget({
                                worksheetId: card.worksheetId,
                                taskId: card.taskId,
                              })
                            }
                            className="mt-1.5 block w-full text-left cursor-pointer"
                          >
                            <div className="text-[13px] font-medium text-slate-900 hover:text-sky-700">
                              {card.taskTitle}
                            </div>
                            {card.divisionNote && (
                              <div className="mt-0.5 truncate text-xs text-slate-500">
                                {card.divisionNote}
                              </div>
                            )}
                          </button>

                          {/* 本列工序状态行 */}
                          <div className="mt-2 flex items-center justify-between text-xs">
                            <span
                              className={cn(
                                'rounded px-1.5 py-0.5 text-[11px] font-medium',
                                STAGE_STATUS_STYLES[card.stageStatus].badge,
                              )}
                            >
                              {assigneesText
                                ? `${assigneesText} · ${STAGE_STATUS_LABELS[card.stageStatus]}`
                                : `${STAGE_STATUS_LABELS[card.stageStatus]} · 缺人`}
                            </span>
                          </div>

                          {/* 缺人标签区（点击原子抢占认领） */}
                          {card.missingStages.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {card.missingStages.map((ms) => {
                                const claimKey = `${card.taskId}:${ms.columnId}`;
                                const claiming = claimingKeys.has(claimKey);
                                return (
                                  <button
                                    key={ms.columnId}
                                    type="button"
                                    disabled={claiming}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleClaim(card.taskId, ms.columnId, ms.name);
                                    }}
                                    className="inline-flex items-center gap-0.5 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 cursor-pointer"
                                  >
                                    <Hand className="h-3 w-3" />
                                    {claiming ? '认领中…' : `缺 ${ms.name}`}
                                  </button>
                                );
                              })}
                            </div>
                          )}

                          {/* 底部迷你进度点 + 阶段 3 快捷附件下载槽位 */}
                          {card.stageProgress.length > 0 && (
                            <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-100 pt-1.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                {card.stageProgress.map((sp) => (
                                  <span
                                    key={sp.columnId}
                                    title={`${sp.name}：${STAGE_STATUS_LABELS[sp.status]}`}
                                    className="inline-flex items-center gap-1 text-[10px] text-slate-500"
                                  >
                                    <span
                                      className={cn(
                                        'h-1.5 w-1.5 rounded-full',
                                        STAGE_STATUS_STYLES[sp.status].dot,
                                      )}
                                    />
                                    <span>{sp.name}</span>
                                  </span>
                                ))}
                              </div>
                              {/* 阶段 3 预留：本列工序最新附件一键下载角标槽位 */}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
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
