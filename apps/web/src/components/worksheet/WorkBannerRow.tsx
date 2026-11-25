import { useDroppable } from '@dnd-kit/core';
import type { Work } from '@nw/shared';
import {
  ChevronDown,
  ChevronRight,
  Download,
  Link2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Unlink,
} from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/overlays.js';
import { Button, cn } from '@/components/ui/primitives.js';

/** 阶段 3 作品级共用附件数据结构（当前阶段 2 为空，不伪造持久化假数据） */
export interface WorkAttachmentSummary {
  id: string;
  kind: 'r2' | 'link';
  label: string;
  url?: string;
  onClick?: () => void;
}

/** 阶段 3 作品大标题横幅右侧共用附件快捷槽位 */
export function WorkAttachmentSlots({
  workName,
  attachments = [],
}: {
  workId: string;
  workName: string;
  attachments?: WorkAttachmentSummary[];
}) {
  return (
    <div className="flex shrink-0 items-center gap-1" data-testid="work-attachment-slots">
      {attachments.map((att) =>
        att.url && /^https?:\/\//i.test(att.url) ? (
          <a
            key={att.id}
            href={att.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={att.label}
            className="inline-flex items-center gap-1 rounded bg-white px-1.5 py-0.5 text-[11px] font-medium text-slate-700 ring-1 ring-slate-200/90 transition-colors hover:text-sky-700 hover:ring-sky-300"
          >
            {att.kind === 'r2' ? <Download className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
            <span className="max-w-[96px] truncate">{att.label}</span>
          </a>
        ) : (
          <button
            key={att.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              att.onClick?.();
            }}
            title={att.label}
            className="inline-flex items-center gap-1 rounded bg-white px-1.5 py-0.5 text-[11px] font-medium text-slate-700 ring-1 ring-slate-200/90 transition-colors hover:text-sky-700 hover:ring-sky-300 cursor-pointer"
          >
            {att.kind === 'r2' ? <Download className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
            <span className="max-w-[96px] truncate">{att.label}</span>
          </button>
        ),
      )}

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`作品 ${workName} 共用附件`}
            title="作品共用附件（阶段 3 接入）"
            className="inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-slate-300/90 bg-white/80 px-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:border-indigo-300 hover:bg-white hover:text-indigo-700 cursor-pointer"
          >
            <Paperclip className="h-3 w-3" />
            <span className="hidden sm:inline">附件</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 space-y-1.5 p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
            <Paperclip className="h-3.5 w-3.5 text-indigo-500" />
            作品共用附件（阶段 3 接入）
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            后续可在此直接挂载「{workName}
            」的整片原片、纯音源、通用字体包或网盘链接，并在旗下每条分段任务的详情侧栏中自动透出。
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function WorkBannerRow({
  work,
  colSpan,
  taskCount,
  doneCount,
  hasStages,
  collapsed,
  dragEnabled,
  isEmptyPending,
  onToggleCollapse,
  onRename,
  onAddSegment,
  onUngroup,
}: {
  work: Work;
  colSpan: number;
  taskCount: number;
  doneCount: number;
  hasStages: boolean;
  collapsed: boolean;
  dragEnabled: boolean;
  isEmptyPending: boolean;
  onToggleCollapse: () => void;
  onRename: (newName: string) => Promise<void>;
  onAddSegment: () => void;
  onUngroup: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `work-drop:${work.id}`,
    disabled: !dragEnabled,
  });

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(work.name);
  const [savingName, setSavingName] = useState(false);
  const isComposingRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!renaming) {
      setNameDraft(work.name);
    }
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
    <tr
      ref={setNodeRef}
      data-testid={`work-banner-${work.id}`}
      data-work-banner={work.id}
      className={cn(
        'h-[38px] border-b border-slate-200/90 bg-slate-50/90 transition-colors',
        isOver && 'bg-sky-50/90 ring-2 ring-inset ring-sky-400',
      )}
    >
      <td colSpan={colSpan} className="p-0 align-middle">
        <div
          className="sticky left-0 flex min-h-[38px] items-center justify-between gap-2 px-2.5 py-1"
          style={{ width: 'min(100%, var(--ws-scroll-w, 100%))' }}
        >
          {/* 左侧：色条 + 折叠箭头 + 作品名 + 紧凑进度统计 */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span aria-hidden="true" className="h-4 w-1 shrink-0 rounded-full bg-indigo-500/85" />

            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={collapsed ? `展开作品 ${work.name}` : `折叠作品 ${work.name}`}
              aria-expanded={!collapsed}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800 cursor-pointer"
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
                className="h-6 min-w-[140px] max-w-xs rounded border border-sky-500 bg-white px-1.5 text-[13px] font-semibold text-slate-900 outline-none"
              />
            ) : (
              <button
                type="button"
                onDoubleClick={() => setRenaming(true)}
                title={`${work.name}（双击重命名）`}
                className="min-w-0 truncate text-left text-[13px] font-semibold text-slate-800 hover:text-indigo-700 cursor-text"
              >
                {work.name}
              </button>
            )}

            {/* 进度统计胶囊 */}
            <span
              data-testid={`work-progress-${work.id}`}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200/80"
            >
              {hasStages && taskCount > 0 && (
                <span className="hidden h-1.5 w-10 overflow-hidden rounded-full bg-slate-200 sm:inline-block">
                  <span
                    className={cn(
                      'block h-full rounded-full transition-all',
                      progressPct === 100 ? 'bg-emerald-500' : 'bg-sky-500',
                    )}
                    style={{ width: `${progressPct}%` }}
                  />
                </span>
              )}
              <span className="tabular-nums">{progressText}</span>
            </span>

            {isOver && (
              <span className="hidden text-[11px] font-medium text-sky-700 sm:inline">
                松开移入此作品
              </span>
            )}
          </div>

          {/* 右侧：作品共用附件槽位 + 添加分段 + 菜单 */}
          <div className="flex shrink-0 items-center gap-1.5">
            <WorkAttachmentSlots workId={work.id} workName={work.name} />

            <button
              type="button"
              onClick={onAddSegment}
              aria-label={`在 ${work.name} 下添加分段`}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2 text-[11px] font-medium text-slate-700 transition-colors hover:border-sky-300 hover:bg-sky-50/70 hover:text-sky-800 cursor-pointer"
            >
              <Plus className="h-3 w-3" />
              <span>添加分段</span>
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`作品操作 ${work.name}`}
                  className="flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-800 cursor-pointer"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[164px]">
                <DropdownMenuItem onSelect={() => setRenaming(true)}>
                  <Pencil className="h-3.5 w-3.5 text-slate-400" />
                  重命名作品
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onToggleCollapse}>
                  {collapsed ? (
                    <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                  )}
                  {collapsed ? '展开分段' : '折叠分段'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onUngroup}>
                  <Unlink className="h-3.5 w-3.5 text-slate-400" />
                  {isEmptyPending ? '关闭空作品横幅' : '解散分组（移出任务）'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </td>
    </tr>
  );
}

/** 作品末尾原地添加分段行（回车连续录入） */
export function InlineAddSegmentRow({
  workName,
  colSpan,
  pending,
  onSubmit,
  onCancel,
}: {
  workName: string;
  colSpan: number;
  pending: boolean;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setTitle('');
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  return (
    <tr
      data-testid="inline-add-segment-row"
      className="h-9 border-b border-indigo-200/80 bg-indigo-50/40"
    >
      <td className="sticky left-0 z-20 h-9 w-10 min-w-10 border-r border-slate-200/80 bg-indigo-50/80 text-center text-indigo-500">
        <Plus className="mx-auto h-3.5 w-3.5" />
      </td>
      <td colSpan={colSpan - 1} className="h-9 p-0 align-middle">
        <form
          onSubmit={handleSubmit}
          className="sticky left-[40px] flex h-9 w-full max-w-lg items-center gap-1.5 px-2"
        >
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onKeyDown={(e) => {
              if (isComposingRef.current || e.nativeEvent.isComposing) return;
              if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
              }
            }}
            placeholder={`在「${workName}」下添加分段（如 0-36:37，回车连续添加）`}
            aria-label={`为 ${workName} 添加分段`}
            className="h-7 min-w-0 flex-1 rounded border border-indigo-300 bg-white px-2 text-[13px] text-slate-900 placeholder:text-slate-400 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            maxLength={200}
          />
          <Button
            type="submit"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={pending || !title.trim()}
          >
            添加
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={onCancel}
          >
            完成
          </Button>
        </form>
      </td>
    </tr>
  );
}
