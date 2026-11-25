import {
  type Assignee,
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
  type UserListItem,
  type Work,
} from '@nw/shared';
import { Check, ExternalLink, MessageSquareText, Pencil, Plus, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/client.js';
import { PRIORITY_STYLES, peerColorForUser, STAGE_STATUS_STYLES } from '@/components/ui/colors.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/overlays.js';
import { Button, cn, Input } from '@/components/ui/primitives.js';

export interface ActiveCellConflict {
  actorDisplayName: string;
  remoteValue: string;
}

export interface StageCellConflict {
  actorDisplayName: string;
  remoteCell: StageCell;
}

function PeerOverlay({ peer }: { peer?: PresencePeer }) {
  if (!peer?.focus) return null;
  const color = peerColorForUser(peer.userId);
  return (
    <>
      <div
        className="pointer-events-none absolute inset-0 z-10 rounded-[2px]"
        style={{ boxShadow: `inset 0 0 0 2px ${color.hex}` }}
      />
      <div
        data-testid="peer-focus-badge"
        className={cn(
          'pointer-events-none absolute -top-5 right-0 z-20 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium shadow-xs',
          color.bg,
          color.text,
        )}
      >
        {peer.displayName}
        {peer.focus.editing ? ' 正在编辑' : ''}
      </div>
    </>
  );
}

// ---- 内联文本/日期/链接单元格（支持 IME 保护与冲突浮条） ----

export function InlineTextCell({
  taskId,
  columnKey,
  value,
  placeholder = '',
  inputType = 'text',
  required = false,
  selected,
  peer,
  remoteConflict,
  onSelect,
  onEditingChange,
  onClearConflict,
  onAcceptRemote,
  onCommit,
}: {
  taskId: string;
  columnKey: string;
  value: string;
  placeholder?: string;
  inputType?: 'text' | 'date' | 'link';
  required?: boolean;
  selected: boolean;
  peer?: PresencePeer;
  remoteConflict: ActiveCellConflict | null;
  onSelect: () => void;
  onEditingChange: (editing: boolean) => void;
  onClearConflict: () => void;
  onAcceptRemote: (val: string) => void;
  onCommit: (nextValue: string, baseValue: string, force: boolean) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [baseValue, setBaseValue] = useState(value);
  const [localConflict, setLocalConflict] = useState<ActiveCellConflict | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isComposingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const conflict = remoteConflict ?? localConflict;

  // 非编辑态同步外部最新值；编辑态绝不覆盖用户草稿（A19）
  useEffect(() => {
    if (!editing && !saveError && !conflict) {
      setDraft(value);
    }
  }, [value, editing, saveError, conflict]);

  const enterEdit = () => {
    if (editing) return;
    setDraft(value);
    setBaseValue(value);
    setLocalConflict(null);
    setSaveError(null);
    setEditing(true);
    onEditingChange(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(value);
    setLocalConflict(null);
    setSaveError(null);
    onClearConflict();
    onEditingChange(false);
  };

  const commitValue = async (force: boolean) => {
    const trimmed = draft.trim();
    if (required && !trimmed) {
      cancelEdit();
      return;
    }
    if (!force && trimmed === baseValue && !conflict) {
      setEditing(false);
      onEditingChange(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onCommit(trimmed, baseValue, force);
      setLocalConflict(null);
      onClearConflict();
      setEditing(false);
      onEditingChange(false);
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
      setSaving(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法组字期间禁止按 Enter 提前提交
    if (e.key === 'Enter' && (isComposingRef.current || e.nativeEvent.isComposing)) {
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!conflict) {
        void commitValue(false);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  };

  return (
    <div
      data-testid={`cell-${taskId}-${columnKey}`}
      className={cn(
        'relative flex min-h-[38px] w-full items-center px-2 py-1 text-sm',
        selected && !editing && 'ring-2 ring-inset ring-slate-900/70',
        saveError && 'ring-2 ring-inset ring-red-500 bg-red-50/40',
      )}
    >
      <PeerOverlay peer={peer} />

      {editing ? (
        <input
          ref={inputRef}
          type={inputType === 'date' ? 'date' : 'text'}
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            // 有冲突提示条或正在组字时，失焦不自动销毁草稿，交由用户点击“保留我的 / 采用对方的”
            if (isComposingRef.current || conflict || saveError) return;
            void commitValue(false);
          }}
          aria-label={`编辑 ${columnKey}`}
          className="w-full rounded border border-slate-900 bg-white px-1.5 py-0.5 text-sm text-slate-900 outline-none"
        />
      ) : (
        <div className="flex w-full min-w-0 items-center justify-between gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              enterEdit();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                enterEdit();
              }
            }}
            className={cn(
              'min-h-[28px] min-w-0 flex-1 truncate text-left outline-none cursor-text',
              value ? 'text-slate-900' : 'text-slate-400',
              columnKey === 'title' && 'font-medium',
            )}
            title={value || undefined}
          >
            {value || placeholder}
          </button>
          {inputType === 'link' && value && /^https?:\/\//i.test(value) && (
            <a
              href={value}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              aria-label="打开外链"
              className="shrink-0 rounded p-0.5 text-sky-600 hover:bg-sky-50"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      )}

      {/* 冲突提示浮条（不破坏草稿） */}
      {conflict && (
        <div
          role="alert"
          data-testid="cell-conflict-bar"
          className="absolute top-full left-0 z-30 mt-1 flex min-w-[260px] flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-950 shadow-lg"
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
                setEditing(false);
                onEditingChange(false);
              }}
            >
              采用对方的
            </Button>
          </div>
        </div>
      )}

      {/* 保存失败重试提示 */}
      {saveError && !conflict && (
        <div
          role="alert"
          className="absolute top-full left-0 z-30 mt-1 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-800 shadow-md"
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
              cancelEdit();
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

// ---- 作品单元格 Combobox（支持选择、新建、清空与行内重命名） ----

export function WorkCellEditor({
  taskId,
  workId,
  works,
  peer,
  onFocusChange,
  onSelectWork,
  onRenameWork,
}: {
  taskId: string;
  workId: string | null;
  works: Work[];
  peer?: PresencePeer;
  onFocusChange: (editing: boolean | null) => void;
  onSelectWork: (next: { workId?: string | null; workName?: string | null }) => Promise<void>;
  onRenameWork: (targetWorkId: string, newName: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');

  const currentWork = workId ? works.find((w) => w.id === workId) : null;
  const trimmed = query.trim();
  const filtered = trimmed
    ? works.filter((w) => w.name.toLowerCase().includes(trimmed.toLowerCase()))
    : works;
  const exactExists = works.some((w) => w.name === trimmed);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery('');
        setRenamingId(null);
        onFocusChange(next ? true : null);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={`cell-${taskId}-work`}
          className="relative flex min-h-[38px] w-full items-center px-2 py-1 text-left text-sm hover:bg-slate-50 cursor-pointer"
        >
          <PeerOverlay peer={peer} />
          {currentWork ? (
            <span className="inline-flex max-w-full items-center truncate rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700">
              {currentWork.name}
            </span>
          ) : (
            <span className="text-xs text-slate-400">选择作品</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2.5">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && trimmed && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void onSelectWork({ workName: trimmed }).then(() => setOpen(false));
            }
          }}
          placeholder="搜索或输入新作品名回车"
          className="h-8 text-xs"
          autoFocus
        />
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
          {filtered.map((w) =>
            renamingId === w.id ? (
              <div key={w.id} className="flex items-center gap-1 px-1">
                <Input
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && renameVal.trim()) {
                      e.preventDefault();
                      void onRenameWork(w.id, renameVal.trim()).then(() => setRenamingId(null));
                    } else if (e.key === 'Escape') {
                      setRenamingId(null);
                    }
                  }}
                  className="h-7 text-xs"
                  autoFocus
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => {
                    if (renameVal.trim()) {
                      void onRenameWork(w.id, renameVal.trim()).then(() => setRenamingId(null));
                    }
                  }}
                >
                  存
                </Button>
              </div>
            ) : (
              <div
                key={w.id}
                className="group flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-slate-100"
              >
                <button
                  type="button"
                  onClick={() => void onSelectWork({ workId: w.id }).then(() => setOpen(false))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-slate-800 cursor-pointer"
                >
                  <span className="truncate">{w.name}</span>
                  {w.id === workId && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRenamingId(w.id);
                    setRenameVal(w.name);
                  }}
                  aria-label={`重命名作品 ${w.name}`}
                  className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200 hover:text-slate-700 group-hover:opacity-100 cursor-pointer"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </div>
            ),
          )}

          {trimmed && !exactExists && (
            <button
              type="button"
              onClick={() => void onSelectWork({ workName: trimmed }).then(() => setOpen(false))}
              className="flex w-full items-center gap-1.5 rounded bg-slate-900 px-2 py-1.5 text-left text-xs font-medium text-white hover:bg-slate-800 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              新建作品「{trimmed}」
            </button>
          )}
        </div>
        {workId && (
          <div className="mt-2 border-t border-slate-100 pt-1.5">
            <button
              type="button"
              onClick={() => void onSelectWork({ workId: null }).then(() => setOpen(false))}
              className="w-full rounded px-2 py-1 text-left text-xs text-slate-500 hover:bg-slate-100 cursor-pointer"
            >
              清除所属作品
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---- 优先级单元格 ----

export function PriorityCellEditor({
  taskId,
  priority,
  peer,
  onSelect,
}: {
  taskId: string;
  priority: Priority;
  peer?: PresencePeer;
  onSelect: (next: Priority) => Promise<void>;
}) {
  return (
    <div
      data-testid={`cell-${taskId}-priority`}
      className="relative flex min-h-[38px] w-full items-center px-2 py-1"
    >
      <PeerOverlay peer={peer} />
      <select
        aria-label="优先级"
        value={priority}
        onChange={(e) => void onSelect(e.target.value as Priority)}
        className={cn(
          'rounded-full px-2 py-0.5 text-xs font-medium outline-none cursor-pointer',
          PRIORITY_STYLES[priority],
        )}
      >
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABELS[p]}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---- 发布信息单元格 ----

export function PublishCellEditor({
  taskId,
  publishStatus,
  publishedAt,
  publishUrl,
  peer,
  onFocusChange,
  onSave,
}: {
  taskId: string;
  publishStatus: PublishStatus;
  publishedAt: string | null;
  publishUrl: string | null;
  peer?: PresencePeer;
  onFocusChange: (editing: boolean | null) => void;
  onSave: (patch: {
    publishStatus: PublishStatus;
    publishedAt: string | null;
    publishUrl: string | null;
  }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<PublishStatus>(publishStatus);
  const [date, setDate] = useState(publishedAt ?? '');
  const [url, setUrl] = useState(publishUrl ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const openPopover = (next: boolean) => {
    if (next) {
      setStatus(publishStatus);
      setDate(publishedAt ?? '');
      setUrl(publishUrl ?? '');
      setErr(null);
    }
    setOpen(next);
    onFocusChange(next ? true : null);
  };

  const handleSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onSave({
        publishStatus: status,
        publishedAt: date.trim() || null,
        publishUrl: url.trim() || null,
      });
      setOpen(false);
      onFocusChange(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={openPopover}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={`cell-${taskId}-publish`}
          className="relative flex min-h-[38px] w-full items-center justify-between gap-1 px-2 py-1 text-left text-xs hover:bg-slate-50 cursor-pointer"
        >
          <PeerOverlay peer={peer} />
          <span
            className={cn(
              'truncate rounded-full px-2 py-0.5 font-medium',
              publishStatus === 'published'
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-slate-100 text-slate-600',
            )}
          >
            {PUBLISH_STATUS_LABELS[publishStatus]}
            {publishStatus === 'published' && publishedAt ? ` · ${publishedAt}` : ''}
          </span>
          {publishUrl && /^https?:\/\//i.test(publishUrl) && (
            <a
              href={publishUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              aria-label="打开发布链接"
              className="shrink-0 rounded p-0.5 text-sky-600 hover:bg-sky-50"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3">
        <div className="text-xs font-semibold text-slate-800">发布信息</div>
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
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
              )}
            >
              {PUBLISH_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        <div>
          <label htmlFor={`pub-date-${taskId}`} className="mb-1 block text-xs text-slate-600">
            发布日期
          </label>
          <Input
            id={`pub-date-${taskId}`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <div>
          <label htmlFor={`pub-url-${taskId}`} className="mb-1 block text-xs text-slate-600">
            发布链接
          </label>
          <Input
            id={`pub-url-${taskId}`}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
            className="h-8 text-xs"
          />
        </div>
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" variant="secondary" onClick={() => openPopover(false)}>
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

// ---- 工序格 Popover（负责人多选+纯文本、4 状态、备注、并发冲突保护） ----

export function StageCellEditor({
  taskId,
  columnId,
  columnName,
  cell,
  users,
  userMap,
  peer,
  remoteConflict,
  onFocusChange,
  onClearConflict,
  onCommit,
}: {
  taskId: string;
  columnId: string;
  columnName: string;
  cell: StageCell;
  users: UserListItem[];
  userMap: Map<string, string>;
  peer?: PresencePeer;
  remoteConflict: StageCellConflict | null;
  onFocusChange: (editing: boolean | null) => void;
  onClearConflict: () => void;
  onCommit: (payload: {
    assignees: Assignee[];
    status: StageStatus;
    note: string;
    baseRevision: number;
    force: boolean;
  }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [assignees, setAssignees] = useState<Assignee[]>(cell.assignees);
  const [status, setStatus] = useState<StageStatus>(cell.status);
  const [note, setNote] = useState(cell.note);
  const [baseRevision, setBaseRevision] = useState(cell.revision);
  const [textInput, setTextInput] = useState('');
  const [localConflict, setLocalConflict] = useState<StageCellConflict | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const conflict = remoteConflict ?? localConflict;

  const openPopover = (next: boolean) => {
    if (next) {
      setAssignees(cell.assignees);
      setStatus(cell.status);
      setNote(cell.note);
      setBaseRevision(cell.revision);
      setTextInput('');
      setLocalConflict(null);
      setErr(null);
      onClearConflict();
    } else {
      setLocalConflict(null);
      onClearConflict();
    }
    setOpen(next);
    onFocusChange(next ? true : null);
  };

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
      setOpen(false);
      onFocusChange(null);
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

  const displayNames = cell.assignees.map((a) =>
    a.type === 'user' ? (userMap.get(a.userId) ?? '未知用户') : a.name,
  );
  const statusStyle = STAGE_STATUS_STYLES[cell.status];
  const summaryText =
    cell.status === 'na'
      ? '不适用'
      : displayNames.length > 0
        ? `${displayNames.join('、')} · ${STAGE_STATUS_LABELS[cell.status]}`
        : STAGE_STATUS_LABELS[cell.status];

  return (
    <Popover open={open} onOpenChange={openPopover}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={`cell-${taskId}-${columnId}`}
          className="relative flex min-h-[38px] w-full items-center gap-1 px-1.5 py-1 text-left cursor-pointer"
        >
          <PeerOverlay peer={peer} />
          <span
            className={cn(
              'flex min-w-0 flex-1 items-center justify-between gap-1 rounded border px-2 py-1 text-xs font-medium',
              statusStyle.cell,
            )}
          >
            <span className="truncate" title={summaryText}>
              {summaryText}
            </span>
            {cell.note && (
              <span title={cell.note} className="shrink-0 opacity-75">
                <MessageSquareText className="h-3 w-3" />
              </span>
            )}
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-80 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-800">{columnName}</span>
          <span className="text-[11px] text-slate-400">可多选用户或输入纯文本名字</span>
        </div>

        {conflict && (
          <div
            data-testid="stage-conflict-bar"
            className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 space-y-1.5"
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

        {/* 状态选择 */}
        <div>
          <div className="mb-1 text-xs text-slate-500">状态</div>
          <div className="grid grid-cols-4 gap-1">
            {STAGE_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className={cn(
                  'rounded border py-1 text-xs font-medium cursor-pointer',
                  status === s
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                )}
              >
                {STAGE_STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        {/* 已选负责人 */}
        <div>
          <div className="mb-1 text-xs text-slate-500">已选负责人</div>
          <div className="flex flex-wrap gap-1">
            {assignees.length === 0 ? (
              <span className="text-xs text-slate-400">无（将标记为缺人）</span>
            ) : (
              assignees.map((a, i) => {
                const label = a.type === 'user' ? (userMap.get(a.userId) ?? '未知用户') : a.name;
                return (
                  <span
                    key={a.type === 'user' ? `u:${a.userId}` : `t:${a.name}`}
                    className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-800"
                  >
                    {label}
                    <button
                      type="button"
                      onClick={() => setAssignees((prev) => prev.filter((_, idx) => idx !== i))}
                      className="text-slate-400 hover:text-slate-700 cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })
            )}
          </div>
        </div>

        {/* 项目用户多选 */}
        <div>
          <div className="mb-1 text-xs text-slate-500">选择项目用户</div>
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
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                  )}
                >
                  {u.displayName}
                </button>
              );
            })}
          </div>
        </div>

        {/* 纯文本负责人 */}
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
          <Button type="button" size="sm" variant="secondary" onClick={addTextAssignee}>
            添加
          </Button>
        </div>

        {/* 工序备注 */}
        <div>
          <div className="mb-1 text-xs text-slate-500">工序备注</div>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：初校完成、待终校"
            className="h-8 text-xs"
            maxLength={200}
          />
        </div>

        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" variant="secondary" onClick={() => openPopover(false)}>
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
