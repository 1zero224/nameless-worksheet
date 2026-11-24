import { zodResolver } from '@hookform/resolvers/zod';
import { type ResetPreview, resetPasswordBodySchema } from '@nw/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { Alert, Button, Card, Input, Label } from '@/components/ui/primitives.js';

const formSchema = resetPasswordBodySchema
  .extend({
    confirmPassword: z.string({ error: '请再次输入新密码' }).min(1, { error: '请再次输入新密码' }),
  })
  .superRefine((v, ctx) => {
    if (v.password !== v.confirmPassword) {
      ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: '两次输入的密码不一致' });
    }
  });

type ResetForm = z.input<typeof formSchema>;

export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const previewQuery = useQuery<ResetPreview, ApiError>({
    queryKey: queryKeys.resetPreview(token),
    queryFn: () =>
      apiFetch<ResetPreview>(`/api/password-resets/${encodeURIComponent(token)}`, {
        skipAuthRedirect: true,
      }),
    retry: false,
  });

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetForm>({
    resolver: zodResolver(formSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  const onSubmit = async (values: ResetForm) => {
    setSubmitError(null);
    try {
      await apiFetch<void>(`/api/password-resets/${encodeURIComponent(token)}`, {
        method: 'POST',
        body: { password: values.password },
        skipAuthRedirect: true,
      });
      navigate('/login?reset=1', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields?.password) {
          setError('password', { message: err.fields.password });
        }
        setSubmitError(err.message);
      } else {
        setSubmitError('设置密码失败，请稍后再试');
      }
    }
  };

  if (previewQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        正在校验重置链接…
      </div>
    );
  }

  if (previewQuery.isError || !previewQuery.data) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md space-y-3 text-center">
          <h1 className="text-lg font-semibold text-slate-900">链接无效</h1>
          <p className="text-sm text-slate-600">重置链接无效或已过期，请联系管理员重新生成</p>
        </Card>
      </div>
    );
  }

  const preview = previewQuery.data;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">设置新密码</h1>
          <p className="mt-1 text-sm text-slate-600">
            用户：<span className="font-medium text-slate-900">{preview.displayName}</span>
            （登录名：
            <span className="font-mono text-slate-900">{preview.loginName}</span>）
          </p>
        </div>

        {submitError && <Alert variant="error">{submitError}</Alert>}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="password">新密码</Label>
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
            <Label htmlFor="confirmPassword">确认新密码</Label>
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
            {isSubmitting ? '提交中…' : '保存新密码'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
