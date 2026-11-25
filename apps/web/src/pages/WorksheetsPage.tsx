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
import {
  type BoardColumn,
  WORKSHEET_COLOR_LABELS,
  WORKSHEET_COLORS,
  WORKSHEET_TEMPLATES,
  type WorksheetColor,
  type WorksheetSummary,
  type WorksheetTemplateId,
} from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import { ConfirmDialog, ModalDialog, useToast } from '@/components/ui/overlays.js';
import { Alert, Button, Card, cn, Input, Label } from '@/components/ui/primitives.js';

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
        isDragging && 'z-10 shadow-md ring-2 ring-slate-900/15',
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

export function WorksheetsPage() {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const { data: worksheets = [], isLoading: wsLoading } = useQuery<WorksheetSummary[]>({
    queryKey: queryKeys.worksheets,
    queryFn: () => apiFetch<WorksheetSummary[]>('/api/worksheets'),
  });

  const { data: boardColumns = [], isLoading: bcLoading } = useQuery<BoardColumn[]>({
    queryKey: queryKeys.boardColumns,
    queryFn: () => apiFetch<BoardColumn[]>('/api/board-columns'),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 新建工作表弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<WorksheetColor>('sky');
  const [newTemplate, setNewTemplate] = useState<WorksheetTemplateId>('standard_video');
  const [createErr, setCreateErr] = useState<string | null>(null);

  // 编辑工作表弹窗
  const [editingWs, setEditingWs] = useState<WorksheetSummary | null>(null);
  const [editWsName, setEditWsName] = useState('');
  const [editWsColor, setEditWsColor] = useState<WorksheetColor>('sky');
  const [editWsErr, setEditWsErr] = useState<string | null>(null);

  // 删除工作表确认
  const [deletingWs, setDeletingWs] = useState<WorksheetSummary | null>(null);

  // 看板列新增 / 重命名 / 删除
  const [newBcName, setNewBcName] = useState('');
  const [bcErr, setBcErr] = useState<string | null>(null);
  const [renamingBc, setRenamingBc] = useState<BoardColumn | null>(null);
  const [renameBcName, setRenameBcName] = useState('');
  const [renameBcErr, setRenameBcErr] = useState<string | null>(null);
  const [deletingBc, setDeletingBc] = useState<BoardColumn | null>(null);

  const createWsMutation = useMutation({
    mutationFn: () =>
      apiFetch('/api/worksheets', {
        method: 'POST',
        body: { name: newName, color: newColor, template: newTemplate },
      }),
    onSuccess: () => {
      setCreateOpen(false);
      setNewName('');
      setCreateErr(null);
      pushToast({ message: '工作表已创建', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    onError: (err) => {
      setCreateErr(err instanceof ApiError ? err.message : '创建失败');
    },
  });

  const updateWsMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/worksheets/${editingWs?.id}`, {
        method: 'PATCH',
        body: { name: editWsName, color: editWsColor },
      }),
    onSuccess: () => {
      const id = editingWs?.id;
      setEditingWs(null);
      setEditWsErr(null);
      pushToast({ message: '工作表已更新', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
      if (id) void queryClient.invalidateQueries({ queryKey: queryKeys.worksheet(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    onError: (err) => {
      setEditWsErr(err instanceof ApiError ? err.message : '保存失败');
    },
  });

  const deleteWsMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/worksheets/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeletingWs(null);
      pushToast({ message: '工作表已删除', variant: 'info' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '删除失败',
        variant: 'error',
      });
    },
  });

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

  const handleBcDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = boardColumns.findIndex((c) => c.id === active.id);
    const newIndex = boardColumns.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(boardColumns, oldIndex, newIndex);
    queryClient.setQueryData(queryKeys.boardColumns, reordered);
    reorderBcMutation.mutate(reordered.map((c) => c.id));
  };

  const onSubmitCreateWs = (e: FormEvent) => {
    e.preventDefault();
    setCreateErr(null);
    createWsMutation.mutate();
  };

  const onSubmitEditWs = (e: FormEvent) => {
    e.preventDefault();
    setEditWsErr(null);
    updateWsMutation.mutate();
  };

  const onSubmitAddBc = (e: FormEvent) => {
    e.preventDefault();
    if (!newBcName.trim()) return;
    setBcErr(null);
    createBcMutation.mutate(newBcName.trim());
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
        <Button
          type="button"
          onClick={() => {
            setNewName('');
            setNewColor('sky');
            setNewTemplate('standard_video');
            setCreateErr(null);
            setCreateOpen(true);
          }}
        >
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
                    onEdit={(target) => {
                      setEditingWs(target);
                      setEditWsName(target.name);
                      setEditWsColor(target.color);
                      setEditWsErr(null);
                    }}
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

        {bcLoading ? (
          <div className="py-6 text-center text-sm text-slate-500">正在加载看板列…</div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleBcDragEnd}
          >
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

        <form onSubmit={onSubmitAddBc} className="mt-4 flex flex-wrap items-center gap-2">
          <Input
            value={newBcName}
            onChange={(e) => setNewBcName(e.target.value)}
            placeholder="输入新看板列名称（如：压制、特效）"
            aria-label="新看板列名称"
            className="max-w-xs"
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
      </Card>

      {/* 新建工作表弹窗 */}
      <ModalDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="新建工作表"
        description="选择模板可自动生成常用工序列，并按名称自动映射到同名看板列。"
      >
        <form onSubmit={onSubmitCreateWs} className="space-y-4">
          {createErr && <Alert variant="error">{createErr}</Alert>}
          <div>
            <Label htmlFor="ws-new-name">工作表名称</Label>
            <Input
              id="ws-new-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="例如：视频、歌曲翻译、杂志漫画"
              required
              maxLength={32}
              autoFocus
            />
          </div>

          <div>
            <Label>标签颜色</Label>
            <div className="flex flex-wrap gap-2">
              {WORKSHEET_COLORS.map((color) => {
                const style = WORKSHEET_COLOR_STYLES[color];
                const selected = newColor === color;
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setNewColor(color)}
                    title={WORKSHEET_COLOR_LABELS[color]}
                    aria-label={`颜色 ${WORKSHEET_COLOR_LABELS[color]}`}
                    aria-pressed={selected}
                    className={cn(
                      'flex h-7 w-7 items-center justify-center rounded-full border cursor-pointer transition-transform',
                      selected
                        ? 'scale-110 border-slate-900 ring-2 ring-slate-900/20'
                        : 'border-slate-200',
                    )}
                  >
                    <span className={cn('h-4 w-4 rounded-full', style.dot)} />
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <Label>初始列模板</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {WORKSHEET_TEMPLATES.map((t) => {
                const selected = newTemplate === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setNewTemplate(t.id)}
                    aria-pressed={selected}
                    className={cn(
                      'rounded-lg border p-2.5 text-left transition-colors cursor-pointer',
                      selected
                        ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
                        : 'border-slate-200 hover:border-slate-300',
                    )}
                  >
                    <div className="text-sm font-medium text-slate-900">{t.name}</div>
                    <div className="mt-0.5 text-xs text-slate-500">{t.description}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={createWsMutation.isPending}>
              {createWsMutation.isPending ? '创建中…' : '创建工作表'}
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* 编辑工作表弹窗 */}
      <ModalDialog
        open={Boolean(editingWs)}
        onOpenChange={(open) => {
          if (!open) setEditingWs(null);
        }}
        title="编辑工作表"
      >
        <form onSubmit={onSubmitEditWs} className="space-y-4">
          {editWsErr && <Alert variant="error">{editWsErr}</Alert>}
          <div>
            <Label htmlFor="ws-edit-name">工作表名称</Label>
            <Input
              id="ws-edit-name"
              value={editWsName}
              onChange={(e) => setEditWsName(e.target.value)}
              required
              maxLength={32}
            />
          </div>
          <div>
            <Label>标签颜色</Label>
            <div className="flex flex-wrap gap-2">
              {WORKSHEET_COLORS.map((color) => {
                const style = WORKSHEET_COLOR_STYLES[color];
                const selected = editWsColor === color;
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setEditWsColor(color)}
                    aria-label={`颜色 ${WORKSHEET_COLOR_LABELS[color]}`}
                    className={cn(
                      'flex h-7 w-7 items-center justify-center rounded-full border cursor-pointer',
                      selected ? 'border-slate-900 ring-2 ring-slate-900/20' : 'border-slate-200',
                    )}
                  >
                    <span className={cn('h-4 w-4 rounded-full', style.dot)} />
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setEditingWs(null)}>
              取消
            </Button>
            <Button type="submit" disabled={updateWsMutation.isPending}>
              {updateWsMutation.isPending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* 删除工作表二次确认 */}
      <ConfirmDialog
        open={Boolean(deletingWs)}
        onOpenChange={(open) => {
          if (!open) setDeletingWs(null);
        }}
        title="确认删除工作表"
        message={`确定要删除工作表「${deletingWs?.name ?? ''}」吗？删除后该工作表及其中任务将不再显示在导航、首页看板和检索中。`}
        pending={deleteWsMutation.isPending}
        onConfirm={() => {
          if (deletingWs) deleteWsMutation.mutate(deletingWs.id);
        }}
      />

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
