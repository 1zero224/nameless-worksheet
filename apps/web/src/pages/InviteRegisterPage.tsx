import { zodResolver } from '@hookform/resolvers/zod';
import { type InvitePreview, type MeResponse, ROLE_LABELS, registerBodySchema } from '@nw/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { Alert, Button, Card, Input, Label } from '@/components/ui/primitives.js';

const formSchema = registerBodySchema
  .extend({
    confirmPassword: z.string({ error: '请再次输入密码' }).min(1, { error: '请再次输入密码' }),
  })
  .superRefine((v, ctx) => {
    if (v.password !== v.confirmPassword) {
      ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: '两次输入的密码不一致' });
    }
  });

type RegisterForm = z.input<typeof formSchema>;

export function InviteRegisterPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const previewQuery = useQuery<InvitePreview, ApiError>({
    queryKey: queryKeys.invitePreview(token),
    queryFn: () =>
      apiFetch<InvitePreview>(`/api/invites/by-token/${encodeURIComponent(token)}`, {
        skipAuthRedirect: true,
      }),
    retry: false,
  });

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterForm>({
    resolver: zodResolver(formSchema),
    defaultValues: { loginName: '', displayName: '', password: '', confirmPassword: '' },
  });

  const onSubmit = async (values: RegisterForm) => {
    setSubmitError(null);
    try {
      const me = await apiFetch<MeResponse>(
        `/api/invites/by-token/${encodeURIComponent(token)}/register`,
        {
          method: 'POST',
          body: {
            loginName: values.loginName,
            displayName: values.displayName,
            password: values.password,
          },
          skipAuthRedirect: true,
        },
      );
      queryClient.setQueryData(queryKeys.me, me);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) {
          for (const [k, msg] of Object.entries(err.fields)) {
            if (k === 'loginName' || k === 'displayName' || k === 'password') {
              setError(k, { message: msg });
            }
          }
        }
        setSubmitError(err.message);
      } else {
        setSubmitError('注册失败，请稍后再试');
      }
    }
  };

  if (previewQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        正在校验邀请链接…
      </div>
    );
  }

  if (previewQuery.isError || !previewQuery.data) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md space-y-3 text-center">
          <h1 className="text-lg font-semibold text-slate-900">邀请无效</h1>
          <p className="text-sm text-slate-600">邀请链接无效或已过期，请联系管理员</p>
        </Card>
      </div>
    );
  }

  const preview = previewQuery.data;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">接受邀请并注册</h1>
          <p className="mt-1 text-sm text-slate-600">
            项目：<span className="font-medium text-slate-900">{preview.projectName}</span> · 角色：
            <span className="font-medium text-slate-900">{ROLE_LABELS[preview.role]}</span>
          </p>
        </div>

        {submitError && <Alert variant="error">{submitError}</Alert>}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="loginName">登录名</Label>
            <Input id="loginName" autoComplete="username" {...register('loginName')} />
            <p className="mt-1 text-xs text-slate-500">
              3–32 位小写字母、数字或下划线，注册后不可修改
            </p>
            {errors.loginName && (
              <p className="mt-1 text-xs text-red-600">{errors.loginName.message}</p>
            )}
          </div>

          <div>
            <Label htmlFor="displayName">显示名</Label>
            <Input id="displayName" {...register('displayName')} />
            {errors.displayName && (
              <p className="mt-1 text-xs text-red-600">{errors.displayName.message}</p>
            )}
          </div>

          <div>
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              {...register('password')}
            />
            {errors.password && (
              <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>
            )}
          </div>

          <div>
            <Label htmlFor="confirmPassword">确认密码</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              {...register('confirmPassword')}
            />
            {errors.confirmPassword && (
              <p className="mt-1 text-xs text-red-600">{errors.confirmPassword.message}</p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? '注册中…' : '完成注册'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
