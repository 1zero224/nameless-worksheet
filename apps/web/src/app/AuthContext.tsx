import type { MeResponse, Permission } from '@nw/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';

export function useMe() {
  return useQuery<MeResponse | null, ApiError>({
    queryKey: queryKeys.me,
    queryFn: async () => {
      try {
        return await apiFetch<MeResponse>('/api/auth/me', { skipAuthRedirect: true });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          return null;
        }
        throw err;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: me, isLoading } = useMe();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        正在加载…
      </div>
    );
  }

  if (!me) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return <>{children}</>;
}

export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { data: me } = useMe();
  if (!me) return null;

  if (!me.permissions.includes(permission)) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <h1 className="text-xl font-semibold text-slate-900">无权访问</h1>
        <p className="mt-2 text-sm text-slate-500">当前角色没有访问此页面的权限。</p>
      </div>
    );
  }

  return <>{children}</>;
}
