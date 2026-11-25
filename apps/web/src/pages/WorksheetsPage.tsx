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
import type { WorksheetSummary } from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { BoardColumnsManager } from '@/components/board/BoardColumnsModal.js';
import { WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import { Button, Card, cn } from '@/components/ui/primitives.js';
import {
  CreateWorksheetModal,
  DeleteWorksheetDialog,
  EditWorksheetModal,
} from '@/components/worksheet/WorksheetFormModal.js';

function SortableWorksheetRow({
  ws,
  onEdit,
  onDelete,
}: {
  ws: WorksheetSummary;
  onEdit: (ws: WorksheetSummary) => void;
  onDelete: (ws: WorksheetSummary) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ws.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const colorStyle = WORKSHEET_COLOR_STYLES[ws.color] ?? WORKSHEET_COLOR_STYLES.sky;

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`worksheet-row-${ws.id}`}
      className={cn(
        'flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 shadow-2xs',
        isDragging && 'z-10 shadow-md ring-2 ring-slate-900/15',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`拖动排序 ${ws.name}`}
          className="cursor-grab rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className={cn('h-3 w-3 shrink-0 rounded-full', colorStyle.dot)} />
        <Link
          to={`/worksheets/${ws.id}`}
          className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 hover:underline"
        >
          {ws.name}
        </Link>
        <span className="shrink-0 text-xs text-slate-500">
          未发布 {ws.unpublishedTaskCount} / 共 {ws.totalTaskCount} 条
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Link
          to={`/worksheets/${ws.id}`}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
        >
          打开
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
        <button
          type="button"
          onClick={() => onEdit(ws)}
          aria-label={`编辑工作表 ${ws.name}`}
          className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 cursor-pointer"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(ws)}
          aria-label={`删除工作表 ${ws.name}`}
          className="rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600 cursor-pointer"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function WorksheetsPage() {
  const queryClient = useQueryClient();

  const { data: worksheets = [], isLoading: wsLoading } = useQuery<WorksheetSummary[]>({
    queryKey: queryKeys.worksheets,
    queryFn: () => apiFetch<WorksheetSummary[]>('/api/worksheets'),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [editingWs, setEditingWs] = useState<WorksheetSummary | null>(null);
  const [deletingWs, setDeletingWs] = useState<WorksheetSummary | null>(null);

  const reorderWsMutation = useMutation({
    mutationFn: (orderedIds: string[]) =>
      apiFetch<WorksheetSummary[]>('/api/worksheets/reorder', {
        method: 'PUT',
        body: { orderedIds },
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.worksheets, updated);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
    },
  });

  const handleWsDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = worksheets.findIndex((w) => w.id === active.id);
    const newIndex = worksheets.findIndex((w) => w.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(worksheets, oldIndex, newIndex);
    queryClient.setQueryData(queryKeys.worksheets, reordered);
    reorderWsMutation.mutate(reordered.map((w) => w.id));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">工作表与看板列配置</h1>
          <p className="mt-1 text-sm text-slate-500">
            所有已登录用户均可新建与管理工作表及项目级看板列，改动即时同步给所有人。
          </p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          新建工作表
        </Button>
      </div>

      {/* 工作表列表 */}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">工作表列表</h2>
          <span className="text-xs text-slate-500">拖动左侧把手调整导航显示顺序</span>
        </div>

        {wsLoading ? (
          <div className="py-8 text-center text-sm text-slate-500">正在加载工作表…</div>
        ) : worksheets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 py-10 text-center">
            <p className="text-sm text-slate-600">还没有工作表</p>
            <Button type="button" size="sm" className="mt-3" onClick={() => setCreateOpen(true)}>
              新建第一张工作表
            </Button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleWsDragEnd}
          >
            <SortableContext
              items={worksheets.map((w) => w.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2" data-testid="worksheets-list">
                {worksheets.map((ws) => (
                  <SortableWorksheetRow
                    key={ws.id}
                    ws={ws}
                    onEdit={(target) => setEditingWs(target)}
                    onDelete={(target) => setDeletingWs(target)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </Card>

      {/* 项目级看板列配置 */}
      <Card>
        <div className="mb-3">
          <h2 className="text-base font-semibold text-slate-900">首页看板列配置</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            决定首页任务流转看板的分列与顺序。工作表内的工序列可选择映射到某个看板列。
          </p>
        </div>
        <BoardColumnsManager />
      </Card>

      <CreateWorksheetModal open={createOpen} onOpenChange={setCreateOpen} />
      <EditWorksheetModal worksheet={editingWs} onClose={() => setEditingWs(null)} />
      <DeleteWorksheetDialog worksheet={deletingWs} onClose={() => setDeletingWs(null)} />
    </div>
  );
}
