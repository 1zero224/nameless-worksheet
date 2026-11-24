import { zodResolver } from '@hookform/resolvers/zod';
import { loginBodySchema, type MeResponse } from '@nw/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import { Alert, Button, Card, Input, Label } from '@/components/ui/primitives.js';

type LoginForm = z.input<typeof loginBodySchema>;

export function LoginPage() {
  const { data: me, isLoading } = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const resetDone = searchParams.get('reset') === '1';
  const nextRaw = searchParams.get('next');
  const nextPath = nextRaw && nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/';

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginBodySchema),
    defaultValues: { loginName: '', password: '' },
  });

  if (!isLoading && me) {
    return <Navigate to={nextPath} replace />;
  }

  const onSubmit = async (values: LoginForm) => {
    setSubmitError(null);
    try {
      const data = await apiFetch<MeResponse>('/api/auth/login', {
        method: 'POST',
        body: values,
        skipAuthRedirect: true,
      });
      queryClient.setQueryData(queryKeys.me, data);
      navigate(nextPath, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError('登录失败，请稍后再试');
      }
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">登录工作台</h1>
          <p className="mt-1 text-sm text-slate-500">无名字幕组在线工作台</p>
        </div>

        {resetDone && <Alert variant="success">密码已设置，请使用新密码登录</Alert>}
        {submitError && <Alert variant="error">{submitError}</Alert>}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="loginName">登录名</Label>
            <Input id="loginName" autoComplete="username" {...register('loginName')} />
            {errors.loginName && (
              <p className="mt-1 text-xs text-red-600">{errors.loginName.message}</p>
            )}
          </div>

          <div>
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              {...register('password')}
            />
            {errors.password && (
              <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? '登录中…' : '登录'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
