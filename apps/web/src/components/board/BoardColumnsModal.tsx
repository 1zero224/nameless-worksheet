import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { BoardColumn } from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { ConfirmDialog, ModalDialog, useToast } from '@/components/ui/overlays.js';
import { Alert, Button, cn, Input, Label } from '@/components/ui/primitives.js';

function SortableBoardColumnRow({
  col,
  onRename,
  onDelete,
}: {
  col: BoardColumn;
  onRename: (col: BoardColumn) => void;
  onDelete: (col: BoardColumn) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: col.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`board-column-row-${col.id}`}
      className={cn(
        'flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2',
        isDragging && 'z-10 shadow-md ring-2 ring-sky-500/25',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`拖动排序看板列 ${col.name}`}
          className="cursor-grab rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="truncate text-sm font-medium text-slate-800">{col.name}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onRename(col)}
          aria-label={`重命名看板列 ${col.name}`}
          className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 cursor-pointer"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(col)}
          aria-label={`删除看板列 ${col.name}`}
          className="rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600 cursor-pointer"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function BoardColumnsManager() {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const { data: boardColumns = [], isLoading } = useQuery<BoardColumn[]>({
    queryKey: queryKeys.boardColumns,
    queryFn: () => apiFetch<BoardColumn[]>('/api/board-columns'),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const [newBcName, setNewBcName] = useState('');
  const [bcErr, setBcErr] = useState<string | null>(null);
  const [renamingBc, setRenamingBc] = useState<BoardColumn | null>(null);
  const [renameBcName, setRenameBcName] = useState('');
  const [renameBcErr, setRenameBcErr] = useState<string | null>(null);
  const [deletingBc, setDeletingBc] = useState<BoardColumn | null>(null);

  const createBcMutation = useMutation({
    mutationFn: (name: string) =>
      apiFetch<BoardColumn>('/api/board-columns', {
        method: 'POST',
        body: { name },
      }),
    onSuccess: () => {
      setNewBcName('');
      setBcErr(null);
      pushToast({ message: '看板列已添加', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.boardColumns });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    onError: (err) => {
      setBcErr(err instanceof ApiError ? err.message : '添加失败');
    },
  });

  const renameBcMutation = useMutation({
    mutationFn: () =>
      apiFetch<BoardColumn>(`/api/board-columns/${renamingBc?.id}`, {
        method: 'PATCH',
        body: { name: renameBcName },
      }),
    onSuccess: () => {
      setRenamingBc(null);
      setRenameBcErr(null);
      pushToast({ message: '看板列已改名', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.boardColumns });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    onError: (err) => {
      setRenameBcErr(err instanceof ApiError ? err.message : '改名失败');
    },
  });

  const deleteBcMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/board-columns/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeletingBc(null);
      pushToast({ message: '看板列已删除', variant: 'info' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.boardColumns });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '删除失败',
        variant: 'error',
      });
    },
  });

  const reorderBcMutation = useMutation({
    mutationFn: (orderedIds: string[]) =>
      apiFetch<BoardColumn[]>('/api/board-columns/reorder', {
        method: 'PUT',
        body: { orderedIds },
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.boardColumns, updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.boardColumns });
    },
  });

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = boardColumns.findIndex((c) => c.id === active.id);
    const newIndex = boardColumns.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(boardColumns, oldIndex, newIndex);
    queryClient.setQueryData(queryKeys.boardColumns, reordered);
    reorderBcMutation.mutate(reordered.map((c) => c.id));
  };

  const onSubmitAdd = (e: FormEvent) => {
    e.preventDefault();
    if (!newBcName.trim()) return;
    setBcErr(null);
    createBcMutation.mutate(newBcName.trim());
  };

  return (
    <div>
      {isLoading ? (
        <div className="py-6 text-center text-sm text-slate-500">正在加载看板列…</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={boardColumns.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-2" data-testid="board-columns-list">
              {boardColumns.map((col) => (
                <SortableBoardColumnRow
                  key={col.id}
                  col={col}
                  onRename={(target) => {
                    setRenamingBc(target);
                    setRenameBcName(target.name);
                    setRenameBcErr(null);
                  }}
                  onDelete={(target) => setDeletingBc(target)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <form onSubmit={onSubmitAdd} className="mt-4 flex flex-wrap items-center gap-2">
        <Input
          value={newBcName}
          onChange={(e) => setNewBcName(e.target.value)}
          placeholder="输入新看板列名称（如：压制、特效）"
          aria-label="新看板列名称"
          className="min-w-0 flex-1"
          maxLength={32}
        />
        <Button type="submit" variant="secondary" disabled={createBcMutation.isPending}>
          <Plus className="mr-1 h-4 w-4" />
          新增看板列
        </Button>
      </form>
      {bcErr && (
        <div className="mt-2">
          <Alert variant="error">{bcErr}</Alert>
        </div>
      )}

      {/* 重命名看板列弹窗 */}
      <ModalDialog
        open={Boolean(renamingBc)}
        onOpenChange={(open) => {
          if (!open) setRenamingBc(null);
        }}
        title="重命名看板列"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setRenameBcErr(null);
            renameBcMutation.mutate();
          }}
          className="space-y-4"
        >
          {renameBcErr && <Alert variant="error">{renameBcErr}</Alert>}
          <div>
            <Label htmlFor="bc-rename-input">看板列名称</Label>
            <Input
              id="bc-rename-input"
              value={renameBcName}
              onChange={(e) => setRenameBcName(e.target.value)}
              required
              maxLength={32}
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setRenamingBc(null)}>
              取消
            </Button>
            <Button type="submit" disabled={renameBcMutation.isPending}>
              保存
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* 删除看板列二次确认 */}
      <ConfirmDialog
        open={Boolean(deletingBc)}
        onOpenChange={(open) => {
          if (!open) setDeletingBc(null);
        }}
        title="确认删除看板列"
        message={`确定要删除看板列「${deletingBc?.name ?? ''}」吗？已映射到此列的工序列将自动变为“不上看板”，不会删除工序列或已有分工数据。`}
        pending={deleteBcMutation.isPending}
        onConfirm={() => {
          if (deletingBc) deleteBcMutation.mutate(deletingBc.id);
        }}
      />
    </div>
  );
}

export function BoardColumnsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title="管理看板列"
      description="决定首页任务流转看板的分列与顺序。改动实时同步给所有用户。"
      maxWidthClass="max-w-lg"
    >
      <BoardColumnsManager />
    </ModalDialog>
  );
}
