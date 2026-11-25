import { type Permission, ROLE_LABELS, type WorksheetSummary } from '@nw/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import { WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import { cn } from '@/components/ui/primitives.js';
import { useRealtimeScope, useRealtimeStatus } from '@/realtime/context.js';

interface NavItem {
  to: string;
  label: string;
  permission?: Permission;
  end?: boolean;
}

const TOP_NAV: NavItem[] = [
  { to: '/', label: '首页', end: true },
  { to: '/my-tasks', label: '我的任务' },
  { to: '/search', label: '资源检索' },
  { to: '/references', label: '参考资料' },
];

const ADMIN_NAV: NavItem[] = [
  { to: '/admin/users', label: '用户与邀请', permission: 'users.manage' },
  { to: '/admin/storage', label: '存储', permission: 'storage.manage' },
  { to: '/admin/realtime', label: '实时通道诊断', permission: 'diag.realtime' },
];

export function AppShell() {
  const { data: me } = useMe();
  const { status } = useRealtimeStatus();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const queryClient = useQueryClient();

  const { data: worksheets = [] } = useQuery<WorksheetSummary[]>({
    queryKey: queryKeys.worksheets,
    queryFn: () => apiFetch<WorksheetSummary[]>('/api/worksheets'),
    enabled: Boolean(me),
  });

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

  // 工作表与首页看板使用全宽布局，其余页面保持合适最大宽度
  const isFullWidthPage = location.pathname === '/' || location.pathname.startsWith('/worksheets/');

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
      isActive
        ? 'bg-slate-900 text-white'
        : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900',
    );

  const renderNav = (onNavigate?: () => void) => (
    <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-4" aria-label="主导航">
      {TOP_NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={navLinkClass}
        >
          {item.label}
        </NavLink>
      ))}

      {/* 工作表分组（实时列出所有未删工作表） */}
      <div className="mt-4 mb-1 flex items-center justify-between px-3">
        <NavLink
          to="/worksheets"
          end
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'text-xs font-semibold tracking-wider transition-colors',
              isActive ? 'text-slate-900' : 'text-slate-400 hover:text-slate-700',
            )
          }
        >
          工作表
        </NavLink>
        <NavLink
          to="/worksheets"
          onClick={onNavigate}
          title="管理或新建工作表"
          className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          aria-label="管理或新建工作表"
        >
          <Plus className="h-3.5 w-3.5" />
        </NavLink>
      </div>

      <div className="flex flex-col gap-0.5" data-testid="sidebar-worksheets">
        {worksheets.length === 0 ? (
          <NavLink
            to="/worksheets"
            onClick={onNavigate}
            className="rounded-md px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            暂无工作表，去新建…
          </NavLink>
        ) : (
          worksheets.map((ws) => {
            const colorStyle = WORKSHEET_COLOR_STYLES[ws.color] ?? WORKSHEET_COLOR_STYLES.sky;
            return (
              <NavLink
                key={ws.id}
                to={`/worksheets/${ws.id}`}
                onClick={onNavigate}
                className={navLinkClass}
              >
                <span className={cn('h-2 w-2 shrink-0 rounded-full', colorStyle.dot)} />
                <span className="truncate">{ws.name}</span>
              </NavLink>
            );
          })
        )}
      </div>

      {/* 底部个人设置与管理 */}
      <div className="mt-auto pt-4">
        <div className="border-t border-slate-200 pt-3">
          <NavLink to="/settings" onClick={onNavigate} className={navLinkClass}>
            个人设置
          </NavLink>

          {visibleAdminNav.length > 0 && (
            <>
              <div className="mt-3 mb-1 px-3 text-xs font-semibold tracking-wider text-slate-400">
                管理
              </div>
              {visibleAdminNav.map((item) => (
                <NavLink key={item.to} to={item.to} onClick={onNavigate} className={navLinkClass}>
                  {item.label}
                </NavLink>
              ))}
            </>
          )}
        </div>
      </div>
    </nav>
  );

  const showDisconnectBanner = status === 'disconnected';

  return (
    <div className="flex min-h-screen w-full overflow-x-hidden bg-slate-50">
      {/* 桌面端左侧栏 */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="border-b border-slate-200 px-4 py-4">
          <div className="truncate text-base font-semibold text-slate-900">{me.project.name}</div>
          <div className="mt-0.5 truncate text-xs text-slate-500">
            {me.user.displayName} · {ROLE_LABELS[me.role]}
          </div>
        </div>
        {renderNav()}
      </aside>

      {/* 窄屏抽屉 */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <button
            type="button"
            aria-label="关闭菜单"
            className="fixed inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="relative z-50 flex w-64 max-w-[80vw] flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-4">
              <div className="min-w-0">
                <div className="truncate text-base font-semibold text-slate-900">
                  {me.project.name}
                </div>
                <div className="mt-0.5 truncate text-xs text-slate-500">
                  {me.user.displayName} · {ROLE_LABELS[me.role]}
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
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 窄屏顶栏 */}
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="rounded-md border border-slate-300 px-2.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            aria-label="打开导航"
          >
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
            className="bg-amber-100 px-4 py-2 text-center text-xs font-medium text-amber-900"
          >
            连接中断，正在重连
          </div>
        )}

        <main
          className={cn(
            'w-full min-w-0 flex-1 p-4 sm:p-6',
            !isFullWidthPage && 'mx-auto max-w-5xl',
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
