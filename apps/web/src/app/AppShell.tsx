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
  ChevronDown,
  ChevronRight,
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
        'hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-black/[0.04] hover:text-zinc-950 md:inline-flex cursor-pointer',
        className,
      )}
    >
      <PanelLeftOpen className="h-[15px] w-[15px]" strokeWidth={1.75} />
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
  {
    to: '/',
    label: '任务看板',
    icon: <Kanban className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} />,
    end: true,
  },
  {
    to: '/my-tasks',
    label: '我的任务',
    icon: <CheckSquare className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} />,
  },
  {
    to: '/search',
    label: '资源检索',
    icon: <Search className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} />,
  },
  {
    to: '/references',
    label: '参考资料',
    icon: <BookOpen className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} />,
  },
];

const ADMIN_NAV: NavItem[] = [
  {
    to: '/admin/users',
    label: '用户与邀请',
    icon: <Users className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} />,
    permission: 'users.manage',
  },
  {
    to: '/admin/storage',
    label: '存储',
    icon: <HardDrive className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} />,
    permission: 'storage.manage',
  },
  {
    to: '/admin/realtime',
    label: '实时通道诊断',
    icon: <Activity className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} />,
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
        isDragging && 'z-20 bg-white shadow-md ring-1 ring-black/10',
      )}
    >
      <NavLink
        to={`/worksheets/${ws.id}`}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-12 pl-2.5 text-[13px] transition-colors select-none',
            isActive
              ? 'bg-black/[0.06] font-medium text-zinc-950'
              : 'text-zinc-600 hover:bg-black/[0.04] hover:text-zinc-950',
          )
        }
      >
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', colorStyle.dot)} />
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
          className="flex h-5 w-5 cursor-grab items-center justify-center rounded text-zinc-400 hover:bg-black/[0.06] hover:text-zinc-700 active:cursor-grabbing"
        >
          <GripVertical className="h-3 w-3" />
        </button>

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`工作表操作 ${ws.name}`}
              onClick={(e) => e.stopPropagation()}
              className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-black/[0.06] hover:text-zinc-800 cursor-pointer"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[144px]">
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [adminExpanded, setAdminExpanded] = useState(true);
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

  const isCanvasPage = location.pathname === '/' || /^\/worksheets\/[^/]+/.test(location.pathname);

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
      isActive
        ? 'bg-black/[0.06] font-medium text-zinc-950'
        : 'text-zinc-600 hover:bg-black/[0.04] hover:text-zinc-950',
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
          <span className="text-zinc-400">{item.icon}</span>
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
              'text-[11px] font-medium tracking-wide transition-colors',
              isActive ? 'text-zinc-950' : 'text-zinc-400 hover:text-zinc-700',
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
          className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-black/[0.06] hover:text-zinc-900 cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
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
            className="mx-1 rounded-md border border-dashed border-black/[0.12] px-2.5 py-2 text-left text-xs text-zinc-400 hover:border-black/[0.22] hover:text-zinc-700 cursor-pointer"
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

      {/* 左下角紧凑折叠区：管理入口与个人设置 */}
      <div className="mt-auto pt-3">
        <div className="border-t border-black/[0.08] pt-2">
          {visibleAdminNav.length > 0 && (
            <div className="mb-1.5 space-y-0.5">
              <button
                type="button"
                onClick={() => setAdminExpanded((v) => !v)}
                className="flex w-full items-center justify-between px-2.5 py-1 text-[11px] font-medium tracking-wide text-zinc-400 hover:text-zinc-700 cursor-pointer"
              >
                <span>管理</span>
                {adminExpanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>
              {adminExpanded &&
                visibleAdminNav.map((item) => (
                  <NavLink key={item.to} to={item.to} onClick={onNavigate} className={navLinkClass}>
                    <span className="text-zinc-400">{item.icon}</span>
                    <span className="truncate">{item.label}</span>
                  </NavLink>
                ))}
            </div>
          )}

          <NavLink to="/settings" onClick={onNavigate} className={navLinkClass}>
            <span className="text-zinc-400">
              <Settings className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1 truncate">个人设置</span>
          </NavLink>
          <div className="mt-1 truncate px-2.5 text-[11px] text-zinc-400">
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
          isCanvasPage ? 'h-dvh overflow-hidden bg-white' : 'min-h-screen bg-[#fafafa]',
        )}
      >
        {/* 桌面端极简左侧栏（216px，底色 #FAFAFA，支持一键折叠） */}
        {!collapsed && (
          <aside className="hidden w-[216px] shrink-0 flex-col border-r border-black/[0.08] bg-[#fafafa] md:flex">
            <div className="flex h-11 shrink-0 items-center justify-between gap-1.5 border-b border-black/[0.08] px-3">
              <span className="truncate text-[13px] font-semibold tracking-tight text-zinc-950">
                {me.project.name}
              </span>
              <button
                type="button"
                onClick={toggleCollapsed}
                title="折叠左侧栏"
                aria-label="折叠侧栏"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-800 cursor-pointer"
              >
                <PanelLeftClose className="h-[15px] w-[15px]" strokeWidth={1.75} />
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
              className="fixed inset-0 bg-black/35"
              onClick={() => setDrawerOpen(false)}
            />
            <aside className="relative z-50 flex w-60 max-w-[80vw] flex-col border-r border-black/[0.08] bg-[#fafafa] shadow-xl">
              <div className="flex h-12 items-center justify-between border-b border-black/[0.08] bg-white px-3.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-950">
                    {me.project.name}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="rounded-md p-1 text-zinc-500 hover:bg-black/[0.05]"
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
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-black/[0.08] bg-white px-3 md:hidden">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="inline-flex items-center gap-1 rounded-md border border-black/[0.1] px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-black/[0.04]"
              aria-label="打开导航"
            >
              <Menu className="h-3.5 w-3.5" />
              菜单
            </button>
            <span className="truncate px-2 text-sm font-semibold text-zinc-950">
              {me.project.name}
            </span>
            <span className="truncate text-xs text-zinc-500">{me.user.displayName}</span>
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
                    className="inline-flex items-center gap-1.5 rounded-md border border-black/[0.1] bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 shadow-2xs hover:bg-black/[0.04] hover:text-zinc-950 cursor-pointer"
                    aria-label="展开侧栏"
                  >
                    <PanelLeftOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
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
