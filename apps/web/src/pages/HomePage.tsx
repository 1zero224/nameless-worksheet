import {
  type BoardCard,
  type BoardResponse,
  type MyTaskItem,
  PRIORITY_LABELS,
  STAGE_STATUS_LABELS,
  type UserListItem,
} from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Hand, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import { TaskDetailDrawer } from '@/components/task/TaskDetailDrawer.js';
import {
  PRIORITY_STYLES,
  STAGE_STATUS_STYLES,
  WORKSHEET_COLOR_STYLES,
} from '@/components/ui/colors.js';
import { useToast } from '@/components/ui/overlays.js';
import { Button, cn, Select } from '@/components/ui/primitives.js';
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
    <div className="space-y-4">
      {/* 标题行 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">首页</h1>
          <p className="text-xs text-slate-500">跨工作表任务流转看板，实时同步</p>
        </div>
        <Link
          to="/worksheets"
          className="text-xs font-medium text-slate-600 hover:text-slate-900 hover:underline"
        >
          配置工作表与看板列 →
        </Link>
      </div>

      {/* 顶部“我进行中的任务”条 */}
      {board && (
        <section
          data-testid="my-in-progress-bar"
          className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-2xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">我进行中的任务</span>
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800">
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
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          {board.myInProgress.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {board.myInProgress.map((item) => {
                const wsColor =
                  WORKSHEET_COLOR_STYLES[item.worksheetColor] ?? WORKSHEET_COLOR_STYLES.sky;
                return (
                  <div
                    key={`${item.taskId}:${item.stageColumnId}`}
                    data-testid={`my-in-progress-item-${item.taskId}-${item.stageColumnId}`}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50/70 px-3 py-1.5 text-xs"
                  >
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-medium',
                        wsColor.badge,
                      )}
                    >
                      <span className={cn('h-1.5 w-1.5 rounded-full', wsColor.dot)} />
                      {item.worksheetName}
                    </span>
                    {item.workName && (
                      <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-700">
                        {item.workName}
                      </span>
                    )}
                    <span className="font-medium text-slate-900">{item.taskTitle}</span>
                    <span className="rounded bg-sky-100 px-1.5 py-0.5 font-medium text-sky-800">
                      {item.stageColumnName}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="h-6 px-2 text-xs"
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
                        className="h-6 px-2 text-xs"
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
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <Select
          aria-label="按工作表筛选"
          value={worksheetFilter}
          onChange={(e) => {
            setWorksheetFilter(e.target.value);
            setWorkFilter(null);
          }}
          className="h-8 w-36 py-1 text-xs"
        >
          <option value="">全部工作表</option>
          {(board?.worksheets ?? []).map((ws) => (
            <option key={ws.id} value={ws.id}>
              {ws.name}
            </option>
          ))}
        </Select>

        <Select
          aria-label="按作品筛选"
          value={workFilter ? `${workFilter.worksheetId}:${workFilter.workId}` : ''}
          onChange={(e) => {
            const val = e.target.value;
            if (!val) {
              setWorkFilter(null);
            } else {
              const [wsId, wId] = val.split(':');
              if (wsId && wId) setWorkFilter({ worksheetId: wsId, workId: wId });
            }
          }}
          className="h-8 w-40 py-1 text-xs"
        >
          <option value="">全部作品</option>
          {availableWorks.map((w) => (
            <option key={w.id} value={`${w.worksheetId}:${w.id}`}>
              {w.name}
            </option>
          ))}
        </Select>

        <button
          type="button"
          onClick={() => setOnlyMissing((v) => !v)}
          aria-pressed={onlyMissing}
          className={cn(
            'rounded-full border px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors',
            onlyMissing
              ? 'border-amber-600 bg-amber-600 text-white'
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
            'rounded-full border px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors',
            onlyMine
              ? 'border-slate-900 bg-slate-900 text-white'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
          )}
        >
          仅看与我有关
        </button>

        {activeWorkObj && (
          <span
            data-testid="active-work-filter-chip"
            className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-800"
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

      {/* 看板主体（横向滚动容器，保证 390px 不产生页面级溢出） */}
      {isLoading || !board ? (
        <div className="py-12 text-center text-sm text-slate-500">正在加载看板…</div>
      ) : (
        <div data-testid="board-columns" className="flex gap-4 overflow-x-auto pb-4">
          {board.boardColumns.map((bc) => {
            const colCards = cardsByBoardCol.get(bc.id) ?? [];
            return (
              <div
                key={bc.id}
                data-testid={`board-col-${bc.id}`}
                data-board-column-name={bc.name}
                className="flex w-72 shrink-0 flex-col rounded-lg border border-slate-200 bg-slate-100/80 p-2.5 sm:w-80"
              >
                <div className="mb-2.5 flex items-center justify-between px-1">
                  <h2 className="text-sm font-semibold text-slate-800">{bc.name}</h2>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-600 shadow-2xs">
                    {colCards.length}
                  </span>
                </div>

                <div className="flex flex-1 flex-col gap-2.5">
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
                          className="rounded-lg border border-slate-200 bg-white p-3 shadow-2xs transition-shadow hover:shadow-sm"
                        >
                          {/* 顶部标签行 */}
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
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
                                className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 cursor-pointer"
                              >
                                {card.workName}
                              </button>
                            )}

                            {card.priority !== 'normal' && (
                              <span
                                className={cn(
                                  'rounded-full px-1.5 py-0.5 text-[11px] font-medium',
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
                            className="mt-2 block w-full text-left cursor-pointer"
                          >
                            <div className="text-sm font-medium text-slate-900 hover:underline">
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
                                'rounded px-1.5 py-0.5 font-medium',
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
                            <div className="mt-2 flex flex-wrap gap-1">
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

                          {/* 底部迷你进度点 */}
                          {card.stageProgress.length > 0 && (
                            <div className="mt-2.5 flex items-center gap-1.5 border-t border-slate-100 pt-2">
                              {card.stageProgress.map((sp) => (
                                <span
                                  key={sp.columnId}
                                  title={`${sp.name}：${STAGE_STATUS_LABELS[sp.status]}`}
                                  className="inline-flex items-center gap-1 text-[10px] text-slate-500"
                                >
                                  <span
                                    className={cn(
                                      'h-2 w-2 rounded-full',
                                      STAGE_STATUS_STYLES[sp.status].dot,
                                    )}
                                  />
                                  <span>{sp.name}</span>
                                </span>
                              ))}
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
