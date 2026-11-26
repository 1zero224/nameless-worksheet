import {
  CLAIM_LINK_DEFAULT_TTL_DAYS,
  type ClaimLinkResponse,
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
import { Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import {
  Alert,
  Badge,
  Button,
  Card,
  cn,
  Dialog,
  Input,
  Label,
} from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';
import { useRealtimeScope } from '@/realtime/context.js';

function statusBadgeVariant(status: InviteStatus) {
  if (status === 'active') return 'success' as const;
  if (status === 'exhausted') return 'default' as const;
  if (status === 'expired') return 'warning' as const;
  return 'muted' as const;
}

function formatDate(iso: string | undefined | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function formatShortDate(iso: string | undefined | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

type UserFilterTab = 'all' | 'claimed' | 'unclaimed';
const CLAIM_TTL_OPTIONS = [1, 7, 30, 90] as const;

export function AdminUsersPage() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();

  const [actionError, setActionError] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<UserListItem | null>(null);
  const [claimTarget, setClaimTarget] = useState<UserListItem | null>(null);
  const [claimTtlDays, setClaimTtlDays] = useState<number>(CLAIM_LINK_DEFAULT_TTL_DAYS);
  const [oneTimeLink, setOneTimeLink] = useState<{ title: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [userFilter, setUserFilter] = useState<UserFilterTab>('all');
  const [userSearch, setUserSearch] = useState('');

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

  const allUsers = usersQuery.data ?? [];
  const claimedCount = useMemo(
    () => allUsers.filter((u) => u.claimStatus === 'claimed' || u.loginName !== null).length,
    [allUsers],
  );
  const unclaimedCount = allUsers.length - claimedCount;

  const filteredUsers = useMemo(() => {
    const kw = userSearch.trim().toLowerCase();
    return allUsers.filter((u) => {
      const isClaimed = u.claimStatus === 'claimed' || u.loginName !== null;
      if (userFilter === 'claimed' && !isClaimed) return false;
      if (userFilter === 'unclaimed' && isClaimed) return false;
      if (kw) {
        const hitName = u.displayName.toLowerCase().includes(kw);
        const hitLogin = (u.loginName ?? '').toLowerCase().includes(kw);
        if (!hitName && !hitLogin) return false;
      }
      return true;
    });
  }, [allUsers, userFilter, userSearch]);

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

  const claimLinkMutation = useMutation({
    mutationFn: ({ userId, ttlDays }: { userId: string; ttlDays: number }) =>
      apiFetch<ClaimLinkResponse>(`/api/users/${userId}/claim-link`, {
        method: 'POST',
        body: { ttlDays },
      }),
    onSuccess: (data) => {
      const name = claimTarget?.displayName ?? '';
      setActionError(null);
      setClaimTarget(null);
      setCopied(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.users });
      setOneTimeLink({ title: `${name} 的认领链接`, url: data.url });
    },
    onError: (err) => {
      setClaimTarget(null);
      setActionError(err instanceof ApiError ? err.message : '生成认领链接失败');
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-medium text-slate-900">用户列表</h2>
            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs">
              {(
                [
                  ['all', `全部（${allUsers.length}）`],
                  ['claimed', `已认领（${claimedCount}）`],
                  ['unclaimed', `待认领（${unclaimedCount}）`],
                ] as const
              ).map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  data-testid={`admin-users-filter-${tab}`}
                  onClick={() => setUserFilter(tab)}
                  className={cn(
                    'rounded-md px-2.5 py-1 font-medium transition-colors cursor-pointer',
                    userFilter === tab
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-500 hover:text-slate-800',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <Input
              data-testid="admin-users-search"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="按显示名或登录名搜索…"
              aria-label="搜索用户"
              className="h-8 pr-7 pl-8 text-xs"
            />
            {userSearch && (
              <button
                type="button"
                onClick={() => setUserSearch('')}
                aria-label="清空搜索"
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {usersQuery.isLoading ? (
          <p className="text-sm text-slate-500">加载中…</p>
        ) : filteredUsers.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">没有符合条件的用户</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">显示名</th>
                  <th className="py-2 pr-3 font-medium">登录名 / 状态</th>
                  <th className="py-2 pr-3 font-medium">角色</th>
                  <th className="py-2 pr-3 font-medium">加入时间</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredUsers.map((u) => {
                  const isUnclaimed =
                    u.claimStatus !== undefined
                      ? u.claimStatus !== 'claimed'
                      : u.loginName === null;
                  return (
                    <tr key={u.id} data-testid={`admin-user-row-${u.id}`}>
                      <td className="py-2.5 pr-3 font-medium text-slate-900">
                        <div className="flex items-center gap-1.5">
                          <span>{u.displayName}</span>
                          {isUnclaimed && <Badge variant="muted">待认领</Badge>}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-slate-600">
                        {isUnclaimed ? (
                          <div className="flex items-center gap-1.5">
                            {u.claimStatus === 'active' ? (
                              <Badge variant="success">
                                有效至 {formatShortDate(u.claimExpiresAt)}
                              </Badge>
                            ) : u.claimStatus === 'expired' ? (
                              <Badge variant="warning">已过期</Badge>
                            ) : (
                              <span className="text-slate-400">未生成认领链接</span>
                            )}
                          </div>
                        ) : (
                          <span className="font-mono">{u.loginName ?? '-'}</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <SelectField
                          aria-label={`调整 ${u.displayName} 的角色`}
                          size="sm"
                          value={u.role}
                          className="w-28"
                          disabled={roleMutation.isPending}
                          onValueChange={(val) =>
                            roleMutation.mutate({ userId: u.id, role: val as Role })
                          }
                          options={[
                            { value: 'admin', label: ROLE_LABELS.admin },
                            { value: 'user', label: ROLE_LABELS.user },
                          ]}
                        />
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-slate-500">
                        {formatDate(u.createdAt)}
                      </td>
                      <td className="py-2.5">
                        {isUnclaimed ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            data-testid={`generate-claim-link-${u.id}`}
                            onClick={() => {
                              setClaimTtlDays(CLAIM_LINK_DEFAULT_TTL_DAYS);
                              setClaimTarget(u);
                            }}
                          >
                            {u.claimStatus === 'active' || u.claimStatus === 'expired'
                              ? '重新生成认领链接'
                              : '生成认领链接'}
                          </Button>
                        ) : (
                          <Button variant="secondary" size="sm" onClick={() => setResetTarget(u)}>
                            生成重置链接
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
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
            <SelectField
              id="invRole"
              value={invRole}
              onValueChange={(val) => setInvRole(val as Role)}
              options={[
                { value: 'user', label: ROLE_LABELS.user },
                { value: 'admin', label: ROLE_LABELS.admin },
              ]}
            />
          </div>

          <div>
            <Label htmlFor="invDays">有效期</Label>
            <SelectField
              id="invDays"
              value={String(invDays)}
              onValueChange={(val) => setInvDays(Number(val) as 1 | 7 | 30)}
              options={INVITE_EXPIRY_DAYS.map((d) => ({
                value: String(d),
                label: `${d} 天`,
              }))}
            />
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

      {/* 生成 / 重新生成认领链接弹窗 */}
      <Dialog
        open={Boolean(claimTarget)}
        title="生成一次性认领链接"
        onClose={() => setClaimTarget(null)}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            为待认领用户 <span className="font-semibold">{claimTarget?.displayName}</span>{' '}
            生成专属认领链接，对方打开后可自设登录名与密码并立即接管名下全部任务。
          </p>
          {claimTarget?.claimStatus === 'active' && (
            <Alert variant="warning">重新生成将自动作废该用户此前未使用的旧认领链接。</Alert>
          )}
          <div>
            <Label htmlFor="claimTtlDays">链接有效期</Label>
            <SelectField
              id="claimTtlDays"
              value={String(claimTtlDays)}
              onValueChange={(val) => setClaimTtlDays(Number(val))}
              options={CLAIM_TTL_OPTIONS.map((d) => ({ value: String(d), label: `${d} 天` }))}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setClaimTarget(null)}>
              取消
            </Button>
            <Button
              data-testid="confirm-generate-claim-link"
              disabled={claimLinkMutation.isPending}
              onClick={() =>
                claimTarget &&
                claimLinkMutation.mutate({ userId: claimTarget.id, ttlDays: claimTtlDays })
              }
            >
              {claimLinkMutation.isPending ? '生成中…' : '确认生成'}
            </Button>
          </div>
        </div>
      </Dialog>

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
