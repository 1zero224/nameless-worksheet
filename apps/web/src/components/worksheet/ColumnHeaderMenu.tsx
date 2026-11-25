import {
  type BoardColumn,
  COLUMN_TYPE_LABELS,
  type ColumnConfig,
  type SystemColumnsConfig,
} from '@nw/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ChevronDown, EyeOff, Lock, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import {
  ConfirmDialog,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
  useToast,
} from '@/components/ui/overlays.js';
import { cn, Input } from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';

type SystemToggleKey = Exclude<keyof SystemColumnsConfig, 'title'>;

export function ColumnHeaderMenu({
  worksheetId,
  label,
  systemKey,
  columnConfig,
  allColumns,
  boardColumns,
  controlledOpen,
  onControlledOpenChange,
  anchorRect,
}: {
  worksheetId: string;
  label: string;
  systemKey?: keyof SystemColumnsConfig;
  columnConfig?: ColumnConfig;
  allColumns: ColumnConfig[];
  boardColumns: BoardColumn[];
  controlledOpen?: boolean;
  onControlledOpenChange?: (open: boolean) => void;
  anchorRect?: { x: number; y: number; width: number; height: number } | null;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (isControlled) onControlledOpenChange?.(next);
    else setInternalOpen(next);
  };

  const [nameDraft, setNameDraft] = useState(columnConfig?.name ?? label);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  useEffect(() => {
    if (open && columnConfig) {
      setNameDraft(columnConfig.name);
    }
  }, [open, columnConfig]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.worksheet(worksheetId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.board });
  };

  const updateColMutation = useMutation({
    mutationFn: (patch: { name?: string; hidden?: boolean; boardColumnId?: string | null }) =>
      apiFetch(`/api/worksheets/${worksheetId}/columns/${columnConfig?.id}`, {
        method: 'PATCH',
        body: patch,
      }),
    onSuccess: () => {
      refresh();
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '更新列失败',
        variant: 'error',
      });
      refresh();
    },
  });

  const reorderColMutation = useMutation({
    mutationFn: (orderedIds: string[]) =>
      apiFetch(`/api/worksheets/${worksheetId}/columns/reorder`, {
        method: 'PUT',
        body: { orderedIds },
      }),
    onSuccess: () => {
      setOpen(false);
      refresh();
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '调整列顺序失败',
        variant: 'error',
      });
    },
  });

  const deleteColMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/worksheets/${worksheetId}/columns/${columnConfig?.id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      setConfirmDeleteOpen(false);
      setOpen(false);
      pushToast({ message: '已删除列', variant: 'info' });
      refresh();
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '删除列失败',
        variant: 'error',
      });
    },
  });

  const hideSystemMutation = useMutation({
    mutationFn: (key: SystemToggleKey) =>
      apiFetch(`/api/worksheets/${worksheetId}`, {
        method: 'PATCH',
        body: { systemColumns: { [key]: { hidden: true } } },
      }),
    onSuccess: () => {
      setOpen(false);
      pushToast({ message: `已隐藏「${label}」列`, variant: 'info' });
      refresh();
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '隐藏列失败',
        variant: 'error',
      });
    },
  });

  // 标题列不可隐藏或删除
  if (systemKey === 'title') {
    if (isControlled) return null;
    return (
      <div className="flex h-full items-center gap-1 truncate px-2.5 text-xs font-medium text-zinc-600">
        <span className="truncate">{label}</span>
      </div>
    );
  }

  const colIndex = columnConfig ? allColumns.findIndex((c) => c.id === columnConfig.id) : -1;
  const visibleConfigCols = allColumns.filter((c) => !c.hidden);
  const visibleIdx = columnConfig
    ? visibleConfigCols.findIndex((c) => c.id === columnConfig.id)
    : -1;
  const canMoveLeft = columnConfig ? visibleIdx > 0 : false;
  const canMoveRight = columnConfig
    ? visibleIdx !== -1 && visibleIdx < visibleConfigCols.length - 1
    : false;

  const moveColumn = (direction: -1 | 1) => {
    if (!columnConfig || colIndex === -1 || visibleIdx === -1) return;
    const swapTarget = visibleConfigCols[visibleIdx + direction];
    if (!swapTarget) return;
    const targetIdx = allColumns.findIndex((c) => c.id === swapTarget.id);
    if (targetIdx === -1) return;
    const next = [...allColumns];
    const current = next[colIndex];
    const swap = next[targetIdx];
    if (!current || !swap) return;
    next[colIndex] = swap;
    next[targetIdx] = current;
    reorderColMutation.mutate(next.map((c) => c.id));
  };

  const commitRename = () => {
    if (!columnConfig) return;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== columnConfig.name) {
      updateColMutation.mutate({ name: trimmed });
    } else {
      setNameDraft(columnConfig.name);
    }
  };

  const usedBoardIds = new Set(
    allColumns.map((c) => c.boardColumnId).filter((id): id is string => id !== null),
  );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        {isControlled ? (
          anchorRect && (
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
          )
        ) : (
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid={`col-header-${columnConfig?.id ?? systemKey ?? label}`}
              className={cn(
                'group/hdr flex h-full w-full items-center justify-between gap-1 px-2.5 text-left text-xs font-medium text-zinc-600 transition-colors hover:bg-black/[0.04] hover:text-zinc-950 cursor-pointer',
                open && 'bg-black/[0.06] text-zinc-950',
              )}
            >
              <span className="truncate">{label}</span>
              <ChevronDown
                className={cn(
                  'h-3 w-3 shrink-0 text-zinc-400 transition-opacity',
                  open ? 'opacity-100 text-zinc-700' : 'opacity-0 group-hover/hdr:opacity-100',
                )}
              />
            </button>
          </PopoverTrigger>
        )}

        <PopoverContent align="start" className="w-60 p-2">
          {columnConfig ? (
            <div className="space-y-2">
              <div className="space-y-1">
                <div className="flex items-center justify-between px-0.5">
                  <span className="text-[11px] font-medium text-zinc-400">列名称</span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">
                    {COLUMN_TYPE_LABELS[columnConfig.type]}
                  </span>
                </div>
                <Input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      commitRename();
                      setOpen(false);
                    }
                  }}
                  aria-label={`修改列名 ${columnConfig.name}`}
                  className="h-7 px-2 text-xs"
                  maxLength={32}
                />
              </div>

              {columnConfig.type === 'stage' && (
                <div className="space-y-1">
                  <div className="px-0.5 text-[11px] font-medium text-zinc-400">对应看板列</div>
                  <SelectField
                    aria-label={`${columnConfig.name} 看板列映射`}
                    size="xs"
                    value={columnConfig.boardColumnId ?? ''}
                    onValueChange={(val) =>
                      updateColMutation.mutate({ boardColumnId: val ? val : null })
                    }
                    options={[
                      { value: '', label: '不上看板' },
                      ...boardColumns.map((bc) => {
                        const occupied =
                          usedBoardIds.has(bc.id) && columnConfig.boardColumnId !== bc.id;
                        return {
                          value: bc.id,
                          label: `${bc.name}${occupied ? '（已占用）' : ''}`,
                          disabled: occupied,
                        };
                      }),
                    ]}
                  />
                </div>
              )}

              <div className="border-t border-black/[0.06] pt-1">
                <button
                  type="button"
                  disabled={!canMoveLeft || reorderColMutation.isPending}
                  onClick={() => moveColumn(-1)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-700 hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                >
                  <ArrowLeft className="h-3.5 w-3.5 text-zinc-400" />
                  向左移动
                </button>
                <button
                  type="button"
                  disabled={!canMoveRight || reorderColMutation.isPending}
                  onClick={() => moveColumn(1)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-700 hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                >
                  <ArrowRight className="h-3.5 w-3.5 text-zinc-400" />
                  向右移动
                </button>
                <button
                  type="button"
                  onClick={() => {
                    updateColMutation.mutate({ hidden: true });
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-700 hover:bg-black/[0.04] cursor-pointer"
                >
                  <EyeOff className="h-3.5 w-3.5 text-zinc-400" />
                  隐藏此列
                </button>
              </div>

              <div className="border-t border-black/[0.06] pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setConfirmDeleteOpen(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-red-600 hover:bg-red-50 cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除此列
                </button>
              </div>
            </div>
          ) : systemKey ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-xs font-medium text-zinc-900">{label}</span>
                <span className="inline-flex items-center gap-0.5 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">
                  <Lock className="h-2.5 w-2.5" />
                  系统列
                </span>
              </div>
              <div className="border-t border-black/[0.06] pt-1">
                <button
                  type="button"
                  disabled={hideSystemMutation.isPending}
                  onClick={() => hideSystemMutation.mutate(systemKey as SystemToggleKey)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-700 hover:bg-black/[0.04] cursor-pointer"
                >
                  <EyeOff className="h-3.5 w-3.5 text-zinc-400" />
                  隐藏此列
                </button>
              </div>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>

      {columnConfig && (
        <ConfirmDialog
          open={confirmDeleteOpen}
          onOpenChange={setConfirmDeleteOpen}
          title="确认删除列"
          message={`确定要删除列「${columnConfig.name}」吗？删除后该列将从表格隐藏并同步给所有人。`}
          pending={deleteColMutation.isPending}
          onConfirm={() => deleteColMutation.mutate()}
        />
      )}
    </>
  );
}
