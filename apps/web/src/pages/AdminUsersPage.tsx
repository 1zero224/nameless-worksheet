import {
  type CreatedInvite,
  INVITE_EXPIRY_DAYS,
  INVITE_STATUS_LABELS,
  type InviteItem,
  type InviteStatus,
  type ResetLinkResponse,
  ROLE_LABELS,
  type Role,
  type UserListItem,
  type UserUpdatedPayload,
} from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Input,
  Label,
  Select,
} from '@/components/ui/primitives.js';
import { useRealtimeScope } from '@/realtime/context.js';

function statusBadgeVariant(status: InviteStatus) {
  if (status === 'active') return 'success' as const;
  if (status === 'exhausted') return 'default' as const;
  if (status === 'expired') return 'warning' as const;
  return 'muted' as const;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

export function AdminUsersPage() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();

  const [actionError, setActionError] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<UserListItem | null>(null);
  const [oneTimeLink, setOneTimeLink] = useState<{ title: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // 创建邀请表单状态
  const [invRole, setInvRole] = useState<Role>('user');
  const [invDays, setInvDays] = useState<1 | 7 | 30>(7);
  const [invMaxUses, setInvMaxUses] = useState(1);

  const usersQuery = useQuery<UserListItem[], ApiError>({
    queryKey: queryKeys.users,
    queryFn: () => apiFetch<UserListItem[]>('/api/users'),
  });

  const invitesQuery = useQuery<InviteItem[], ApiError>({
    queryKey: queryKeys.invites,
    queryFn: () => apiFetch<InviteItem[]>('/api/invites'),
  });

  // 订阅 project 范围：收到 user.updated 时刷新用户列表，若涉及自己则同时刷新 /api/auth/me
  useRealtimeScope(me ? { type: 'project', id: me.project.id } : null, {
    onEvent: (ev) => {
      if (ev.type === 'user.updated') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.users });
        const payload = ev.payload as UserUpdatedPayload | null;
        if (payload?.userId === me?.user.id) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.me });
        }
      }
    },
    onResync: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users });
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      apiFetch<UserListItem>(`/api/users/${userId}/role`, { method: 'PATCH', body: { role } }),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.users });
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (err) => {
      setActionError(err instanceof ApiError ? err.message : '调整角色失败');
    },
  });

  const resetMutation = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<ResetLinkResponse>(`/api/users/${userId}/password-reset`, { method: 'POST' }),
    onSuccess: (data) => {
      setActionError(null);
      setResetTarget(null);
      setCopied(false);
      setOneTimeLink({ title: '密码重置链接', url: data.url });
    },
    onError: (err) => {
      setResetTarget(null);
      setActionError(err instanceof ApiError ? err.message : '生成重置链接失败');
    },
  });

  const createInviteMutation = useMutation({
    mutationFn: () =>
      apiFetch<CreatedInvite>('/api/invites', {
        method: 'POST',
        body: { role: invRole, expiresInDays: invDays, maxUses: invMaxUses },
      }),
    onSuccess: (data) => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.invites });
      setCopied(false);
      setOneTimeLink({ title: '邀请链接', url: data.url });
    },
    onError: (err) => {
      setActionError(err instanceof ApiError ? err.message : '创建邀请失败');
    },
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/invites/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.invites });
    },
    onError: (err) => {
      setActionError(err instanceof ApiError ? err.message : '作废邀请失败');
    },
  });

  const copyLink = async () => {
    if (!oneTimeLink) return;
    try {
      await navigator.clipboard.writeText(oneTimeLink.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">用户与邀请</h1>

      {actionError && <Alert variant="error">{actionError}</Alert>}

      {/* 用户列表 */}
      <Card className="space-y-4">
        <h2 className="text-base font-medium text-slate-900">用户列表</h2>
        {usersQuery.isLoading ? (
          <p className="text-sm text-slate-500">加载中…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">显示名</th>
                  <th className="py-2 pr-3 font-medium">登录名</th>
                  <th className="py-2 pr-3 font-medium">角色</th>
                  <th className="py-2 pr-3 font-medium">加入时间</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(usersQuery.data ?? []).map((u) => (
                  <tr key={u.id}>
                    <td className="py-2.5 pr-3 font-medium text-slate-900">{u.displayName}</td>
                    <td className="py-2.5 pr-3 font-mono text-xs text-slate-600">
                      {u.loginName ?? '-'}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Select
                        aria-label={`调整 ${u.displayName} 的角色`}
                        value={u.role}
                        className="w-28 py-1 text-xs"
                        disabled={roleMutation.isPending}
                        onChange={(e) =>
                          roleMutation.mutate({ userId: u.id, role: e.target.value as Role })
                        }
                      >
                        <option value="admin">{ROLE_LABELS.admin}</option>
                        <option value="user">{ROLE_LABELS.user}</option>
                      </Select>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-slate-500">
                      {formatDate(u.createdAt)}
                    </td>
                    <td className="py-2.5">
                      <Button variant="secondary" size="sm" onClick={() => setResetTarget(u)}>
                        生成重置链接
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 创建邀请 */}
      <Card className="space-y-4">
        <h2 className="text-base font-medium text-slate-900">创建邀请</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createInviteMutation.mutate();
          }}
          className="grid grid-cols-1 gap-3 sm:grid-cols-4 sm:items-end"
        >
          <div>
            <Label htmlFor="invRole">角色</Label>
            <Select
              id="invRole"
              value={invRole}
              onChange={(e) => setInvRole(e.target.value as Role)}
            >
              <option value="user">{ROLE_LABELS.user}</option>
              <option value="admin">{ROLE_LABELS.admin}</option>
            </Select>
          </div>

          <div>
            <Label htmlFor="invDays">有效期</Label>
            <Select
              id="invDays"
              value={invDays}
              onChange={(e) => setInvDays(Number(e.target.value) as 1 | 7 | 30)}
            >
              {INVITE_EXPIRY_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d} 天
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="invMaxUses">可用次数（1–50）</Label>
            <Input
              id="invMaxUses"
              type="number"
              min={1}
              max={50}
              value={invMaxUses}
              onChange={(e) =>
                setInvMaxUses(Math.max(1, Math.min(50, Number(e.target.value) || 1)))
              }
            />
          </div>

          <Button type="submit" disabled={createInviteMutation.isPending}>
            {createInviteMutation.isPending ? '生成中…' : '生成邀请链接'}
          </Button>
        </form>
      </Card>

      {/* 邀请列表 */}
      <Card className="space-y-4">
        <h2 className="text-base font-medium text-slate-900">邀请列表</h2>
        {invitesQuery.isLoading ? (
          <p className="text-sm text-slate-500">加载中…</p>
        ) : (invitesQuery.data ?? []).length === 0 ? (
          <p className="text-sm text-slate-500">暂无邀请记录</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">角色</th>
                  <th className="py-2 pr-3 font-medium">状态</th>
                  <th className="py-2 pr-3 font-medium">使用次数</th>
                  <th className="py-2 pr-3 font-medium">到期时间</th>
                  <th className="py-2 pr-3 font-medium">创建人</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(invitesQuery.data ?? []).map((inv) => (
                  <tr key={inv.id}>
                    <td className="py-2.5 pr-3">{ROLE_LABELS[inv.role]}</td>
                    <td className="py-2.5 pr-3">
                      <Badge variant={statusBadgeVariant(inv.status)}>
                        {INVITE_STATUS_LABELS[inv.status]}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-3">
                      {inv.usedCount} / {inv.maxUses}
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-slate-500">
                      {formatDate(inv.expiresAt)}
                    </td>
                    <td className="py-2.5 pr-3 text-slate-700">{inv.createdBy.displayName}</td>
                    <td className="py-2.5">
                      {inv.status === 'active' && (
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={revokeInviteMutation.isPending}
                          onClick={() => revokeInviteMutation.mutate(inv.id)}
                        >
                          作废
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 生成重置链接确认弹窗 */}
      <Dialog
        open={Boolean(resetTarget)}
        title="确认生成密码重置链接"
        onClose={() => setResetTarget(null)}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            确定要为 <span className="font-semibold">{resetTarget?.displayName}</span>{' '}
            生成密码重置链接吗？
          </p>
          <Alert variant="warning">对方当前密码将立即失效并被登出所有设备</Alert>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setResetTarget(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={resetMutation.isPending}
              onClick={() => resetTarget && resetMutation.mutate(resetTarget.id)}
            >
              {resetMutation.isPending ? '生成中…' : '确认生成'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* 一次性链接展示弹窗 */}
      <Dialog
        open={Boolean(oneTimeLink)}
        title={oneTimeLink?.title ?? ''}
        onClose={() => setOneTimeLink(null)}
      >
        <div className="space-y-4">
          <Alert variant="info">此链接仅显示这一次，关闭后无法再次查看，请立即复制保存。</Alert>
          <Input readOnly value={oneTimeLink?.url ?? ''} data-testid="one-time-link-input" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={copyLink}>
              {copied ? '已复制' : '复制链接'}
            </Button>
            <Button onClick={() => setOneTimeLink(null)}>我已保存</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
