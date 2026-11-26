import {
  type Assignee,
  type BoardColumn,
  type ColumnConfig,
  getEffectiveStageCell,
  PRIORITIES,
  PRIORITY_LABELS,
  type PresencePeer,
  type Priority,
  PUBLISH_STATUS_LABELS,
  PUBLISH_STATUSES,
  type PublishStatus,
  STAGE_STATUS_LABELS,
  STAGE_STATUSES,
  type StageCell,
  type StageStatus,
  type SystemColumnsConfig,
  type TaskDetail,
  type UserListItem,
  type Work,
  type Worksheet,
} from '@nw/shared';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  ListPlus,
  MoreHorizontal,
  PanelRightOpen,
  Paperclip,
  Pencil,
  Plus,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError } from '@/api/client.js';
import { peerColorForUser } from '@/components/ui/colors.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/overlays.js';
import { Button, cn, Input } from '@/components/ui/primitives.js';
import { AddColumnPopover } from '@/components/worksheet/AddColumnPopover.js';
import type {
  ActiveCellConflict,
  StageAttachmentSummary,
  StageCellConflict,
} from '@/components/worksheet/CellEditors.js';
import { ColumnHeaderMenu } from '@/components/worksheet/ColumnHeaderMenu.js';
import { isSystemColumnHidden } from '@/components/worksheet/FieldVisibilityPopover.js';
import { WorkAttachmentSlots } from '@/components/worksheet/WorkBannerRow.js';
import {
  CellType,
  type CombinedSelection,
  DraggableType,
  Grid,
  type ICell,
  type ICellItem,
  type ICollaborator,
  type IGridColumn,
  type IGridRef,
  type IGroupPoint,
  type IRectangle,
  LinearRowType,
  RegionType,
  RowControlType,
  SelectionRegionType,
} from '@/vendor/teable-grid/index.js';

export type GridDisplayBlock =
  | { kind: 'standalone'; key: string; tasks: TaskDetail[] }
  | { kind: 'work'; key: string; work: Work; tasks: TaskDetail[]; isEmptyPending: boolean };

export interface CanvasColumnDef {
  id: string;
  name: string;
  width: number;
  isSystem: boolean;
  systemKey?: keyof SystemColumnsConfig;
  columnConfig?: ColumnConfig;
  kind: 'title' | 'stage' | 'work' | 'priority' | 'publish' | 'files' | 'divisionNote' | 'custom';
  isTextCell: boolean;
}

const PRIORITY_CANVAS_CHOICES: Record<
  Priority,
  { id: string; name: string; color: string; backgroundColor: string }
> = {
  normal: {
    id: 'normal',
    name: PRIORITY_LABELS.normal,
    color: '#52525B',
    backgroundColor: '#F4F4F5',
  },
  high: { id: 'high', name: PRIORITY_LABELS.high, color: '#92400E', backgroundColor: '#FEF3C7' },
  urgent: {
    id: 'urgent',
    name: PRIORITY_LABELS.urgent,
    color: '#B91C1C',
    backgroundColor: '#FEE2E2',
  },
};

function isTaskAllStagesDone(task: TaskDetail, stageCols: ColumnConfig[]): boolean {
  const applicable = stageCols
    .map((c) => getEffectiveStageCell(task, c.id))
    .filter((cell) => cell.status !== 'na');
  return applicable.length > 0 && applicable.every((cell) => cell.status === 'done');
}

// ---- Canvas Work Group Banner Overlay Item ----

function CanvasWorkBannerOverlay({
  work,
  top,
  height,
  taskCount,
  doneCount,
  hasStages,
  collapsed,
  isEmptyPending,
  onToggleCollapse,
  onRename,
  onAddSegment,
  onUngroup,
}: {
  work: Work;
  top: number;
  height: number;
  taskCount: number;
  doneCount: number;
  hasStages: boolean;
  collapsed: boolean;
  isEmptyPending: boolean;
  onToggleCollapse: () => void;
  onRename: (newName: string) => Promise<void>;
  onAddSegment: () => void;
  onUngroup: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(work.name);
  const [savingName, setSavingName] = useState(false);
  const isComposingRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!renaming) setNameDraft(work.name);
  }, [work.name, renaming]);

  useEffect(() => {
    if (renaming) {
      requestAnimationFrame(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      });
    }
  }, [renaming]);

  const commitRename = async () => {
    if (savingName) return;
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === work.name) {
      setNameDraft(work.name);
      setRenaming(false);
      return;
    }
    setSavingName(true);
    try {
      await onRename(trimmed);
      setRenaming(false);
    } catch {
      setNameDraft(work.name);
      setRenaming(false);
    } finally {
      setSavingName(false);
    }
  };

  const progressText =
    taskCount === 0
      ? '待添加分段'
      : hasStages
        ? `已完成 ${doneCount}/${taskCount}`
        : `共 ${taskCount} 条`;
  const progressPct = taskCount > 0 && hasStages ? Math.round((doneCount / taskCount) * 100) : 0;

  return (
    <div
      data-testid={`work-banner-${work.id}`}
      data-work-banner={work.id}
      style={{ top, height }}
      className="pointer-events-auto absolute inset-x-0 z-10 flex items-center justify-between gap-2 border-y border-indigo-200/80 bg-[#EEF2FF] px-2.5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span aria-hidden="true" className="h-4 w-[3px] shrink-0 rounded-full bg-indigo-500" />

        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={collapsed ? `展开作品 ${work.name}` : `折叠作品 ${work.name}`}
          aria-expanded={!collapsed}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-indigo-600/80 transition-colors hover:bg-indigo-200/50 hover:text-indigo-950 cursor-pointer"
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>

        {renaming ? (
          <input
            ref={renameInputRef}
            value={nameDraft}
            disabled={savingName}
            onChange={(e) => setNameDraft(e.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onBlur={() => {
              if (!isComposingRef.current) void commitRename();
            }}
            onKeyDown={(e) => {
              if (isComposingRef.current || e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                void commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setNameDraft(work.name);
                setRenaming(false);
              }
            }}
            aria-label={`重命名作品 ${work.name}`}
            maxLength={80}
            className="h-6 min-w-[140px] max-w-xs rounded border border-indigo-500 bg-white px-1.5 text-[13px] font-semibold text-zinc-950 outline-none"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => setRenaming(true)}
            title={`${work.name}（双击重命名）`}
            className="min-w-0 truncate text-left text-[13px] font-semibold text-indigo-950 hover:text-indigo-700 cursor-text"
          >
            {work.name}
          </button>
        )}

        <span
          data-testid={`work-progress-${work.id}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-indigo-200/80 bg-white/90 px-2 py-0.5 text-[11px] font-medium text-indigo-700"
        >
          {hasStages && taskCount > 0 && (
            <span className="hidden h-1.5 w-10 overflow-hidden rounded-full bg-indigo-100 sm:inline-block">
              <span
                className={cn(
                  'block h-full rounded-full transition-all',
                  progressPct === 100 ? 'bg-emerald-500' : 'bg-indigo-500',
                )}
                style={{ width: `${progressPct}%` }}
              />
            </span>
          )}
          <span className="tabular-nums">{progressText}</span>
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <WorkAttachmentSlots workId={work.id} workName={work.name} />

        <button
          type="button"
          onClick={onAddSegment}
          aria-label={`在 ${work.name} 下添加分段`}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-indigo-200/90 bg-white/95 px-2 text-[11px] font-medium text-indigo-900 transition-colors hover:bg-indigo-50 hover:text-indigo-950 cursor-pointer"
        >
          <Plus className="h-3 w-3" />
          <span>添加分段</span>
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`作品操作 ${work.name}`}
              className="flex h-6 w-6 items-center justify-center rounded-md text-indigo-500/80 transition-colors hover:bg-indigo-200/50 hover:text-indigo-950 cursor-pointer"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[164px]">
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <Pencil className="h-3.5 w-3.5 text-zinc-400" />
              重命名作品
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggleCollapse}>
              {collapsed ? (
                <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />
              )}
              {collapsed ? '展开分段' : '折叠分段'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onUngroup}>
              <Unlink className="h-3.5 w-3.5 text-zinc-400" />
              {isEmptyPending ? '关闭空作品横幅' : '解散分组（移出任务）'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ---- IME-Safe Inline Text Editor Overlay (positioned over Canvas cell) ----

function CanvasInlineTextOverlay({
  taskId,
  columnKey,
  initialValue,
  initialChar,
  inputType = 'text',
  required = false,
  rect,
  remoteConflict,
  onClearConflict,
  onAcceptRemote,
  onCommit,
  onClose,
}: {
  taskId: string;
  columnKey: string;
  initialValue: string;
  initialChar?: string;
  inputType?: 'text' | 'date' | 'link';
  required?: boolean;
  rect: IRectangle;
  remoteConflict: ActiveCellConflict | null;
  onClearConflict: () => void;
  onAcceptRemote: (val: string) => void;
  onCommit: (nextValue: string, baseValue: string, force: boolean) => Promise<void>;
  onClose: (moveAfter?: 'down' | 'right' | 'left') => void;
}) {
  const [draft, setDraft] = useState(
    initialChar !== undefined && inputType !== 'date' ? initialChar : initialValue,
  );
  const [baseValue] = useState(initialValue);
  const [localConflict, setLocalConflict] = useState<ActiveCellConflict | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const isComposingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const conflict = remoteConflict ?? localConflict;

  useEffect(() => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      if (initialChar !== undefined && inputType !== 'date') {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      } else {
        el.select();
      }
    });
  }, [initialChar, inputType]);

  const commitValue = async (force: boolean, moveAfter?: 'down' | 'right' | 'left') => {
    if (savingRef.current) return;
    const trimmed = draft.trim();
    if (required && !trimmed) {
      onClearConflict();
      onClose();
      return;
    }
    if (!force && trimmed === baseValue && !conflict) {
      onClearConflict();
      onClose(moveAfter);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onCommit(trimmed, baseValue, force);
      setLocalConflict(null);
      onClearConflict();
      onClose(moveAfter);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'FIELD_CONFLICT') {
        const details = err.details as
          | { conflicts?: Array<{ currentValue?: unknown; updatedByDisplayName?: string | null }> }
          | undefined;
        const first = details?.conflicts?.[0];
        setLocalConflict({
          actorDisplayName: first?.updatedByDisplayName ?? '他人',
          remoteValue: first?.currentValue == null ? '' : String(first.currentValue),
        });
      } else {
        setSaveError(err instanceof ApiError ? err.message : '保存失败');
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposingRef.current || e.nativeEvent.isComposing) {
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!conflict) {
        void commitValue(false, 'down');
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      if (!conflict) {
        void commitValue(false, e.shiftKey ? 'left' : 'right');
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClearConflict();
      onClose();
    }
  };

  return (
    <div
      data-testid={`canvas-editor-${taskId}-${columnKey}`}
      style={{
        left: rect.x,
        top: rect.y,
        width: Math.max(rect.width, 160),
        height: rect.height,
      }}
      className="pointer-events-auto absolute z-30"
    >
      <input
        ref={inputRef}
        type={inputType === 'date' ? 'date' : 'text'}
        value={draft}
        disabled={saving}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false;
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (savingRef.current || isComposingRef.current || conflict || saveError) return;
          void commitValue(false);
        }}
        aria-label={`编辑 ${columnKey}`}
        className="h-full w-full rounded-[2px] bg-white px-2 text-[13px] text-zinc-950 shadow-sm ring-2 ring-blue-600 outline-none"
      />

      {conflict && (
        <div
          role="alert"
          data-testid="cell-conflict-bar"
          className="absolute top-full left-0 z-40 mt-1.5 flex min-w-[270px] flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 shadow-lg"
        >
          <span>
            {conflict.actorDisplayName} 刚把此格改为「{conflict.remoteValue || '（空）'}」
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="h-6 px-2 text-xs"
              disabled={saving}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                void commitValue(true);
              }}
            >
              保留我的
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-6 px-2 text-xs"
              disabled={saving}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                const remoteVal = conflict.remoteValue;
                setLocalConflict(null);
                onClearConflict();
                onAcceptRemote(remoteVal);
                setDraft(remoteVal);
                onClose();
              }}
            >
              采用对方的
            </Button>
          </div>
        </div>
      )}

      {saveError && !conflict && (
        <div
          role="alert"
          className="absolute top-full left-0 z-40 mt-1.5 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-800 shadow-md"
        >
          <span>保存失败：{saveError}</span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              void commitValue(false);
            }}
            className="font-semibold underline cursor-pointer"
          >
            点击重试
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onClearConflict();
              onClose();
            }}
            className="text-red-500 hover:text-red-700 cursor-pointer"
          >
            取消
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Anchored Stage Cell Popover ----

function AnchoredStagePopover({
  anchorRect,
  columnName,
  cell,
  users,
  userMap,
  remoteConflict,
  onClearConflict,
  onCommit,
  onClose,
}: {
  anchorRect: IRectangle;
  columnName: string;
  cell: StageCell;
  users: UserListItem[];
  userMap: Map<string, string>;
  remoteConflict: StageCellConflict | null;
  onClearConflict: () => void;
  onCommit: (payload: {
    assignees: Assignee[];
    status: StageStatus;
    note: string;
    baseRevision: number;
    force: boolean;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [assignees, setAssignees] = useState<Assignee[]>(cell.assignees);
  const [status, setStatus] = useState<StageStatus>(cell.status);
  const [note, setNote] = useState(cell.note);
  const [baseRevision, setBaseRevision] = useState(cell.revision);
  const [textInput, setTextInput] = useState('');
  const [localConflict, setLocalConflict] = useState<StageCellConflict | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const conflict = remoteConflict ?? localConflict;

  const toggleUser = (userId: string) => {
    setAssignees((prev) =>
      prev.some((a) => a.type === 'user' && a.userId === userId)
        ? prev.filter((a) => !(a.type === 'user' && a.userId === userId))
        : [...prev, { type: 'user', userId }],
    );
  };

  const addTextAssignee = () => {
    const trimmed = textInput.trim();
    if (!trimmed) return;
    setAssignees((prev) =>
      prev.some((a) => a.type === 'text' && a.name === trimmed)
        ? prev
        : [...prev, { type: 'text', name: trimmed }],
    );
    setTextInput('');
  };

  const handleSave = async (force: boolean) => {
    setSaving(true);
    setErr(null);
    try {
      await onCommit({
        assignees,
        status,
        note: note.trim(),
        baseRevision,
        force,
      });
      setLocalConflict(null);
      onClearConflict();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'FIELD_CONFLICT') {
        const details = e.details as
          | { currentCell?: StageCell; updatedByDisplayName?: string | null }
          | undefined;
        if (details?.currentCell) {
          setLocalConflict({
            actorDisplayName: details.updatedByDisplayName ?? '他人',
            remoteCell: details.currentCell,
          });
        } else {
          setErr(e.message);
        }
      } else {
        setErr(e instanceof ApiError ? e.message : '保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) {
          onClearConflict();
          onClose();
        }
      }}
    >
      <PopoverAnchor asChild>
        <div
          className="pointer-events-none absolute"
          style={{
            left: anchorRect.x,
            top: anchorRect.y,
            width: anchorRect.width,
            height: anchorRect.height,
          }}
        />
      </PopoverAnchor>
      <PopoverContent className="w-80 space-y-3" data-testid="stage-cell-popover">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-900">{columnName}</span>
          <span className="text-[11px] text-zinc-400">可多选用户或输入纯文本名字</span>
        </div>

        {conflict && (
          <div
            data-testid="stage-conflict-bar"
            className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950"
          >
            <div>
              {conflict.actorDisplayName} 刚修改了此工序格（状态：
              {STAGE_STATUS_LABELS[conflict.remoteCell.status]}）
            </div>
            <div className="flex gap-1.5">
              <Button
                type="button"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => void handleSave(true)}
                disabled={saving}
              >
                保留我的
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  setAssignees(conflict.remoteCell.assignees);
                  setStatus(conflict.remoteCell.status);
                  setNote(conflict.remoteCell.note);
                  setBaseRevision(conflict.remoteCell.revision);
                  setLocalConflict(null);
                  onClearConflict();
                }}
              >
                采用对方的
              </Button>
            </div>
          </div>
        )}

        {err && <div className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{err}</div>}

        <div>
          <div className="mb-1 text-xs text-zinc-500">状态</div>
          <div className="grid grid-cols-4 gap-1">
            {STAGE_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className={cn(
                  'rounded-md border py-1 text-xs font-medium cursor-pointer',
                  status === s
                    ? 'border-zinc-900 bg-zinc-900 text-white'
                    : 'border-black/[0.1] bg-white text-zinc-700 hover:bg-black/[0.04]',
                )}
              >
                {STAGE_STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1 text-xs text-zinc-500">已选负责人</div>
          <div className="flex flex-wrap gap-1">
            {assignees.length === 0 ? (
              <span className="text-xs text-zinc-400">无（将标记为空缺）</span>
            ) : (
              assignees.map((a, i) => {
                const label = a.type === 'user' ? (userMap.get(a.userId) ?? '未知用户') : a.name;
                return (
                  <span
                    key={a.type === 'user' ? `u:${a.userId}` : `t:${a.name}`}
                    className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-800"
                  >
                    {label}
                    <button
                      type="button"
                      onClick={() => setAssignees((prev) => prev.filter((_, idx) => idx !== i))}
                      className="text-zinc-400 hover:text-zinc-800 cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })
            )}
          </div>
        </div>

        <div>
          <div className="mb-1 text-xs text-zinc-500">选择项目用户</div>
          <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
            {users.map((u) => {
              const active = assignees.some((a) => a.type === 'user' && a.userId === u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => toggleUser(u.id)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-xs cursor-pointer',
                    active
                      ? 'border-zinc-900 bg-zinc-900 text-white'
                      : 'border-black/[0.1] bg-white text-zinc-700 hover:bg-black/[0.04]',
                  )}
                >
                  {u.displayName}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex gap-1.5">
          <Input
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                addTextAssignee();
              }
            }}
            placeholder="输入纯文本名字（如外援小王）"
            className="h-7 text-xs"
            maxLength={32}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 shrink-0 whitespace-nowrap px-2.5 text-xs"
            onClick={addTextAssignee}
          >
            添加
          </Button>
        </div>

        <div>
          <div className="mb-1 text-xs text-zinc-500">工序备注</div>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：初校完成、待终校"
            className="h-8 text-xs"
            maxLength={200}
          />
        </div>

        {/* 阶段 3 本工序附件上传与版本历史预留区 */}
        <div className="flex items-center justify-between rounded-md border border-dashed border-black/[0.1] bg-[#fafafa] px-2.5 py-1.5 text-[11px] text-zinc-400">
          <span className="inline-flex items-center gap-1.5">
            <Paperclip className="h-3 w-3" />
            本工序附件（阶段 3 接入）
          </span>
          <span>直挂新版 / 网盘</span>
        </div>

        <div className="flex justify-end gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              onClearConflict();
              onClose();
            }}
          >
            取消
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => void handleSave(false)}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---- Anchored Publish Popover ----

function AnchoredPublishPopover({
  anchorRect,
  task,
  onSave,
  onClose,
}: {
  anchorRect: IRectangle;
  task: TaskDetail;
  onSave: (patch: {
    publishStatus: PublishStatus;
    publishedAt: string | null;
    publishUrl: string | null;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<PublishStatus>(task.publishStatus);
  const [date, setDate] = useState(task.publishedAt ?? '');
  const [url, setUrl] = useState(task.publishUrl ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onSave({
        publishStatus: status,
        publishedAt: date.trim() || null,
        publishUrl: url.trim() || null,
      });
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverAnchor asChild>
        <div
          className="pointer-events-none absolute"
          style={{
            left: anchorRect.x,
            top: anchorRect.y,
            width: anchorRect.width,
            height: anchorRect.height,
          }}
        />
      </PopoverAnchor>
      <PopoverContent className="w-72 space-y-3" data-testid="publish-cell-popover">
        <div className="text-xs font-semibold text-zinc-900">发布信息</div>
        {err && <div className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{err}</div>}
        <div className="flex gap-1.5">
          {PUBLISH_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={cn(
                'flex-1 rounded-md border py-1.5 text-xs font-medium cursor-pointer',
                status === s
                  ? 'border-zinc-900 bg-zinc-900 text-white'
                  : 'border-black/[0.1] bg-white text-zinc-700 hover:bg-black/[0.04]',
              )}
            >
              {PUBLISH_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        <div>
          <label
            htmlFor={`canvas-pub-date-${task.id}`}
            className="mb-1 block text-xs text-zinc-500"
          >
            发布日期
          </label>
          <Input
            id={`canvas-pub-date-${task.id}`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <div>
          <label htmlFor={`canvas-pub-url-${task.id}`} className="mb-1 block text-xs text-zinc-500">
            发布链接
          </label>
          <Input
            id={`canvas-pub-url-${task.id}`}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
            className="h-8 text-xs"
          />
        </div>
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => void handleSave()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---- Anchored Priority Popover ----

function AnchoredPriorityPopover({
  anchorRect,
  current,
  onSelect,
  onClose,
}: {
  anchorRect: IRectangle;
  current: Priority;
  onSelect: (next: Priority) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverAnchor asChild>
        <div
          className="pointer-events-none absolute"
          style={{
            left: anchorRect.x,
            top: anchorRect.y,
            width: anchorRect.width,
            height: anchorRect.height,
          }}
        />
      </PopoverAnchor>
      <PopoverContent className="w-36 p-1.5">
        <div className="space-y-0.5">
          {PRIORITIES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                void onSelect(p).then(() => onClose());
              }}
              className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs text-zinc-700 hover:bg-black/[0.04] cursor-pointer"
            >
              <span>{PRIORITY_LABELS[p]}</span>
              {current === p && <Check className="h-3.5 w-3.5 text-zinc-900" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---- Anchored Work Combobox Popover (when redundant Work column is explicitly shown) ----

function AnchoredWorkPopover({
  anchorRect,
  workId,
  works,
  onSelectWork,
  onClose,
}: {
  anchorRect: IRectangle;
  workId: string | null;
  works: Work[];
  onSelectWork: (next: { workId?: string | null; workName?: string | null }) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const filtered = trimmed
    ? works.filter((w) => w.name.toLowerCase().includes(trimmed.toLowerCase()))
    : works;
  const exactExists = works.some((w) => w.name === trimmed);

  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverAnchor asChild>
        <div
          className="pointer-events-none absolute"
          style={{
            left: anchorRect.x,
            top: anchorRect.y,
            width: anchorRect.width,
            height: anchorRect.height,
          }}
        />
      </PopoverAnchor>
      <PopoverContent className="w-60 p-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && trimmed && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void onSelectWork({ workName: trimmed }).then(() => onClose());
            }
          }}
          placeholder="搜索或输入新作品名回车"
          className="h-7 text-xs"
          autoFocus
        />
        <div className="mt-1.5 max-h-44 space-y-0.5 overflow-y-auto">
          {filtered.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => void onSelectWork({ workId: w.id }).then(() => onClose())}
              className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs text-zinc-800 hover:bg-black/[0.04] cursor-pointer"
            >
              <span className="truncate">{w.name}</span>
              {w.id === workId && <Check className="h-3.5 w-3.5 text-emerald-600" />}
            </button>
          ))}
          {trimmed && !exactExists && (
            <button
              type="button"
              onClick={() => void onSelectWork({ workName: trimmed }).then(() => onClose())}
              className="flex w-full items-center gap-1 rounded-md bg-zinc-900 px-2 py-1.5 text-left text-xs font-medium text-white hover:bg-zinc-800 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              新建作品「{trimmed}」
            </button>
          )}
        </div>
        {workId && (
          <div className="mt-1.5 border-t border-black/[0.06] pt-1">
            <button
              type="button"
              onClick={() => void onSelectWork({ workId: null }).then(() => onClose())}
              className="w-full rounded-md px-2 py-1 text-left text-xs text-zinc-500 hover:bg-black/[0.04] cursor-pointer"
            >
              清除所属作品
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---- Main Canvas Grid Component ----

export interface WorksheetCanvasGridProps {
  worksheet: Worksheet;
  columns: ColumnConfig[];
  boardColumns: BoardColumn[];
  works: Work[];
  workMap: Map<string, Work>;
  displayBlocks: GridDisplayBlock[];
  visualActiveTasks: TaskDetail[];
  stageCols: ColumnConfig[];
  users: UserListItem[];
  userMap: Map<string, string>;
  peers: Map<string, PresencePeer>;
  selectedCell: { taskId: string; columnKey: string } | null;
  textConflicts: Map<string, ActiveCellConflict>;
  stageConflicts: Map<string, StageCellConflict>;
  highlightedTaskId: string | null;
  collapsedWorkIds: Set<string>;
  addingSegmentWorkId: string | null;
  dragEnabled: boolean;
  isFilteredOrSorted: boolean;
  createTaskPending: boolean;
  createWorkPending: boolean;
  onSelectCell: (taskId: string, columnKey: string) => void;
  onSetEditingFocus: (taskId: string | null, columnKey: string | null, editing: boolean) => void;
  onPatchTask: (
    taskId: string,
    changes: Record<string, unknown>,
    baseValues?: Record<string, unknown>,
    force?: boolean,
  ) => Promise<void>;
  onPatchStage: (
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
  onCreateTask: (payload: {
    title: string;
    afterTaskId?: string | null;
    workId?: string | null;
  }) => void;
  onCreateWork: (name: string) => Promise<void>;
  onDeleteTask: (task: TaskDetail) => void;
  onReorderRows: (movingTaskId: string, targetRowIndex: number) => void;
  onResizeColumn: (colId: string, width: number, isSystem: boolean) => void;
  onToggleWorkCollapsed: (workId: string) => void;
  onRenameWork: (workId: string, newName: string) => Promise<void>;
  onOpenAddSegment: (workId: string) => void;
  onCloseAddSegment: () => void;
  onUngroupWork: (block: Extract<GridDisplayBlock, { kind: 'work' }>) => void;
  onOpenDetail: (taskId: string) => void;
  onClearTextConflict: (key: string) => void;
  onClearStageConflict: (key: string) => void;
  onAcceptRemoteField: (taskId: string, field: string, remoteVal: string) => void;
}

export function WorksheetCanvasGrid(props: WorksheetCanvasGridProps) {
  const {
    worksheet,
    columns,
    boardColumns,
    works,
    workMap,
    displayBlocks,
    visualActiveTasks,
    stageCols,
    users,
    userMap,
    peers,
    selectedCell,
    textConflicts,
    stageConflicts,
    highlightedTaskId,
    collapsedWorkIds,
    addingSegmentWorkId,
    dragEnabled,
    isFilteredOrSorted,
    createTaskPending,
    createWorkPending,
    onSelectCell,
    onSetEditingFocus,
    onPatchTask,
    onPatchStage,
    onCreateTask,
    onCreateWork,
    onDeleteTask,
    onReorderRows,
    onResizeColumn,
    onToggleWorkCollapsed,
    onRenameWork,
    onOpenAddSegment,
    onCloseAddSegment,
    onUngroupWork,
    onOpenDetail,
    onClearTextConflict,
    onClearStageConflict,
    onAcceptRemoteField,
  } = props;

  const gridRef = useRef<IGridRef | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const quickAddInputRef = useRef<HTMLInputElement | null>(null);
  const segInputRef = useRef<HTMLInputElement | null>(null);
  const insertInputRef = useRef<HTMLInputElement | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 640 : false,
  );
  const [previewWidths, setPreviewWidths] = useState<Record<string, number>>({});
  const [layoutTick, setLayoutTick] = useState(0);
  const [createMode, setCreateMode] = useState<'task' | 'work'>('task');
  const [quickAddTitle, setQuickAddTitle] = useState('');
  const [segmentTitle, setSegmentTitle] = useState('');
  const [insertingAfterId, setInsertingAfterId] = useState<string | null>(null);
  const [insertTitle, setInsertTitle] = useState('');

  // 活动编辑态（Canvas 内联文本浮层 / 锚定 Popover）
  const [activeTextEdit, setActiveTextEdit] = useState<{
    taskId: string;
    colIndex: number;
    rowIndex: number;
    columnKey: string;
    initialChar?: string;
  } | null>(null);
  const [activePopover, setActivePopover] = useState<{
    kind: 'stage' | 'priority' | 'publish' | 'work';
    taskId: string;
    colIndex: number;
    rowIndex: number;
    columnKey: string;
  } | null>(null);
  const [headerMenuTarget, setHeaderMenuTarget] = useState<{
    colDef: CanvasColumnDef;
    bounds: IRectangle;
  } | null>(null);
  const [addColOpen, setAddColOpen] = useState(false);
  const [addColAnchor, setAddColAnchor] = useState<IRectangle | null>(null);
  const [rowContextMenu, setRowContextMenu] = useState<{
    task: TaskDetail;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    const onResize = () => {
      setIsNarrow(window.innerWidth < 640);
      setLayoutTick((t) => t + 1);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    return () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (addingSegmentWorkId) {
      setSegmentTitle('');
      requestAnimationFrame(() => segInputRef.current?.focus());
    }
  }, [addingSegmentWorkId]);

  useEffect(() => {
    if (insertingAfterId) {
      setInsertTitle('');
      requestAnimationFrame(() => insertInputRef.current?.focus());
    }
  }, [insertingAfterId]);

  // 点击外部或 Esc 关闭右键菜单
  useEffect(() => {
    if (!rowContextMenu) return;
    const close = () => setRowContextMenu(null);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setRowContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [rowContextMenu]);

  // 列定义列表
  const columnDefs = useMemo<CanvasColumnDef[]>(() => {
    const sys = worksheet.systemColumns ?? {};
    const defs: CanvasColumnDef[] = [
      {
        id: 'title',
        name: '标题 / 分段',
        width: previewWidths.title ?? sys.title?.width ?? 220,
        isSystem: true,
        systemKey: 'title',
        kind: 'title',
        isTextCell: true,
      },
    ];

    for (const col of columns) {
      if (col.hidden) continue;
      defs.push({
        id: col.id,
        name: col.name,
        width: previewWidths[col.id] ?? col.width,
        isSystem: false,
        columnConfig: col,
        kind: col.type === 'stage' ? 'stage' : 'custom',
        isTextCell: col.type !== 'stage',
      });
    }

    if (!isSystemColumnHidden(sys, 'priority')) {
      defs.push({
        id: 'priority',
        name: '优先级',
        width: previewWidths.priority ?? sys.priority?.width ?? 92,
        isSystem: true,
        systemKey: 'priority',
        kind: 'priority',
        isTextCell: false,
      });
    }

    if (!isSystemColumnHidden(sys, 'publish')) {
      defs.push({
        id: 'publish',
        name: '发布信息',
        width: previewWidths.publish ?? sys.publish?.width ?? 148,
        isSystem: true,
        systemKey: 'publish',
        kind: 'publish',
        isTextCell: false,
      });
    }

    if (!isSystemColumnHidden(sys, 'files')) {
      defs.push({
        id: 'files',
        name: '文件',
        width: previewWidths.files ?? sys.files?.width ?? 92,
        isSystem: true,
        systemKey: 'files',
        kind: 'files',
        isTextCell: false,
      });
    }

    if (!isSystemColumnHidden(sys, 'divisionNote')) {
      defs.push({
        id: 'divisionNote',
        name: '分工说明',
        width: previewWidths.divisionNote ?? sys.divisionNote?.width ?? 170,
        isSystem: true,
        systemKey: 'divisionNote',
        kind: 'divisionNote',
        isTextCell: true,
      });
    }

    return defs;
  }, [worksheet.systemColumns, columns, previewWidths]);

  const gridColumns = useMemo<IGridColumn[]>(
    () =>
      columnDefs.map((c) => ({
        id: c.id,
        name: c.name,
        width: c.width,
        hasMenu: c.id !== 'title',
        readonly: true,
      })),
    [columnDefs],
  );

  // 原生 LinearRowType.Group 分组点（无作品任务直接平铺，作品块上下自动插 14px 纯白呼吸间距）
  const groupPoints = useMemo<IGroupPoint[] | null>(() => {
    const hasWorkBlocks = displayBlocks.some((b) => b.kind === 'work');
    if (!hasWorkBlocks) return null;

    const pts: IGroupPoint[] = [];
    for (let idx = 0; idx < displayBlocks.length; idx++) {
      const block = displayBlocks[idx];
      if (!block) continue;
      if (block.kind === 'standalone') {
        if (block.tasks.length > 0) {
          pts.push({ type: LinearRowType.Row, count: block.tasks.length });
        }
      } else {
        if (idx > 0) {
          pts.push({
            type: LinearRowType.Group,
            id: `__spacer__before_${block.work.id}`,
            depth: 0,
            value: null,
            isCollapsed: false,
          });
        }
        const isCollapsed = collapsedWorkIds.has(block.work.id);
        pts.push({
          type: LinearRowType.Group,
          id: block.work.id,
          depth: 0,
          value: block.work,
          isCollapsed,
        });
        if (!isCollapsed && block.tasks.length > 0) {
          pts.push({ type: LinearRowType.Row, count: block.tasks.length });
        }
        const nextBlock = displayBlocks[idx + 1];
        if (nextBlock?.kind === 'standalone') {
          pts.push({
            type: LinearRowType.Group,
            id: `__spacer__after_${block.work.id}`,
            depth: 0,
            value: null,
            isCollapsed: false,
          });
        }
      }
    }
    return pts;
  }, [displayBlocks, collapsedWorkIds]);

  const groupCollection = useMemo(
    () =>
      groupPoints
        ? {
            groupColumns: [{ id: 'work', name: '' }],
            getGroupCell: () => ({ type: CellType.Text, data: '', displayData: '' }) as ICell,
          }
        : null,
    [groupPoints],
  );

  // WebSocket Presence -> teable-grid collaborators（直接绘制彩色在线焦点框）
  const collaborators = useMemo<ICollaborator>(() => {
    const list: ICollaborator = [];
    for (const peer of peers.values()) {
      if (!peer.focus) continue;
      const color = peerColorForUser(peer.userId);
      list.push({
        activeCellId: [peer.focus.taskId, peer.focus.columnKey],
        user: { id: peer.userId, name: peer.displayName },
        borderColor: color.hex,
        timeStamp: Date.now(),
      });
    }
    return list;
  }, [peers]);

  const highlightedRowIndex = useMemo(() => {
    if (!highlightedTaskId) return null;
    const idx = visualActiveTasks.findIndex((t) => t.id === highlightedTaskId);
    return idx >= 0 ? idx : null;
  }, [highlightedTaskId, visualActiveTasks]);

  const getCellContent = useCallback(
    ([colIndex, rowIndex]: ICellItem): ICell => {
      const col = columnDefs[colIndex];
      const task = visualActiveTasks[rowIndex];
      if (!col || !task) {
        return { type: CellType.Text, data: '', displayData: '', readonly: true };
      }

      // 与 layoutRenderer.ts 中 groupBy(collaborators, 'activeCellId') 精确匹配
      const cellId = `${task.id},${col.id}`;

      if (col.kind === 'title') {
        return {
          id: cellId,
          type: CellType.Text,
          data: task.title,
          displayData: task.title,
          readonly: true,
        };
      }

      if (col.kind === 'divisionNote') {
        return {
          id: cellId,
          type: CellType.Text,
          data: task.divisionNote,
          displayData: task.divisionNote,
          readonly: true,
        };
      }

      if (col.kind === 'files') {
        return {
          id: cellId,
          type: CellType.Text,
          data: '阶段 3',
          displayData: '阶段 3',
          readonly: true,
          customTheme: { cellTextColor: '#A1A1AA' },
        };
      }

      if (col.kind === 'work') {
        const w = task.workId ? workMap.get(task.workId) : null;
        return {
          id: cellId,
          type: CellType.Select,
          data: w ? [w.name] : [],
          displayData: w ? [w.name] : [],
          choiceMap: w
            ? {
                [w.name]: {
                  id: w.id,
                  name: w.name,
                  color: '#3F3F46',
                  backgroundColor: '#F4F4F5',
                },
              }
            : {},
          readonly: true,
        };
      }

      if (col.kind === 'priority') {
        const choice = PRIORITY_CANVAS_CHOICES[task.priority];
        return {
          id: cellId,
          type: CellType.Select,
          data: [choice.name],
          displayData: [choice.name],
          choiceMap: { [choice.name]: choice },
          readonly: true,
        };
      }

      if (col.kind === 'publish') {
        const label =
          task.publishStatus === 'published' && task.publishedAt
            ? `${PUBLISH_STATUS_LABELS.published} · ${task.publishedAt}`
            : PUBLISH_STATUS_LABELS[task.publishStatus];
        return {
          id: cellId,
          type: CellType.Select,
          data: [label],
          displayData: [label],
          choiceMap: {
            [label]:
              task.publishStatus === 'published'
                ? { id: label, name: label, color: '#065F46', backgroundColor: '#ECFDF5' }
                : { id: label, name: label, color: '#52525B', backgroundColor: '#F4F4F5' },
          },
          readonly: true,
        };
      }

      if (col.kind === 'stage' && col.columnConfig) {
        const stageCell = getEffectiveStageCell(task, col.columnConfig.id);
        const names = stageCell.assignees.map((a) =>
          a.type === 'user' ? (userMap.get(a.userId) ?? '未知用户') : a.name,
        );
        const assigneesText =
          names.length <= 2 ? names.join('、') : `${names[0]}、${names[1]} +${names.length - 2}`;
        const stageAttachment: StageAttachmentSummary | null = null;
        return {
          id: cellId,
          type: CellType.Stage,
          data: {
            status: stageCell.status,
            assigneesText,
            note: stageCell.note,
            attachment: stageAttachment,
          },
          readonly: true,
          onAttachmentClick: (att) => {
            if (att.url && /^https?:\/\//i.test(att.url)) {
              window.open(att.url, '_blank', 'noopener,noreferrer');
            } else {
              att.onClick?.();
            }
          },
        };
      }

      // 自定义列（text / date / link）
      const val = task.customValues[col.id] ?? '';
      if (col.columnConfig?.type === 'link' && val && /^https?:\/\//i.test(val)) {
        return {
          id: cellId,
          type: CellType.Link,
          data: [val],
          displayData: val,
          readonly: true,
          onClick: (url) => {
            if (/^https?:\/\//i.test(url)) {
              window.open(url, '_blank', 'noopener,noreferrer');
            }
          },
        };
      }

      return {
        id: cellId,
        type: CellType.Text,
        data: val,
        displayData: val,
        readonly: true,
      };
    },
    [columnDefs, visualActiveTasks, workMap, userMap],
  );

  // 打开指定单元格编辑器（支持文本内联编辑或结构化 Popover）
  const openEditorForCell = useCallback(
    (colIndex: number, rowIndex: number, initialChar?: string) => {
      const col = columnDefs[colIndex];
      const task = visualActiveTasks[rowIndex];
      if (!col || !task) return;

      gridRef.current?.scrollToItem([colIndex, rowIndex]);
      onSelectCell(task.id, col.id);

      if (col.kind === 'files') {
        onOpenDetail(task.id);
        return;
      }

      if (col.isTextCell) {
        setActivePopover(null);
        setActiveTextEdit({
          taskId: task.id,
          colIndex,
          rowIndex,
          columnKey: col.id,
          initialChar,
        });
        onSetEditingFocus(task.id, col.id, true);
        return;
      }

      if (
        col.kind === 'stage' ||
        col.kind === 'priority' ||
        col.kind === 'publish' ||
        col.kind === 'work'
      ) {
        setActiveTextEdit(null);
        setActivePopover({
          kind: col.kind,
          taskId: task.id,
          colIndex,
          rowIndex,
          columnKey: col.id,
        });
        onSetEditingFocus(task.id, col.id, true);
      }
    },
    [columnDefs, visualActiveTasks, onSelectCell, onOpenDetail, onSetEditingFocus],
  );

  const handleItemClick = useCallback(
    (regionType: RegionType, _bounds: IRectangle, [colIndex, rowIndex]: ICellItem) => {
      if (regionType !== RegionType.Cell && regionType !== RegionType.ActiveCell) return;
      const col = columnDefs[colIndex];
      const task = visualActiveTasks[rowIndex];
      if (!col || !task) return;

      onSelectCell(task.id, col.id);

      if (col.kind === 'files') {
        onOpenDetail(task.id);
        return;
      }

      if (
        col.kind === 'stage' ||
        col.kind === 'priority' ||
        col.kind === 'publish' ||
        col.kind === 'work'
      ) {
        setActiveTextEdit(null);
        setActivePopover({
          kind: col.kind,
          taskId: task.id,
          colIndex,
          rowIndex,
          columnKey: col.id,
        });
        onSetEditingFocus(task.id, col.id, true);
      }
    },
    [columnDefs, visualActiveTasks, onSelectCell, onOpenDetail, onSetEditingFocus],
  );

  const handleCellDblClick = useCallback(
    ([colIndex, rowIndex]: ICellItem) => {
      openEditorForCell(colIndex, rowIndex);
    },
    [openEditorForCell],
  );

  const handleSelectionChanged = useCallback(
    (selection: CombinedSelection) => {
      if (selection.type === SelectionRegionType.Cells && selection.ranges[0]) {
        const [colIdx, rowIdx] = selection.ranges[0];
        const col = columnDefs[colIdx];
        const task = visualActiveTasks[rowIdx];
        if (col && task) {
          onSelectCell(task.id, col.id);
        }
      }
    },
    [columnDefs, visualActiveTasks, onSelectCell],
  );

  const handleColumnHeaderOpen = useCallback(
    (colIndex: number, bounds: IRectangle) => {
      const colDef = columnDefs[colIndex];
      if (!colDef || colDef.id === 'title') return;
      setHeaderMenuTarget({ colDef, bounds });
    },
    [columnDefs],
  );

  const handleColumnAppend = useCallback(() => {
    const lastIdx = columnDefs.length - 1;
    const lastBounds = lastIdx >= 0 ? gridRef.current?.getColumnHeaderBounds(lastIdx) : null;
    setAddColAnchor(
      lastBounds
        ? {
            x: lastBounds.x + lastBounds.width,
            y: 0,
            width: 44,
            height: 34,
          }
        : { x: 240, y: 0, width: 44, height: 34 },
    );
    setAddColOpen(true);
  }, [columnDefs.length]);

  const handleColumnResize = useCallback(
    (_col: IGridColumn, newSize: number, colIndex: number) => {
      const colDef = columnDefs[colIndex];
      if (!colDef) return;
      const clamped = Math.max(80, Math.min(600, Math.round(newSize)));
      setPreviewWidths((prev) => ({ ...prev, [colDef.id]: clamped }));
      setLayoutTick((t) => t + 1);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        onResizeColumn(colDef.id, clamped, colDef.isSystem);
      }, 280);
    },
    [columnDefs, onResizeColumn],
  );

  const handleContextMenu = useCallback(
    (selection: CombinedSelection, position: { x: number; y: number }) => {
      let rowIdx: number | undefined;
      if (selection.type === SelectionRegionType.Cells && selection.ranges[0]) {
        rowIdx = selection.ranges[0][1];
      } else if (selection.type === SelectionRegionType.Rows && selection.ranges[0]) {
        rowIdx = selection.ranges[0][0];
      } else {
        const hit = gridRef.current?.getCellIndicesAtPosition(position.x, position.y);
        rowIdx = hit?.[1];
      }
      if (rowIdx == null) return;
      const task = visualActiveTasks[rowIdx];
      if (task) {
        const rect = gridRef.current?.getContainer()?.getBoundingClientRect();
        const absX = (rect?.left ?? 0) + position.x;
        const absY = (rect?.top ?? 0) + position.y;
        setRowContextMenu({
          task,
          x: Math.min(absX, window.innerWidth - 170),
          y: Math.min(absY, window.innerHeight - 130),
        });
      }
    },
    [visualActiveTasks],
  );

  // 键盘 Enter / F2 / 直接键入字符进入单元格编辑
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.isComposing) return;
      if (activeTextEdit || activePopover || headerMenuTarget || addColOpen || rowContextMenu) {
        return;
      }
      if (!selectedCell) return;

      const target = e.target as HTMLElement | null;
      if (target) {
        const insideGrid = Boolean(target.closest('[data-t-grid-container]'));
        if (
          target.closest('[role="dialog"]') ||
          target.closest('[data-radix-popper-content-wrapper]') ||
          target.closest('[role="menu"]')
        ) {
          return;
        }
        if (
          !insideGrid &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable)
        ) {
          return;
        }
      }

      const colIndex = columnDefs.findIndex((c) => c.id === selectedCell.columnKey);
      const rowIndex = visualActiveTasks.findIndex((t) => t.id === selectedCell.taskId);
      if (colIndex === -1 || rowIndex === -1) return;

      if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault();
        openEditorForCell(colIndex, rowIndex);
        return;
      }

      const col = columnDefs[colIndex];
      if (
        col?.isTextCell &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.length === 1 &&
        e.key !== ' '
      ) {
        e.preventDefault();
        openEditorForCell(colIndex, rowIndex, e.key);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    selectedCell,
    activeTextEdit,
    activePopover,
    headerMenuTarget,
    addColOpen,
    rowContextMenu,
    columnDefs,
    visualActiveTasks,
    openEditorForCell,
  ]);

  // 同步 groupPoints / scroll 变化时重绘浮层坐标
  const layoutKey = `${groupPoints?.length ?? 0}:${visualActiveTasks.length}:${columnDefs.length}:${collapsedWorkIds.size}`;
  useEffect(() => {
    void layoutKey;
    const raf = requestAnimationFrame(() => setLayoutTick((t) => t + 1));
    return () => cancelAnimationFrame(raf);
  }, [layoutKey]);

  const moveSelectionAfterEdit = useCallback(
    (colIndex: number, rowIndex: number, dir?: 'down' | 'right' | 'left') => {
      if (!dir) return;
      let nextC = colIndex;
      let nextR = rowIndex;
      if (dir === 'down') {
        nextR = Math.min(visualActiveTasks.length - 1, rowIndex + 1);
      } else if (dir === 'right') {
        if (colIndex + 1 < columnDefs.length) nextC = colIndex + 1;
        else if (rowIndex + 1 < visualActiveTasks.length) {
          nextR = rowIndex + 1;
          nextC = 0;
        }
      } else if (dir === 'left') {
        if (colIndex - 1 >= 0) nextC = colIndex - 1;
        else if (rowIndex - 1 >= 0) {
          nextR = rowIndex - 1;
          nextC = columnDefs.length - 1;
        }
      }
      const nextTask = visualActiveTasks[nextR];
      const nextCol = columnDefs[nextC];
      if (!nextTask || !nextCol) return;
      gridRef.current?.setActiveCell([nextC, nextR]);
      gridRef.current?.scrollToItem([nextC, nextR]);
      onSelectCell(nextTask.id, nextCol.id);
    },
    [visualActiveTasks, columnDefs, onSelectCell],
  );

  // 计算可见作品大标题横幅坐标
  const workBlockById = useMemo(() => {
    const map = new Map<string, Extract<GridDisplayBlock, { kind: 'work' }>>();
    for (const b of displayBlocks) {
      if (b.kind === 'work') map.set(b.work.id, b);
    }
    return map;
  }, [displayBlocks]);

  // 读取当前帧的分组头坐标、作品分段左导轨与表格底部坐标（随滚动实时更新）
  const groupHeadersLayout = useMemo(() => {
    void layoutTick;
    return gridRef.current?.getGroupHeadersLayout() ?? [];
  }, [layoutTick]);

  const workRowRails = useMemo(() => {
    void layoutTick;
    const rails: Array<{ key: string; top: number; height: number }> = [];
    for (let i = 0; i < visualActiveTasks.length; i++) {
      const t = visualActiveTasks[i];
      if (!t?.workId) continue;
      const b = gridRef.current?.getCellBounds([0, i]);
      if (!b) continue;
      const relTop = b.y - 34;
      if (relTop < -b.height || relTop > 2400) continue;
      rails.push({ key: t.id, top: relTop, height: b.height });
    }
    return rails;
  }, [layoutTick, visualActiveTasks]);

  const contentBottomY = useMemo(() => {
    void layoutTick;
    return gridRef.current?.getContentBottomY() ?? 34;
  }, [layoutTick]);

  // 计算可见远端协作者浮标坐标
  const visiblePeerBadges = useMemo(() => {
    void layoutTick;
    const result: Array<{ peer: PresencePeer; bounds: IRectangle }> = [];
    for (const peer of peers.values()) {
      if (!peer.focus) continue;
      const colIdx = columnDefs.findIndex((c) => c.id === peer.focus?.columnKey);
      const rowIdx = visualActiveTasks.findIndex((t) => t.id === peer.focus?.taskId);
      if (colIdx === -1 || rowIdx === -1) continue;
      const bounds = gridRef.current?.getCellBounds([colIdx, rowIdx]);
      if (bounds && bounds.y >= 20) {
        result.push({ peer, bounds });
      }
    }
    return result;
  }, [layoutTick, peers, columnDefs, visualActiveTasks]);

  const activeTextTask = activeTextEdit
    ? (visualActiveTasks.find((t) => t.id === activeTextEdit.taskId) ?? null)
    : null;
  const activeTextCol = activeTextEdit ? (columnDefs[activeTextEdit.colIndex] ?? null) : null;
  const activeTextBounds = useMemo(() => {
    void layoutTick;
    if (!activeTextEdit) return null;
    return (
      gridRef.current?.getCellBounds([activeTextEdit.colIndex, activeTextEdit.rowIndex]) ?? null
    );
  }, [layoutTick, activeTextEdit]);

  const activePopoverTask = activePopover
    ? (visualActiveTasks.find((t) => t.id === activePopover.taskId) ?? null)
    : null;
  const activePopoverCol = activePopover ? (columnDefs[activePopover.colIndex] ?? null) : null;
  const activePopoverBounds = useMemo(() => {
    void layoutTick;
    if (!activePopover) return null;
    return gridRef.current?.getCellBounds([activePopover.colIndex, activePopover.rowIndex]) ?? null;
  }, [layoutTick, activePopover]);

  const handleQuickAdd = async (e: FormEvent) => {
    e.preventDefault();
    const title = quickAddTitle.trim();
    if (!title) return;
    if (createMode === 'work') {
      try {
        await onCreateWork(title);
        setQuickAddTitle('');
        setCreateMode('task');
      } catch {
        // 错误提示已在父层 toast 弹出，保留输入内容方便修改
      }
      return;
    }
    onCreateTask({ title });
    setQuickAddTitle('');
    requestAnimationFrame(() => quickAddInputRef.current?.focus());
  };

  const addingSegmentBlock = addingSegmentWorkId
    ? (workBlockById.get(addingSegmentWorkId) ?? null)
    : null;
  const addingSegmentBannerLayout = addingSegmentWorkId
    ? (groupHeadersLayout.find((g) => g.id === addingSegmentWorkId) ?? null)
    : null;

  const handleSegmentSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!addingSegmentBlock) return;
    const trimmed = segmentTitle.trim();
    if (!trimmed) return;
    const lastTask = addingSegmentBlock.tasks[addingSegmentBlock.tasks.length - 1] ?? null;
    onCreateTask({
      title: trimmed,
      workId: addingSegmentBlock.work.id,
      afterTaskId: lastTask?.id ?? null,
    });
    setSegmentTitle('');
    requestAnimationFrame(() => segInputRef.current?.focus());
  };

  const handleInsertSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = insertTitle.trim();
    if (!trimmed || !insertingAfterId) return;
    const anchor = visualActiveTasks.find((t) => t.id === insertingAfterId);
    onCreateTask({
      title: trimmed,
      afterTaskId: insertingAfterId,
      workId: anchor?.workId ?? null,
    });
    setInsertingAfterId(null);
    setInsertTitle('');
  };

  // 为当前选中格和每列/每行导出轻量交互辅助，便于桌面键盘操作、屏幕阅读器与 E2E 真实画布点击定位
  const openCellById = useCallback(
    (taskId: string, columnKey: string, mode: 'select' | 'edit') => {
      const colIndex = columnDefs.findIndex((c) => c.id === columnKey);
      const rowIndex = visualActiveTasks.findIndex((t) => t.id === taskId);
      if (colIndex === -1 || rowIndex === -1) return;
      gridRef.current?.scrollToItem([colIndex, rowIndex]);
      gridRef.current?.setActiveCell([colIndex, rowIndex]);
      if (mode === 'edit') {
        openEditorForCell(colIndex, rowIndex);
      } else {
        onSelectCell(taskId, columnKey);
      }
    },
    [columnDefs, visualActiveTasks, openEditorForCell, onSelectCell],
  );

  // 暴露只读视口坐标查询（供 E2E 用真实鼠标点击 Canvas 单元格与列头，严禁绕过画布交互）
  useEffect(() => {
    const host = canvasHostRef.current as
      | (HTMLDivElement & {
          __nwGridGeometry?: {
            getCellPoint: (taskId: string, columnKey: string) => { x: number; y: number } | null;
            getHeaderPoint: (columnKey: string) => { x: number; y: number } | null;
            getRowExpandPoint: (taskId: string) => { x: number; y: number } | null;
          };
        })
      | null;
    if (!host) return;
    host.__nwGridGeometry = {
      getCellPoint: (taskId: string, columnKey: string) => {
        const colIdx = columnDefs.findIndex((c) => c.id === columnKey);
        const rowIdx = visualActiveTasks.findIndex((t) => t.id === taskId);
        if (colIdx === -1 || rowIdx === -1) return null;
        const b = gridRef.current?.getCellBounds([colIdx, rowIdx]);
        const hostRect = host.getBoundingClientRect();
        if (!b || hostRect.width === 0 || hostRect.height === 0) return null;
        const frozenRight =
          colIdx > 0
            ? (gridRef.current?.getColumnHeaderBounds(0)?.x ?? 0) +
              (gridRef.current?.getColumnHeaderBounds(0)?.width ?? 0)
            : 0;
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        if (
          cx < frozenRight + 4 ||
          cx > hostRect.width - 4 ||
          cy < 36 ||
          cy > hostRect.height - 4
        ) {
          gridRef.current?.scrollToItem([colIdx, rowIdx]);
          return null;
        }
        return { x: hostRect.left + cx, y: hostRect.top + cy };
      },
      getHeaderPoint: (columnKey: string) => {
        const colIdx = columnDefs.findIndex((c) => c.id === columnKey);
        if (colIdx === -1) return null;
        const b = gridRef.current?.getColumnHeaderBounds(colIdx);
        const hostRect = host.getBoundingClientRect();
        if (!b || hostRect.width === 0) return null;
        const frozenRight =
          colIdx > 0
            ? (gridRef.current?.getColumnHeaderBounds(0)?.x ?? 0) +
              (gridRef.current?.getColumnHeaderBounds(0)?.width ?? 0)
            : 0;
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        if (cx < frozenRight + 4 || cx > hostRect.width - 4) {
          gridRef.current?.scrollToItem([colIdx, 0]);
          return null;
        }
        return { x: hostRect.left + cx, y: hostRect.top + cy };
      },
      getRowExpandPoint: (taskId: string) => {
        const rowIdx = visualActiveTasks.findIndex((t) => t.id === taskId);
        if (rowIdx === -1) return null;
        const b = gridRef.current?.getCellBounds([0, rowIdx]);
        const hostRect = host.getBoundingClientRect();
        if (!b || hostRect.height === 0) return null;
        const cy = b.y + b.height / 2;
        if (cy < 36 || cy > hostRect.height - 4) {
          gridRef.current?.scrollToItem([0, rowIdx]);
          return null;
        }
        return { x: hostRect.left + 40, y: hostRect.top + cy };
      },
    };
    return () => {
      delete host.__nwGridGeometry;
    };
  }, [columnDefs, visualActiveTasks]);

  return (
    <div
      data-testid="worksheet-main-table"
      data-selected-cell={selectedCell ? `${selectedCell.taskId}:${selectedCell.columnKey}` : ''}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-white"
    >
      {/* 主 Canvas 画布容器 */}
      <div
        ref={canvasHostRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        data-testid="worksheet-canvas-grid"
      >
        {displayBlocks.length === 0 ? (
          <div className="flex flex-col">
            <div
              data-testid="inline-quick-add-row"
              className="flex h-10 items-center border-b border-black/[0.08] bg-[#fafafa]/80 px-2.5 transition-colors focus-within:bg-white"
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    data-testid="quick-add-mode-trigger"
                    aria-label="切换新增类型"
                    className={cn(
                      'mr-2 inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors cursor-pointer',
                      createMode === 'work'
                        ? 'border-indigo-200 bg-[#EEF2FF] text-indigo-800 hover:bg-indigo-100/80'
                        : 'border-black/[0.1] bg-white text-zinc-700 hover:bg-black/[0.04]',
                    )}
                  >
                    {createMode === 'work' ? (
                      <FolderPlus className="h-3.5 w-3.5 text-indigo-600" strokeWidth={1.75} />
                    ) : (
                      <ListPlus className="h-3.5 w-3.5 text-zinc-500" strokeWidth={1.75} />
                    )}
                    <span>{createMode === 'work' ? '作品' : '任务'}</span>
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[144px]">
                  <DropdownMenuItem
                    onSelect={() => {
                      setCreateMode('task');
                      requestAnimationFrame(() => quickAddInputRef.current?.focus());
                    }}
                  >
                    <ListPlus className="h-3.5 w-3.5 text-zinc-500" />
                    <span>新增任务</span>
                    {createMode === 'task' && (
                      <Check className="ml-auto h-3.5 w-3.5 text-zinc-900" />
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setCreateMode('work');
                      requestAnimationFrame(() => quickAddInputRef.current?.focus());
                    }}
                  >
                    <FolderPlus className="h-3.5 w-3.5 text-indigo-600" />
                    <span>新增作品</span>
                    {createMode === 'work' && (
                      <Check className="ml-auto h-3.5 w-3.5 text-indigo-600" />
                    )}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <form
                onSubmit={(e) => void handleQuickAdd(e)}
                className="flex h-full min-w-0 flex-1 items-center gap-2"
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
                  placeholder={
                    createMode === 'work'
                      ? '新增作品大标题（输入作品名，回车创建并添加分段）'
                      : '新增任务（输入标题，回车连续添加）'
                  }
                  aria-label={createMode === 'work' ? '新作品名称' : '新建任务标题'}
                  maxLength={createMode === 'work' ? 80 : 200}
                  className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-zinc-950 placeholder:text-zinc-400 focus:outline-none"
                />
                {quickAddTitle.trim() && (
                  <Button
                    type="submit"
                    size="sm"
                    variant="secondary"
                    className="h-6 shrink-0 whitespace-nowrap px-2 text-xs"
                    disabled={createMode === 'work' ? createWorkPending : createTaskPending}
                  >
                    {createMode === 'work' ? '创建作品' : '添加'}
                  </Button>
                )}
              </form>
            </div>
            <div className="px-4 py-10 text-center text-xs text-zinc-400">
              {isFilteredOrSorted
                ? '没有符合筛选条件的任务'
                : '暂无未发布任务，可直接在上方新增行录入任务或切换为「作品」创建作品大标题'}
            </div>
          </div>
        ) : (
          <Grid
            ref={gridRef}
            columns={gridColumns}
            rowCount={visualActiveTasks.length}
            rowHeight={36}
            columnHeaderHeight={34}
            scrollBufferY={76}
            freezeColumnCount={isNarrow ? 0 : 1}
            isTouchDevice={isNarrow}
            isMultiSelectionEnable={false}
            rowIndexVisible
            rowControls={
              dragEnabled
                ? [{ type: RowControlType.Drag }, { type: RowControlType.Expand }]
                : [{ type: RowControlType.Expand }]
            }
            draggable={dragEnabled ? DraggableType.Row : DraggableType.None}
            groupPoints={groupPoints}
            groupCollection={groupCollection}
            collapsedGroupIds={collapsedWorkIds}
            collaborators={collaborators}
            highlightedRowIndex={highlightedRowIndex}
            getCellContent={getCellContent}
            onItemClick={handleItemClick}
            onCellDblClick={handleCellDblClick}
            onSelectionChanged={handleSelectionChanged}
            onColumnHeaderClick={handleColumnHeaderOpen}
            onColumnHeaderMenuClick={handleColumnHeaderOpen}
            onColumnAppend={handleColumnAppend}
            onColumnResize={handleColumnResize}
            onRowExpand={(rowIndex) => {
              const t = visualActiveTasks[rowIndex];
              if (t) onOpenDetail(t.id);
            }}
            onRowOrdered={(dragRowIndices, dropRowIndex) => {
              const firstIdx = dragRowIndices[0];
              if (firstIdx == null) return;
              const movingTask = visualActiveTasks[firstIdx];
              if (movingTask) onReorderRows(movingTask.id, dropRowIndex);
            }}
            onCollapsedGroupChanged={(nextSet) => {
              for (const b of displayBlocks) {
                if (b.kind !== 'work') continue;
                const was = collapsedWorkIds.has(b.work.id);
                const now = nextSet.has(b.work.id);
                if (was !== now) onToggleWorkCollapsed(b.work.id);
              }
            }}
            onContextMenu={handleContextMenu}
            onScrollChanged={() => {
              setLayoutTick((t) => t + 1);
            }}
          />
        )}

        {/* 原生 LinearRowType.Group 作品大标题横幅 + 作品分段左导轨精确对齐浮层 */}
        <div className="pointer-events-none absolute inset-x-0 top-[34px] bottom-0 overflow-hidden">
          {workRowRails.map((rail) => (
            <span
              key={rail.key}
              aria-hidden="true"
              style={{ top: rail.top, height: rail.height }}
              className="pointer-events-none absolute left-0 z-[5] w-[3px] bg-indigo-300/80"
            />
          ))}
          {groupHeadersLayout.map((hdr) => {
            const block = workBlockById.get(hdr.id);
            if (!block) return null;
            const relativeTop = hdr.y - 34;
            if (relativeTop < -hdr.height || relativeTop > 2400) return null;
            const doneCount = block.tasks.filter((t) => isTaskAllStagesDone(t, stageCols)).length;
            return (
              <CanvasWorkBannerOverlay
                key={block.work.id}
                work={block.work}
                top={relativeTop}
                height={hdr.height}
                taskCount={block.tasks.length}
                doneCount={doneCount}
                hasStages={stageCols.length > 0}
                collapsed={collapsedWorkIds.has(block.work.id)}
                isEmptyPending={block.isEmptyPending}
                onToggleCollapse={() => onToggleWorkCollapsed(block.work.id)}
                onRename={(nextName) => onRenameWork(block.work.id, nextName)}
                onAddSegment={() => onOpenAddSegment(block.work.id)}
                onUngroup={() => onUngroupWork(block)}
              />
            );
          })}
        </div>

        {/* 在线状态远端聚焦浮标（叠加在 Canvas collaborators 边框上方） */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {visiblePeerBadges.map(({ peer, bounds }) => {
            const color = peerColorForUser(peer.userId);
            return (
              <div
                key={peer.connId}
                data-testid="peer-focus-badge"
                style={{
                  left: Math.max(4, bounds.x + bounds.width - 96),
                  top: Math.max(2, bounds.y - 20),
                }}
                className={cn(
                  'pointer-events-none absolute z-20 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium shadow-xs',
                  color.bg,
                  color.text,
                )}
              >
                {peer.displayName}
                {peer.focus?.editing ? ' 正在编辑' : ''}
              </div>
            );
          })}
        </div>

        {/* 文本/日期/链接单元格 DOM 内联编辑浮层（严格保留中文 IME 与并发冲突浮条） */}
        {activeTextEdit && activeTextTask && activeTextCol && activeTextBounds && (
          <CanvasInlineTextOverlay
            key={`${activeTextEdit.taskId}:${activeTextEdit.columnKey}`}
            taskId={activeTextEdit.taskId}
            columnKey={activeTextEdit.columnKey}
            initialValue={
              activeTextCol.kind === 'title'
                ? activeTextTask.title
                : activeTextCol.kind === 'divisionNote'
                  ? activeTextTask.divisionNote
                  : (activeTextTask.customValues[activeTextCol.id] ?? '')
            }
            initialChar={activeTextEdit.initialChar}
            inputType={
              activeTextCol.columnConfig?.type === 'date'
                ? 'date'
                : activeTextCol.columnConfig?.type === 'link'
                  ? 'link'
                  : 'text'
            }
            required={activeTextCol.kind === 'title'}
            rect={activeTextBounds}
            remoteConflict={
              textConflicts.get(`${activeTextEdit.taskId}:${activeTextEdit.columnKey}`) ?? null
            }
            onClearConflict={() =>
              onClearTextConflict(`${activeTextEdit.taskId}:${activeTextEdit.columnKey}`)
            }
            onAcceptRemote={(val) =>
              onAcceptRemoteField(activeTextEdit.taskId, activeTextEdit.columnKey, val)
            }
            onCommit={(nextVal, baseVal, force) => {
              if (activeTextCol.kind === 'title') {
                return onPatchTask(
                  activeTextEdit.taskId,
                  { title: nextVal },
                  { title: baseVal },
                  force,
                );
              }
              if (activeTextCol.kind === 'divisionNote') {
                return onPatchTask(
                  activeTextEdit.taskId,
                  { divisionNote: nextVal },
                  { divisionNote: baseVal },
                  force,
                );
              }
              return onPatchTask(
                activeTextEdit.taskId,
                { customValues: { [activeTextCol.id]: nextVal || null } },
                { customValues: { [activeTextCol.id]: baseVal || null } },
                force,
              );
            }}
            onClose={(moveAfter) => {
              const { colIndex, rowIndex, taskId, columnKey } = activeTextEdit;
              setActiveTextEdit(null);
              onSetEditingFocus(taskId, columnKey, false);
              if (moveAfter) {
                moveSelectionAfterEdit(colIndex, rowIndex, moveAfter);
              }
            }}
          />
        )}

        {/* 锚定工序格 Popover */}
        {activePopover?.kind === 'stage' &&
          activePopoverTask &&
          activePopoverCol?.columnConfig &&
          activePopoverBounds &&
          (() => {
            const stageColCfg = activePopoverCol.columnConfig;
            return (
              <AnchoredStagePopover
                key={`${activePopover.taskId}:${activePopover.columnKey}`}
                anchorRect={activePopoverBounds}
                columnName={stageColCfg.name}
                cell={getEffectiveStageCell(activePopoverTask, stageColCfg.id)}
                users={users}
                userMap={userMap}
                remoteConflict={
                  stageConflicts.get(`${activePopover.taskId}:${activePopover.columnKey}`) ?? null
                }
                onClearConflict={() =>
                  onClearStageConflict(`${activePopover.taskId}:${activePopover.columnKey}`)
                }
                onCommit={(payload) => onPatchStage(activePopover.taskId, stageColCfg.id, payload)}
                onClose={() => {
                  onSetEditingFocus(activePopover.taskId, activePopover.columnKey, false);
                  setActivePopover(null);
                }}
              />
            );
          })()}

        {/* 锚定发布信息 Popover */}
        {activePopover?.kind === 'publish' && activePopoverTask && activePopoverBounds && (
          <AnchoredPublishPopover
            key={`${activePopover.taskId}:publish`}
            anchorRect={activePopoverBounds}
            task={activePopoverTask}
            onSave={(patch) => onPatchTask(activePopoverTask.id, patch, undefined, true)}
            onClose={() => {
              onSetEditingFocus(activePopoverTask.id, 'publish', false);
              setActivePopover(null);
            }}
          />
        )}

        {/* 锚定优先级 Popover */}
        {activePopover?.kind === 'priority' && activePopoverTask && activePopoverBounds && (
          <AnchoredPriorityPopover
            key={`${activePopover.taskId}:priority`}
            anchorRect={activePopoverBounds}
            current={activePopoverTask.priority}
            onSelect={(next) =>
              onPatchTask(
                activePopoverTask.id,
                { priority: next },
                { priority: activePopoverTask.priority },
                true,
              )
            }
            onClose={() => {
              onSetEditingFocus(activePopoverTask.id, 'priority', false);
              setActivePopover(null);
            }}
          />
        )}

        {/* 锚定作品列 Popover（当用户在字段显隐中开启作品列时） */}
        {activePopover?.kind === 'work' && activePopoverTask && activePopoverBounds && (
          <AnchoredWorkPopover
            key={`${activePopover.taskId}:work`}
            anchorRect={activePopoverBounds}
            workId={activePopoverTask.workId}
            works={works}
            onSelectWork={(next) =>
              onPatchTask(activePopoverTask.id, next, { workId: activePopoverTask.workId }, true)
            }
            onClose={() => {
              onSetEditingFocus(activePopoverTask.id, 'work', false);
              setActivePopover(null);
            }}
          />
        )}

        {/* 锚定列头菜单 Popover */}
        {headerMenuTarget && (
          <ColumnHeaderMenu
            worksheetId={worksheet.id}
            label={headerMenuTarget.colDef.name}
            systemKey={headerMenuTarget.colDef.systemKey}
            columnConfig={headerMenuTarget.colDef.columnConfig}
            allColumns={columns}
            boardColumns={boardColumns}
            controlledOpen
            onControlledOpenChange={(next) => {
              if (!next) setHeaderMenuTarget(null);
            }}
            anchorRect={headerMenuTarget.bounds}
          />
        )}

        {/* 锚定 `+` 新增列 Popover */}
        <AddColumnPopover
          worksheetId={worksheet.id}
          columns={columns}
          boardColumns={boardColumns}
          controlledOpen={addColOpen}
          onControlledOpenChange={setAddColOpen}
          anchorRect={addColAnchor}
        />

        {/* 原地添加作品分段浮条 */}
        {addingSegmentBlock && (
          <div
            data-testid="inline-add-segment-row"
            style={{
              top: addingSegmentBannerLayout
                ? Math.max(38, Math.min(addingSegmentBannerLayout.y + 42, 420))
                : 76,
            }}
            className="absolute right-4 left-4 z-30 flex max-w-xl items-center gap-1.5 rounded-lg border border-black/[0.12] bg-white px-2.5 py-1.5 shadow-lg"
          >
            <Plus className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <form
              onSubmit={handleSegmentSubmit}
              className="flex min-w-0 flex-1 items-center gap-1.5"
            >
              <input
                ref={segInputRef}
                value={segmentTitle}
                onChange={(e) => setSegmentTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    onCloseAddSegment();
                  }
                }}
                placeholder={`在「${addingSegmentBlock.work.name}」下添加分段（如 0-36:37，回车连续添加）`}
                aria-label={`为 ${addingSegmentBlock.work.name} 添加分段`}
                className="h-7 min-w-0 flex-1 rounded border border-black/[0.12] bg-white px-2 text-[13px] text-zinc-950 placeholder:text-zinc-400 outline-none focus:border-zinc-900"
                maxLength={200}
              />
              <Button
                type="submit"
                size="sm"
                className="h-7 px-2.5 text-xs"
                disabled={createTaskPending || !segmentTitle.trim()}
              >
                添加
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={onCloseAddSegment}
              >
                完成
              </Button>
            </form>
          </div>
        )}

        {/* 在指定行下方插入新行浮条 */}
        {insertingAfterId && (
          <div
            data-testid="inline-insert-row"
            className="absolute right-4 bottom-3 left-4 z-30 flex max-w-xl items-center gap-1.5 rounded-lg border border-black/[0.12] bg-white px-2.5 py-1.5 shadow-lg"
          >
            <Plus className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <form
              onSubmit={handleInsertSubmit}
              className="flex min-w-0 flex-1 items-center gap-1.5"
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
                className="h-7 min-w-0 flex-1 rounded border border-black/[0.12] bg-white px-2 text-[13px] text-zinc-950 outline-none focus:border-zinc-900"
                maxLength={200}
              />
              <Button
                type="submit"
                size="sm"
                className="h-7 px-2.5 text-xs"
                disabled={createTaskPending || !insertTitle.trim()}
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
          </div>
        )}
        {/* 紧贴最新任务行下方的统一「新增」行（支持左侧下拉切换 任务 / 作品） */}
        {displayBlocks.length > 0 && (
          <div
            data-testid="inline-quick-add-row"
            style={{
              top: Math.max(
                34,
                Math.min(
                  contentBottomY,
                  Math.max(34, (canvasHostRef.current?.clientHeight ?? 600) - 38),
                ),
              ),
            }}
            className="pointer-events-auto absolute inset-x-0 z-20 flex h-[38px] items-center border-y border-black/[0.08] bg-[#fafafa]/95 px-2.5 backdrop-blur-[2px] transition-colors focus-within:bg-white"
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="quick-add-mode-trigger"
                  aria-label="切换新增类型"
                  className={cn(
                    'mr-2 inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors cursor-pointer',
                    createMode === 'work'
                      ? 'border-indigo-200 bg-[#EEF2FF] text-indigo-800 hover:bg-indigo-100/80'
                      : 'border-black/[0.1] bg-white text-zinc-700 hover:bg-black/[0.04]',
                  )}
                >
                  {createMode === 'work' ? (
                    <FolderPlus className="h-3.5 w-3.5 text-indigo-600" strokeWidth={1.75} />
                  ) : (
                    <ListPlus className="h-3.5 w-3.5 text-zinc-500" strokeWidth={1.75} />
                  )}
                  <span>{createMode === 'work' ? '作品' : '任务'}</span>
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[144px]">
                <DropdownMenuItem
                  onSelect={() => {
                    setCreateMode('task');
                    requestAnimationFrame(() => quickAddInputRef.current?.focus());
                  }}
                >
                  <ListPlus className="h-3.5 w-3.5 text-zinc-500" />
                  <span>新增任务</span>
                  {createMode === 'task' && <Check className="ml-auto h-3.5 w-3.5 text-zinc-900" />}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setCreateMode('work');
                    requestAnimationFrame(() => quickAddInputRef.current?.focus());
                  }}
                >
                  <FolderPlus className="h-3.5 w-3.5 text-indigo-600" />
                  <span>新增作品</span>
                  {createMode === 'work' && (
                    <Check className="ml-auto h-3.5 w-3.5 text-indigo-600" />
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <form
              onSubmit={(e) => void handleQuickAdd(e)}
              className="flex h-full min-w-0 flex-1 items-center gap-2"
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
                placeholder={
                  createMode === 'work'
                    ? '新增作品大标题（输入作品名，回车创建并添加分段）'
                    : '新增任务（输入标题，回车连续添加）'
                }
                aria-label={createMode === 'work' ? '新作品名称' : '新建任务标题'}
                maxLength={createMode === 'work' ? 80 : 200}
                className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-zinc-950 placeholder:text-zinc-400 focus:outline-none"
              />
              {quickAddTitle.trim() && (
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  className="h-6 shrink-0 whitespace-nowrap px-2 text-xs"
                  disabled={createMode === 'work' ? createWorkPending : createTaskPending}
                >
                  {createMode === 'work' ? '创建作品' : '添加'}
                </Button>
              )}
            </form>
          </div>
        )}
      </div>

      {/* 右键整行上下文菜单 */}
      {rowContextMenu && (
        <div
          role="menu"
          style={{ top: rowContextMenu.y, left: rowContextMenu.x }}
          className="fixed z-[80] min-w-[156px] rounded-xl border border-black/[0.08] bg-white p-1 shadow-[0_10px_30px_-8px_rgba(0,0,0,0.16)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const t = rowContextMenu.task;
              setRowContextMenu(null);
              onOpenDetail(t.id);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-zinc-700 hover:bg-black/[0.04] cursor-pointer"
          >
            <PanelRightOpen className="h-3.5 w-3.5 text-zinc-400" />
            展开任务详情
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const t = rowContextMenu.task;
              setRowContextMenu(null);
              onCloseAddSegment();
              setInsertingAfterId(t.id);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-zinc-700 hover:bg-black/[0.04] cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5 text-zinc-400" />
            在下方插入一行
          </button>
          <div className="my-1 h-px bg-black/[0.06]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const t = rowContextMenu.task;
              setRowContextMenu(null);
              onDeleteTask(t);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除任务
          </button>
        </div>
      )}

      {/* WAI-ARIA Canvas 语义表格镜像（供屏幕阅读器与无障碍同步读取网格结构与行操作） */}
      <table className="sr-only" aria-label={`${worksheet.name} 表格内容`}>
        <thead>
          <tr>
            <th>操作</th>
            {columnDefs.map((col, colIdx) => (
              <th key={col.id} data-testid={`col-header-${col.id}`}>
                {col.id !== 'title' ? (
                  <button
                    type="button"
                    onClick={() => {
                      const b = gridRef.current?.getColumnHeaderBounds(colIdx) ?? {
                        x: 120 + colIdx * 120,
                        y: 0,
                        width: col.width,
                        height: 34,
                      };
                      handleColumnHeaderOpen(colIdx, b);
                    }}
                  >
                    {col.name}
                  </button>
                ) : (
                  <span>{col.name}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visualActiveTasks.map((task) => (
            <tr key={task.id} data-task-row={task.id}>
              <td>
                <button
                  type="button"
                  aria-label={`打开 ${task.title} 详情`}
                  onClick={() => onOpenDetail(task.id)}
                >
                  详情
                </button>
                <button
                  type="button"
                  aria-label={`在 ${task.title} 下方插入`}
                  onClick={() => {
                    onCloseAddSegment();
                    setInsertingAfterId(task.id);
                  }}
                >
                  插入
                </button>
                <button
                  type="button"
                  aria-label={`删除任务 ${task.title}`}
                  onClick={() => onDeleteTask(task)}
                >
                  删除
                </button>
              </td>
              {columnDefs.map((col) => {
                let textVal = '';
                let stageStatusAttr: StageStatus | undefined;
                if (col.kind === 'title') textVal = task.title;
                else if (col.kind === 'divisionNote') textVal = task.divisionNote;
                else if (col.kind === 'priority') textVal = PRIORITY_LABELS[task.priority];
                else if (col.kind === 'publish')
                  textVal = PUBLISH_STATUS_LABELS[task.publishStatus];
                else if (col.kind === 'work') {
                  textVal = task.workId ? (workMap.get(task.workId)?.name ?? '') : '';
                } else if (col.kind === 'stage' && col.columnConfig) {
                  const sc = getEffectiveStageCell(task, col.columnConfig.id);
                  stageStatusAttr = sc.status;
                  textVal = sc.assignees
                    .map((a) =>
                      a.type === 'user' ? (userMap.get(a.userId) ?? '未知用户') : a.name,
                    )
                    .join('、');
                } else if (col.kind === 'custom') {
                  textVal = task.customValues[col.id] ?? '';
                }

                return (
                  <td
                    key={col.id}
                    data-testid={`cell-${task.id}-${col.id}`}
                    data-stage-status={stageStatusAttr}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        openCellById(task.id, col.id, col.isTextCell ? 'select' : 'edit')
                      }
                      onDoubleClick={() => openCellById(task.id, col.id, 'edit')}
                    >
                      {textVal}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
