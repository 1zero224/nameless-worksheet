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
import {
  Check,
  Download,
  ExternalLink,
  Link2,
  MessageSquareText,
  Paperclip,
  Pencil,
  Plus,
  X,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/client.js';
import {
  PRIORITY_DOT_STYLES,
  PRIORITY_STYLES,
  peerColorForUser,
  STAGE_MISSING_STYLE,
  STAGE_STATUS_STYLES,
} from '@/components/ui/colors.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/overlays.js';
import { Button, cn, Input } from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';
import { StageAssigneeInput } from '@/components/worksheet/StageAssigneeInput.js';

export interface ActiveCellConflict {
  actorDisplayName: string;
  remoteValue: string;
}

export interface StageCellConflict {
  actorDisplayName: string;
  remoteCell: StageCell;
}

export interface CellEditSignal {
  nonce: number;
  initialChar?: string;
}

/** 阶段 3 工序格直挂附件角标数据结构（当前阶段 2 为空，保留无缝衔接接口） */
export interface StageAttachmentSummary {
  kind: 'r2' | 'link';
  label: string;
  url?: string;
  onClick?: () => void;
}

/** 阶段 3 工序格右侧最新附件快捷角标槽位（点击阻止冒泡，直通下载或网盘） */
export function StageAttachmentBadge({
  attachment,
}: {
  attachment?: StageAttachmentSummary | null;
}) {
  if (!attachment) return null;

  if (attachment.url && /^https?:\/\//i.test(attachment.url)) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        title={attachment.label}
        className="inline-flex shrink-0 items-center gap-0.5 rounded bg-white/85 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 ring-1 ring-slate-200/90 transition-colors hover:bg-white hover:text-sky-700"
      >
        {attachment.kind === 'r2' ? (
          <Download className="h-2.5 w-2.5" />
        ) : (
          <Link2 className="h-2.5 w-2.5" />
        )}
        <span>{attachment.label}</span>
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        attachment.onClick?.();
      }}
      title={attachment.label}
      className="inline-flex shrink-0 items-center gap-0.5 rounded bg-white/85 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 ring-1 ring-slate-200/90 transition-colors hover:bg-white hover:text-sky-700 cursor-pointer"
    >
      {attachment.kind === 'r2' ? (
        <Download className="h-2.5 w-2.5" />
      ) : (
        <Link2 className="h-2.5 w-2.5" />
      )}
      <span>{attachment.label}</span>
    </button>
  );
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

// ---- 内联文本/日期/链接单元格（支持键盘导航、IME 保护与冲突浮条） ----

export function InlineTextCell({
  taskId,
  columnKey,
  value,
  placeholder = '',
  inputType = 'text',
  required = false,
  selected,
  editSignal,
  peer,
  remoteConflict,
  onSelect,
  onEditingChange,
  onMoveAfterCommit,
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
  editSignal?: CellEditSignal | null;
  peer?: PresencePeer;
  remoteConflict: ActiveCellConflict | null;
  onSelect: () => void;
  onEditingChange: (editing: boolean) => void;
  onMoveAfterCommit?: (direction: 'down' | 'right' | 'left') => void;
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
  const savingRef = useRef(false);
  const isComposingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const lastEditNonceRef = useRef<number>(0);

  const conflict = remoteConflict ?? localConflict;

  // 非编辑态同步外部最新值；编辑态绝不覆盖用户草稿（A19）
  useEffect(() => {
    if (!editing && !saveError && !conflict) {
      setDraft(value);
    }
  }, [value, editing, saveError, conflict]);

  const enterEdit = (initialChar?: string) => {
    if (editing) return;
    setDraft(initialChar !== undefined && inputType !== 'date' ? initialChar : value);
    setBaseValue(value);
    setLocalConflict(null);
    setSaveError(null);
    setEditing(true);
    onEditingChange(true);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      if (initialChar !== undefined && inputType !== 'date') {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
  };

  // 响应外部键盘 Enter / F2 / 直接键入字符触发编辑
  useEffect(() => {
    if (!editSignal || editSignal.nonce === lastEditNonceRef.current) return;
    lastEditNonceRef.current = editSignal.nonce;
    enterEdit(editSignal.initialChar);
  });

  const cancelEdit = () => {
    setEditing(false);
    setDraft(value);
    setLocalConflict(null);
    setSaveError(null);
    onClearConflict();
    onEditingChange(false);
    requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  };

  const commitValue = async (force: boolean, moveAfter?: 'down' | 'right' | 'left') => {
    if (savingRef.current) return;
    const trimmed = draft.trim();
    if (required && !trimmed) {
      cancelEdit();
      return;
    }
    if (!force && trimmed === baseValue && !conflict) {
      setEditing(false);
      onEditingChange(false);
      if (moveAfter) {
        onMoveAfterCommit?.(moveAfter);
      }
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onCommit(trimmed, baseValue, force);
      setLocalConflict(null);
      onClearConflict();
      setEditing(false);
      onEditingChange(false);
      if (moveAfter) {
        onMoveAfterCommit?.(moveAfter);
      }
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
    // 中文输入法组字期间禁止按 Enter / Tab 提前提交
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
      cancelEdit();
    }
  };

  return (
    <div
      data-testid={`cell-${taskId}-${columnKey}`}
      className={cn(
        'relative flex min-h-[36px] w-full items-center px-2 text-[13px]',
        selected && !editing && 'ring-2 ring-inset ring-sky-500',
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
            // 提交中、有冲突提示条或正在组字时，失焦不重复提交也不销毁草稿
            if (savingRef.current || isComposingRef.current || conflict || saveError) return;
            void commitValue(false);
          }}
          aria-label={`编辑 ${columnKey}`}
          className="-mx-2 h-[36px] w-[calc(100%+16px)] bg-white px-2 text-[13px] text-slate-900 ring-2 ring-inset ring-sky-500 outline-none"
        />
      ) : (
        <div className="flex w-full min-w-0 items-center justify-between gap-1">
          <button
            ref={triggerRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onSelect();
              enterEdit();
            }}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === 'F2') && selected) {
                e.preventDefault();
                e.stopPropagation();
                onSelect();
                enterEdit();
              }
            }}
            className={cn(
              'min-h-[32px] min-w-0 flex-1 truncate text-left outline-none cursor-text',
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
  selected = false,
  editSignal,
  peer,
  onSelect,
  onFocusChange,
  onSelectWork,
  onRenameWork,
}: {
  taskId: string;
  workId: string | null;
  works: Work[];
  selected?: boolean;
  editSignal?: CellEditSignal | null;
  peer?: PresencePeer;
  onSelect?: () => void;
  onFocusChange: (editing: boolean | null) => void;
  onSelectWork: (next: { workId?: string | null; workName?: string | null }) => Promise<void>;
  onRenameWork: (targetWorkId: string, newName: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const lastEditNonceRef = useRef<number>(0);

  useEffect(() => {
    if (!editSignal || editSignal.nonce === lastEditNonceRef.current) return;
    lastEditNonceRef.current = editSignal.nonce;
    setOpen(true);
    setQuery('');
    setRenamingId(null);
    onFocusChange(true);
  });

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
        if (next) onSelect?.();
        onFocusChange(next ? true : null);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={`cell-${taskId}-work`}
          onClick={() => onSelect?.()}
          className={cn(
            'relative flex min-h-[36px] w-full items-center px-2 text-left text-[13px] transition-colors hover:bg-slate-50 outline-none cursor-pointer',
            selected && !open && 'ring-2 ring-inset ring-sky-500',
          )}
        >
          <PeerOverlay peer={peer} />
          {currentWork ? (
            <span className="inline-flex max-w-full items-center truncate rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700">
              {currentWork.name}
            </span>
          ) : (
            <span className="text-xs text-slate-300">—</span>
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
  selected = false,
  editSignal,
  peer,
  onSelectCell,
  onFocusChange,
  onSelect,
}: {
  taskId: string;
  priority: Priority;
  selected?: boolean;
  editSignal?: CellEditSignal | null;
  peer?: PresencePeer;
  onSelectCell?: () => void;
  onFocusChange?: (editing: boolean | null) => void;
  onSelect: (next: Priority) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const lastEditNonceRef = useRef<number>(0);

  useEffect(() => {
    if (!editSignal || editSignal.nonce === lastEditNonceRef.current) return;
    lastEditNonceRef.current = editSignal.nonce;
    setOpen(true);
    onFocusChange?.(true);
  });

  return (
    <div
      data-testid={`cell-${taskId}-priority`}
      className={cn(
        'relative flex min-h-[36px] w-full items-center px-2',
        selected && !open && 'ring-2 ring-inset ring-sky-500',
      )}
    >
      <PeerOverlay peer={peer} />
      <SelectField
        aria-label="优先级"
        variant="pill"
        size="xs"
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) onSelectCell?.();
          onFocusChange?.(next ? true : null);
        }}
        value={priority}
        onValueChange={(val) => void onSelect(val as Priority)}
        className={PRIORITY_STYLES[priority]}
        options={PRIORITIES.map((p) => ({
          value: p,
          label: PRIORITY_LABELS[p],
          dotClass: PRIORITY_DOT_STYLES[p],
        }))}
      />
    </div>
  );
}

// ---- 发布信息单元格 ----

export function PublishCellEditor({
  taskId,
  publishStatus,
  publishedAt,
  publishUrl,
  selected = false,
  editSignal,
  peer,
  onSelect,
  onFocusChange,
  onSave,
}: {
  taskId: string;
  publishStatus: PublishStatus;
  publishedAt: string | null;
  publishUrl: string | null;
  selected?: boolean;
  editSignal?: CellEditSignal | null;
  peer?: PresencePeer;
  onSelect?: () => void;
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
  const lastEditNonceRef = useRef<number>(0);

  const openPopover = (next: boolean) => {
    if (next) {
      setStatus(publishStatus);
      setDate(publishedAt ?? '');
      setUrl(publishUrl ?? '');
      setErr(null);
      onSelect?.();
    }
    setOpen(next);
    onFocusChange(next ? true : null);
  };

  useEffect(() => {
    if (!editSignal || editSignal.nonce === lastEditNonceRef.current) return;
    lastEditNonceRef.current = editSignal.nonce;
    openPopover(true);
  });

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
          onClick={() => onSelect?.()}
          className={cn(
            'relative flex min-h-[36px] w-full items-center justify-between gap-1 px-2 text-left text-xs transition-colors hover:bg-slate-50 outline-none cursor-pointer',
            selected && !open && 'ring-2 ring-inset ring-sky-500',
          )}
        >
          <PeerOverlay peer={peer} />
          <span
            className={cn(
              'truncate rounded-full px-2 py-0.5 text-[11px] font-medium',
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

// ---- 工序格 Popover（整格状态着色 + 附件快捷角标槽位 + 负责人多选 + 并发冲突保护） ----

export function StageCellEditor({
  taskId,
  columnId,
  columnName,
  cell,
  users,
  userMap,
  selected = false,
  editSignal,
  attachment = null,
  peer,
  remoteConflict,
  onSelect,
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
  selected?: boolean;
  editSignal?: CellEditSignal | null;
  attachment?: StageAttachmentSummary | null;
  peer?: PresencePeer;
  remoteConflict: StageCellConflict | null;
  onSelect?: () => void;
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
  const [localConflict, setLocalConflict] = useState<StageCellConflict | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const lastEditNonceRef = useRef<number>(0);

  const conflict = remoteConflict ?? localConflict;

  const openPopover = (next: boolean) => {
    if (next) {
      setAssignees(cell.assignees);
      setStatus(cell.status);
      setNote(cell.note);
      setBaseRevision(cell.revision);
      setLocalConflict(null);
      setErr(null);
      onClearConflict();
      onSelect?.();
    } else {
      setLocalConflict(null);
      onClearConflict();
    }
    setOpen(next);
    onFocusChange(next ? true : null);
  };

  useEffect(() => {
    if (!editSignal || editSignal.nonce === lastEditNonceRef.current) return;
    lastEditNonceRef.current = editSignal.nonce;
    openPopover(true);
  });

  const toggleAssignee = (target: Assignee) => {
    setAssignees((prev) => {
      const exists =
        target.type === 'user'
          ? prev.some((a) => a.type === 'user' && a.userId === target.userId)
          : prev.some((a) => a.type === 'text' && a.name === target.name);
      if (exists) {
        return target.type === 'user'
          ? prev.filter((a) => !(a.type === 'user' && a.userId === target.userId))
          : prev.filter((a) => !(a.type === 'text' && a.name === target.name));
      }
      return [...prev, target];
    });
  };

  const addAssignee = (target: Assignee) => {
    setAssignees((prev) => {
      const exists =
        target.type === 'user'
          ? prev.some((a) => a.type === 'user' && a.userId === target.userId)
          : prev.some((a) => a.type === 'text' && a.name === target.name);
      return exists ? prev : [...prev, target];
    });
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
  const statusStyle =
    cell.status === 'not_started' && displayNames.length === 0
      ? STAGE_MISSING_STYLE
      : STAGE_STATUS_STYLES[cell.status];
  const fullNamesText = displayNames.join('、');
  const compactNamesText =
    displayNames.length <= 2
      ? fullNamesText
      : `${displayNames[0]}、${displayNames[1]} +${displayNames.length - 2}`;

  const tooltipText =
    cell.status === 'na'
      ? `${columnName}：不适用`
      : fullNamesText
        ? `${columnName}：${fullNamesText} · ${STAGE_STATUS_LABELS[cell.status]}${cell.note ? `（${cell.note}）` : ''}`
        : `${columnName}：${STAGE_STATUS_LABELS[cell.status]} · 待认领${cell.note ? `（${cell.note}）` : ''}`;

  return (
    <Popover open={open} onOpenChange={openPopover}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={`cell-${taskId}-${columnId}`}
          data-stage-status={cell.status}
          title={tooltipText}
          onClick={() => onSelect?.()}
          className={cn(
            'relative flex min-h-[36px] w-full items-center justify-between gap-1.5 px-2.5 text-left text-[13px] transition-colors outline-none cursor-pointer',
            statusStyle.fill,
            selected && !open && 'ring-2 ring-inset ring-sky-500',
          )}
        >
          {/* 左侧 2px 状态细色条（进行中/已完成一眼辨识） */}
          {statusStyle.accent && (
            <span
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute inset-y-0 left-0 w-[2px]',
                statusStyle.accent,
              )}
            />
          )}
          <PeerOverlay peer={peer} />

          {/* 左侧：状态指示器 + 负责人 */}
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {cell.status === 'done' ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 stroke-[2.5]" />
            ) : cell.status === 'na' ? null : (
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusStyle.dot)} />
            )}

            {cell.status === 'na' ? (
              <span className="truncate text-xs text-slate-400">—</span>
            ) : displayNames.length > 0 ? (
              <span className={cn('truncate', statusStyle.text)}>{compactNamesText}</span>
            ) : cell.status === 'not_started' ? (
              <span className="truncate text-xs text-slate-400">待认领</span>
            ) : (
              <span className={cn('truncate text-xs opacity-80', statusStyle.text)}>
                {STAGE_STATUS_LABELS[cell.status]}
              </span>
            )}
          </span>

          {/* 右侧：附件快捷角标槽位（阶段 3）+ 备注图标 */}
          {(attachment || cell.note) && (
            <span className="flex shrink-0 items-center gap-1">
              <StageAttachmentBadge attachment={attachment} />
              {cell.note && (
                <span title={cell.note} className="shrink-0 text-slate-400">
                  <MessageSquareText className="h-3 w-3" />
                </span>
              )}
            </span>
          )}
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
              <span className="text-xs text-slate-400">无（将标记为空缺）</span>
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

        {/* 负责人输入与聚焦弹出频次菜单 */}
        <StageAssigneeInput
          columnName={columnName}
          assignees={assignees}
          users={users}
          onToggleAssignee={toggleAssignee}
          onAddAssignee={addAssignee}
        />

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

        {/* 阶段 3 工序直挂附件预留槽位 */}
        <div className="flex items-center justify-between rounded-md border border-dashed border-slate-200 bg-slate-50/70 px-2.5 py-1.5 text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <Paperclip className="h-3 w-3" />
            本工序附件（阶段 3 接入）
          </span>
          <span>直挂新版 / 网盘</span>
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
