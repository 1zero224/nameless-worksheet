import { decodeShortUuid, type TaskLocateResponse } from '@nw/shared';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError, apiFetch } from '@/api/client.js';
import { Button, Card } from '@/components/ui/primitives.js';

/**
 * 无状态任务/工序分享短链落地页：
 * - `/t/:taskCode` -> 定位任务并打开详情
 * - `/t/:taskCode/:stageCode` -> 定位任务并优先弹出该工序资源浮层（移动端降级至详情对应工序卡片）
 */
export function TaskShortLinkPage() {
  const { taskCode = '', stageCode } = useParams<{ taskCode: string; stageCode?: string }>();
  const navigate = useNavigate();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const decoded = useMemo(() => {
    const taskId = decodeShortUuid(taskCode);
    const stageId = stageCode ? decodeShortUuid(stageCode) : null;
    return { taskId, stageId, hasStageParam: Boolean(stageCode) };
  }, [taskCode, stageCode]);

  useEffect(() => {
    if (!decoded.taskId) {
      setErrorMsg('分享链接无效，请检查链接是否完整。');
      return;
    }

    let cancelled = false;
    setErrorMsg(null);

    const query = decoded.stageId ? `?stageId=${encodeURIComponent(decoded.stageId)}` : '';
    apiFetch<TaskLocateResponse>(`/api/tasks/${decoded.taskId}/locate${query}`)
      .then((res) => {
        if (cancelled) return;
        if (res.worksheetPlacement === 'docs') {
          navigate(`/docs?sheetId=${res.worksheetId}&taskId=${res.taskId}`, { replace: true });
          return;
        }
        const params = new URLSearchParams();
        params.set('taskId', res.taskId);
        if (decoded.hasStageParam) {
          if (res.stageColumnId && res.stageExists) {
            params.set('stageId', res.stageColumnId);
            params.set('open', 'resources');
          } else {
            params.set('stageMissing', '1');
          }
        }
        navigate(`/worksheets/${res.worksheetId}?${params.toString()}`, { replace: true });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setErrorMsg('该任务不存在或已被删除。');
        } else {
          setErrorMsg(err instanceof ApiError ? err.message : '定位任务失败，请稍后重试。');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [decoded, navigate]);

  if (errorMsg) {
    return (
      <div
        data-testid="short-link-error"
        className="flex min-h-[60vh] items-center justify-center p-4"
      >
        <Card className="w-full max-w-sm space-y-4 text-center">
          <div className="space-y-1.5">
            <h1 className="text-base font-semibold text-zinc-900">无法打开分享链接</h1>
            <p className="text-sm text-zinc-500">{errorMsg}</p>
          </div>
          <div className="flex justify-center">
            <Button type="button" onClick={() => navigate('/', { replace: true })}>
              返回首页
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center text-sm text-zinc-500">
      正在定位任务…
    </div>
  );
}
