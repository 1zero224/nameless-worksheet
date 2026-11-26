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
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type Permission, ROLE_LABELS, type WorksheetSummary } from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  FolderKanban,
  HardDrive,
  Kanban,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  Trash2,
  Users,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import { WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/overlays.js';
import { cn } from '@/components/ui/primitives.js';
import {
  CreateWorksheetModal,
  DeleteWorksheetDialog,
  EditWorksheetModal,
} from '@/components/worksheet/WorksheetFormModal.js';
import { useRealtimeScope, useRealtimeStatus } from '@/realtime/context.js';

interface AdminMenuItem {
  to: string;
  label: string;
  icon: ReactNode;
  permission?: Permission;
}

const ADMIN_MENU_ITEMS: AdminMenuItem[] = [
  {
    to: '/admin/users',
    label: '用户与邀请',
    icon: <Users className="h-3.5 w-3.5 shrink-0 text-zinc-400" strokeWidth={1.75} />,
    permission: 'users.manage',
  },
  {
    to: '/admin/storage',
    label: '存储',
    icon: <HardDrive className="h-3.5 w-3.5 shrink-0 text-zinc-400" strokeWidth={1.75} />,
    permission: 'storage.manage',
  },
  {
    to: '/admin/realtime',
    label: '实时通道诊断',
    icon: <Activity className="h-3.5 w-3.5 shrink-0 text-zinc-400" strokeWidth={1.75} />,
    permission: 'diag.realtime',
  },
];

function avatarInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'U';
  const chars = [...trimmed];
  return (chars[0] ?? 'U').toUpperCase();
}

function SortableTopWorksheetTab({
  ws,
  isActive,
  onEdit,
  onDelete,
}: {
  ws: WorksheetSummary;
  isActive: boolean;
  onEdit: (ws: WorksheetSummary) => void;
  onDelete: (ws: WorksheetSummary) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ws.id,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const colorStyle = WORKSHEET_COLOR_STYLES[ws.color] ?? WORKSHEET_COLOR_STYLES.sky;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={cn(
        'group relative flex h-8 shrink-0 items-center rounded-md transition-colors select-none',
        isActive
          ? 'bg-white text-zinc-950 shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.08]'
          : 'text-zinc-600 hover:bg-black/[0.04] hover:text-zinc-950',
        isDragging && 'z-30 opacity-85 shadow-md ring-1 ring-black/15',
      )}
    >
      <NavLink
        to={`/worksheets/${ws.id}`}
        className={cn(
          'flex h-full items-center gap-1.5 pl-2.5 text-[13px] transition-colors',
          isActive ? 'pr-7 font-medium text-zinc-950' : 'pr-2.5 group-hover:pr-7',
        )}
      >
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', colorStyle.dot)} />
        <span className="max-w-[132px] truncate">{ws.name}</span>
      </NavLink>

      <div
        className={cn(
          'absolute right-1 flex items-center transition-opacity',
          isActive || menuOpen
            ? 'opacity-100'
            : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
        )}
      >
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`工作表操作 ${ws.name}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-black/[0.06] hover:text-zinc-800 cursor-pointer"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[144px]">
            <DropdownMenuItem
              onSelect={() => {
                onEdit(ws);
              }}
            >
              <Pencil className="h-3.5 w-3.5 text-zinc-400" />
              重命名 / 改色
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                onDelete(ws);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除工作表
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function AppShell() {
  const { data: me } = useMe();
  const { status } = useRealtimeStatus();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingWs, setEditingWs] = useState<WorksheetSummary | null>(null);
  const [deletingWs, setDeletingWs] = useState<WorksheetSummary | null>(null);

  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: worksheets = [] } = useQuery<WorksheetSummary[]>({
    queryKey: queryKeys.worksheets,
    queryFn: () => apiFetch<WorksheetSummary[]>('/api/worksheets'),
    enabled: Boolean(me),
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

  const logoutMutation = useMutation({
    mutationFn: () => apiFetch('/api/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      queryClient.clear();
      navigate('/login', { replace: true });
    },
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useRealtimeScope(me ? { type: 'project', id: me.project.id } : null, {
    onEvent: (ev) => {
      if (ev.type === 'worksheet.changed') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
        void queryClient.invalidateQueries({ queryKey: queryKeys.board });
      } else if (ev.type === 'board_columns.changed') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.boardColumns });
        void queryClient.invalidateQueries({ queryKey: queryKeys.board });
      } else if (ev.type === 'user.updated') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.users });
        void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      }
    },
    onResync: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.boardColumns });
      void queryClient.invalidateQueries({ queryKey: queryKeys.users });
    },
  });

  if (!me) return null;

  const visibleAdminItems = ADMIN_MENU_ITEMS.filter(
    (item) => !item.permission || me.permissions.includes(item.permission),
  );

  const isCanvasPage = location.pathname === '/' || /^\/worksheets\/[^/]+/.test(location.pathname);

  const handleTabsDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = worksheets.findIndex((w) => w.id === active.id);
    const newIndex = worksheets.findIndex((w) => w.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(worksheets, oldIndex, newIndex);
    queryClient.setQueryData(queryKeys.worksheets, reordered);
    reorderWsMutation.mutate(reordered.map((w) => w.id));
  };

  const showDisconnectBanner = status === 'disconnected';

  return (
    <div
      className={cn(
        'flex w-full flex-col overflow-x-hidden',
        isCanvasPage ? 'h-dvh overflow-hidden bg-white' : 'min-h-screen bg-[#fafafa]',
      )}
    >
      {/* 顶部全局标签栏：项目名 + 任务看板与工作表标签页 + 右上角头像管理菜单 */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-black/[0.08] bg-[#fafafa] px-2.5 sm:px-3">
        <NavLink
          to="/"
          className="hidden shrink-0 items-center gap-1.5 pr-1 text-[13px] font-semibold tracking-tight text-zinc-950 sm:flex"
        >
          <span className="max-w-[120px] truncate">{me.project.name}</span>
        </NavLink>

        <span className="hidden h-4 w-px shrink-0 bg-black/[0.08] sm:inline-block" />

        {/* 顶部标签页区（任务看板 + 各工作表 + 新建表） */}
        <nav
          aria-label="主导航"
          data-testid="top-nav-tabs"
          className="no-scrollbar flex h-11 min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              cn(
                'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors select-none',
                isActive
                  ? 'bg-white font-medium text-zinc-950 shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.08]'
                  : 'text-zinc-600 hover:bg-black/[0.04] hover:text-zinc-950',
              )
            }
          >
            <Kanban className="h-3.5 w-3.5 shrink-0 text-zinc-500" strokeWidth={1.75} />
            <span>任务看板</span>
          </NavLink>

          <span className="mx-0.5 h-4 w-px shrink-0 bg-black/[0.08]" />

          <div className="flex shrink-0 items-center gap-1" data-testid="topbar-worksheets">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleTabsDragEnd}
            >
              <SortableContext
                items={worksheets.map((w) => w.id)}
                strategy={horizontalListSortingStrategy}
              >
                {worksheets.map((ws) => (
                  <SortableTopWorksheetTab
                    key={ws.id}
                    ws={ws}
                    isActive={location.pathname === `/worksheets/${ws.id}`}
                    onEdit={(target) => setEditingWs(target)}
                    onDelete={(target) => setDeletingWs(target)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>

          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            title="新建工作表"
            aria-label="快速建表"
            data-testid="topbar-create-worksheet"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-black/[0.05] hover:text-zinc-950 cursor-pointer"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </nav>

        {/* 右上角用户头像与管理菜单 */}
        <div className="flex shrink-0 items-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="user-avatar-trigger"
                aria-label="用户与管理菜单"
                title={`${me.user.displayName} · ${ROLE_LABELS[me.role]}`}
                className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white ring-2 ring-transparent transition-all hover:ring-black/[0.12] focus-visible:outline-none focus-visible:ring-blue-500/40 cursor-pointer"
              >
                {avatarInitial(me.user.displayName)}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[208px]">
              <div className="px-2.5 py-2">
                <div className="truncate text-[13px] font-semibold text-zinc-950">
                  {me.user.displayName}
                </div>
                <div className="mt-0.5 text-[11px] text-zinc-400">
                  {me.project.name} · {ROLE_LABELS[me.role]}
                </div>
              </div>

              <DropdownMenuSeparator />

              <DropdownMenuItem onSelect={() => navigate('/worksheets')}>
                <FolderKanban className="h-3.5 w-3.5 text-zinc-400" strokeWidth={1.75} />
                工作表总览
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate('/settings')}>
                <Settings className="h-3.5 w-3.5 text-zinc-400" strokeWidth={1.75} />
                个人设置
              </DropdownMenuItem>

              {visibleAdminItems.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>管理</DropdownMenuLabel>
                  {visibleAdminItems.map((item) => (
                    <DropdownMenuItem key={item.to} onSelect={() => navigate(item.to)}>
                      {item.icon}
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                </>
              )}

              <DropdownMenuSeparator />

              <DropdownMenuItem
                variant="destructive"
                disabled={logoutMutation.isPending}
                onSelect={() => logoutMutation.mutate()}
              >
                <LogOut className="h-3.5 w-3.5" strokeWidth={1.75} />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* 断线重连提示条 */}
      {showDisconnectBanner && (
        <div
          role="status"
          className="shrink-0 bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-900"
        >
          连接中断，正在重连
        </div>
      )}

      {/* 主内容区域 */}
      {isCanvasPage ? (
        <main className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-white p-0">
          <Outlet />
        </main>
      ) : (
        <main className="mx-auto w-full min-w-0 max-w-5xl flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      )}

      {/* 顶栏原地新建/编辑/删除工作表弹窗 */}
      <CreateWorksheetModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(wsId) => navigate(`/worksheets/${wsId}`)}
      />
      <EditWorksheetModal worksheet={editingWs} onClose={() => setEditingWs(null)} />
      <DeleteWorksheetDialog
        worksheet={deletingWs}
        onClose={() => setDeletingWs(null)}
        onDeleted={(deletedId) => {
          if (location.pathname === `/worksheets/${deletedId}`) {
            navigate('/', { replace: true });
          }
        }}
      />
    </div>
  );
}
