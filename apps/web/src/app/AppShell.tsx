import { type Permission, ROLE_LABELS } from '@nw/shared';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useMe } from '@/app/AuthContext.js';
import { cn } from '@/components/ui/primitives.js';
import { useRealtimeStatus } from '@/realtime/context.js';

interface NavItem {
  to: string;
  label: string;
  permission?: Permission;
  end?: boolean;
}

const MAIN_NAV: NavItem[] = [
  { to: '/', label: '首页', end: true },
  { to: '/my-tasks', label: '我的任务' },
  { to: '/worksheets', label: '工作表' },
  { to: '/search', label: '资源检索' },
  { to: '/references', label: '参考资料' },
  { to: '/archive', label: '归档' },
  { to: '/settings', label: '个人设置' },
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

  if (!me) return null;

  const visibleAdminNav = ADMIN_NAV.filter(
    (item) => !item.permission || me.permissions.includes(item.permission),
  );

  const renderNav = (onNavigate?: () => void) => (
    <nav className="flex flex-1 flex-col gap-1 px-3 py-4" aria-label="主导航">
      {MAIN_NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-slate-900 text-white'
                : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900',
            )
          }
        >
          {item.label}
        </NavLink>
      ))}

      {visibleAdminNav.length > 0 && (
        <>
          <div className="mt-4 mb-1 px-3 text-xs font-semibold tracking-wider text-slate-400">
            管理
          </div>
          {visibleAdminNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </>
      )}
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

        {/* 断线重连提示条（8.8） */}
        {showDisconnectBanner && (
          <div
            role="status"
            className="bg-amber-100 px-4 py-2 text-center text-xs font-medium text-amber-900"
          >
            连接中断，正在重连
          </div>
        )}

        <main className="mx-auto w-full max-w-5xl flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
