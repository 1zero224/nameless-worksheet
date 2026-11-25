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
  FolderOpen,
  GripVertical,
  History,
  MoreHorizontal,
  PanelRightOpen,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import {
  createContext,
  type FormEvent,
  Fragment,
  type MouseEvent as ReactMouseEvent,
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
import { SidebarExpandButton } from '@/app/AppShell.js';
import { useMe } from '@/app/AuthContext.js';
import { TaskDetailDrawer } from '@/components/task/TaskDetailDrawer.js';
import { peerColorForUser, WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import {
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useToast,
} from '@/components/ui/overlays.js';
import { Button, cn, Input } from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';
import { AddColumnPopover } from '@/components/worksheet/AddColumnPopover.js';
import {
  type ActiveCellConflict,
  type CellEditSignal,
  InlineTextCell,
  PriorityCellEditor,
  PublishCellEditor,
  type StageCellConflict,
  StageCellEditor,
} from '@/components/worksheet/CellEditors.js';
import { ChangeLogDrawer } from '@/components/worksheet/ChangeLogDrawer.js';
import { ColumnHeaderMenu } from '@/components/worksheet/ColumnHeaderMenu.js';
import { ColumnManagerModal } from '@/components/worksheet/ColumnManagerModal.js';
import { CreateWorkPopover } from '@/components/worksheet/CreateWorkPopover.js';
import {
  FieldVisibilityPopover,
  isSystemColumnHidden,
} from '@/components/worksheet/FieldVisibilityPopover.js';
import { InlineAddSegmentRow, WorkBannerRow } from '@/components/worksheet/WorkBannerRow.js';
import { useRealtimeClient, useRealtimeScope } from '@/realtime/context.js';

const TABLE_FEATURES = tableFeatures({});
const columnHelper = createColumnHelper<typeof TABLE_FEATURES, TaskDetail>();
const EMPTY_TASKS: TaskDetail[] = [];

type StatusChip = 'all' | 'mine' | 'not_started' | 'in_progress' | 'all_stages_done';
type LocalSort = 'manual' | 'title' | 'priority' | 'work';

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2 };

type DisplayBlock =
  | { kind: 'standalone'; key: string; tasks: TaskDetail[] }
  | { kind: 'work'; key: string; work: Work; tasks: TaskDetail[]; isEmptyPending: boolean };

function sortTasksByKey(list: TaskDetail[]): TaskDetail[] {
  return [...list].sort((a, b) => {
    if (a.sortOrder < b.sortOrder) return -1;
    if (a.sortOrder > b.sortOrder) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function isTaskAllStagesDone(task: TaskDetail, stageCols: ColumnConfig[]): boolean {
  const applicable = stageCols
    .map((c) => getEffectiveStageCell(task, c.id))
    .filter((cell) => cell.status !== 'na');
  return applicable.length > 0 && applicable.every((cell) => cell.status === 'done');
}

// ---- 稳定单元格上下文（避免 FlexRender 因列定义变更而卸载单元格、丢失输入态/IME） ----

interface EditRequestState {
  taskId: string;
  columnKey: string;
  signal: CellEditSignal;
}

interface WorksheetGridContextValue {
  users: UserListItem[];
  userMap: Map<string, string>;
  selectedCell: { taskId: string; columnKey: string } | null;
  editRequest: EditRequestState | null;
  peerByCell: Map<string, PresencePeer>;
  textConflicts: Map<string, ActiveCellConflict>;
  stageConflicts: Map<string, StageCellConflict>;
  selectCell: (taskId: string, columnKey: string) => void;
  setEditingFocus: (taskId: string | null, columnKey: string | null, editing: boolean) => void;
  moveFromCell: (taskId: string, columnKey: string, direction: 'down' | 'right' | 'left') => void;
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
  openDetail: (taskId: string) => void;
}

const WorksheetGridContext = createContext<WorksheetGridContextValue | null>(null);

function useWorksheetGrid(): WorksheetGridContextValue {
  const ctx = useContext(WorksheetGridContext);
  if (!ctx) throw new Error('WorksheetGridContext missing');
  return ctx;
}

function getEditSignalFor(
  req: EditRequestState | null,
  taskId: string,
  columnKey: string,
): CellEditSignal | null {
  if (!req || req.taskId !== taskId || req.columnKey !== columnKey) return null;
  return req.signal;
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
      editSignal={getEditSignalFor(ctx.editRequest, task.id, 'title')}
      peer={ctx.peerByCell.get(conflictKey)}
      remoteConflict={ctx.textConflicts.get(conflictKey) ?? null}
      onSelect={() => ctx.selectCell(task.id, 'title')}
      onEditingChange={(ed) => ctx.setEditingFocus(task.id, 'title', ed)}
      onMoveAfterCommit={(dir) => ctx.moveFromCell(task.id, 'title', dir)}
      onClearConflict={() => ctx.clearTextConflict(conflictKey)}
      onAcceptRemote={(val) => ctx.acceptRemoteField(task.id, 'title', val)}
      onCommit={(nextVal, baseVal, force) =>
        ctx.patchTask(task.id, { title: nextVal }, { title: baseVal }, force)
      }
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
      editSignal={getEditSignalFor(ctx.editRequest, task.id, 'divisionNote')}
      peer={ctx.peerByCell.get(conflictKey)}
      remoteConflict={ctx.textConflicts.get(conflictKey) ?? null}
      onSelect={() => ctx.selectCell(task.id, 'divisionNote')}
      onEditingChange={(ed) => ctx.setEditingFocus(task.id, 'divisionNote', ed)}
      onMoveAfterCommit={(dir) => ctx.moveFromCell(task.id, 'divisionNote', dir)}
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
      selected={ctx.selectedCell?.taskId === task.id && ctx.selectedCell.columnKey === col.id}
      editSignal={getEditSignalFor(ctx.editRequest, task.id, col.id)}
      peer={ctx.peerByCell.get(conflictKey)}
      remoteConflict={ctx.stageConflicts.get(conflictKey) ?? null}
      onSelect={() => ctx.selectCell(task.id, col.id)}
      onFocusChange={(ed) =>
        ed === null
          ? ctx.setEditingFocus(task.id, col.id, false)
          : ctx.setEditingFocus(task.id, col.id, ed)
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
      editSignal={getEditSignalFor(ctx.editRequest, task.id, col.id)}
      peer={ctx.peerByCell.get(conflictKey)}
      remoteConflict={ctx.textConflicts.get(conflictKey) ?? null}
      onSelect={() => ctx.selectCell(task.id, col.id)}
      onEditingChange={(ed) => ctx.setEditingFocus(task.id, col.id, ed)}
      onMoveAfterCommit={(dir) => ctx.moveFromCell(task.id, col.id, dir)}
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
      selected={ctx.selectedCell?.taskId === task.id && ctx.selectedCell.columnKey === 'priority'}
      editSignal={getEditSignalFor(ctx.editRequest, task.id, 'priority')}
      peer={ctx.peerByCell.get(`${task.id}:priority`)}
      onSelectCell={() => ctx.selectCell(task.id, 'priority')}
      onFocusChange={(ed) =>
        ed === null
          ? ctx.setEditingFocus(task.id, 'priority', false)
          : ctx.setEditingFocus(task.id, 'priority', ed)
      }
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
      selected={ctx.selectedCell?.taskId === task.id && ctx.selectedCell.columnKey === 'publish'}
      editSignal={getEditSignalFor(ctx.editRequest, task.id, 'publish')}
      peer={ctx.peerByCell.get(`${task.id}:publish`)}
      onSelect={() => ctx.selectCell(task.id, 'publish')}
      onFocusChange={(ed) =>
        ed === null
          ? ctx.setEditingFocus(task.id, 'publish', false)
          : ctx.setEditingFocus(task.id, 'publish', ed)
      }
      onSave={(patch) => ctx.patchTask(task.id, patch, undefined, true)}
    />
  );
}

function FilesGridCell({ row }: { row: { original: TaskDetail } }) {
  const ctx = useWorksheetGrid();
  const task = row.original;
  const selected = ctx.selectedCell?.taskId === task.id && ctx.selectedCell.columnKey === 'files';
  return (
    <button
      type="button"
      data-testid={`cell-${task.id}-files`}
      onClick={() => {
        ctx.selectCell(task.id, 'files');
        ctx.openDetail(task.id);
      }}
      className={cn(
        'flex min-h-[36px] w-full items-center gap-1 px-2 text-xs text-slate-400 hover:bg-slate-50 hover:text-slate-600 outline-none cursor-pointer',
        selected && 'ring-2 ring-inset ring-sky-500',
      )}
      title="任务文件将在阶段 3 启用，点击打开详情"
    >
      <FolderOpen className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">阶段 3</span>
    </button>
  );
}

function SortableTableRow({
  task,
  rowNumber,
  dragEnabled,
  rowSelected,
  highlighted,
  onContextMenu,
  onInsertBelow,
  onOpenDetail,
  onDelete,
  children,
}: {
  task: TaskDetail;
  rowNumber: number;
  dragEnabled: boolean;
  rowSelected: boolean;
  highlighted: boolean;
  onContextMenu: (e: ReactMouseEvent<HTMLTableRowElement>) => void;
  onInsertBelow: () => void;
  onOpenDetail: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !dragEnabled,
  });
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <tr
      ref={setNodeRef}
      data-task-row={task.id}
      onContextMenu={onContextMenu}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group h-9 border-b border-slate-200/80 bg-white hover:bg-slate-50/70',
        isDragging && 'relative z-30 shadow-md ring-2 ring-sky-500/30',
        highlighted && 'bg-amber-50 ring-2 ring-inset ring-amber-400 transition-colors',
      )}
    >
      {/* 极窄 40px 行号列：默认显行号，悬停/选中切为拖拽手柄 + 展开详情 */}
      <td className="sticky left-0 z-20 h-9 w-10 min-w-10 max-w-10 border-r border-slate-200/80 bg-white p-0 text-center group-hover:bg-slate-50">
        <div className="relative flex h-9 w-10 items-center justify-center">
          <span
            className={cn(
              'text-[11px] tabular-nums text-slate-400 select-none',
              rowSelected || menuOpen ? 'hidden' : 'group-hover:hidden group-focus-within:hidden',
            )}
          >
            {rowNumber}
          </span>
          <div
            className={cn(
              'items-center justify-center gap-0.5',
              rowSelected || menuOpen ? 'flex' : 'hidden group-hover:flex group-focus-within:flex',
            )}
          >
            <button
              type="button"
              {...(dragEnabled ? attributes : {})}
              {...(dragEnabled ? listeners : {})}
              disabled={!dragEnabled}
              aria-label={`拖动排序 ${task.title}`}
              title={dragEnabled ? '拖动调整行序或跨作品移动' : '恢复默认顺序后可拖动调整行序'}
              className={cn(
                'flex h-5 w-4 items-center justify-center rounded text-slate-400',
                dragEnabled
                  ? 'cursor-grab hover:bg-slate-200/70 hover:text-slate-700 active:cursor-grabbing'
                  : 'cursor-not-allowed opacity-30',
              )}
            >
              <GripVertical className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={onOpenDetail}
              title="展开任务详情"
              aria-label={`打开 ${task.title} 详情`}
              className="flex h-5 w-4 items-center justify-center rounded text-slate-400 hover:bg-sky-50 hover:text-sky-700 cursor-pointer"
            >
              <PanelRightOpen className="h-3 w-3" />
            </button>
          </div>
        </div>
      </td>

      {children}

      {/* 最右侧 40px 轻量行菜单列（与表头 `+` 列对齐） */}
      <td className="h-9 w-10 min-w-10 p-0 text-center">
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`行操作 ${task.title}`}
              title="行操作"
              className={cn(
                'mx-auto flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-opacity hover:bg-slate-200/70 hover:text-slate-800 cursor-pointer',
                menuOpen || rowSelected
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
              )}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[148px]">
            <DropdownMenuItem onSelect={onOpenDetail}>
              <PanelRightOpen className="h-3.5 w-3.5 text-slate-400" />
              展开任务详情
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onInsertBelow}>
              <Plus className="h-3.5 w-3.5 text-slate-400" />
              在下方插入一行
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 className="h-3.5 w-3.5" />
              删除任务
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
  const [editRequest, setEditRequest] = useState<EditRequestState | null>(null);
  const activeEditorRef = useRef<{ taskId: string; columnKey: string } | null>(null);
  const quickAddInputRef = useRef<HTMLInputElement | null>(null);
  const insertInputRef = useRef<HTMLInputElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null);
  const editNonceRef = useRef(1);

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
  const [rowContextMenu, setRowContextMenu] = useState<{
    task: TaskDetail;
    x: number;
    y: number;
  } | null>(null);

  // 作品大标题横幅相关状态
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
    setEditRequest(null);
    activeEditorRef.current = null;
    setTextConflicts(new Map());
    setStageConflicts(new Map());
    setPublishedExpanded(false);
    setPreviewWidths({});
    setInsertingAfterId(null);
    setRowContextMenu(null);
    setPendingWorks([]);
    setCollapsedWorkIds(new Set());
    setAddingSegmentWorkId(null);
    setUngroupingWork(null);
  }, [worksheetId]);

  // 追踪表格滚动容器可视宽度，确保作品大标题横幅在宽表横向滚动时仍完整贴合视口
  useEffect(() => {
    const el = scrollContainerEl;
    if (!el) return;
    const syncWidth = () => {
      el.style.setProperty('--ws-scroll-w', `${el.clientWidth}px`);
    };
    syncWidth();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(syncWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollContainerEl]);

  // 插入行展开时自动聚焦输入框
  useEffect(() => {
    if (insertingAfterId) {
      requestAnimationFrame(() => insertInputRef.current?.focus());
    }
  }, [insertingAfterId]);

  // 关闭行右键菜单（点击外部、Esc 或滚动）
  useEffect(() => {
    if (!rowContextMenu) return;
    const onPointerClick = (e: MouseEvent) => {
      if (contextMenuRef.current?.contains(e.target as Node)) return;
      setRowContextMenu(null);
    };
    const close = () => setRowContextMenu(null);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setRowContextMenu(null);
    };
    window.addEventListener('click', onPointerClick);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', onPointerClick);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [rowContextMenu]);

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
    if (target.publishStatus === 'published') {
      setPublishedExpanded(true);
    }
    if (target.workId) {
      setCollapsedWorkIds((prev) => {
        if (!prev.has(target.workId!)) return prev;
        const next = new Set(prev);
        next.delete(target.workId!);
        return next;
      });
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

  // 将未发布任务组织为「作品大标题横幅块」+「无作品独立平铺块」
  const displayBlocks = useMemo<DisplayBlock[]>(() => {
    const blocks: DisplayBlock[] = [];
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

    // 刚新建但尚未录入分段的空作品，立即渲染横幅引导输入首条分段
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

  // 展平当前主表所有可见任务行（按渲染顺序，跳过已折叠作品内的行）
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
      if (addingSegmentWorkId === work.id) {
        setAddingSegmentWorkId(null);
      }
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
    setInsertingAfterId(null);
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
        header: '标题 / 分段',
        meta: {
          width: previewWidths.title ?? sys.title?.width ?? 220,
          isSystem: true,
          systemKey: 'title' as const,
          stickyTitle: true,
          isTextCell: true,
        },
        cell: TitleGridCell,
      }),
    );

    for (const col of wsColumns) {
      if (col.hidden) continue;
      defs.push(
        columnHelper.display({
          id: col.id,
          header: col.name,
          meta: {
            width: previewWidths[col.id] ?? col.width,
            isSystem: false,
            columnConfig: col,
            isTextCell: col.type === 'text' || col.type === 'link',
          },
          cell: col.type === 'stage' ? StageGridCell : CustomGridCell,
        }),
      );
    }

    if (!isSystemColumnHidden(sys, 'priority')) {
      defs.push(
        columnHelper.display({
          id: 'priority',
          header: '优先级',
          meta: {
            width: previewWidths.priority ?? sys.priority?.width ?? 92,
            isSystem: true,
            systemKey: 'priority' as const,
          },
          cell: PriorityGridCell,
        }),
      );
    }

    if (!isSystemColumnHidden(sys, 'publish')) {
      defs.push(
        columnHelper.display({
          id: 'publish',
          header: '发布信息',
          meta: {
            width: previewWidths.publish ?? sys.publish?.width ?? 148,
            isSystem: true,
            systemKey: 'publish' as const,
          },
          cell: PublishGridCell,
        }),
      );
    }

    if (!isSystemColumnHidden(sys, 'files')) {
      defs.push(
        columnHelper.display({
          id: 'files',
          header: '文件',
          meta: {
            width: previewWidths.files ?? sys.files?.width ?? 96,
            isSystem: true,
            systemKey: 'files' as const,
          },
          cell: FilesGridCell,
        }),
      );
    }

    if (!isSystemColumnHidden(sys, 'divisionNote')) {
      defs.push(
        columnHelper.display({
          id: 'divisionNote',
          header: '分工说明',
          meta: {
            width: previewWidths.divisionNote ?? sys.divisionNote?.width ?? 170,
            isSystem: true,
            systemKey: 'divisionNote' as const,
            isTextCell: true,
          },
          cell: DivisionNoteGridCell,
        }),
      );
    }

    return defs;
  }, [wsSystemColumns, wsColumns, previewWidths]);

  const visibleColumnKeys = useMemo(
    () => visibleColumns.map((c) => c.id as string),
    [visibleColumns],
  );

  const textColumnKeySet = useMemo(() => {
    const set = new Set<string>();
    for (const col of visibleColumns) {
      const meta = col.meta as { isTextCell?: boolean } | undefined;
      if (meta?.isTextCell && col.id) set.add(col.id);
    }
    return set;
  }, [visibleColumns]);

  const focusCellElement = useCallback((taskId: string, columnKey: string) => {
    const focusNow = () => {
      const el = document.querySelector<HTMLElement>(`[data-testid="cell-${taskId}-${columnKey}"]`);
      if (!el) return false;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const focusable = el.matches('button') ? el : el.querySelector<HTMLElement>('button');
      focusable?.focus({ preventScroll: true });
      return true;
    };
    if (!focusNow()) {
      requestAnimationFrame(() => {
        focusNow();
      });
    }
  }, []);

  const moveFromCell = useCallback(
    (taskId: string, columnKey: string, direction: 'down' | 'right' | 'left') => {
      const list = visualActiveTasks.some((t) => t.id === taskId)
        ? visualActiveTasks
        : publishedExpanded && publishedTasks.some((t) => t.id === taskId)
          ? publishedTasks
          : null;
      if (!list || visibleColumnKeys.length === 0) return;

      const rIdx = list.findIndex((t) => t.id === taskId);
      const cIdx = visibleColumnKeys.indexOf(columnKey);
      if (rIdx === -1 || cIdx === -1) return;

      let nextR = rIdx;
      let nextC = cIdx;
      if (direction === 'down') {
        nextR = Math.min(list.length - 1, rIdx + 1);
      } else if (direction === 'right') {
        if (cIdx + 1 < visibleColumnKeys.length) {
          nextC = cIdx + 1;
        } else if (rIdx + 1 < list.length) {
          nextR = rIdx + 1;
          nextC = 0;
        }
      } else if (direction === 'left') {
        if (cIdx - 1 >= 0) {
          nextC = cIdx - 1;
        } else if (rIdx - 1 >= 0) {
          nextR = rIdx - 1;
          nextC = visibleColumnKeys.length - 1;
        }
      }

      const targetTask = list[nextR];
      const targetCol = visibleColumnKeys[nextC];
      if (!targetTask || !targetCol) return;
      selectCell(targetTask.id, targetCol);
      focusCellElement(targetTask.id, targetCol);
    },
    [
      visualActiveTasks,
      publishedTasks,
      publishedExpanded,
      visibleColumnKeys,
      selectCell,
      focusCellElement,
    ],
  );

  // 单元格键盘导航（顺畅跨越作品大标题横幅并在可见任务行之间移动）
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!selectedCell) return;
      if (activeEditorRef.current) return;
      if (
        colModalOpen ||
        logsOpen ||
        detailTaskId ||
        rowContextMenu ||
        insertingAfterId ||
        ungroupingWork
      ) {
        return;
      }

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable ||
          target.closest('[role="dialog"]') ||
          target.closest('[data-radix-popper-content-wrapper]'))
      ) {
        return;
      }

      const list = visualActiveTasks.some((t) => t.id === selectedCell.taskId)
        ? visualActiveTasks
        : publishedExpanded && publishedTasks.some((t) => t.id === selectedCell.taskId)
          ? publishedTasks
          : null;
      if (!list || visibleColumnKeys.length === 0) return;

      const rIdx = list.findIndex((t) => t.id === selectedCell.taskId);
      const cIdx = visibleColumnKeys.indexOf(selectedCell.columnKey);
      if (rIdx === -1 || cIdx === -1) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        setSelectedCell(null);
        setEditingFocus(null, null, false);
        return;
      }

      let nextR = rIdx;
      let nextC = cIdx;
      let moved = false;

      if (e.key === 'ArrowUp') {
        nextR = Math.max(0, rIdx - 1);
        moved = true;
      } else if (e.key === 'ArrowDown') {
        nextR = Math.min(list.length - 1, rIdx + 1);
        moved = true;
      } else if (e.key === 'ArrowLeft') {
        nextC = Math.max(0, cIdx - 1);
        moved = true;
      } else if (e.key === 'ArrowRight') {
        nextC = Math.min(visibleColumnKeys.length - 1, cIdx + 1);
        moved = true;
      } else if (e.key === 'Tab') {
        if (e.shiftKey) {
          if (cIdx > 0) {
            nextC = cIdx - 1;
          } else if (rIdx > 0) {
            nextR = rIdx - 1;
            nextC = visibleColumnKeys.length - 1;
          }
        } else {
          if (cIdx + 1 < visibleColumnKeys.length) {
            nextC = cIdx + 1;
          } else if (rIdx + 1 < list.length) {
            nextR = rIdx + 1;
            nextC = 0;
          }
        }
        moved = true;
      }

      if (moved) {
        e.preventDefault();
        const nextTask = list[nextR];
        const nextCol = visibleColumnKeys[nextC];
        if (nextTask && nextCol) {
          selectCell(nextTask.id, nextCol);
          focusCellElement(nextTask.id, nextCol);
        }
        return;
      }

      if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault();
        if (selectedCell.columnKey === 'files') {
          setDetailTaskId(selectedCell.taskId);
        } else {
          const nonce = ++editNonceRef.current;
          setEditRequest({
            taskId: selectedCell.taskId,
            columnKey: selectedCell.columnKey,
            signal: { nonce },
          });
        }
        return;
      }

      // 选中文本格时直接键入字符快速进入编辑（不拦截中文 IME Process/组合态）
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.isComposing &&
        e.key.length === 1 &&
        e.key !== ' ' &&
        textColumnKeySet.has(selectedCell.columnKey)
      ) {
        e.preventDefault();
        const nonce = ++editNonceRef.current;
        setEditRequest({
          taskId: selectedCell.taskId,
          columnKey: selectedCell.columnKey,
          signal: { nonce, initialChar: e.key },
        });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    selectedCell,
    colModalOpen,
    logsOpen,
    detailTaskId,
    rowContextMenu,
    insertingAfterId,
    ungroupingWork,
    visualActiveTasks,
    publishedTasks,
    publishedExpanded,
    visibleColumnKeys,
    textColumnKeySet,
    selectCell,
    setEditingFocus,
    focusCellElement,
  ]);

  const gridContextValue = useMemo<WorksheetGridContextValue>(
    () => ({
      users,
      userMap,
      selectedCell,
      editRequest,
      peerByCell,
      textConflicts,
      stageConflicts,
      selectCell,
      setEditingFocus,
      moveFromCell,
      clearTextConflict,
      clearStageConflict,
      acceptRemoteField,
      patchTask,
      patchStage,
      openDetail: setDetailTaskId,
    }),
    [
      users,
      userMap,
      selectedCell,
      editRequest,
      peerByCell,
      textConflicts,
      stageConflicts,
      selectCell,
      setEditingFocus,
      moveFromCell,
      clearTextConflict,
      clearStageConflict,
      acceptRemoteField,
      patchTask,
      patchStage,
    ],
  );

  const mainTable = useTable({
    features: TABLE_FEATURES,
    columns: visibleColumns,
    data: visualActiveTasks,
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

    const movingId = String(active.id);
    const overId = String(over.id);
    const movingTask = visualActiveTasks.find((t) => t.id === movingId);
    if (!movingTask) return;

    // 情况 1：拖放到作品大标题横幅上 -> 移入该作品末尾
    if (overId.startsWith('work-drop:')) {
      const targetWorkId = overId.slice('work-drop:'.length);
      const targetWorkTasks = activeTasks.filter(
        (t) => t.workId === targetWorkId && t.id !== movingId,
      );
      const lastTarget = targetWorkTasks[targetWorkTasks.length - 1] ?? null;

      try {
        if (movingTask.workId !== targetWorkId) {
          await patchTask(movingId, { workId: targetWorkId }, { workId: movingTask.workId }, true);
        }
        if (lastTarget) {
          const { updates } = await apiFetch<{
            updates: Array<{ taskId: string; sortOrder: string }>;
          }>(`/api/worksheets/${worksheetId}/tasks/reorder`, {
            method: 'POST',
            body: { taskId: movingId, afterTaskId: lastTarget.id, beforeTaskId: null },
          });
          const map = new Map(updates.map((u) => [u.taskId, u.sortOrder]));
          queryClient.setQueryData<WorksheetFullResponse>(
            queryKeys.worksheet(worksheetId),
            (old) => {
              if (!old) return old;
              const next = old.tasks.map((t) => {
                const s = map.get(t.id);
                return s !== undefined ? { ...t, sortOrder: s } : t;
              });
              return { ...old, tasks: sortTasksByKey(next) };
            },
          );
        }
      } catch {
        refetchWorksheet();
      }
      return;
    }

    // 情况 2：拖放到另一任务行（同作品内排序，或跨作品/独立区互拖同步更新 workId + sortOrder）
    const oldIdx = visualActiveTasks.findIndex((t) => t.id === movingId);
    const newIdx = visualActiveTasks.findIndex((t) => t.id === overId);
    if (oldIdx === -1 || newIdx === -1) return;

    const overTask = visualActiveTasks[newIdx];
    const targetWorkId = overTask ? overTask.workId : null;
    const targetList = visualActiveTasks.filter((t) => t.id !== movingId);
    const afterTaskId = newIdx > 0 ? (targetList[newIdx - 1]?.id ?? null) : null;
    const beforeTaskId = newIdx < targetList.length ? (targetList[newIdx]?.id ?? null) : null;

    try {
      if (movingTask.workId !== targetWorkId) {
        await patchTask(movingId, { workId: targetWorkId }, { workId: movingTask.workId }, true);
      }
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
    requestAnimationFrame(() => {
      quickAddInputRef.current?.focus();
    });
  };

  const handleInsertSubmit = (e: FormEvent) => {
    e.preventDefault();
    const title = insertTitle.trim();
    if (!title || !insertingAfterId) return;
    const anchor = data?.tasks.find((t) => t.id === insertingAfterId);
    createTaskMutation.mutate({
      title,
      afterTaskId: insertingAfterId,
      workId: anchor?.workId ?? null,
    });
    setInsertingAfterId(null);
    setInsertTitle('');
  };

  if (isLoading || !subscribedReady) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
        正在加载工作表…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
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
  const totalColSpan = visibleColumns.length + 2;

  const renderTableHeaders = (tableInstance: typeof mainTable, stickyTop: boolean) => (
    <thead
      className={cn(
        'bg-slate-50/95 text-left text-xs font-medium text-slate-600',
        stickyTop && 'sticky top-0 z-30',
      )}
    >
      {tableInstance.getHeaderGroups().map((hg) => (
        <tr key={hg.id} className="h-[34px] border-b border-slate-200/80">
          {/* 40px 极窄行号列头 */}
          <th className="sticky left-0 z-30 h-[34px] w-10 min-w-10 max-w-10 border-r border-slate-200/80 bg-slate-50/95 p-0 text-center text-[11px] font-medium text-slate-400">
            #
          </th>

          {hg.headers.map((header) => {
            const meta = header.column.columnDef.meta as
              | {
                  width?: number;
                  isSystem?: boolean;
                  systemKey?: keyof SystemColumnsConfig;
                  stickyTitle?: boolean;
                  columnConfig?: ColumnConfig;
                }
              | undefined;
            const width = meta?.width ?? 140;
            const label =
              typeof header.column.columnDef.header === 'string'
                ? header.column.columnDef.header
                : header.id;
            return (
              <th
                key={header.id}
                style={{ width, minWidth: width }}
                className={cn(
                  'relative h-[34px] select-none border-r border-slate-200/80 bg-slate-50/95 p-0 font-medium',
                  meta?.stickyTitle &&
                    'sticky left-[40px] z-30 shadow-[2px_0_4px_-2px_rgba(15,23,42,0.06)]',
                )}
              >
                <ColumnHeaderMenu
                  worksheetId={data.worksheet.id}
                  label={label}
                  systemKey={meta?.systemKey}
                  columnConfig={meta?.columnConfig}
                  allColumns={data.columns}
                  boardColumns={data.boardColumns}
                />
                {/* 右缘 6px 隐形列宽拖拽热区 */}
                <button
                  type="button"
                  aria-label={`调整列宽 ${header.id}`}
                  onMouseDown={(e) => startResize(header.id, width, Boolean(meta?.isSystem), e)}
                  className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize transition-colors hover:bg-sky-500"
                />
              </th>
            );
          })}

          {/* 最右侧 `+` 列头原地加列 */}
          <th className="h-[34px] w-10 min-w-10 bg-slate-50/95 p-0 text-center">
            <AddColumnPopover
              worksheetId={data.worksheet.id}
              columns={data.columns}
              boardColumns={data.boardColumns}
            />
          </th>
        </tr>
      ))}
    </thead>
  );

  const renderSingleRow = (
    tableInstance: typeof mainTable,
    row: ReturnType<typeof mainTable.getRowModel>['rows'][number],
    rowNumber: number,
    allowDrag: boolean,
  ) => {
    const task = row.original;
    const rowSelected = selectedCell?.taskId === task.id;
    return (
      <Fragment key={row.id}>
        <SortableTableRow
          task={task}
          rowNumber={rowNumber}
          dragEnabled={allowDrag}
          rowSelected={rowSelected}
          highlighted={highlightedTaskId === task.id}
          onContextMenu={(e) => {
            e.preventDefault();
            setRowContextMenu({
              task,
              x: Math.min(e.clientX, window.innerWidth - 170),
              y: Math.min(e.clientY, window.innerHeight - 130),
            });
          }}
          onInsertBelow={() => {
            setAddingSegmentWorkId(null);
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
            const width = meta?.width ?? 140;
            return (
              <td
                key={cell.id}
                style={{ width, minWidth: width }}
                className={cn(
                  'border-r border-slate-200/80 p-0 align-middle',
                  meta?.stickyTitle &&
                    'sticky left-[40px] z-20 bg-white group-hover:bg-slate-50 shadow-[2px_0_4px_-2px_rgba(15,23,42,0.06)]',
                )}
              >
                <tableInstance.FlexRender cell={cell} />
              </td>
            );
          })}
        </SortableTableRow>

        {/* 在该行下方贴合网格原地插入新行 */}
        {insertingAfterId === task.id && (
          <tr data-testid="inline-insert-row" className="h-9 border-b border-sky-200 bg-sky-50/60">
            <td className="sticky left-0 z-20 h-9 w-10 min-w-10 border-r border-slate-200/80 bg-sky-50 text-center text-sky-600">
              <Plus className="mx-auto h-3.5 w-3.5" />
            </td>
            <td colSpan={visibleColumns.length + 1} className="h-9 p-0 align-middle">
              <form
                onSubmit={handleInsertSubmit}
                className="sticky left-[40px] flex h-9 w-full max-w-lg items-center gap-1.5 px-2"
              >
                <input
                  ref={insertInputRef}
                  value={insertTitle}
                  onChange={(e) => setInsertTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setInsertingAfterId(null);
                    }
                  }}
                  placeholder="输入新任务标题回车确认"
                  className="h-7 min-w-0 flex-1 rounded border border-sky-400 bg-white px-2 text-[13px] text-slate-900 outline-none focus:ring-2 focus:ring-sky-500/20"
                  maxLength={200}
                />
                <Button
                  type="submit"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={createTaskMutation.isPending}
                >
                  插入
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setInsertingAfterId(null)}
                >
                  取消
                </Button>
              </form>
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  // 建立主表可见行索引映射（支持作品大标题横幅块与独立平铺块混合渲染）
  const mainRowLookup = new Map(
    mainTable.getRowModel().rows.map((r, idx) => [r.original.id, { row: r, rowNumber: idx + 1 }]),
  );

  return (
    <WorksheetGridContext.Provider value={gridContextValue}>
      <div className="flex h-full min-h-0 flex-col bg-white">
        {/* 上层极简顶栏（44px）：表名、统计、+ 新建作品、在线状态、修改记录 */}
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-slate-200/80 px-3">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarExpandButton />
            <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', wsColor.dot)} />
            <h1 className="truncate text-[15px] font-semibold text-slate-900">
              {data.worksheet.name}
            </h1>
            <span className="hidden shrink-0 text-xs text-slate-400 sm:inline">
              未发布 {data.tasks.length - totalPublishedCount} · 已发布 {totalPublishedCount}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <CreateWorkPopover
              worksheetId={data.worksheet.id}
              onCreated={(createdWork) => {
                setPendingWorks((prev) =>
                  prev.some((w) => w.id === createdWork.id) ||
                  data.works.some((w) => w.id === createdWork.id)
                    ? prev
                    : [...prev, createdWork],
                );
                openAddSegmentForWork(createdWork.id);
                requestAnimationFrame(() => {
                  const banner = document.querySelector(
                    `[data-testid="work-banner-${createdWork.id}"]`,
                  );
                  banner?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                });
              }}
            />

            {onlineUsers.length > 0 && (
              <div
                data-testid="presence-bar"
                className="flex items-center gap-1 rounded-full border border-slate-200/90 bg-slate-50/80 px-2 py-0.5"
              >
                <span className="hidden text-[11px] text-slate-400 sm:inline">在线</span>
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
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
            >
              <History className="h-3.5 w-3.5 text-slate-400" />
              <span className="hidden sm:inline">修改记录</span>
              <span className="sr-only sm:hidden">修改记录</span>
            </button>
          </div>
        </div>

        {/* 下层单行紧凑工具栏（38px） */}
        <div className="flex min-h-[38px] shrink-0 flex-wrap items-center gap-1.5 border-b border-slate-200/80 bg-slate-50/40 px-3 py-1">
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
                  'rounded-md px-2 py-1 text-xs font-medium transition-colors cursor-pointer',
                  statusChip === val
                    ? 'bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-200'
                    : 'text-slate-600 hover:bg-slate-200/60 hover:text-slate-900',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
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

            <FieldVisibilityPopover
              worksheet={data.worksheet}
              columns={data.columns}
              onOpenFullModal={() => setColModalOpen(true)}
            />

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
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-sky-700 hover:bg-sky-50 cursor-pointer"
              >
                <RotateCcw className="h-3 w-3" />
                重置
              </button>
            )}
          </div>
        </div>

        {/* 紧凑已发布折叠条（30px，仅存在已发布任务时显示） */}
        {totalPublishedCount > 0 && (
          <div
            data-testid="published-section"
            className="shrink-0 border-b border-emerald-200/80 bg-emerald-50/45"
          >
            <button
              type="button"
              onClick={() => setPublishedExpanded((v) => !v)}
              className="flex h-[30px] w-full items-center justify-between px-3 text-left text-xs font-medium text-emerald-900 transition-colors hover:bg-emerald-50 cursor-pointer"
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
              <div className="max-h-[34vh] overflow-auto border-t border-emerald-200/60 bg-white">
                <table className="w-max min-w-full border-collapse">
                  {renderTableHeaders(publishedTable, true)}
                  <tbody>
                    {publishedTable
                      .getRowModel()
                      .rows.map((row, idx) => renderSingleRow(publishedTable, row, idx + 1, false))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* 主表格画布（占满剩余视口高度，内部自由横纵滚动） */}
        <div
          ref={setScrollContainerEl}
          className="min-h-0 flex-1 overflow-auto bg-white"
          data-testid="worksheet-table-scroll"
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(ev) => void handleRowDragEnd(ev)}
          >
            <SortableContext
              items={visualActiveTasks.map((t) => t.id)}
              strategy={verticalListSortingStrategy}
            >
              <table
                className="w-max min-w-full border-collapse"
                data-testid="worksheet-main-table"
              >
                {renderTableHeaders(mainTable, true)}
                <tbody>
                  {displayBlocks.length === 0 && (
                    <tr className="border-b border-slate-200/80">
                      <td
                        colSpan={totalColSpan}
                        className="py-10 text-center text-xs text-slate-400"
                      >
                        {isFilteredOrSorted
                          ? '没有符合筛选条件的任务'
                          : '暂无未发布任务，点击顶栏「新建作品」或下方「+ 新建独立任务」开始录入'}
                      </td>
                    </tr>
                  )}

                  {displayBlocks.map((block) => {
                    if (block.kind === 'standalone') {
                      return (
                        <Fragment key={block.key}>
                          {block.tasks.map((task) => {
                            const entry = mainRowLookup.get(task.id);
                            if (!entry) return null;
                            return renderSingleRow(
                              mainTable,
                              entry.row,
                              entry.rowNumber,
                              dragEnabled,
                            );
                          })}
                        </Fragment>
                      );
                    }

                    const collapsed = collapsedWorkIds.has(block.work.id);
                    const doneCount = block.tasks.filter((t) =>
                      isTaskAllStagesDone(t, stageCols),
                    ).length;
                    const lastTaskInWork = block.tasks[block.tasks.length - 1] ?? null;

                    return (
                      <Fragment key={block.key}>
                        <WorkBannerRow
                          work={block.work}
                          colSpan={totalColSpan}
                          taskCount={block.tasks.length}
                          doneCount={doneCount}
                          hasStages={stageCols.length > 0}
                          collapsed={collapsed}
                          dragEnabled={dragEnabled}
                          isEmptyPending={block.isEmptyPending}
                          onToggleCollapse={() => toggleWorkCollapsed(block.work.id)}
                          onRename={(nextName) => renameWork(block.work.id, nextName)}
                          onAddSegment={() => openAddSegmentForWork(block.work.id)}
                          onUngroup={() => {
                            if (block.isEmptyPending || block.tasks.length === 0) {
                              setPendingWorks((prev) => prev.filter((w) => w.id !== block.work.id));
                              if (addingSegmentWorkId === block.work.id) {
                                setAddingSegmentWorkId(null);
                              }
                              pushToast({ message: '已关闭空作品横幅', variant: 'info' });
                            } else {
                              setUngroupingWork({ work: block.work, tasks: block.tasks });
                            }
                          }}
                        />

                        {!collapsed &&
                          block.tasks.map((task) => {
                            const entry = mainRowLookup.get(task.id);
                            if (!entry) return null;
                            return renderSingleRow(
                              mainTable,
                              entry.row,
                              entry.rowNumber,
                              dragEnabled,
                            );
                          })}

                        {!collapsed && addingSegmentWorkId === block.work.id && (
                          <InlineAddSegmentRow
                            workName={block.work.name}
                            colSpan={totalColSpan}
                            pending={createTaskMutation.isPending}
                            onSubmit={(segTitle) => {
                              createTaskMutation.mutate({
                                title: segTitle,
                                workId: block.work.id,
                                afterTaskId: lastTaskInWork?.id ?? null,
                              });
                            }}
                            onCancel={() => setAddingSegmentWorkId(null)}
                          />
                        )}
                      </Fragment>
                    );
                  })}

                  {/* 贴合网格的底部 `+ 新建独立任务` 原地行（回车连续加行） */}
                  <tr className="h-9 border-b border-slate-200/80 bg-white transition-colors hover:bg-slate-50/70">
                    <td className="sticky left-0 z-20 h-9 w-10 min-w-10 border-r border-slate-200/80 bg-white text-center text-slate-400">
                      <Plus className="mx-auto h-3.5 w-3.5" />
                    </td>
                    <td colSpan={visibleColumns.length + 1} className="h-9 p-0 align-middle">
                      <form
                        onSubmit={handleQuickAdd}
                        className="sticky left-[40px] flex h-9 w-full max-w-md items-center gap-2 px-2"
                      >
                        <input
                          ref={quickAddInputRef}
                          id="worksheet-quick-add-input"
                          value={quickAddTitle}
                          onChange={(e) => setQuickAddTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && e.nativeEvent.isComposing) {
                              e.preventDefault();
                            }
                          }}
                          placeholder="新建独立任务（输入标题，回车连续添加）"
                          aria-label="新建任务标题"
                          maxLength={200}
                          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-slate-900 placeholder:text-slate-400 focus:outline-none"
                        />
                        {quickAddTitle.trim() && (
                          <Button
                            type="submit"
                            size="sm"
                            variant="secondary"
                            className="h-6 px-2 text-xs"
                            disabled={createTaskMutation.isPending}
                          >
                            添加
                          </Button>
                        )}
                      </form>
                    </td>
                  </tr>
                </tbody>
              </table>
            </SortableContext>
          </DndContext>
        </div>

        {/* 右键整行上下文菜单 */}
        {rowContextMenu && (
          <div
            ref={contextMenuRef}
            role="menu"
            style={{ top: rowContextMenu.y, left: rowContextMenu.x }}
            className="fixed z-[80] min-w-[152px] rounded-xl border border-slate-200/90 bg-white/98 p-1 shadow-[0_12px_32px_-8px_rgba(15,23,42,0.18)] ring-1 ring-slate-950/5 backdrop-blur-md"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const t = rowContextMenu.task;
                setRowContextMenu(null);
                setDetailTaskId(t.id);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-100 cursor-pointer"
            >
              <PanelRightOpen className="h-3.5 w-3.5 text-slate-400" />
              展开任务详情
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const t = rowContextMenu.task;
                setRowContextMenu(null);
                setAddingSegmentWorkId(null);
                setInsertingAfterId(t.id);
                setInsertTitle('');
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-100 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5 text-slate-400" />
              在下方插入一行
            </button>
            <div className="my-1 h-px bg-slate-100" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const t = rowContextMenu.task;
                setRowContextMenu(null);
                void deleteTask(t);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除任务
            </button>
          </div>
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
