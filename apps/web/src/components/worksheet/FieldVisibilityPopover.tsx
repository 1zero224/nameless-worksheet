import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  COLUMN_TYPE_LABELS,
  type ColumnConfig,
  type SystemColumnsConfig,
  type Worksheet,
} from '@nw/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Columns3, Eye, EyeOff, GripVertical, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { Popover, PopoverContent, PopoverTrigger, useToast } from '@/components/ui/overlays.js';
import { cn } from '@/components/ui/primitives.js';

const SYSTEM_TOGGLEABLE: Array<{
  key: Exclude<keyof SystemColumnsConfig, 'title'>;
  label: string;
}> = [
  { key: 'work', label: '作品' },
  { key: 'divisionNote', label: '分工说明' },
  { key: 'priority', label: '优先级' },
  { key: 'publish', label: '发布信息' },
  { key: 'files', label: '文件' },
];

export function isSystemColumnHidden(
  sys: SystemColumnsConfig | undefined,
  key: Exclude<keyof SystemColumnsConfig, 'title'>,
): boolean {
  // 大标题横幅已表达归属，因此「作品」列默认隐藏，用户仍可在此手动开启
  if (key === 'work') return sys?.work?.hidden !== false;
  return Boolean(sys?.[key]?.hidden);
}

function SortableFieldRow({
  col,
  onToggleHidden,
}: {
  col: ColumnConfig;
  onToggleHidden: (col: ColumnConfig) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: col.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-slate-50',
        isDragging && 'z-10 bg-white shadow-sm ring-1 ring-sky-400/50',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`拖动排序列 ${col.name}`}
          className="cursor-grab rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-600 active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <span
          className={cn('truncate', col.hidden ? 'text-slate-400 line-through' : 'text-slate-700')}
        >
          {col.name}
        </span>
        <span className="shrink-0 rounded bg-slate-100 px-1 py-0.25 text-[10px] text-slate-400">
          {COLUMN_TYPE_LABELS[col.type]}
        </span>
      </div>
      <button
        type="button"
        onClick={() => onToggleHidden(col)}
        aria-label={col.hidden ? `显示列 ${col.name}` : `隐藏列 ${col.name}`}
        className={cn(
          'rounded p-1 transition-colors cursor-pointer',
          col.hidden
            ? 'text-slate-300 hover:bg-slate-100 hover:text-slate-600'
            : 'text-sky-600 hover:bg-sky-50',
        )}
      >
        {col.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

export function FieldVisibilityPopover({
  worksheet,
  columns,
  onOpenFullModal,
}: {
  worksheet: Worksheet;
  columns: ColumnConfig[];
  onOpenFullModal?: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [open, setOpen] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const hiddenSystemCount = SYSTEM_TOGGLEABLE.filter((item) =>
    isSystemColumnHidden(worksheet.systemColumns, item.key),
  ).length;
  const hiddenCustomCount = columns.filter((c) => c.hidden).length;
  const hiddenTotal = hiddenSystemCount + hiddenCustomCount;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.worksheet(worksheet.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.board });
  };

  const toggleSystemMutation = useMutation({
    mutationFn: (systemColumns: SystemColumnsConfig) =>
      apiFetch(`/api/worksheets/${worksheet.id}`, {
        method: 'PATCH',
        body: { systemColumns },
      }),
    onSuccess: refresh,
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '保存失败',
        variant: 'error',
      });
    },
  });

  const toggleColMutation = useMutation({
    mutationFn: ({ columnId, hidden }: { columnId: string; hidden: boolean }) =>
      apiFetch(`/api/worksheets/${worksheetId(worksheet)}/columns/${columnId}`, {
        method: 'PATCH',
        body: { hidden },
      }),
    onSuccess: refresh,
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '更新列失败',
        variant: 'error',
      });
    },
  });

  const reorderColMutation = useMutation({
    mutationFn: (orderedIds: string[]) =>
      apiFetch(`/api/worksheets/${worksheet.id}/columns/reorder`, {
        method: 'PUT',
        body: { orderedIds },
      }),
    onSuccess: refresh,
  });

  const handleDragEnd = (ev: DragEndEvent) => {
    const { active, over } = ev;
    if (!over || active.id === over.id) return;
    const oldIdx = columns.findIndex((c) => c.id === active.id);
    const newIdx = columns.findIndex((c) => c.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    const next = arrayMove(columns, oldIdx, newIdx);
    reorderColMutation.mutate(next.map((c) => c.id));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="field-visibility-trigger"
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors cursor-pointer',
            hiddenTotal > 0 || open
              ? 'border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100/70'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900',
          )}
        >
          <Columns3 className="h-3.5 w-3.5" />
          <span>字段显隐</span>
          {hiddenTotal > 0 && (
            <span className="rounded-full bg-sky-600 px-1.5 py-0 text-[10px] text-white">
              {hiddenTotal}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64 p-2.5">
        <div className="space-y-2.5">
          <div>
            <div className="mb-1.5 px-1 text-[11px] font-semibold text-slate-400">固定列</div>
            <div className="space-y-0.5">
              <div className="flex items-center justify-between px-1.5 py-1 text-xs text-slate-400">
                <span>标题（冻结常显）</span>
                <Eye className="h-3.5 w-3.5" />
              </div>
              {SYSTEM_TOGGLEABLE.map((item) => {
                const hidden = isSystemColumnHidden(worksheet.systemColumns, item.key);
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => toggleSystemMutation.mutate({ [item.key]: { hidden: !hidden } })}
                    className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-slate-50 cursor-pointer"
                  >
                    <span className={hidden ? 'text-slate-400 line-through' : 'text-slate-700'}>
                      {item.label}
                    </span>
                    {hidden ? (
                      <EyeOff className="h-3.5 w-3.5 text-slate-300" />
                    ) : (
                      <Eye className="h-3.5 w-3.5 text-sky-600" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-slate-100 pt-2">
            <div className="mb-1.5 flex items-center justify-between px-1">
              <span className="text-[11px] font-semibold text-slate-400">工序与自定义列</span>
              <span className="text-[10px] text-slate-400">可拖拽排序</span>
            </div>
            {columns.length === 0 ? (
              <div className="py-2 text-center text-xs text-slate-400">暂无可配置列</div>
            ) : (
              <div className="max-h-52 overflow-y-auto">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={columns.map((c) => c.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-0.5">
                      {columns.map((col) => (
                        <SortableFieldRow
                          key={col.id}
                          col={col}
                          onToggleHidden={(target) =>
                            toggleColMutation.mutate({
                              columnId: target.id,
                              hidden: !target.hidden,
                            })
                          }
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>
            )}
          </div>

          {onOpenFullModal && (
            <div className="border-t border-slate-100 pt-2">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenFullModal();
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-md py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 cursor-pointer"
              >
                <SlidersHorizontal className="h-3 w-3" />
                全部列设置
              </button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function worksheetId(ws: Worksheet) {
  return ws.id;
}
