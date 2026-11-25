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
  type BoardColumn,
  COLUMN_TYPE_LABELS,
  COLUMN_TYPES,
  type ColumnConfig,
  type ColumnType,
  type SystemColumnsConfig,
  type Worksheet,
} from '@nw/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, GripVertical, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { ConfirmDialog, ModalDialog, useToast } from '@/components/ui/overlays.js';
import { Alert, Button, cn, Input, Label, Select } from '@/components/ui/primitives.js';

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

function SortableColumnItem({
  col,
  boardColumns,
  usedBoardIds,
  onUpdate,
  onDelete,
}: {
  col: ColumnConfig;
  boardColumns: BoardColumn[];
  usedBoardIds: Set<string>;
  onUpdate: (
    columnId: string,
    patch: { name?: string; hidden?: boolean; boardColumnId?: string | null },
  ) => void;
  onDelete: (col: ColumnConfig) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: col.id,
  });
  const [nameDraft, setNameDraft] = useState(col.name);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2',
        isDragging && 'z-10 shadow-md ring-2 ring-slate-900/15',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`拖动排序列 ${col.name}`}
        className="cursor-grab rounded p-1 text-slate-400 hover:bg-slate-100 active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <input
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={() => {
          const trimmed = nameDraft.trim();
          if (trimmed && trimmed !== col.name) {
            onUpdate(col.id, { name: trimmed });
          } else {
            setNameDraft(col.name);
          }
        }}
        aria-label={`列名 ${col.name}`}
        className="min-w-[100px] flex-1 rounded border border-transparent px-1.5 py-1 text-sm font-medium text-slate-900 hover:border-slate-200 focus:border-slate-900 focus:outline-none"
        maxLength={32}
      />

      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
        {COLUMN_TYPE_LABELS[col.type]}
      </span>

      {col.type === 'stage' && (
        <select
          aria-label={`${col.name} 看板列映射`}
          value={col.boardColumnId ?? ''}
          onChange={(e) =>
            onUpdate(col.id, { boardColumnId: e.target.value ? e.target.value : null })
          }
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
        >
          <option value="">不上看板</option>
          {boardColumns.map((bc) => {
            const occupied = usedBoardIds.has(bc.id) && col.boardColumnId !== bc.id;
            return (
              <option key={bc.id} value={bc.id} disabled={occupied}>
                看板：{bc.name}
                {occupied ? '（已占用）' : ''}
              </option>
            );
          })}
        </select>
      )}

      <button
        type="button"
        onClick={() => onUpdate(col.id, { hidden: !col.hidden })}
        aria-label={col.hidden ? `显示列 ${col.name}` : `隐藏列 ${col.name}`}
        title={col.hidden ? '点击显示' : '点击隐藏'}
        className={cn(
          'rounded p-1.5 cursor-pointer',
          col.hidden ? 'text-slate-400 hover:bg-slate-100' : 'text-slate-700 hover:bg-slate-100',
        )}
      >
        {col.hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>

      <button
        type="button"
        onClick={() => onDelete(col)}
        aria-label={`删除列 ${col.name}`}
        className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 cursor-pointer"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

export function ColumnManagerModal({
  open,
  onOpenChange,
  worksheet,
  columns,
  boardColumns,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worksheet: Worksheet;
  columns: ColumnConfig[];
  boardColumns: BoardColumn[];
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const [newColName, setNewColName] = useState('');
  const [newColType, setNewColType] = useState<ColumnType>('stage');
  const [newBoardColId, setNewBoardColId] = useState<string>('auto');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [deletingCol, setDeletingCol] = useState<ColumnConfig | null>(null);

  const usedBoardIds = new Set(
    columns.map((c) => c.boardColumnId).filter((id): id is string => id !== null),
  );

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
      setErrMsg(err instanceof ApiError ? err.message : '保存失败');
    },
  });

  const createColMutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        name: newColName.trim(),
        type: newColType,
      };
      if (newColType === 'stage' && newBoardColId !== 'auto') {
        payload.boardColumnId = newBoardColId === 'none' ? null : newBoardColId;
      }
      return apiFetch<ColumnConfig>(`/api/worksheets/${worksheet.id}/columns`, {
        method: 'POST',
        body: payload,
      });
    },
    onSuccess: () => {
      setNewColName('');
      setNewBoardColId('auto');
      setErrMsg(null);
      pushToast({ message: '已新增列', variant: 'success' });
      refresh();
    },
    onError: (err) => {
      setErrMsg(err instanceof ApiError ? err.message : '新增列失败');
    },
  });

  const updateColMutation = useMutation({
    mutationFn: ({
      columnId,
      patch,
    }: {
      columnId: string;
      patch: { name?: string; hidden?: boolean; boardColumnId?: string | null };
    }) =>
      apiFetch(`/api/worksheets/${worksheet.id}/columns/${columnId}`, {
        method: 'PATCH',
        body: patch,
      }),
    onSuccess: () => {
      setErrMsg(null);
      refresh();
    },
    onError: (err) => {
      setErrMsg(err instanceof ApiError ? err.message : '更新列失败');
      refresh();
    },
  });

  const deleteColMutation = useMutation({
    mutationFn: (columnId: string) =>
      apiFetch(`/api/worksheets/${worksheet.id}/columns/${columnId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeletingCol(null);
      pushToast({ message: '已删除列', variant: 'info' });
      refresh();
    },
    onError: (err) => {
      setErrMsg(err instanceof ApiError ? err.message : '删除列失败');
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

  const handleAdd = (e: FormEvent) => {
    e.preventDefault();
    if (!newColName.trim()) return;
    setErrMsg(null);
    createColMutation.mutate();
  };

  return (
    <>
      <ModalDialog
        open={open}
        onOpenChange={onOpenChange}
        title="列设置"
        description="所有列显隐、顺序与看板映射均实时同步给全部用户。"
        maxWidthClass="max-w-xl"
      >
        <div className="space-y-5">
          {errMsg && <Alert variant="error">{errMsg}</Alert>}

          {/* 固定系统列 */}
          <div>
            <div className="mb-2 text-xs font-semibold text-slate-600">固定列显隐</div>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs text-slate-500">
                标题（冻结常显）
              </span>
              {SYSTEM_TOGGLEABLE.map((item) => {
                const hidden = Boolean(worksheet.systemColumns?.[item.key]?.hidden);
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => toggleSystemMutation.mutate({ [item.key]: { hidden: !hidden } })}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors',
                      hidden
                        ? 'border-slate-200 bg-white text-slate-400 line-through'
                        : 'border-slate-900 bg-slate-900 text-white',
                    )}
                  >
                    {hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 可配置列列表 */}
          <div>
            <div className="mb-2 text-xs font-semibold text-slate-600">
              工序列与自定义列（可拖动排序）
            </div>
            {columns.length === 0 ? (
              <p className="rounded border border-dashed border-slate-300 py-4 text-center text-xs text-slate-500">
                暂无可配置列
              </p>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={columns.map((c) => c.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2">
                    {columns.map((col) => (
                      <SortableColumnItem
                        key={col.id}
                        col={col}
                        boardColumns={boardColumns}
                        usedBoardIds={usedBoardIds}
                        onUpdate={(columnId, patch) =>
                          updateColMutation.mutate({ columnId, patch })
                        }
                        onDelete={(c) => setDeletingCol(c)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>

          {/* 新增列 */}
          <form onSubmit={handleAdd} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 text-xs font-semibold text-slate-700">新增列</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div>
                <Label htmlFor="new-col-name" className="text-xs">
                  列名
                </Label>
                <Input
                  id="new-col-name"
                  value={newColName}
                  onChange={(e) => setNewColName(e.target.value)}
                  placeholder="例如：压制、片源链接"
                  maxLength={32}
                />
              </div>
              <div>
                <Label htmlFor="new-col-type" className="text-xs">
                  列类型
                </Label>
                <Select
                  id="new-col-type"
                  value={newColType}
                  onChange={(e) => setNewColType(e.target.value as ColumnType)}
                >
                  {COLUMN_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {COLUMN_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
              </div>
              {newColType === 'stage' && (
                <div>
                  <Label htmlFor="new-col-board" className="text-xs">
                    看板列映射
                  </Label>
                  <Select
                    id="new-col-board"
                    value={newBoardColId}
                    onChange={(e) => setNewBoardColId(e.target.value)}
                  >
                    <option value="auto">按同名自动匹配</option>
                    <option value="none">不上看板</option>
                    {boardColumns.map((bc) => (
                      <option key={bc.id} value={bc.id} disabled={usedBoardIds.has(bc.id)}>
                        {bc.name}
                        {usedBoardIds.has(bc.id) ? '（已占用）' : ''}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </div>
            <div className="mt-3 flex justify-end">
              <Button type="submit" size="sm" disabled={createColMutation.isPending}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                添加列
              </Button>
            </div>
          </form>
        </div>
      </ModalDialog>

      <ConfirmDialog
        open={Boolean(deletingCol)}
        onOpenChange={(v) => {
          if (!v) setDeletingCol(null);
        }}
        title="确认删除列"
        message={`确定要删除列「${deletingCol?.name ?? ''}」吗？删除后该列将从表格隐藏并同步给所有人。`}
        pending={deleteColMutation.isPending}
        onConfirm={() => {
          if (deletingCol) deleteColMutation.mutate(deletingCol.id);
        }}
      />
    </>
  );
}
