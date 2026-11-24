import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordBodySchema, ROLE_LABELS, updateAccountBodySchema } from '@nw/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import { Alert, Button, Card, Input, Label } from '@/components/ui/primitives.js';

type DisplayNameForm = z.input<typeof updateAccountBodySchema>;

const changePwSchema = changePasswordBodySchema
  .extend({
    confirmNewPassword: z
      .string({ error: '请再次输入新密码' })
      .min(1, { error: '请再次输入新密码' }),
  })
  .superRefine((v, ctx) => {
    if (v.newPassword !== v.confirmNewPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmNewPassword'],
        message: '两次输入的新密码不一致',
      });
    }
  });
type ChangePwForm = z.input<typeof changePwSchema>;

export function SettingsPage() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [nameMsg, setNameMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [pwMsg, setPwMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const nameForm = useForm<DisplayNameForm>({
    resolver: zodResolver(updateAccountBodySchema),
    values: { displayName: me?.user.displayName ?? '' },
  });

  const pwForm = useForm<ChangePwForm>({
    resolver: zodResolver(changePwSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmNewPassword: '' },
  });

  if (!me) return null;

  const onSaveName = async (values: DisplayNameForm) => {
    setNameMsg(null);
    try {
      await apiFetch('/api/account', { method: 'PATCH', body: values });
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      await queryClient.invalidateQueries({ queryKey: queryKeys.users });
      setNameMsg({ type: 'success', text: '显示名已更新' });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields?.displayName) {
          nameForm.setError('displayName', { message: err.fields.displayName });
        }
        setNameMsg({ type: 'error', text: err.message });
      } else {
        setNameMsg({ type: 'error', text: '更新失败' });
      }
    }
  };

  const onSavePassword = async (values: ChangePwForm) => {
    setPwMsg(null);
    try {
      await apiFetch('/api/account/password', {
        method: 'POST',
        body: { currentPassword: values.currentPassword, newPassword: values.newPassword },
      });
      pwForm.reset();
      setPwMsg({ type: 'success', text: '密码已修改，其他设备已被登出' });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields?.currentPassword) {
          pwForm.setError('currentPassword', { message: err.fields.currentPassword });
        }
        if (err.fields?.newPassword) {
          pwForm.setError('newPassword', { message: err.fields.newPassword });
        }
        setPwMsg({ type: 'error', text: err.message });
      } else {
        setPwMsg({ type: 'error', text: '修改密码失败' });
      }
    }
  };

  const onLogout = async () => {
    setLoggingOut(true);
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', skipAuthRedirect: true });
    } finally {
      queryClient.clear();
      navigate('/login', { replace: true });
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">个人设置</h1>

      <Card className="space-y-4">
        <div>
          <h2 className="text-base font-medium text-slate-900">基本资料</h2>
          <p className="mt-1 text-xs text-slate-500">
            登录名：<span className="font-mono text-slate-700">{me.user.loginName}</span>
            （不可修改） · 角色：{ROLE_LABELS[me.role]}
          </p>
        </div>

        {nameMsg && <Alert variant={nameMsg.type}>{nameMsg.text}</Alert>}

        <form
          onSubmit={nameForm.handleSubmit(onSaveName)}
          className="max-w-sm space-y-3"
          noValidate
        >
          <div>
            <Label htmlFor="displayName">显示名</Label>
            <Input id="displayName" {...nameForm.register('displayName')} />
            {nameForm.formState.errors.displayName && (
              <p className="mt-1 text-xs text-red-600">
                {nameForm.formState.errors.displayName.message}
              </p>
            )}
          </div>
          <Button type="submit" disabled={nameForm.formState.isSubmitting}>
            {nameForm.formState.isSubmitting ? '保存中…' : '保存显示名'}
          </Button>
        </form>
      </Card>

      <Card className="space-y-4">
        <h2 className="text-base font-medium text-slate-900">修改密码</h2>

        {pwMsg && <Alert variant={pwMsg.type}>{pwMsg.text}</Alert>}

        <form
          onSubmit={pwForm.handleSubmit(onSavePassword)}
          className="max-w-sm space-y-3"
          noValidate
        >
          <div>
            <Label htmlFor="currentPassword">当前密码</Label>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              {...pwForm.register('currentPassword')}
            />
            {pwForm.formState.errors.currentPassword && (
              <p className="mt-1 text-xs text-red-600">
                {pwForm.formState.errors.currentPassword.message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="newPassword">新密码</Label>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              {...pwForm.register('newPassword')}
            />
            {pwForm.formState.errors.newPassword && (
              <p className="mt-1 text-xs text-red-600">
                {pwForm.formState.errors.newPassword.message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="confirmNewPassword">确认新密码</Label>
            <Input
              id="confirmNewPassword"
              type="password"
              autoComplete="new-password"
              {...pwForm.register('confirmNewPassword')}
            />
            {pwForm.formState.errors.confirmNewPassword && (
              <p className="mt-1 text-xs text-red-600">
                {pwForm.formState.errors.confirmNewPassword.message}
              </p>
            )}
          </div>

          <Button type="submit" disabled={pwForm.formState.isSubmitting}>
            {pwForm.formState.isSubmitting ? '修改中…' : '修改密码'}
          </Button>
        </form>
      </Card>

      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-slate-900">退出登录</h2>
          <p className="text-xs text-slate-500">仅退出当前设备的会话</p>
        </div>
        <Button variant="danger" onClick={onLogout} disabled={loggingOut}>
          {loggingOut ? '退出中…' : '登出'}
        </Button>
      </Card>
    </div>
  );
}
