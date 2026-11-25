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
import { type Permission, ROLE_LABELS, type WorksheetSummary } from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BookOpen,
  CheckSquare,
  GripVertical,
  HardDrive,
  Kanban,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  Users,
} from 'lucide-react';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import { WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/overlays.js';
import { cn } from '@/components/ui/primitives.js';
import {
  CreateWorksheetModal,
  DeleteWorksheetDialog,
  EditWorksheetModal,
} from '@/components/worksheet/WorksheetFormModal.js';
import { useRealtimeScope, useRealtimeStatus } from '@/realtime/context.js';

const SIDEBAR_STORAGE_KEY = 'nw_sidebar_collapsed';

interface SidebarContextValue {
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  toggleCollapsed: () => void;
}

const SidebarContext = createContext<SidebarContextValue>({
  collapsed: false,
  setCollapsed: () => {},
  toggleCollapsed: () => {},
});

export function useSidebar() {
  return useContext(SidebarContext);
}

export function SidebarExpandButton({ className }: { className?: string }) {
  const { collapsed, toggleCollapsed } = useSidebar();
  if (!collapsed) return null;
  return (
    <button
      type="button"
      onClick={toggleCollapsed}
      title="展开左侧栏"
      aria-label="展开侧栏"
      className={cn(
        'hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 md:inline-flex cursor-pointer',
        className,
      )}
    >
      <PanelLeftOpen className="h-4 w-4" />
    </button>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  permission?: Permission;
  end?: boolean;
}

const TOP_NAV: NavItem[] = [
  { to: '/', label: '任务看板', icon: <Kanban className="h-3.5 w-3.5 shrink-0" />, end: true },
  { to: '/my-tasks', label: '我的任务', icon: <CheckSquare className="h-3.5 w-3.5 shrink-0" /> },
  { to: '/search', label: '资源检索', icon: <Search className="h-3.5 w-3.5 shrink-0" /> },
  { to: '/references', label: '参考资料', icon: <BookOpen className="h-3.5 w-3.5 shrink-0" /> },
];

const ADMIN_NAV: NavItem[] = [
  {
    to: '/admin/users',
    label: '用户与邀请',
    icon: <Users className="h-3.5 w-3.5 shrink-0" />,
    permission: 'users.manage',
  },
  {
    to: '/admin/storage',
    label: '存储',
    icon: <HardDrive className="h-3.5 w-3.5 shrink-0" />,
    permission: 'storage.manage',
  },
  {
    to: '/admin/realtime',
    label: '实时通道诊断',
    icon: <Activity className="h-3.5 w-3.5 shrink-0" />,
    permission: 'diag.realtime',
  },
];

function SortableSidebarWorksheetItem({
  ws,
  onNavigate,
  onEdit,
  onDelete,
}: {
  ws: WorksheetSummary;
  onNavigate?: () => void;
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
      className={cn(
        'group relative flex items-center rounded-md transition-colors',
        isDragging && 'z-20 bg-white shadow-md ring-1 ring-sky-400/50',
      )}
    >
      <NavLink
        to={`/worksheets/${ws.id}`}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-12 pl-2.5 text-[13px] transition-colors select-none',
            isActive
              ? 'bg-sky-50 font-medium text-sky-900'
              : 'text-slate-700 hover:bg-slate-200/55 hover:text-slate-900',
          )
        }
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', colorStyle.dot)} />
        <span className="truncate">{ws.name}</span>
      </NavLink>

      <div
        className={cn(
          'absolute right-1 flex items-center gap-0.5 transition-opacity',
          menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
        )}
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`拖动排序 ${ws.name}`}
          title="拖动调整顺序"
          className="flex h-5 w-5 cursor-grab items-center justify-center rounded text-slate-400 hover:bg-slate-200/80 hover:text-slate-700 active:cursor-grabbing"
        >
          <GripVertical className="h-3 w-3" />
        </button>

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`工作表操作 ${ws.name}`}
              onClick={(e) => e.stopPropagation()}
              className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-200/80 hover:text-slate-800 cursor-pointer"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[140px]">
            <DropdownMenuItem
              onSelect={() => {
                onEdit(ws);
              }}
            >
              <Pencil className="h-3.5 w-3.5 text-slate-400" />
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [editingWs, setEditingWs] = useState<WorksheetSummary | null>(null);
  const [deletingWs, setDeletingWs] = useState<WorksheetSummary | null>(null);

  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const setCollapsed = (next: boolean) => {
    setCollapsedState(next);
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // ignore storage errors
    }
  };

  const toggleCollapsed = () => setCollapsed(!collapsed);

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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // 订阅项目级实时通道，同步左侧工作表列表、看板列与用户显示名变化
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

  const visibleAdminNav = ADMIN_NAV.filter(
    (item) => !item.permission || me.permissions.includes(item.permission),
  );

  // 首页看板与单张工作表页切为全屏贴边白底画布，其余页面保留舒适留白
  const isCanvasPage = location.pathname === '/' || /^\/worksheets\/[^/]+/.test(location.pathname);

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
      isActive
        ? 'bg-sky-50 font-medium text-sky-900'
        : 'text-slate-700 hover:bg-slate-200/55 hover:text-slate-900',
    );

  const handleSidebarDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = worksheets.findIndex((w) => w.id === active.id);
    const newIndex = worksheets.findIndex((w) => w.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(worksheets, oldIndex, newIndex);
    queryClient.setQueryData(queryKeys.worksheets, reordered);
    reorderWsMutation.mutate(reordered.map((w) => w.id));
  };

  const renderNav = (onNavigate?: () => void) => (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2.5" aria-label="主导航">
      {TOP_NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={navLinkClass}
        >
          <span className="text-slate-400">{item.icon}</span>
          <span className="truncate">{item.label}</span>
        </NavLink>
      ))}

      {/* 工作表分组（实时列出所有未删工作表，支持原地新建/改名/删表/拖序） */}
      <div className="mt-4 mb-1 flex items-center justify-between px-2.5">
        <NavLink
          to="/worksheets"
          end
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'text-[11px] font-semibold tracking-wider transition-colors',
              isActive ? 'text-sky-800' : 'text-slate-400 hover:text-slate-700',
            )
          }
        >
          工作表
        </NavLink>
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            setCreateOpen(true);
          }}
          title="新建工作表"
          aria-label="快速建表"
          data-testid="sidebar-create-worksheet"
          className="flex h-5 w-5 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-800 cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-col gap-0.5" data-testid="sidebar-worksheets">
        {worksheets.length === 0 ? (
          <button
            type="button"
            onClick={() => {
              onNavigate?.();
              setCreateOpen(true);
            }}
            className="mx-1 rounded-md border border-dashed border-slate-200 px-2.5 py-2 text-left text-xs text-slate-400 hover:border-slate-300 hover:text-slate-600 cursor-pointer"
          >
            + 新建第一张工作表
          </button>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleSidebarDragEnd}
          >
            <SortableContext
              items={worksheets.map((w) => w.id)}
              strategy={verticalListSortingStrategy}
            >
              {worksheets.map((ws) => (
                <SortableSidebarWorksheetItem
                  key={ws.id}
                  ws={ws}
                  onNavigate={onNavigate}
                  onEdit={(target) => {
                    onNavigate?.();
                    setEditingWs(target);
                  }}
                  onDelete={(target) => {
                    onNavigate?.();
                    setDeletingWs(target);
                  }}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* 底部个人设置与管理 */}
      <div className="mt-auto pt-3">
        <div className="border-t border-slate-200/80 pt-2">
          {visibleAdminNav.length > 0 && (
            <div className="mb-1.5 space-y-0.5">
              <div className="px-2.5 pt-1 pb-0.5 text-[11px] font-semibold tracking-wider text-slate-400">
                管理
              </div>
              {visibleAdminNav.map((item) => (
                <NavLink key={item.to} to={item.to} onClick={onNavigate} className={navLinkClass}>
                  <span className="text-slate-400">{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                </NavLink>
              ))}
            </div>
          )}

          <NavLink to="/settings" onClick={onNavigate} className={navLinkClass}>
            <span className="text-slate-400">
              <Settings className="h-3.5 w-3.5 shrink-0" />
            </span>
            <span className="min-w-0 flex-1 truncate">个人设置</span>
          </NavLink>
          <div className="mt-1 truncate px-2.5 text-[11px] text-slate-400">
            {me.user.displayName} · {ROLE_LABELS[me.role]}
          </div>
        </div>
      </div>
    </nav>
  );

  const showDisconnectBanner = status === 'disconnected';

  return (
    <SidebarContext.Provider value={{ collapsed, setCollapsed, toggleCollapsed }}>
      <div
        className={cn(
          'flex w-full overflow-x-hidden',
          isCanvasPage ? 'h-dvh overflow-hidden bg-white' : 'min-h-screen bg-slate-50',
        )}
      >
        {/* 桌面端左侧栏（收窄至 208px，支持一键折叠） */}
        {!collapsed && (
          <aside className="hidden w-52 shrink-0 flex-col border-r border-slate-200/80 bg-slate-50/70 md:flex">
            <div className="flex h-11 shrink-0 items-center justify-between gap-1.5 border-b border-slate-200/80 px-3">
              <span className="truncate text-sm font-semibold text-slate-900">
                {me.project.name}
              </span>
              <button
                type="button"
                onClick={toggleCollapsed}
                title="折叠左侧栏"
                aria-label="折叠侧栏"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-700 cursor-pointer"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </button>
            </div>
            {renderNav()}
          </aside>
        )}

        {/* 窄屏抽屉 */}
        {drawerOpen && (
          <div className="fixed inset-0 z-40 flex md:hidden">
            <button
              type="button"
              aria-label="关闭菜单"
              className="fixed inset-0 bg-black/40"
              onClick={() => setDrawerOpen(false)}
            />
            <aside className="relative z-50 flex w-60 max-w-[80vw] flex-col bg-slate-50 shadow-xl">
              <div className="flex h-12 items-center justify-between border-b border-slate-200 bg-white px-3.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-900">
                    {me.project.name}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="rounded p-1 text-slate-500 hover:bg-slate-100"
                  aria-label="关闭导航"
                >
                  ✕
                </button>
              </div>
              {renderNav(() => setDrawerOpen(false))}
            </aside>
          </div>
        )}

        {/* 右侧主区域 */}
        <div
          className={cn(
            'flex min-w-0 flex-1 flex-col',
            isCanvasPage && 'h-full min-h-0 overflow-hidden',
          )}
        >
          {/* 窄屏顶栏（48px） */}
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200/80 bg-white px-3 md:hidden">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              aria-label="打开导航"
            >
              <Menu className="h-3.5 w-3.5" />
              菜单
            </button>
            <span className="truncate px-2 text-sm font-semibold text-slate-900">
              {me.project.name}
            </span>
            <span className="truncate text-xs text-slate-500">{me.user.displayName}</span>
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

          {isCanvasPage ? (
            <main className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-white p-0">
              <Outlet />
            </main>
          ) : (
            <main className="mx-auto w-full min-w-0 max-w-5xl flex-1 p-4 sm:p-6">
              {collapsed && (
                <div className="mb-3 hidden md:block">
                  <button
                    type="button"
                    onClick={toggleCollapsed}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 shadow-2xs hover:bg-slate-50 hover:text-slate-900 cursor-pointer"
                    aria-label="展开侧栏"
                  >
                    <PanelLeftOpen className="h-3.5 w-3.5" />
                    展开导航栏
                  </button>
                </div>
              )}
              <Outlet />
            </main>
          )}
        </div>

        {/* 左侧栏原地新建/编辑/删除工作表弹窗 */}
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
    </SidebarContext.Provider>
  );
}
