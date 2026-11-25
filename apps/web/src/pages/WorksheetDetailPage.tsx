import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  type Assignee,
  type ColumnChangedPayload,
  type ColumnConfig,
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
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Columns3,
  FolderOpen,
  GripVertical,
  History,
  PanelRightOpen,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import {
  createContext,
  type FormEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import { TaskDetailDrawer } from '@/components/task/TaskDetailDrawer.js';
import { peerColorForUser, WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import { useToast } from '@/components/ui/overlays.js';
import { Button, cn, Input } from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';
import {
  type ActiveCellConflict,
  InlineTextCell,
  PriorityCellEditor,
  PublishCellEditor,
  type StageCellConflict,
  StageCellEditor,
  WorkCellEditor,
} from '@/components/worksheet/CellEditors.js';
import { ChangeLogDrawer } from '@/components/worksheet/ChangeLogDrawer.js';
import { ColumnManagerModal } from '@/components/worksheet/ColumnManagerModal.js';
import { useRealtimeClient, useRealtimeScope } from '@/realtime/context.js';

const TABLE_FEATURES = tableFeatures({});
const columnHelper = createColumnHelper<typeof TABLE_FEATURES, TaskDetail>();
const EMPTY_TASKS: TaskDetail[] = [];

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

// ---- 稳定单元格上下文（避免 FlexRender 因列定义变更而卸载单元格、丢失输入态/IME） ----

interface WorksheetGridContextValue {
  works: Work[];
  users: UserListItem[];
  userMap: Map<string, string>;
  selectedCell: { taskId: string; columnKey: string } | null;
  peerByCell: Map<string, PresencePeer>;
  textConflicts: Map<string, ActiveCellConflict>;
  stageConflicts: Map<string, StageCellConflict>;
  setSelectedCell: (cell: { taskId: string; columnKey: string } | null) => void;
  reportFocus: (taskId: string | null, columnKey: string | null, editing: boolean) => void;
  clearTextConflict: (key: string) => void;
  clearStageConflict: (key: string) => void;
  acceptRemoteField: (taskId: string, field: string, remoteVal: string) => void;
  patchTask: (
    taskId: string,
    changes: Record<string, unknown>,
    baseValues?: Record<string, unknown>,
    force?: boolean,
  ) => Promise<void>;
  patchStage: (
    taskId: string,
    columnId: string,
    payload: {
      assignees: Assignee[];
      status: StageStatus;
      note: string;
      baseRevision: number;
      force: boolean;
    },
  ) => Promise<void>;
  renameWork: (targetWorkId: string, newName: string) => Promise<void>;
  openDetail: (taskId: string) => void;
}

const WorksheetGridContext = createContext<WorksheetGridContextValue | null>(null);

function useWorksheetGrid(): WorksheetGridContextValue {
  const ctx = useContext(WorksheetGridContext);
  if (!ctx) throw new Error('WorksheetGridContext missing');
  return ctx;
}

function TitleGridCell({ row }: { row: { original: TaskDetail } }) {
  const ctx = useWorksheetGrid();
  const task = row.original;
  const conflictKey = `${task.id}:title`;
  return (
    <InlineTextCell
      taskId={task.id}
      columnKey="title"
      value={task.title}
      required
      selected={ctx.selectedCell?.taskId === task.id && ctx.selectedCell.columnKey === 'title'}
      peer={ctx.peerByCell.get(conflictKey)}
      remoteConflict={ctx.textConflicts.get(conflictKey) ?? null}
      onSelect={() => {
        ctx.setSelectedCell({ taskId: task.id, columnKey: 'title' });
        ctx.reportFocus(task.id, 'title', false);
      }}
      onEditingChange={(ed) => ctx.reportFocus(task.id, 'title', ed)}
      onClearConflict={() => ctx.clearTextConflict(conflictKey)}
      onAcceptRemote={(val) => ctx.acceptRemoteField(task.id, 'title', val)}
      onCommit={(nextVal, baseVal, force) =>
        ctx.patchTask(task.id, { title: nextVal }, { title: baseVal }, force)
      }
    />
  );
}

function WorkGridCell({ row }: { row: { original: TaskDetail } }) {
  const ctx = useWorksheetGrid();
  const task = row.original;
  return (
    <WorkCellEditor
      taskId={task.id}
      workId={task.workId}
      works={ctx.works}
      peer={ctx.peerByCell.get(`${task.id}:work`)}
      onFocusChange={(ed) =>
        ed === null ? ctx.reportFocus(null, null, false) : ctx.reportFocus(task.id, 'work', ed)
      }
      onSelectWork={(next) => ctx.patchTask(task.id, next, { workId: task.workId }, true)}
      onRenameWork={ctx.renameWork}
    />
  );
}

function DivisionNoteGridCell({ row }: { row: { original: TaskDetail } }) {
  const ctx = useWorksheetGrid();
  const task = row.original;
  const conflictKey = `${task.id}:divisionNote`;
  return (
    <InlineTextCell
      taskId={task.id}
      columnKey="divisionNote"
      value={task.divisionNote}
      placeholder="填写分工说明"
      selected={
        ctx.selectedCell?.taskId === task.id && ctx.selectedCell.columnKey === 'divisionNote'
      }
      peer={ctx.peerByCell.get(conflictKey)}
      remoteConflict={ctx.textConflicts.get(conflictKey) ?? null}
      onSelect={() => {
        ctx.setSelectedCell({ taskId: task.id, columnKey: 'divisionNote' });
        ctx.reportFocus(task.id, 'divisionNote', false);
      }}
      onEditingChange={(ed) => ctx.reportFocus(task.id, 'divisionNote', ed)}
      onClearConflict={() => ctx.clearTextConflict(conflictKey)}
      onAcceptRemote={(val) => ctx.acceptRemoteField(task.id, 'divisionNote', val)}
      onCommit={(nextVal, baseVal, force) =>
        ctx.patchTask(task.id, { divisionNote: nextVal }, { divisionNote: baseVal }, force)
      }
    />
  );
}

function StageGridCell({
  row,
  column,
}: {
  row: { original: TaskDetail };
  column: { columnDef: { meta?: unknown } };
}) {
  const ctx = useWorksheetGrid();
  const col = (column.columnDef.meta as { columnConfig: ColumnConfig }).columnConfig;
  const task = row.original;
  const cell = getEffectiveStageCell(task, col.id);
  const conflictKey = `${task.id}:${col.id}`;
  return (
    <StageCellEditor
      taskId={task.id}
      columnId={col.id}
      columnName={col.name}
      cell={cell}
      users={ctx.users}
      userMap={ctx.userMap}
      peer={ctx.peerByCell.get(conflictKey)}
      remoteConflict={ctx.stageConflicts.get(conflictKey) ?? null}
      onFocusChange={(ed) =>
        ed === null ? ctx.reportFocus(null, null, false) : ctx.reportFocus(task.id, col.id, ed)
      }
      onClearConflict={() => ctx.clearStageConflict(conflictKey)}
      onCommit={(payload) => ctx.patchStage(task.id, col.id, payload)}
    />
  );
}

function CustomGridCell({
  row,
  column,
}: {
  row: { original: TaskDetail };
  column: { columnDef: { meta?: unknown } };
}) {
  const ctx = useWorksheetGrid();
  const col = (column.columnDef.meta as { columnConfig: ColumnConfig }).columnConfig;
  const customInputType: 'text' | 'date' | 'link' =
    col.type === 'date' || col.type === 'link' ? col.type : 'text';
  const task = row.original;
  const val = task.customValues[col.id] ?? '';
  const conflictKey = `${task.id}:${col.id}`;
  return (
    <InlineTextCell
      taskId={task.id}
      columnKey={col.id}
      value={val}
      inputType={customInputType}
      placeholder={col.type === 'link' ? 'https://...' : ''}
      selected={ctx.selectedCell?.taskId === task.id && ctx.selectedCell.columnKey === col.id}
      peer={ctx.peerByCell.get(conflictKey)}
      remoteConflict={ctx.textConflicts.get(conflictKey) ?? null}
      onSelect={() => {
        ctx.setSelectedCell({ taskId: task.id, columnKey: col.id });
        ctx.reportFocus(task.id, col.id, false);
      }}
      onEditingChange={(ed) => ctx.reportFocus(task.id, col.id, ed)}
      onClearConflict={() => ctx.clearTextConflict(conflictKey)}
      onAcceptRemote={(remoteVal) => ctx.acceptRemoteField(task.id, col.id, remoteVal)}
      onCommit={(nextVal, baseVal, force) =>
        ctx.patchTask(
          task.id,
          { customValues: { [col.id]: nextVal || null } },
          { customValues: { [col.id]: baseVal || null } },
          force,
        )
      }
    />
  );
}

function PriorityGridCell({ row }: { row: { original: TaskDetail } }) {
  const ctx = useWorksheetGrid();
  const task = row.original;
  return (
    <PriorityCellEditor
      taskId={task.id}
      priority={task.priority}
      peer={ctx.peerByCell.get(`${task.id}:priority`)}
      onSelect={(next) =>
        ctx.patchTask(task.id, { priority: next }, { priority: task.priority }, true)
      }
    />
  );
}

function PublishGridCell({ row }: { row: { original: TaskDetail } }) {
  const ctx = useWorksheetGrid();
  const task = row.original;
  return (
    <PublishCellEditor
      taskId={task.id}
      publishStatus={task.publishStatus}
      publishedAt={task.publishedAt}
      publishUrl={task.publishUrl}
      peer={ctx.peerByCell.get(`${task.id}:publish`)}
      onFocusChange={(ed) =>
        ed === null ? ctx.reportFocus(null, null, false) : ctx.reportFocus(task.id, 'publish', ed)
      }
      onSave={(patch) => ctx.patchTask(task.id, patch, undefined, true)}
    />
  );
}

function FilesGridCell({ row }: { row: { original: TaskDetail } }) {
  const ctx = useWorksheetGrid();
  return (
    <button
      type="button"
      onClick={() => ctx.openDetail(row.original.id)}
      className="flex min-h-[38px] w-full items-center gap-1 px-2 text-xs text-slate-400 hover:bg-slate-50 hover:text-slate-600 cursor-pointer"
      title="任务文件将在阶段 3 启用，点击打开详情"
    >
      <FolderOpen className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">阶段 3</span>
    </button>
  );
}

function SortableTableRow({
  task,
  dragEnabled,
  highlighted,
  onInsertBelow,
  onOpenDetail,
  onDelete,
  children,
}: {
  task: TaskDetail;
  dragEnabled: boolean;
  highlighted: boolean;
  onInsertBelow: () => void;
  onOpenDetail: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !dragEnabled,
  });

  return (
    <tr
      ref={setNodeRef}
      data-task-row={task.id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group border-b border-slate-200 bg-white hover:bg-slate-50/70',
        isDragging && 'relative z-30 shadow-md ring-2 ring-slate-900/20',
        highlighted && 'bg-amber-50 ring-2 ring-inset ring-amber-400 transition-colors',
      )}
    >
      <td className="sticky left-0 z-20 w-[72px] min-w-[72px] border-r border-slate-200 bg-white px-1 group-hover:bg-slate-50">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            {...(dragEnabled ? attributes : {})}
            {...(dragEnabled ? listeners : {})}
            disabled={!dragEnabled}
            aria-label={`拖动排序 ${task.title}`}
            title={dragEnabled ? '拖动调整行序' : '恢复默认顺序后可拖动调整行序'}
            className={cn(
              'rounded p-1 text-slate-400',
              dragEnabled
                ? 'cursor-grab hover:bg-slate-200/70 hover:text-slate-700 active:cursor-grabbing'
                : 'cursor-not-allowed opacity-30',
            )}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onInsertBelow}
            title="在下方插入行"
            aria-label={`在 ${task.title} 下方插入行`}
            className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200/70 hover:text-slate-800 group-hover:opacity-100 focus:opacity-100 cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onOpenDetail}
            title="打开详情"
            aria-label={`打开 ${task.title} 详情`}
            className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200/70 hover:text-slate-800 group-hover:opacity-100 focus:opacity-100 cursor-pointer"
          >
            <PanelRightOpen className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
      {children}
      <td className="w-10 min-w-10 border-l border-slate-100 px-1 text-center">
        <button
          type="button"
          onClick={onDelete}
          title="删除任务"
          aria-label={`删除任务 ${task.title}`}
          className="rounded p-1 text-slate-400 opacity-0 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus:opacity-100 cursor-pointer"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}

export function WorksheetDetailPage() {
  const { id: worksheetId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const realtime = useRealtimeClient();
  const { pushToast } = useToast();

  const [subscribedReady, setSubscribedReady] = useState(false);
  const [peers, setPeers] = useState<Map<string, PresencePeer>>(new Map());
  const [selectedCell, setSelectedCell] = useState<{ taskId: string; columnKey: string } | null>(
    null,
  );
  const activeEditorRef = useRef<{ taskId: string; columnKey: string } | null>(null);
  const [textConflicts, setTextConflicts] = useState<Map<string, ActiveCellConflict>>(new Map());
  const [stageConflicts, setStageConflicts] = useState<Map<string, StageCellConflict>>(new Map());

  const [colModalOpen, setColModalOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [publishedExpanded, setPublishedExpanded] = useState(false);
  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(null);
  const [quickAddTitle, setQuickAddTitle] = useState('');
  const [insertingAfterId, setInsertingAfterId] = useState<string | null>(null);
  const [insertTitle, setInsertTitle] = useState('');

  const [statusChip, setStatusChip] = useState<StatusChip>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('');
  const [workFilter, setWorkFilter] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [localSort, setLocalSort] = useState<LocalSort>('manual');
  const [previewWidths, setPreviewWidths] = useState<Record<string, number>>({});

  const wsScope = useMemo(
    () => (worksheetId ? { type: 'worksheet', id: worksheetId } : null),
    [worksheetId],
  );

  useEffect(() => {
    if (!worksheetId) return;
    setSubscribedReady(false);
    setPeers(new Map());
    setSelectedCell(null);
    activeEditorRef.current = null;
    setTextConflicts(new Map());
    setStageConflicts(new Map());
    setPublishedExpanded(false);
    setPreviewWidths({});
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
        if (p.action === 'reordered' && p.columns) {
          queryClient.setQueryData<WorksheetFullResponse>(qKey, (old) =>
            old ? { ...old, columns: p.columns! } : old,
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
            payload.work && !old.works.some((w) => w.id === payload.work!.id)
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
  const workMap = useMemo(() => new Map((data?.works ?? []).map((w) => [w.id, w])), [data?.works]);

  const locateTaskId = searchParams.get('taskId');
  useEffect(() => {
    if (!locateTaskId || !data) return;
    const target = data.tasks.find((t) => t.id === locateTaskId);
    if (!target) return;
    if (target.publishStatus === 'published') {
      setPublishedExpanded(true);
    }
    setDetailTaskId(target.id);
    setHighlightedTaskId(target.id);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('taskId');
    setSearchParams(nextParams, { replace: true });

    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-task-row="${target.id}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const timer = setTimeout(() => setHighlightedTaskId(null), 2200);
    return () => clearTimeout(timer);
  }, [locateTaskId, data, searchParams, setSearchParams]);

  const reportFocus = useCallback(
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

  const peerByCell = useMemo(() => {
    const map = new Map<string, PresencePeer>();
    for (const peer of peers.values()) {
      if (peer.focus) {
        map.set(`${peer.focus.taskId}:${peer.focus.columnKey}`, peer);
      }
    }
    return map;
  }, [peers]);

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

  const createTaskMutation = useMutation({
    mutationFn: (payload: { title: string; afterTaskId?: string | null }) =>
      apiFetch<TaskDetail>(`/api/worksheets/${worksheetId}/tasks`, {
        method: 'POST',
        body: payload,
      }),
    onSuccess: (created) => {
      if (!worksheetId) return;
      queryClient.setQueryData<WorksheetFullResponse>(queryKeys.worksheet(worksheetId), (old) => {
        if (!old || old.tasks.some((t) => t.id === created.id)) return old;
        return { ...old, tasks: sortTasksByKey([...old.tasks, created]) };
      });
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

  const renameWork = useCallback(
    async (targetWorkId: string, newName: string) => {
      if (!worksheetId) return;
      const updated = await apiFetch<Work>(`/api/worksheets/${worksheetId}/works/${targetWorkId}`, {
        method: 'PATCH',
        body: { name: newName },
      });
      queryClient.setQueryData<WorksheetFullResponse>(queryKeys.worksheet(worksheetId), (old) =>
        old ? { ...old, works: old.works.map((w) => (w.id === updated.id ? updated : w)) } : old,
      );
      pushToast({ message: '作品名已更新', variant: 'success' });
    },
    [worksheetId, queryClient, pushToast],
  );

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

  const startResize = useCallback(
    (colId: string, startWidth: number, isSystem: boolean, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      let latestWidth = startWidth;

      const onMove = (moveEv: MouseEvent) => {
        latestWidth = Math.max(
          80,
          Math.min(600, Math.round(startWidth + (moveEv.clientX - startX))),
        );
        setPreviewWidths((prev) => ({ ...prev, [colId]: latestWidth }));
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (!worksheetId || latestWidth === startWidth) return;

        if (isSystem) {
          const sysKey = colId as keyof SystemColumnsConfig;
          void apiFetch(`/api/worksheets/${worksheetId}`, {
            method: 'PATCH',
            body: { systemColumns: { [sysKey]: { width: latestWidth } } },
          }).then(() => refetchWorksheet());
        } else {
          void apiFetch(`/api/worksheets/${worksheetId}/columns/${colId}`, {
            method: 'PATCH',
            body: { width: latestWidth },
          }).then(() => refetchWorksheet());
        }
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [worksheetId, refetchWorksheet],
  );

  const wsSystemColumns = data?.worksheet.systemColumns;
  const wsColumns = data?.columns;

  // 列定义仅依赖列结构与列宽，cell 使用模块级稳定组件，绝不因焦点/冲突/任务变更卸载单元格！
  const visibleColumns = useMemo(() => {
    if (!wsColumns) return [];
    const sys = wsSystemColumns ?? {};
    const defs = [];

    defs.push(
      columnHelper.display({
        id: 'title',
        header: '标题',
        meta: {
          width: previewWidths.title ?? sys.title?.width ?? 220,
          isSystem: true,
          stickyTitle: true,
        },
        cell: TitleGridCell,
      }),
    );

    if (!sys.work?.hidden) {
      defs.push(
        columnHelper.display({
          id: 'work',
          header: '作品',
          meta: { width: previewWidths.work ?? sys.work?.width ?? 140, isSystem: true },
          cell: WorkGridCell,
        }),
      );
    }

    if (!sys.divisionNote?.hidden) {
      defs.push(
        columnHelper.display({
          id: 'divisionNote',
          header: '分工说明',
          meta: {
            width: previewWidths.divisionNote ?? sys.divisionNote?.width ?? 180,
            isSystem: true,
          },
          cell: DivisionNoteGridCell,
        }),
      );
    }

    for (const col of wsColumns) {
      if (col.hidden) continue;
      defs.push(
        columnHelper.display({
          id: col.id,
          header: col.name,
          meta: { width: previewWidths[col.id] ?? col.width, isSystem: false, columnConfig: col },
          cell: col.type === 'stage' ? StageGridCell : CustomGridCell,
        }),
      );
    }

    if (!sys.priority?.hidden) {
      defs.push(
        columnHelper.display({
          id: 'priority',
          header: '优先级',
          meta: { width: previewWidths.priority ?? sys.priority?.width ?? 96, isSystem: true },
          cell: PriorityGridCell,
        }),
      );
    }

    if (!sys.publish?.hidden) {
      defs.push(
        columnHelper.display({
          id: 'publish',
          header: '发布信息',
          meta: { width: previewWidths.publish ?? sys.publish?.width ?? 160, isSystem: true },
          cell: PublishGridCell,
        }),
      );
    }

    if (!sys.files?.hidden) {
      defs.push(
        columnHelper.display({
          id: 'files',
          header: '文件',
          meta: { width: previewWidths.files ?? sys.files?.width ?? 100, isSystem: true },
          cell: FilesGridCell,
        }),
      );
    }

    return defs;
  }, [wsSystemColumns, wsColumns, previewWidths]);

  const gridContextValue = useMemo<WorksheetGridContextValue>(
    () => ({
      works: data?.works ?? [],
      users,
      userMap,
      selectedCell,
      peerByCell,
      textConflicts,
      stageConflicts,
      setSelectedCell,
      reportFocus,
      clearTextConflict,
      clearStageConflict,
      acceptRemoteField,
      patchTask,
      patchStage,
      renameWork,
      openDetail: setDetailTaskId,
    }),
    [
      data?.works,
      users,
      userMap,
      selectedCell,
      peerByCell,
      textConflicts,
      stageConflicts,
      reportFocus,
      clearTextConflict,
      clearStageConflict,
      acceptRemoteField,
      patchTask,
      patchStage,
      renameWork,
    ],
  );

  const mainTable = useTable({
    features: TABLE_FEATURES,
    columns: visibleColumns,
    data: activeTasks,
    getRowId: (row) => row.id,
  });

  const publishedTable = useTable({
    features: TABLE_FEATURES,
    columns: visibleColumns,
    data: publishedTasks,
    getRowId: (row) => row.id,
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const handleRowDragEnd = async (ev: DragEndEvent) => {
    if (isFilteredOrSorted || !worksheetId) return;
    const { active, over } = ev;
    if (!over || active.id === over.id) return;
    const oldIdx = activeTasks.findIndex((t) => t.id === active.id);
    const newIdx = activeTasks.findIndex((t) => t.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;

    const movingId = String(active.id);
    const targetList = activeTasks.filter((t) => t.id !== movingId);
    const afterTaskId = newIdx > 0 ? (targetList[newIdx - 1]?.id ?? null) : null;
    const beforeTaskId = newIdx < targetList.length ? (targetList[newIdx]?.id ?? null) : null;

    try {
      const { updates } = await apiFetch<{ updates: Array<{ taskId: string; sortOrder: string }> }>(
        `/api/worksheets/${worksheetId}/tasks/reorder`,
        {
          method: 'POST',
          body: { taskId: movingId, afterTaskId, beforeTaskId },
        },
      );
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
  };

  const handleQuickAdd = (e: FormEvent) => {
    e.preventDefault();
    const title = quickAddTitle.trim();
    if (!title) return;
    createTaskMutation.mutate({ title });
    setQuickAddTitle('');
  };

  const handleInsertSubmit = (e: FormEvent) => {
    e.preventDefault();
    const title = insertTitle.trim();
    if (!title || !insertingAfterId) return;
    createTaskMutation.mutate({ title, afterTaskId: insertingAfterId });
    setInsertingAfterId(null);
    setInsertTitle('');
  };

  if (isLoading || !subscribedReady) {
    return <div className="py-16 text-center text-sm text-slate-500">正在加载工作表…</div>;
  }

  if (error || !data) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-slate-600">工作表不存在或已被删除</p>
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

  const renderTableHeaders = (tableInstance: typeof mainTable) => (
    <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
      {tableInstance.getHeaderGroups().map((hg) => (
        <tr key={hg.id} className="border-b border-slate-200">
          <th className="sticky left-0 z-30 w-[72px] min-w-[72px] border-r border-slate-200 bg-slate-50 px-2 py-2.5">
            操作
          </th>
          {hg.headers.map((header) => {
            const meta = header.column.columnDef.meta as
              | {
                  width?: number;
                  isSystem?: boolean;
                  stickyTitle?: boolean;
                  columnConfig?: ColumnConfig;
                }
              | undefined;
            const width = meta?.width ?? 150;
            return (
              <th
                key={header.id}
                style={{ width, minWidth: width }}
                className={cn(
                  'relative select-none border-r border-slate-200 bg-slate-50 px-2.5 py-2.5 font-semibold',
                  meta?.stickyTitle &&
                    'sticky left-[72px] z-30 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]',
                )}
              >
                <div className="truncate pr-2">
                  <tableInstance.FlexRender header={header} />
                </div>
                <button
                  type="button"
                  aria-label={`调整列宽 ${header.id}`}
                  onMouseDown={(e) => startResize(header.id, width, Boolean(meta?.isSystem), e)}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-sky-400/60"
                />
              </th>
            );
          })}
          <th className="w-10 min-w-10 bg-slate-50 px-1 py-2.5 text-center" />
        </tr>
      ))}
    </thead>
  );

  const renderRows = (tableInstance: typeof mainTable, allowDrag: boolean) =>
    tableInstance.getRowModel().rows.map((row) => {
      const task = row.original;
      return (
        <SortableTableRow
          key={row.id}
          task={task}
          dragEnabled={allowDrag}
          highlighted={highlightedTaskId === task.id}
          onInsertBelow={() => {
            setInsertingAfterId(task.id);
            setInsertTitle('');
          }}
          onOpenDetail={() => setDetailTaskId(task.id)}
          onDelete={() => void deleteTask(task)}
        >
          {row.getAllCells().map((cell) => {
            const meta = cell.column.columnDef.meta as
              | { width?: number; stickyTitle?: boolean }
              | undefined;
            const width = meta?.width ?? 150;
            return (
              <td
                key={cell.id}
                style={{ width, minWidth: width }}
                className={cn(
                  'border-r border-slate-200 p-0 align-middle',
                  meta?.stickyTitle &&
                    'sticky left-[72px] z-20 bg-white group-hover:bg-slate-50 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]',
                )}
              >
                <tableInstance.FlexRender cell={cell} />
              </td>
            );
          })}
        </SortableTableRow>
      );
    });

  return (
    <WorksheetGridContext.Provider value={gridContextValue}>
      <div className="space-y-4">
        {/* 顶部工具栏 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={cn('h-3.5 w-3.5 shrink-0 rounded-full', wsColor.dot)} />
            <h1 className="truncate text-xl font-semibold text-slate-900">{data.worksheet.name}</h1>
            <span className="shrink-0 text-xs text-slate-500">
              未发布 {data.tasks.length - totalPublishedCount} · 已发布 {totalPublishedCount}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onlineUsers.length > 0 && (
              <div
                data-testid="presence-bar"
                className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-1"
              >
                <span className="text-[11px] text-slate-400">在线：</span>
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
                        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
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

            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setColModalOpen(true)}
            >
              <Columns3 className="mr-1 h-4 w-4" />
              列设置
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setLogsOpen(true)}>
              <History className="mr-1 h-4 w-4" />
              修改记录
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const el = document.getElementById('worksheet-quick-add-input');
                el?.focus();
              }}
            >
              <Plus className="mr-1 h-4 w-4" />
              新建任务
            </Button>
          </div>
        </div>

        {/* 本地筛选与排序栏 */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
          <div className="flex flex-wrap items-center gap-1">
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
                  'rounded-full px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer',
                  statusChip === val
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="表内筛选关键词…"
                aria-label="表内筛选关键词"
                className="h-8 w-40 pl-8 text-xs"
              />
            </div>

            <SelectField
              aria-label="按作品筛选"
              size="sm"
              value={workFilter}
              onValueChange={setWorkFilter}
              className="w-36"
              options={[
                { value: '', label: '全部作品' },
                ...data.works.map((w) => ({ value: w.id, label: w.name })),
              ]}
            />

            <SelectField
              aria-label="按负责人筛选"
              size="sm"
              value={assigneeFilter}
              onValueChange={setAssigneeFilter}
              className="w-36"
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

            <SelectField
              aria-label="本地排序"
              size="sm"
              align="end"
              leadingIcon={<ArrowUpDown className="h-3.5 w-3.5" />}
              value={localSort}
              onValueChange={(v) => setLocalSort(v as LocalSort)}
              className="w-40"
              options={[
                { value: 'manual', label: '默认手动顺序' },
                { value: 'title', label: '按标题排序' },
                { value: 'priority', label: '按优先级排序' },
                { value: 'work', label: '按作品排序' },
              ]}
            />
          </div>

          {isFilteredOrSorted && (
            <div className="w-full text-xs text-slate-500">
              恢复默认顺序后可拖动调整行序
              <button
                type="button"
                onClick={() => {
                  setStatusChip('all');
                  setAssigneeFilter('');
                  setWorkFilter('');
                  setKeyword('');
                  setLocalSort('manual');
                }}
                className="ml-2 font-medium text-sky-700 underline cursor-pointer"
              >
                重置筛选与排序
              </button>
            </div>
          )}
        </div>

        {/* 顶部“已发布”折叠区 */}
        {totalPublishedCount > 0 && (
          <div
            data-testid="published-section"
            className="overflow-hidden rounded-lg border border-emerald-200 bg-white"
          >
            <button
              type="button"
              onClick={() => setPublishedExpanded((v) => !v)}
              className="flex w-full items-center justify-between bg-emerald-50/70 px-3.5 py-2 text-left text-sm font-medium text-emerald-900 hover:bg-emerald-50 cursor-pointer"
            >
              <span className="inline-flex items-center gap-1.5">
                {publishedExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                已发布（{publishedTasks.length} 条）
              </span>
              <span className="text-xs font-normal text-emerald-700">
                {publishedExpanded ? '点击收起' : '默认收起，点击展开查看或编辑'}
              </span>
            </button>

            {publishedExpanded && (
              <div className="overflow-x-auto border-t border-emerald-100">
                <table className="w-max min-w-full border-collapse">
                  {renderTableHeaders(publishedTable)}
                  <tbody>{renderRows(publishedTable, false)}</tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* 在指定行下方插入的快捷表单 */}
        {insertingAfterId && (
          <form
            onSubmit={handleInsertSubmit}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2"
          >
            <span className="text-xs font-medium text-sky-900">在选中行下方插入新任务：</span>
            <Input
              value={insertTitle}
              onChange={(e) => setInsertTitle(e.target.value)}
              placeholder="输入新任务标题回车确认"
              className="h-8 max-w-sm text-xs"
              autoFocus
              maxLength={200}
            />
            <Button type="submit" size="sm" disabled={createTaskMutation.isPending}>
              插入
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setInsertingAfterId(null)}
            >
              取消
            </Button>
          </form>
        )}

        {/* 主表格（未发布任务） */}
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xs">
          <div className="overflow-x-auto" data-testid="worksheet-table-scroll">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(ev) => void handleRowDragEnd(ev)}
            >
              <SortableContext
                items={activeTasks.map((t) => t.id)}
                strategy={verticalListSortingStrategy}
              >
                <table
                  className="w-max min-w-full border-collapse"
                  data-testid="worksheet-main-table"
                >
                  {renderTableHeaders(mainTable)}
                  <tbody>
                    {activeTasks.length === 0 ? (
                      <tr>
                        <td
                          colSpan={visibleColumns.length + 2}
                          className="py-10 text-center text-sm text-slate-400"
                        >
                          {isFilteredOrSorted
                            ? '没有符合筛选条件的任务'
                            : '暂无未发布任务，在下方输入标题即可新建'}
                        </td>
                      </tr>
                    ) : (
                      renderRows(mainTable, dragEnabled)
                    )}
                  </tbody>
                </table>
              </SortableContext>
            </DndContext>
          </div>

          <form
            onSubmit={handleQuickAdd}
            className="flex items-center gap-2 border-t border-slate-200 bg-slate-50/70 px-3 py-2"
          >
            <Plus className="h-4 w-4 shrink-0 text-slate-400" />
            <input
              id="worksheet-quick-add-input"
              value={quickAddTitle}
              onChange={(e) => setQuickAddTitle(e.target.value)}
              placeholder="输入新任务标题并按回车添加…"
              aria-label="新建任务标题"
              maxLength={200}
              className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={createTaskMutation.isPending || !quickAddTitle.trim()}
            >
              添加任务
            </Button>
          </form>
        </div>

        <ColumnManagerModal
          open={colModalOpen}
          onOpenChange={setColModalOpen}
          worksheet={data.worksheet}
          columns={data.columns}
          boardColumns={data.boardColumns}
        />

        <ChangeLogDrawer
          worksheetId={data.worksheet.id}
          open={logsOpen}
          onOpenChange={setLogsOpen}
        />

        <TaskDetailDrawer
          worksheetId={data.worksheet.id}
          taskId={detailTaskId}
          open={Boolean(detailTaskId)}
          onClose={() => setDetailTaskId(null)}
          showLocateButton={false}
        />
      </div>
    </WorksheetGridContext.Provider>
  );
}
