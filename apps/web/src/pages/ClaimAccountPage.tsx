import { zodResolver } from '@hookform/resolvers/zod';
import {
  type ClaimPreview,
  claimCompleteBodySchema,
  type MeResponse,
  ROLE_LABELS,
} from '@nw/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { Alert, Button, Card, Input, Label } from '@/components/ui/primitives.js';

const formSchema = claimCompleteBodySchema
  .extend({
    confirmPassword: z.string({ error: '请再次输入密码' }).min(1, { error: '请再次输入密码' }),
  })
  .superRefine((v, ctx) => {
    if (v.password !== v.confirmPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmPassword'],
        message: '两次输入的密码不一致',
      });
    }
  });

type ClaimForm = z.input<typeof formSchema>;

export function ClaimAccountPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const previewQuery = useQuery<ClaimPreview, ApiError>({
    queryKey: queryKeys.claimPreview(token),
    queryFn: () =>
      apiFetch<ClaimPreview>(`/api/account-claims/${encodeURIComponent(token)}`, {
        skipAuthRedirect: true,
      }),
    retry: false,
  });

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ClaimForm>({
    resolver: zodResolver(formSchema),
    defaultValues: { loginName: '', displayName: '', password: '', confirmPassword: '' },
  });

  useEffect(() => {
    if (previewQuery.data?.displayName) {
      setValue('displayName', previewQuery.data.displayName);
    }
  }, [previewQuery.data?.displayName, setValue]);

  const onSubmit = async (values: ClaimForm) => {
    setSubmitError(null);
    try {
      const me = await apiFetch<MeResponse>(
        `/api/account-claims/${encodeURIComponent(token)}/complete`,
        {
          method: 'POST',
          body: {
            loginName: values.loginName,
            ...(values.displayName?.trim() ? { displayName: values.displayName.trim() } : {}),
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
        setSubmitError('认领失败，请稍后再试');
      }
    }
  };

  if (previewQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        正在校验认领链接…
      </div>
    );
  }

  if (previewQuery.isError || !previewQuery.data) {
    return (
      <div
        data-testid="claim-invalid-card"
        className="flex min-h-screen items-center justify-center p-4"
      >
        <Card className="w-full max-w-md space-y-3 text-center">
          <h1 className="text-lg font-semibold text-slate-900">认领链接无效</h1>
          <p className="text-sm text-slate-600">认领链接无效或已过期，请联系管理员</p>
        </Card>
      </div>
    );
  }

  const preview = previewQuery.data;

  return (
    <div
      data-testid="claim-account-card"
      className="flex min-h-screen items-center justify-center p-4"
    >
      <Card className="w-full max-w-md space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            欢迎认领你的账号 · {preview.projectName}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            角色：<span className="font-medium text-slate-900">{ROLE_LABELS[preview.role]}</span> ·
            认领完成后，你的全部历史与进行中任务将立即可见。
          </p>
        </div>

        {submitError && <Alert variant="error">{submitError}</Alert>}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="claim-displayName">显示名</Label>
            <Input id="claim-displayName" {...register('displayName')} />
            <p className="mt-1 text-xs text-slate-500">
              已按原工作表为你预填显示名，可保持不变或微调
            </p>
            {errors.displayName && (
              <p className="mt-1 text-xs text-red-600">{errors.displayName.message}</p>
            )}
          </div>

          <div>
            <Label htmlFor="claim-loginName">登录名</Label>
            <Input
              id="claim-loginName"
              autoComplete="username"
              autoFocus
              {...register('loginName')}
            />
            <p className="mt-1 text-xs text-slate-500">
              3–32 位小写字母、数字或下划线，设置后不可修改
            </p>
            {errors.loginName && (
              <p className="mt-1 text-xs text-red-600">{errors.loginName.message}</p>
            )}
          </div>

          <div>
            <Label htmlFor="claim-password">密码</Label>
            <Input
              id="claim-password"
              type="password"
              autoComplete="new-password"
              {...register('password')}
            />
            <p className="mt-1 text-xs text-slate-500">至少 8 位字符，且不能与登录名相同</p>
            {errors.password && (
              <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>
            )}
          </div>

          <div>
            <Label htmlFor="claim-confirmPassword">确认密码</Label>
            <Input
              id="claim-confirmPassword"
              type="password"
              autoComplete="new-password"
              {...register('confirmPassword')}
            />
            {errors.confirmPassword && (
              <p className="mt-1 text-xs text-red-600">{errors.confirmPassword.message}</p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? '认领中…' : '完成认领并登录'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
