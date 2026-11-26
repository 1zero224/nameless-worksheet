import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router';
import { configureApiClient } from '@/api/client.js';
import { AppShell } from '@/app/AppShell.js';
import { RequireAuth, RequirePermission, useMe } from '@/app/AuthContext.js';
import { ToastProvider } from '@/components/ui/overlays.js';
import { AdminRealtimePage } from '@/pages/AdminRealtimePage.js';
import { AdminUsersPage } from '@/pages/AdminUsersPage.js';
import { HomePage } from '@/pages/HomePage.js';
import { InviteRegisterPage } from '@/pages/InviteRegisterPage.js';
import { LoginPage } from '@/pages/LoginPage.js';
import { PlaceholderPage } from '@/pages/PlaceholderPage.js';
import { ResetPasswordPage } from '@/pages/ResetPasswordPage.js';
import { SettingsPage } from '@/pages/SettingsPage.js';
import { WorksheetDetailPage } from '@/pages/WorksheetDetailPage.js';
import { WorksheetsPage } from '@/pages/WorksheetsPage.js';
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
          <Route index element={<HomePage />} />
          <Route path="/worksheets" element={<WorksheetsPage />} />
          <Route path="/worksheets/:id" element={<WorksheetDetailPage />} />
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

          <Route path="*" element={<Navigate to="/" replace />} />
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
