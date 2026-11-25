import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router';
import { configureApiClient } from '@/api/client.js';
import { AppShell } from '@/app/AppShell.js';
import { RequireAuth, RequirePermission, useMe } from '@/app/AuthContext.js';
import { ToastProvider } from '@/components/ui/overlays.js';
import { AdminRealtimePage } from '@/pages/AdminRealtimePage.js';
import { AdminUsersPage } from '@/pages/AdminUsersPage.js';
import { InviteRegisterPage } from '@/pages/InviteRegisterPage.js';
import { LoginPage } from '@/pages/LoginPage.js';
import { PlaceholderPage } from '@/pages/PlaceholderPage.js';
import { ResetPasswordPage } from '@/pages/ResetPasswordPage.js';
import { SettingsPage } from '@/pages/SettingsPage.js';
import { RealtimeClient } from '@/realtime/client.js';
import { createRealtimeUrl, RealtimeProvider } from '@/realtime/context.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function AppRoutes() {
  const navigate = useNavigate();
  const { data: me } = useMe();

  const realtimeClient = useMemo(() => new RealtimeClient({ url: createRealtimeUrl() }), []);

  const handleAuthLost = useCallback(() => {
    queryClient.clear();
    navigate('/login', { replace: true });
  }, [navigate]);

  useEffect(() => {
    configureApiClient({
      getConnectionId: () => realtimeClient.getConnId(),
      onUnauthenticated: handleAuthLost,
    });
  }, [realtimeClient, handleAuthLost]);

  return (
    <RealtimeProvider client={realtimeClient} active={Boolean(me)} onAuthLost={handleAuthLost}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<InviteRegisterPage />} />
        <Route path="/reset/:token" element={<ResetPasswordPage />} />

        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<PlaceholderPage title="首页" />} />
          <Route path="/my-tasks" element={<PlaceholderPage title="我的任务" />} />
          <Route path="/worksheets" element={<PlaceholderPage title="工作表" />} />
          <Route path="/worksheets/:id" element={<PlaceholderPage title="工作表详情" />} />
          <Route path="/search" element={<PlaceholderPage title="资源检索" />} />
          <Route path="/references" element={<PlaceholderPage title="参考资料" />} />
          <Route path="/settings" element={<SettingsPage />} />

          <Route
            path="/admin/users"
            element={
              <RequirePermission permission="users.manage">
                <AdminUsersPage />
              </RequirePermission>
            }
          />
          <Route
            path="/admin/storage"
            element={
              <RequirePermission permission="storage.manage">
                <PlaceholderPage title="存储" />
              </RequirePermission>
            }
          />
          <Route
            path="/admin/realtime"
            element={
              <RequirePermission permission="diag.realtime">
                <AdminRealtimePage />
              </RequirePermission>
            }
          />
        </Route>
      </Routes>
    </RealtimeProvider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
