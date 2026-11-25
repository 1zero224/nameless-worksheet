import {
  type Assignee,
  type ColumnChangedPayload,
  computeBoardData,
  getEffectiveStageCell,
  type PresencePeer,
  type Priority,
  type StageCell,
  type StageStatus,
  type StageUpdatedPayload,
  type SystemColumnsConfig,
  type TaskCreatedPayload,
  type TaskDeletedPayload,
  type TaskDetail,
  type TaskRestoredPayload,
  type TasksReorderedPayload,
  type TaskUpdatedPayload,
  type UserListItem,
  type Work,
  type WorksheetFullResponse,
  type WorksheetUpdatedPayload,
  type WorkUpdatedPayload,
} from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  History,
  Kanban,
  RotateCcw,
  Search,
  Table2,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { SidebarExpandButton } from '@/app/AppShell.js';
import { useMe } from '@/app/AuthContext.js';
import { KanbanBoard } from '@/components/board/KanbanBoard.js';
import { TaskDetailDrawer } from '@/components/task/TaskDetailDrawer.js';
import { peerColorForUser, WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import { ConfirmDialog, useToast } from '@/components/ui/overlays.js';
import { Button, cn, Input } from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';
import { AddColumnPopover } from '@/components/worksheet/AddColumnPopover.js';
import type { ActiveCellConflict, StageCellConflict } from '@/components/worksheet/CellEditors.js';
import { ChangeLogDrawer } from '@/components/worksheet/ChangeLogDrawer.js';
import { ColumnManagerModal } from '@/components/worksheet/ColumnManagerModal.js';
import { CreateWorkPopover } from '@/components/worksheet/CreateWorkPopover.js';
import { FieldVisibilityPopover } from '@/components/worksheet/FieldVisibilityPopover.js';
import {
  type GridDisplayBlock,
  WorksheetCanvasGrid,
} from '@/components/worksheet/WorksheetCanvasGrid.js';
import { useRealtimeClient, useRealtimeScope } from '@/realtime/context.js';

const EMPTY_TASKS: TaskDetail[] = [];

type ViewMode = 'grid' | 'board';
type StatusChip = 'all' | 'mine' | 'not_started' | 'in_progress' | 'all_stages_done';
type LocalSort = 'manual' | 'title' | 'priority' | 'work';

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2 };

function sortTasksByKey(list: TaskDetail[]): TaskDetail[] {
  return [...list].sort((a, b) => {
    if (a.sortOrder < b.sortOrder) return -1;
    if (a.sortOrder > b.sortOrder) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function WorksheetDetailPage() {
  const { id: worksheetId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const realtime = useRealtimeClient();
  const { pushToast } = useToast();

  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [subscribedReady, setSubscribedReady] = useState(false);
  const [peers, setPeers] = useState<Map<string, PresencePeer>>(new Map());
  const [selectedCell, setSelectedCell] = useState<{ taskId: string; columnKey: string } | null>(
    null,
  );
  const activeEditorRef = useRef<{ taskId: string; columnKey: string } | null>(null);

  const [textConflicts, setTextConflicts] = useState<Map<string, ActiveCellConflict>>(new Map());
  const [stageConflicts, setStageConflicts] = useState<Map<string, StageCellConflict>>(new Map());
  const [claimingKeys, setClaimingKeys] = useState<Set<string>>(new Set());

  const [colModalOpen, setColModalOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [publishedExpanded, setPublishedExpanded] = useState(false);
  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(null);

  // 作品大标题横幅状态
  const [pendingWorks, setPendingWorks] = useState<Work[]>([]);
  const [collapsedWorkIds, setCollapsedWorkIds] = useState<Set<string>>(new Set());
  const [addingSegmentWorkId, setAddingSegmentWorkId] = useState<string | null>(null);
  const [ungroupingWork, setUngroupingWork] = useState<{
    work: Work;
    tasks: TaskDetail[];
  } | null>(null);
  const [ungroupPending, setUngroupPending] = useState(false);

  const [statusChip, setStatusChip] = useState<StatusChip>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('');
  const [workFilter, setWorkFilter] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [localSort, setLocalSort] = useState<LocalSort>('manual');

  const wsScope = useMemo(
    () => (worksheetId ? { type: 'worksheet', id: worksheetId } : null),
    [worksheetId],
  );

  useEffect(() => {
    if (!worksheetId) return;
    setViewMode('grid');
    setSubscribedReady(false);
    setPeers(new Map());
    setSelectedCell(null);
    activeEditorRef.current = null;
    setTextConflicts(new Map());
    setStageConflicts(new Map());
    setPublishedExpanded(false);
    setPendingWorks([]);
    setCollapsedWorkIds(new Set());
    setAddingSegmentWorkId(null);
    setUngroupingWork(null);
  }, [worksheetId]);

  const refetchWorksheet = useCallback(() => {
    if (worksheetId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheet(worksheetId) });
    }
  }, [queryClient, worksheetId]);

  useRealtimeScope(wsScope, {
    onSubscribed: () => {
      setSubscribedReady(true);
    },
    onResync: () => {
      refetchWorksheet();
    },
    onPresenceSnapshot: (list) => {
      setPeers(new Map(list.map((p) => [p.connId, p])));
    },
    onPresenceUpdate: (peer) => {
      setPeers((prev) => {
        const next = new Map(prev);
        next.set(peer.connId, peer);
        return next;
      });
    },
    onPresenceLeave: (connId) => {
      setPeers((prev) => {
        if (!prev.has(connId)) return prev;
        const next = new Map(prev);
        next.delete(connId);
        return next;
      });
    },
    onEvent: (ev) => {
      if (!worksheetId) return;
      const qKey = queryKeys.worksheet(worksheetId);

      if (ev.type === 'worksheet.deleted') {
        const p = ev.payload as { worksheetId: string };
        if (p.worksheetId === worksheetId) {
          pushToast({ message: '此工作表已被删除', variant: 'info' });
          navigate('/worksheets', { replace: true });
        }
        return;
      }

      if (ev.type === 'worksheet.updated') {
        const { worksheet } = ev.payload as WorksheetUpdatedPayload;
        queryClient.setQueryData<WorksheetFullResponse>(qKey, (old) =>
          old ? { ...old, worksheet } : old,
        );
        return;
      }

      if (ev.type === 'column.changed') {
        const p = ev.payload as ColumnChangedPayload;
        const nextCols = p.columns;
        if (p.action === 'reordered' && nextCols) {
          queryClient.setQueryData<WorksheetFullResponse>(qKey, (old) =>
            old ? { ...old, columns: nextCols } : old,
          );
        } else {
          refetchWorksheet();
        }
        return;
      }

      if (ev.type === 'work.updated') {
        const { work } = ev.payload as WorkUpdatedPayload;
        queryClient.setQueryData<WorksheetFullResponse>(qKey, (old) =>
          old ? { ...old, works: old.works.map((w) => (w.id === work.id ? work : w)) } : old,
        );
        setPendingWorks((prev) => prev.map((w) => (w.id === work.id ? work : w)));
        return;
      }

      if (ev.type === 'task.created') {
        const { task, work } = ev.payload as TaskCreatedPayload;
        queryClient.setQueryData<WorksheetFullResponse>(qKey, (old) => {
          if (!old) return old;
          if (old.tasks.some((t) => t.id === task.id)) return old;
          const nextWorks =
            work && !old.works.some((w) => w.id === work.id) ? [...old.works, work] : old.works;
          return { ...old, works: nextWorks, tasks: sortTasksByKey([...old.tasks, task]) };
        });
        if (work) {
          setPendingWorks((prev) => prev.filter((w) => w.id !== work.id));
        }
        return;
      }

      if (ev.type === 'task.restored') {
        const { task, work } = ev.payload as TaskRestoredPayload;
        queryClient.setQueryData<WorksheetFullResponse>(qKey, (old) => {
          if (!old) return old;
          const filtered = old.tasks.filter((t) => t.id !== task.id);
          const nextWorks =
            work && !old.works.some((w) => w.id === work.id) ? [...old.works, work] : old.works;
          return { ...old, works: nextWorks, tasks: sortTasksByKey([...filtered, task]) };
        });
        return;
      }

      if (ev.type === 'task.deleted') {
        const { taskId } = ev.payload as TaskDeletedPayload;
        if (activeEditorRef.current?.taskId === taskId) {
          pushToast({ message: '该任务已被他人删除', variant: 'error' });
        }
        queryClient.setQueryData<WorksheetFullResponse>(qKey, (old) =>
          old ? { ...old, tasks: old.tasks.filter((t) => t.id !== taskId) } : old,
        );
        return;
      }

      if (ev.type === 'tasks.reordered') {
        const { updates } = ev.payload as TasksReorderedPayload;
        const map = new Map(updates.map((u) => [u.taskId, u.sortOrder]));
        queryClient.setQueryData<WorksheetFullResponse>(qKey, (old) => {
          if (!old) return old;
          const updated = old.tasks.map((t) => {
            const nextOrder = map.get(t.id);
            return nextOrder !== undefined ? { ...t, sortOrder: nextOrder } : t;
          });
          return { ...old, tasks: sortTasksByKey(updated) };
        });
        return;
      }

      if (ev.type === 'task.updated') {
        const payload = ev.payload as TaskUpdatedPayload;
        const active = activeEditorRef.current;

        if (active && active.taskId === payload.taskId) {
          const colKey = active.columnKey;
          let hit = false;
          let remoteVal = '';
          if (colKey === 'title' && payload.patch.title !== undefined) {
            hit = true;
            remoteVal = payload.patch.title;
          } else if (colKey === 'divisionNote' && payload.patch.divisionNote !== undefined) {
            hit = true;
            remoteVal = payload.patch.divisionNote;
          } else if (payload.patch.customValues && colKey in payload.patch.customValues) {
            hit = true;
            remoteVal = payload.patch.customValues[colKey] ?? '';
          }
          if (hit) {
            setTextConflicts((prev) => {
              const next = new Map(prev);
              next.set(`${payload.taskId}:${colKey}`, {
                actorDisplayName: payload.actorDisplayName,
                remoteValue: remoteVal,
              });
              return next;
            });
          }
        }

        let needRefetch = false;
        queryClient.setQueryData<WorksheetFullResponse>(qKey, (old) => {
          if (!old) return old;
          const existing = old.tasks.find((t) => t.id === payload.taskId);
          if (!existing) {
            needRefetch = true;
            return old;
          }
          if (payload.revision > existing.revision + 1) {
            needRefetch = true;
            return old;
          }
          if (payload.revision <= existing.revision) return old;

          const nextTask: TaskDetail = {
            ...existing,
            ...payload.patch,
            revision: payload.revision,
            customValues: payload.patch.customValues
              ? { ...existing.customValues, ...payload.patch.customValues }
              : existing.customValues,
          };
          const nextWorks =
            payload.work && !old.works.some((w) => w.id === payload.work?.id)
              ? [...old.works, payload.work]
              : old.works;
          return {
            ...old,
            works: nextWorks,
            tasks: old.tasks.map((t) => (t.id === payload.taskId ? nextTask : t)),
          };
        });
        if (needRefetch) refetchWorksheet();
        return;
      }

      if (ev.type === 'stage.updated') {
        const payload = ev.payload as StageUpdatedPayload;
        const active = activeEditorRef.current;
        if (active && active.taskId === payload.taskId && active.columnKey === payload.columnId) {
          setStageConflicts((prev) => {
            const next = new Map(prev);
            next.set(`${payload.taskId}:${payload.columnId}`, {
              actorDisplayName: payload.actorDisplayName,
              remoteCell: payload.cell,
            });
            return next;
          });
        }
        queryClient.setQueryData<WorksheetFullResponse>(qKey, (old) => {
          if (!old) return old;
          return {
            ...old,
            tasks: old.tasks.map((t) => {
              if (t.id !== payload.taskId) return t;
              const cur = t.stageCells[payload.columnId];
              if (cur && payload.cell.revision <= cur.revision) return t;
              return {
                ...t,
                stageCells: { ...t.stageCells, [payload.columnId]: payload.cell },
              };
            }),
          };
        });
      }
    },
  });

  useEffect(() => {
    if (!wsScope || subscribedReady) return;
    if (realtime.getStatus() === 'connected' && realtime.getCursor(wsScope) !== null) {
      setSubscribedReady(true);
      return;
    }
    const fallback = setTimeout(() => setSubscribedReady(true), 800);
    return () => clearTimeout(fallback);
  }, [wsScope, realtime, subscribedReady]);

  const { data, isLoading, error } = useQuery<WorksheetFullResponse, ApiError>({
    queryKey: worksheetId ? queryKeys.worksheet(worksheetId) : ['worksheets', 'none'],
    queryFn: () => apiFetch<WorksheetFullResponse>(`/api/worksheets/${worksheetId}`),
    enabled: Boolean(worksheetId && subscribedReady),
  });

  const { data: users = [] } = useQuery<UserListItem[]>({
    queryKey: queryKeys.users,
    queryFn: () => apiFetch<UserListItem[]>('/api/users'),
  });

  const userMap = useMemo(() => new Map(users.map((u) => [u.id, u.displayName])), [users]);

  const allWorks = useMemo(() => {
    const serverWorks = data?.works ?? [];
    const seen = new Set(serverWorks.map((w) => w.id));
    const extras = pendingWorks.filter((pw) => !seen.has(pw.id));
    return [...serverWorks, ...extras];
  }, [data?.works, pendingWorks]);

  const workMap = useMemo(() => new Map(allWorks.map((w) => [w.id, w])), [allWorks]);

  const locateTaskId = searchParams.get('taskId');
  useEffect(() => {
    if (!locateTaskId || !data) return;
    const target = data.tasks.find((t) => t.id === locateTaskId);
    if (!target) return;
    setViewMode('grid');
    if (target.publishStatus === 'published') {
      setPublishedExpanded(true);
    }
    if (target.workId) {
      const targetWorkId = target.workId;
      setCollapsedWorkIds((prev) => {
        if (!prev.has(targetWorkId)) return prev;
        const next = new Set(prev);
        next.delete(targetWorkId);
        return next;
      });
    }
    setDetailTaskId(target.id);
    setHighlightedTaskId(target.id);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('taskId');
    setSearchParams(nextParams, { replace: true });

    const timer = setTimeout(() => setHighlightedTaskId(null), 2200);
    return () => clearTimeout(timer);
  }, [locateTaskId, data, searchParams, setSearchParams]);

  const setEditingFocus = useCallback(
    (taskId: string | null, columnKey: string | null, editing: boolean) => {
      if (!wsScope) return;
      if (taskId && columnKey) {
        if (editing) {
          activeEditorRef.current = { taskId, columnKey };
        } else if (
          activeEditorRef.current?.taskId === taskId &&
          activeEditorRef.current?.columnKey === columnKey
        ) {
          activeEditorRef.current = null;
        }
        realtime.sendPresence(wsScope, { taskId, columnKey, editing });
      } else {
        activeEditorRef.current = null;
        realtime.sendPresence(wsScope, null);
      }
    },
    [wsScope, realtime],
  );

  const selectCell = useCallback(
    (taskId: string, columnKey: string) => {
      setSelectedCell({ taskId, columnKey });
      setEditingFocus(taskId, columnKey, false);
    },
    [setEditingFocus],
  );

  const onlineUsers = useMemo(() => {
    const byUser = new Map<string, PresencePeer>();
    for (const peer of peers.values()) {
      const prev = byUser.get(peer.userId);
      if (!prev || (!prev.focus && peer.focus)) {
        byUser.set(peer.userId, peer);
      }
    }
    return [...byUser.values()];
  }, [peers]);

  const textAssigneeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const task of data?.tasks ?? []) {
      for (const cell of Object.values(task.stageCells)) {
        for (const a of cell.assignees) {
          if (a.type === 'text') set.add(a.name);
        }
      }
    }
    return [...set].sort();
  }, [data?.tasks]);

  const stageCols = useMemo(
    () => (data?.columns ?? []).filter((c) => c.type === 'stage'),
    [data?.columns],
  );

  const isFilteredOrSorted =
    statusChip !== 'all' ||
    assigneeFilter !== '' ||
    workFilter !== '' ||
    keyword.trim() !== '' ||
    localSort !== 'manual';

  const applyFilterAndSort = useCallback(
    (list: TaskDetail[]) => {
      const kw = keyword.trim().toLowerCase();
      const filtered = list.filter((task) => {
        if (workFilter && task.workId !== workFilter) return false;

        const applicableCells = stageCols
          .map((c) => getEffectiveStageCell(task, c.id))
          .filter((cell) => cell.status !== 'na');

        if (statusChip === 'mine' && me) {
          const hit = applicableCells.some((c) =>
            c.assignees.some((a) => a.type === 'user' && a.userId === me.user.id),
          );
          if (!hit) return false;
        } else if (statusChip === 'not_started') {
          if (!applicableCells.some((c) => c.status === 'not_started')) return false;
        } else if (statusChip === 'in_progress') {
          if (!applicableCells.some((c) => c.status === 'in_progress')) return false;
        } else if (statusChip === 'all_stages_done') {
          if (applicableCells.length === 0 || !applicableCells.every((c) => c.status === 'done')) {
            return false;
          }
        }

        if (assigneeFilter) {
          const [kind, val] = assigneeFilter.split(':');
          const hit = applicableCells.some((c) =>
            c.assignees.some((a) =>
              kind === 'u'
                ? a.type === 'user' && a.userId === val
                : a.type === 'text' && a.name === val,
            ),
          );
          if (!hit) return false;
        }

        if (kw) {
          const wName = task.workId ? (workMap.get(task.workId)?.name ?? '') : '';
          const hit =
            task.title.toLowerCase().includes(kw) ||
            task.divisionNote.toLowerCase().includes(kw) ||
            wName.toLowerCase().includes(kw);
          if (!hit) return false;
        }
        return true;
      });

      if (localSort === 'manual') return filtered;
      return [...filtered].sort((a, b) => {
        if (localSort === 'title') return a.title.localeCompare(b.title, 'zh-CN');
        if (localSort === 'priority') return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        const wa = a.workId ? (workMap.get(a.workId)?.name ?? 'я') : 'я';
        const wb = b.workId ? (workMap.get(b.workId)?.name ?? 'я') : 'я';
        return wa.localeCompare(wb, 'zh-CN');
      });
    },
    [keyword, workFilter, stageCols, statusChip, me, assigneeFilter, workMap, localSort],
  );

  const publishedTasks = useMemo(
    () =>
      applyFilterAndSort(
        (data?.tasks ?? EMPTY_TASKS).filter((t) => t.publishStatus === 'published'),
      ),
    [data?.tasks, applyFilterAndSort],
  );
  const activeTasks = useMemo(
    () =>
      applyFilterAndSort(
        (data?.tasks ?? EMPTY_TASKS).filter((t) => t.publishStatus !== 'published'),
      ),
    [data?.tasks, applyFilterAndSort],
  );
  const totalPublishedCount = useMemo(
    () => (data?.tasks ?? EMPTY_TASKS).filter((t) => t.publishStatus === 'published').length,
    [data?.tasks],
  );

  // 将未发布任务组织为「无作品独立平铺块」+「作品大标题横幅块」
  const displayBlocks = useMemo<GridDisplayBlock[]>(() => {
    const blocks: GridDisplayBlock[] = [];
    const tasksByWorkId = new Map<string, TaskDetail[]>();
    for (const task of activeTasks) {
      if (task.workId) {
        const list = tasksByWorkId.get(task.workId);
        if (list) list.push(task);
        else tasksByWorkId.set(task.workId, [task]);
      }
    }

    const emittedWorkIds = new Set<string>();
    for (const task of activeTasks) {
      if (!task.workId) {
        const last = blocks[blocks.length - 1];
        if (last && last.kind === 'standalone') {
          last.tasks.push(task);
        } else {
          blocks.push({
            kind: 'standalone',
            key: `standalone-${blocks.length}`,
            tasks: [task],
          });
        }
      } else if (!emittedWorkIds.has(task.workId)) {
        emittedWorkIds.add(task.workId);
        const work = workMap.get(task.workId) ?? {
          id: task.workId,
          worksheetId: worksheetId ?? '',
          name: '未命名作品',
          createdAt: '',
          updatedAt: '',
        };
        blocks.push({
          kind: 'work',
          key: `work-${work.id}`,
          work,
          tasks: tasksByWorkId.get(task.workId) ?? [],
          isEmptyPending: false,
        });
      }
    }

    const kw = keyword.trim().toLowerCase();
    for (const pw of pendingWorks) {
      if (emittedWorkIds.has(pw.id)) continue;
      if (workFilter && workFilter !== pw.id) continue;
      if (kw && !pw.name.toLowerCase().includes(kw)) continue;
      blocks.push({
        kind: 'work',
        key: `work-${pw.id}`,
        work: pw,
        tasks: [],
        isEmptyPending: true,
      });
    }

    return blocks;
  }, [activeTasks, workMap, worksheetId, pendingWorks, workFilter, keyword]);

  const visualActiveTasks = useMemo(() => {
    const list: TaskDetail[] = [];
    for (const block of displayBlocks) {
      if (block.kind === 'standalone') {
        list.push(...block.tasks);
      } else if (!collapsedWorkIds.has(block.work.id)) {
        list.push(...block.tasks);
      }
    }
    return list;
  }, [displayBlocks, collapsedWorkIds]);

  // 单表「看板视图」实时推导数据（零额外后端接口，严格复用 @nw/shared computeBoardData）
  const singleSheetBoard = useMemo(() => {
    if (!data || !me) return { boardColumns: [], cards: [] };
    const mappedBoardColIds = new Set(
      data.columns
        .filter((c) => c.type === 'stage' && c.boardColumnId)
        .map((c) => c.boardColumnId as string),
    );
    const relevantBoardCols =
      mappedBoardColIds.size > 0
        ? data.boardColumns.filter((bc) => mappedBoardColIds.has(bc.id))
        : data.boardColumns;
    const computed = computeBoardData({
      boardColumns: relevantBoardCols,
      worksheets: [
        {
          id: data.worksheet.id,
          name: data.worksheet.name,
          color: data.worksheet.color,
          sortOrder: data.worksheet.sortOrder,
        },
      ],
      stageColumns: data.columns,
      works: allWorks,
      tasks: activeTasks,
      currentUserId: me.user.id,
    });
    return { boardColumns: relevantBoardCols, cards: computed.cards };
  }, [data, me, allWorks, activeTasks]);

  const createTaskMutation = useMutation({
    mutationFn: (payload: { title: string; afterTaskId?: string | null; workId?: string | null }) =>
      apiFetch<TaskDetail>(`/api/worksheets/${worksheetId}/tasks`, {
        method: 'POST',
        body: payload,
      }),
    onSuccess: (created) => {
      if (!worksheetId) return;
      const pendingMatch = created.workId
        ? pendingWorks.find((w) => w.id === created.workId)
        : undefined;
      queryClient.setQueryData<WorksheetFullResponse>(queryKeys.worksheet(worksheetId), (old) => {
        if (!old || old.tasks.some((t) => t.id === created.id)) return old;
        const nextWorks =
          pendingMatch && !old.works.some((w) => w.id === pendingMatch.id)
            ? [...old.works, pendingMatch]
            : old.works;
        return { ...old, works: nextWorks, tasks: sortTasksByKey([...old.tasks, created]) };
      });
      if (pendingMatch) {
        setPendingWorks((prev) => prev.filter((w) => w.id !== pendingMatch.id));
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '新建任务失败',
        variant: 'error',
      });
    },
  });

  const patchTask = useCallback(
    async (
      taskId: string,
      changes: Record<string, unknown>,
      baseValues?: Record<string, unknown>,
      force = false,
    ) => {
      const updated = await apiFetch<TaskDetail>(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        body: { changes, baseValues, force },
      });
      if (!worksheetId) return;
      const prevTask = data?.tasks.find((t) => t.id === taskId);
      if (prevTask?.publishStatus === 'unpublished' && updated.publishStatus === 'published') {
        pushToast({ message: '已移入顶部“已发布”折叠区', variant: 'info' });
      }
      queryClient.setQueryData<WorksheetFullResponse>(queryKeys.worksheet(worksheetId), (old) =>
        old ? { ...old, tasks: old.tasks.map((t) => (t.id === updated.id ? updated : t)) } : old,
      );
      if (changes.workName !== undefined || changes.workId !== undefined) {
        if (updated.workId) {
          setPendingWorks((prev) => prev.filter((w) => w.id !== updated.workId));
        }
        refetchWorksheet();
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    [worksheetId, data?.tasks, queryClient, pushToast, refetchWorksheet],
  );

  const patchStage = useCallback(
    async (
      taskId: string,
      columnId: string,
      payload: {
        assignees: Assignee[];
        status: StageStatus;
        note: string;
        baseRevision: number;
        force: boolean;
      },
    ) => {
      const { cell } = await apiFetch<{ cell: StageCell }>(
        `/api/tasks/${taskId}/stages/${columnId}`,
        {
          method: 'PATCH',
          body: payload,
        },
      );
      if (!worksheetId) return;
      queryClient.setQueryData<WorksheetFullResponse>(queryKeys.worksheet(worksheetId), (old) =>
        old
          ? {
              ...old,
              tasks: old.tasks.map((t) =>
                t.id === taskId ? { ...t, stageCells: { ...t.stageCells, [columnId]: cell } } : t,
              ),
            }
          : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
      void queryClient.invalidateQueries({ queryKey: queryKeys.myTasks });
    },
    [worksheetId, queryClient],
  );

  const handleBoardClaim = async (taskId: string, columnId: string, stageName: string) => {
    const key = `${taskId}:${columnId}`;
    if (claimingKeys.has(key)) return;
    setClaimingKeys((prev) => new Set(prev).add(key));
    try {
      await apiFetch(`/api/tasks/${taskId}/stages/${columnId}/claim`, { method: 'POST' });
      pushToast({ message: `已认领「${stageName}」（保持未开始）`, variant: 'success' });
      refetchWorksheet();
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
      void queryClient.invalidateQueries({ queryKey: queryKeys.myTasks });
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : '认领失败',
        variant: 'error',
      });
      refetchWorksheet();
    } finally {
      setClaimingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const deleteTask = useCallback(
    async (task: TaskDetail) => {
      try {
        await apiFetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
        if (!worksheetId) return;
        queryClient.setQueryData<WorksheetFullResponse>(queryKeys.worksheet(worksheetId), (old) =>
          old ? { ...old, tasks: old.tasks.filter((t) => t.id !== task.id) } : old,
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
        void queryClient.invalidateQueries({ queryKey: queryKeys.board });
        pushToast({
          message: `已删除任务「${task.title}」`,
          variant: 'info',
          actionLabel: '撤销',
          onAction: async () => {
            await apiFetch(`/api/tasks/${task.id}/restore`, { method: 'POST' });
            refetchWorksheet();
            void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
            void queryClient.invalidateQueries({ queryKey: queryKeys.board });
            pushToast({ message: '任务已恢复', variant: 'success' });
          },
        });
      } catch (err) {
        pushToast({
          message: err instanceof ApiError ? err.message : '删除失败',
          variant: 'error',
        });
      }
    },
    [worksheetId, queryClient, pushToast, refetchWorksheet],
  );

  const handleReorderRows = useCallback(
    async (movingTaskId: string, dropRowIndex: number) => {
      if (isFilteredOrSorted || !worksheetId) return;
      const movingTask = visualActiveTasks.find((t) => t.id === movingTaskId);
      if (!movingTask) return;
      const clampedIdx = Math.max(0, Math.min(visualActiveTasks.length - 1, dropRowIndex));
      const overTask = visualActiveTasks[clampedIdx];
      const targetWorkId = overTask ? overTask.workId : null;
      const targetList = visualActiveTasks.filter((t) => t.id !== movingTaskId);
      const afterTaskId = clampedIdx > 0 ? (targetList[clampedIdx - 1]?.id ?? null) : null;
      const beforeTaskId =
        clampedIdx < targetList.length ? (targetList[clampedIdx]?.id ?? null) : null;

      try {
        if (movingTask.workId !== targetWorkId) {
          await patchTask(
            movingTaskId,
            { workId: targetWorkId },
            { workId: movingTask.workId },
            true,
          );
        }
        const { updates } = await apiFetch<{
          updates: Array<{ taskId: string; sortOrder: string }>;
        }>(`/api/worksheets/${worksheetId}/tasks/reorder`, {
          method: 'POST',
          body: { taskId: movingTaskId, afterTaskId, beforeTaskId },
        });
        const map = new Map(updates.map((u) => [u.taskId, u.sortOrder]));
        queryClient.setQueryData<WorksheetFullResponse>(queryKeys.worksheet(worksheetId), (old) => {
          if (!old) return old;
          const next = old.tasks.map((t) => {
            const s = map.get(t.id);
            return s !== undefined ? { ...t, sortOrder: s } : t;
          });
          return { ...old, tasks: sortTasksByKey(next) };
        });
      } catch {
        refetchWorksheet();
      }
    },
    [isFilteredOrSorted, worksheetId, visualActiveTasks, patchTask, queryClient, refetchWorksheet],
  );

  const handleResizeColumn = useCallback(
    (colId: string, width: number, isSystem: boolean) => {
      if (!worksheetId) return;
      if (isSystem) {
        const sysKey = colId as keyof SystemColumnsConfig;
        void apiFetch(`/api/worksheets/${worksheetId}`, {
          method: 'PATCH',
          body: { systemColumns: { [sysKey]: { width } } },
        }).then(() => refetchWorksheet());
      } else {
        void apiFetch(`/api/worksheets/${worksheetId}/columns/${colId}`, {
          method: 'PATCH',
          body: { width },
        }).then(() => refetchWorksheet());
      }
    },
    [worksheetId, refetchWorksheet],
  );

  const renameWork = useCallback(
    async (targetWorkId: string, newName: string) => {
      if (!worksheetId) return;
      try {
        const updated = await apiFetch<Work>(
          `/api/worksheets/${worksheetId}/works/${targetWorkId}`,
          {
            method: 'PATCH',
            body: { name: newName },
          },
        );
        queryClient.setQueryData<WorksheetFullResponse>(queryKeys.worksheet(worksheetId), (old) =>
          old ? { ...old, works: old.works.map((w) => (w.id === updated.id ? updated : w)) } : old,
        );
        setPendingWorks((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
        void queryClient.invalidateQueries({ queryKey: queryKeys.board });
        pushToast({ message: '作品名已更新', variant: 'success' });
      } catch (err) {
        pushToast({
          message: err instanceof ApiError ? err.message : '重命名作品失败',
          variant: 'error',
        });
        throw err;
      }
    },
    [worksheetId, queryClient, pushToast],
  );

  const handleConfirmUngroupWork = useCallback(async () => {
    if (!ungroupingWork || !worksheetId) return;
    setUngroupPending(true);
    try {
      const { work, tasks } = ungroupingWork;
      for (const task of tasks) {
        await apiFetch(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          body: { changes: { workId: null }, force: true },
        });
      }
      setUngroupingWork(null);
      if (addingSegmentWorkId === work.id) setAddingSegmentWorkId(null);
      setPendingWorks((prev) => prev.filter((w) => w.id !== work.id));
      refetchWorksheet();
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
      pushToast({
        message: `已将「${work.name}」下 ${tasks.length} 条任务移出为独立任务`,
        variant: 'info',
      });
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : '解散分组失败',
        variant: 'error',
      });
    } finally {
      setUngroupPending(false);
    }
  }, [ungroupingWork, worksheetId, addingSegmentWorkId, refetchWorksheet, queryClient, pushToast]);

  const toggleWorkCollapsed = useCallback((workId: string) => {
    setCollapsedWorkIds((prev) => {
      const next = new Set(prev);
      if (next.has(workId)) next.delete(workId);
      else next.add(workId);
      return next;
    });
  }, []);

  const openAddSegmentForWork = useCallback((workId: string) => {
    setCollapsedWorkIds((prev) => {
      if (!prev.has(workId)) return prev;
      const next = new Set(prev);
      next.delete(workId);
      return next;
    });
    setAddingSegmentWorkId(workId);
  }, []);

  const clearTextConflict = useCallback((key: string) => {
    setTextConflicts((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const clearStageConflict = useCallback((key: string) => {
    setStageConflicts((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const acceptRemoteField = useCallback(
    (taskId: string, field: string, remoteVal: string) => {
      if (!worksheetId) return;
      queryClient.setQueryData<WorksheetFullResponse>(queryKeys.worksheet(worksheetId), (old) => {
        if (!old) return old;
        return {
          ...old,
          tasks: old.tasks.map((t) => {
            if (t.id !== taskId) return t;
            if (field === 'title') return { ...t, title: remoteVal };
            if (field === 'divisionNote') return { ...t, divisionNote: remoteVal };
            return { ...t, customValues: { ...t.customValues, [field]: remoteVal || null } };
          }),
        };
      });
    },
    [worksheetId, queryClient],
  );

  if (isLoading || !subscribedReady) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
        正在加载工作表…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
        <p className="text-sm text-zinc-600">工作表不存在或已被删除</p>
        <Button
          type="button"
          variant="secondary"
          className="mt-3"
          onClick={() => navigate('/worksheets')}
        >
          返回工作表总览
        </Button>
      </div>
    );
  }

  const wsColor = WORKSHEET_COLOR_STYLES[data.worksheet.color] ?? WORKSHEET_COLOR_STYLES.sky;
  const dragEnabled = !isFilteredOrSorted;

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* 上层 44px Teable 风格视图标签栏 */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-black/[0.08] px-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarExpandButton />
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', wsColor.dot)} />
            <h1 className="truncate text-[14px] font-semibold text-zinc-950">
              {data.worksheet.name}
            </h1>
          </div>

          <span className="hidden h-4 w-px bg-black/[0.08] sm:inline-block" />

          {/* 表格视图 / 看板视图标签切换（motion layoutId 平滑滑移指示线） */}
          <div className="flex h-11 items-center gap-1" role="tablist" aria-label="工作表视图">
            {(
              [
                { id: 'grid', label: '表格视图', icon: Table2, testId: 'view-tab-grid' },
                { id: 'board', label: '看板视图', icon: Kanban, testId: 'view-tab-board' },
              ] as const
            ).map((tab) => {
              const active = viewMode === tab.id;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={tab.testId}
                  onClick={() => setViewMode(tab.id)}
                  className={cn(
                    'relative inline-flex h-11 items-center gap-1.5 px-2.5 text-xs font-medium transition-colors cursor-pointer',
                    active ? 'text-zinc-950' : 'text-zinc-500 hover:text-zinc-900',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                  <span>{tab.label}</span>
                  {active && (
                    <motion.span
                      layoutId="worksheet-view-tab-indicator"
                      transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                      className="absolute right-1.5 bottom-0 left-1.5 h-[2px] rounded-full bg-zinc-950"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {onlineUsers.length > 0 && (
            <div
              data-testid="presence-bar"
              className="flex items-center gap-1 rounded-full border border-black/[0.08] bg-[#fafafa] px-2 py-0.5"
            >
              <span className="hidden text-[11px] text-zinc-400 sm:inline">在线</span>
              {onlineUsers.map((peer) => {
                const color = peerColorForUser(peer.userId);
                return (
                  <span
                    key={peer.userId}
                    title={
                      peer.focus
                        ? `${peer.displayName}${peer.focus.editing ? '（正在编辑）' : '（正在查看）'}`
                        : `${peer.displayName}（在线）`
                    }
                    className={cn(
                      'inline-flex items-center rounded-full px-1.5 py-0.25 text-[11px] font-medium',
                      color.bg,
                      color.text,
                    )}
                  >
                    {peer.displayName}
                  </span>
                );
              })}
            </div>
          )}

          <button
            type="button"
            onClick={() => setLogsOpen(true)}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-black/[0.04] hover:text-zinc-950 cursor-pointer"
          >
            <History className="h-3.5 w-3.5 text-zinc-400" strokeWidth={1.75} />
            <span className="hidden sm:inline">修改记录</span>
            <span className="sr-only sm:hidden">修改记录</span>
          </button>
        </div>
      </div>

      {/* 下层 36px 极简图标工具栏 */}
      <div className="flex min-h-[36px] shrink-0 flex-wrap items-center gap-1.5 border-b border-black/[0.08] bg-[#fafafa]/60 px-3 py-1">
        <CreateWorkPopover
          worksheetId={data.worksheet.id}
          onCreated={(createdWork) => {
            setViewMode('grid');
            setPendingWorks((prev) =>
              prev.some((w) => w.id === createdWork.id) ||
              data.works.some((w) => w.id === createdWork.id)
                ? prev
                : [...prev, createdWork],
            );
            openAddSegmentForWork(createdWork.id);
          }}
        />

        {viewMode === 'grid' && (
          <>
            <FieldVisibilityPopover
              worksheet={data.worksheet}
              columns={data.columns}
              onOpenFullModal={() => setColModalOpen(true)}
            />
            <AddColumnPopover
              worksheetId={data.worksheet.id}
              columns={data.columns}
              boardColumns={data.boardColumns}
            />
          </>
        )}

        <span className="hidden h-4 w-px bg-black/[0.08] sm:inline-block" />

        <div className="flex flex-wrap items-center gap-0.5">
          {(
            [
              ['all', '全部'],
              ['mine', '我的'],
              ['not_started', '未开始'],
              ['in_progress', '进行中'],
              ['all_stages_done', '全工序已完成'],
            ] as const
          ).map(([val, label]) => (
            <button
              key={val}
              type="button"
              onClick={() => setStatusChip(val)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium transition-colors cursor-pointer',
                statusChip === val
                  ? 'bg-black/[0.07] text-zinc-950'
                  : 'text-zinc-500 hover:bg-black/[0.04] hover:text-zinc-900',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="筛选关键词…"
              aria-label="表内筛选关键词"
              className="h-7 w-32 pl-7 text-xs sm:w-36"
            />
          </div>

          <SelectField
            aria-label="按作品筛选"
            size="xs"
            value={workFilter}
            onValueChange={setWorkFilter}
            className="w-28 sm:w-32"
            options={[
              { value: '', label: '全部作品' },
              ...allWorks.map((w) => ({ value: w.id, label: w.name })),
            ]}
          />

          <SelectField
            aria-label="按负责人筛选"
            size="xs"
            value={assigneeFilter}
            onValueChange={setAssigneeFilter}
            className="w-28 sm:w-32"
            options={[
              { value: '', label: '全部负责人' },
              ...users.map((u) => ({
                value: `u:${u.id}`,
                label: u.displayName,
                group: '项目用户',
              })),
              ...textAssigneeOptions.map((name) => ({
                value: `t:${name}`,
                label: name,
                group: '纯文本负责人',
              })),
            ]}
          />

          {viewMode === 'grid' && (
            <SelectField
              aria-label="本地排序"
              size="xs"
              align="end"
              leadingIcon={<ArrowUpDown className="h-3 w-3" />}
              value={localSort}
              onValueChange={(v) => setLocalSort(v as LocalSort)}
              className="w-32 sm:w-36"
              options={[
                { value: 'manual', label: '默认顺序' },
                { value: 'title', label: '按标题排序' },
                { value: 'priority', label: '按优先级排序' },
                { value: 'work', label: '按作品排序' },
              ]}
            />
          )}

          {isFilteredOrSorted && (
            <button
              type="button"
              title="恢复默认顺序后可拖动调整行序"
              onClick={() => {
                setStatusChip('all');
                setAssigneeFilter('');
                setWorkFilter('');
                setKeyword('');
                setLocalSort('manual');
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-zinc-700 hover:bg-black/[0.05] cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" />
              重置
            </button>
          )}
        </div>
      </div>

      {/* 顶部紧凑 30px「已发布（N 条）」折叠条 */}
      {totalPublishedCount > 0 && (
        <div
          data-testid="published-section"
          className="shrink-0 border-b border-black/[0.08] bg-[#ECFDF5]/60"
        >
          <button
            type="button"
            onClick={() => setPublishedExpanded((v) => !v)}
            className="flex h-[30px] w-full items-center justify-between px-3 text-left text-xs font-medium text-emerald-900 transition-colors hover:bg-[#ECFDF5] cursor-pointer"
          >
            <span className="inline-flex items-center gap-1.5">
              {publishedExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              已发布（{publishedTasks.length} 条）
            </span>
            <span className="text-[11px] font-normal text-emerald-700/80">
              {publishedExpanded ? '收起' : '展开查看'}
            </span>
          </button>

          {publishedExpanded && (
            <div className="max-h-[30vh] divide-y divide-black/[0.05] overflow-y-auto border-t border-black/[0.06] bg-white">
              {publishedTasks.map((task) => {
                const w = task.workId ? workMap.get(task.workId) : null;
                return (
                  <div
                    key={task.id}
                    className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs hover:bg-black/[0.02]"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {w && (
                        <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600">
                          {w.name}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setDetailTaskId(task.id)}
                        className="truncate font-medium text-zinc-900 hover:text-blue-600 cursor-pointer"
                      >
                        {task.title}
                      </button>
                      {task.publishedAt && (
                        <span className="shrink-0 text-[11px] text-zinc-400 tabular-nums">
                          {task.publishedAt}
                        </span>
                      )}
                      {task.publishUrl && /^https?:\/\//i.test(task.publishUrl) && (
                        <a
                          href={task.publishUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="打开发布链接"
                          className="shrink-0 text-blue-600 hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        onClick={() =>
                          void patchTask(task.id, { publishStatus: 'unpublished' }, undefined, true)
                        }
                      >
                        改为未发布
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => setDetailTaskId(task.id)}
                      >
                        详情
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 主视图区：Teable Canvas Grid 或 单表作品聚合看板 */}
      {viewMode === 'grid' ? (
        <WorksheetCanvasGrid
          worksheet={data.worksheet}
          columns={data.columns}
          boardColumns={data.boardColumns}
          works={allWorks}
          workMap={workMap}
          displayBlocks={displayBlocks}
          visualActiveTasks={visualActiveTasks}
          stageCols={stageCols}
          users={users}
          userMap={userMap}
          peers={peers}
          selectedCell={selectedCell}
          textConflicts={textConflicts}
          stageConflicts={stageConflicts}
          highlightedTaskId={highlightedTaskId}
          collapsedWorkIds={collapsedWorkIds}
          addingSegmentWorkId={addingSegmentWorkId}
          dragEnabled={dragEnabled}
          isFilteredOrSorted={isFilteredOrSorted}
          createTaskPending={createTaskMutation.isPending}
          onSelectCell={selectCell}
          onSetEditingFocus={setEditingFocus}
          onPatchTask={patchTask}
          onPatchStage={patchStage}
          onCreateTask={(payload) => createTaskMutation.mutate(payload)}
          onDeleteTask={(t) => void deleteTask(t)}
          onReorderRows={(movingTaskId, dropRowIndex) =>
            void handleReorderRows(movingTaskId, dropRowIndex)
          }
          onResizeColumn={handleResizeColumn}
          onToggleWorkCollapsed={toggleWorkCollapsed}
          onRenameWork={renameWork}
          onOpenAddSegment={openAddSegmentForWork}
          onCloseAddSegment={() => setAddingSegmentWorkId(null)}
          onUngroupWork={(block) => {
            if (block.isEmptyPending || block.tasks.length === 0) {
              setPendingWorks((prev) => prev.filter((w) => w.id !== block.work.id));
              if (addingSegmentWorkId === block.work.id) setAddingSegmentWorkId(null);
              pushToast({ message: '已关闭空作品横幅', variant: 'info' });
            } else {
              setUngroupingWork({ work: block.work, tasks: block.tasks });
            }
          }}
          onOpenDetail={setDetailTaskId}
          onClearTextConflict={clearTextConflict}
          onClearStageConflict={clearStageConflict}
          onAcceptRemoteField={acceptRemoteField}
        />
      ) : (
        <KanbanBoard
          boardColumns={singleSheetBoard.boardColumns}
          cards={singleSheetBoard.cards}
          userMap={userMap}
          claimingKeys={claimingKeys}
          showWorksheetSource={false}
          onClaim={handleBoardClaim}
          onOpenDetail={({ taskId }) => setDetailTaskId(taskId)}
          onSelectWorkFilter={({ workId }) =>
            setWorkFilter((prev) => (prev === workId ? '' : workId))
          }
        />
      )}

      {/* 解散作品分组二次确认 */}
      <ConfirmDialog
        open={Boolean(ungroupingWork)}
        onOpenChange={(open) => {
          if (!open) setUngroupingWork(null);
        }}
        title="确认解散作品分组"
        message={`确定要解散作品「${ungroupingWork?.work.name ?? ''}」的分组吗？旗下 ${ungroupingWork?.tasks.length ?? 0} 条任务将转为无作品独立任务，不会删除任何任务或分工数据。`}
        confirmLabel="确认解散"
        danger={false}
        pending={ungroupPending}
        onConfirm={() => void handleConfirmUngroupWork()}
      />

      <ColumnManagerModal
        open={colModalOpen}
        onOpenChange={setColModalOpen}
        worksheet={data.worksheet}
        columns={data.columns}
        boardColumns={data.boardColumns}
      />

      <ChangeLogDrawer worksheetId={data.worksheet.id} open={logsOpen} onOpenChange={setLogsOpen} />

      <TaskDetailDrawer
        worksheetId={data.worksheet.id}
        taskId={detailTaskId}
        open={Boolean(detailTaskId)}
        onClose={() => setDetailTaskId(null)}
        showLocateButton={false}
      />
    </div>
  );
}
