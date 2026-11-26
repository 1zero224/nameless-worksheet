import { formatFileSize } from '@nw/shared';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FastForward,
  FileUp,
  Loader2,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';
import { cn } from '@/components/ui/primitives.js';
import { type UploadQueueItem, useUploadManager } from '@/uploads/UploadManagerContext.js';

function formatEta(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `剩余 ${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `剩余 ${min} 分 ${rem} 秒`;
  const hr = Math.floor(min / 60);
  return `剩余 ${hr} 小时 ${min % 60} 分`;
}

function UploadQueueRow({ item }: { item: UploadQueueItem }) {
  const {
    cancelItem,
    skipFingerprintAndUpload,
    retryItem,
    resumeWithFile,
    promoteConflictToVersion,
    dismissItem,
  } = useUploadManager();
  const resumeInputRef = useRef<HTMLInputElement | null>(null);

  const handleResumePick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      resumeWithFile(item.id, file);
    }
  };

  return (
    <div
      data-testid={`upload-queue-item-${item.id}`}
      data-upload-status={item.status}
      className="space-y-1.5 border-b border-black/[0.06] px-3 py-2.5 last:border-b-0"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-zinc-900" title={item.filename}>
            {item.filename}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
            <span className="truncate max-w-[160px]" title={item.targetLabel}>
              {item.targetLabel}
            </span>
            <span>·</span>
            <span className="tabular-nums">{formatFileSize(item.sizeBytes)}</span>
            {item.resumed && item.status === 'uploading' && (
              <span className="rounded bg-sky-50 px-1 text-[10px] font-medium text-sky-700">
                已续传
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {item.status === 'completed' ? (
            <button
              type="button"
              aria-label="移除已完成项"
              onClick={() => dismissItem(item.id)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-800 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              data-testid={`upload-cancel-${item.id}`}
              aria-label="取消上传"
              title="取消上传"
              onClick={() => void cancelItem(item.id)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-600 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 指纹计算阶段（A16） */}
      {item.status === 'fingerprinting' && (
        <div className="space-y-1.5" data-testid="upload-stage-fingerprinting">
          <div className="flex items-center justify-between text-[11px] text-zinc-600">
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />
              正在检查续传指纹…
            </span>
            <span className="tabular-nums">
              {formatFileSize(item.fingerprintProcessedBytes)} / {formatFileSize(item.sizeBytes)} (
              {item.fingerprintPercent}%)
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
            <div
              className="h-full rounded-full bg-zinc-700 transition-all duration-150"
              style={{ width: `${item.fingerprintPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              data-testid={`upload-skip-resume-${item.id}`}
              onClick={() => skipFingerprintAndUpload(item.id)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-black/[0.05] hover:text-zinc-950 cursor-pointer"
            >
              <FastForward className="h-3 w-3" />
              跳过续传检查，直接重新上传
            </button>
          </div>
        </div>
      )}

      {/* 上传中 */}
      {item.status === 'uploading' && (
        <div className="space-y-1" data-testid="upload-stage-uploading">
          <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-600">
            <span className="tabular-nums">
              上传中 {item.uploadPercent}% · {formatFileSize(item.bytesUploaded)}
            </span>
            <span className="truncate tabular-nums text-zinc-400">
              {item.speedBps > 0 ? `${formatFileSize(item.speedBps)}/s` : ''}
              {item.etaSec ? ` · ${formatEta(item.etaSec)}` : ''}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
            <div
              className="h-full rounded-full bg-zinc-900 transition-all duration-150"
              style={{ width: `${item.uploadPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* 校验中 */}
      {item.status === 'verifying' && (
        <div
          data-testid="upload-stage-verifying"
          className="flex items-center gap-1.5 text-[11px] text-zinc-600"
        >
          <Loader2 className="h-3 w-3 animate-spin text-zinc-600" />
          <span>校验中：传输已完成，正在服务端校验并保存版本…</span>
        </div>
      )}

      {/* 已保存 */}
      {item.status === 'completed' && (
        <div
          data-testid="upload-stage-completed"
          className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-700"
        >
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          <span>已保存</span>
        </div>
      )}

      {/* 并发补传冲突（409 VERSION_ALREADY_HAS_FILE） */}
      {item.status === 'conflict' && (
        <div
          data-testid="upload-stage-conflict"
          className="space-y-2 rounded-md border border-amber-200 bg-amber-50/70 p-2 text-[11px] text-amber-900"
        >
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <span>
              {item.errorMessage ?? '该版本已由他人上传文件，可将本次已传文件改存为新版本'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid={`upload-promote-${item.id}`}
              onClick={() => void promoteConflictToVersion(item.id)}
              className="rounded-md bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-zinc-800 cursor-pointer"
            >
              改存为新版本
            </button>
            <button
              type="button"
              onClick={() => void cancelItem(item.id)}
              className="rounded-md border border-black/[0.1] bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 cursor-pointer"
            >
              取消释放
            </button>
          </div>
        </div>
      )}

      {/* 刷新中断待续传 */}
      {item.status === 'resumable' && (
        <div
          data-testid="upload-stage-resumable"
          className="space-y-1.5 rounded-md border border-sky-200 bg-sky-50/60 p-2 text-[11px] text-sky-900"
        >
          <div>刷新中断 · 重选原文件继续上传</div>
          {item.errorMessage && <div className="text-red-600">{item.errorMessage}</div>}
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              ref={resumeInputRef}
              type="file"
              data-testid={`upload-resume-input-${item.id}`}
              onChange={handleResumePick}
              className="sr-only"
            />
            <button
              type="button"
              data-testid={`upload-resume-btn-${item.id}`}
              onClick={() => resumeInputRef.current?.click()}
              className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-zinc-800 cursor-pointer"
            >
              <Upload className="h-3 w-3" />
              重选原文件续传
            </button>
            <button
              type="button"
              onClick={() => void cancelItem(item.id)}
              className="rounded-md border border-black/[0.1] bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 cursor-pointer"
            >
              取消会话
            </button>
          </div>
        </div>
      )}

      {/* 错误状态 */}
      {item.status === 'error' && (
        <div
          data-testid="upload-stage-error"
          className="space-y-1.5 rounded-md border border-red-200 bg-red-50/70 p-2 text-[11px] text-red-700"
        >
          <div>{item.errorMessage ?? '上传失败'}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {item.abortFailed ? (
              <button
                type="button"
                data-testid={`upload-retry-cancel-${item.id}`}
                onClick={() => void cancelItem(item.id)}
                className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-700 cursor-pointer"
              >
                <RefreshCw className="h-3 w-3" />
                重试取消
              </button>
            ) : (
              <>
                <button
                  type="button"
                  data-testid={`upload-retry-${item.id}`}
                  onClick={() => retryItem(item.id)}
                  className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-2 py-1 text-[11px] font-medium text-white hover:bg-zinc-800 cursor-pointer"
                >
                  <RefreshCw className="h-3 w-3" />
                  重试
                </button>
                {item.fingerprintStalled && (
                  <button
                    type="button"
                    data-testid={`upload-skip-resume-${item.id}`}
                    onClick={() => skipFingerprintAndUpload(item.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-black/[0.12] bg-white px-2 py-1 text-[11px] font-medium text-zinc-800 hover:bg-zinc-50 cursor-pointer"
                  >
                    <FastForward className="h-3 w-3" />
                    跳过续传检查，直接重新上传
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 全局右下角可折叠上传队列浮窗（跨路由不中断，桌面宽 360px，390×844 手机窄屏贴底全宽零横向溢出）。
 */
export function UploadQueueDock() {
  const { items, clearCompleted } = useUploadManager();
  const [collapsed, setCollapsed] = useState(false);

  if (items.length === 0) return null;

  const activeItems = items.filter(
    (i) => i.status === 'fingerprinting' || i.status === 'uploading' || i.status === 'verifying',
  );
  const completedCount = items.filter((i) => i.status === 'completed').length;
  const resumableCount = items.filter((i) => i.status === 'resumable').length;

  const avgPercent =
    activeItems.length > 0
      ? Math.round(
          activeItems.reduce(
            (sum, i) =>
              sum +
              (i.status === 'fingerprinting'
                ? i.fingerprintPercent
                : i.status === 'verifying'
                  ? 100
                  : i.uploadPercent),
            0,
          ) / activeItems.length,
        )
      : 100;

  const headerText =
    activeItems.length > 0
      ? `上传中 ${activeItems.length}/${items.length} · ${avgPercent}%`
      : resumableCount > 0
        ? `待续传 ${resumableCount} 项`
        : `上传队列（已完成 ${completedCount}/${items.length}）`;

  return (
    <div
      data-testid="upload-queue-dock"
      className={cn(
        'fixed bottom-3 left-3 right-3 z-50 mx-auto max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-black/[0.1] bg-white shadow-lg sm:left-auto sm:right-4 sm:bottom-4 sm:mx-0 sm:w-[360px]',
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] bg-zinc-950 px-3 py-2 text-white">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          data-testid="upload-queue-toggle"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium cursor-pointer"
        >
          <FileUp className="h-3.5 w-3.5 shrink-0 text-white/85" />
          <span className="truncate tabular-nums">{headerText}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {completedCount > 0 && !collapsed && (
            <button
              type="button"
              onClick={clearCompleted}
              className="rounded px-1.5 py-0.5 text-[11px] text-white/75 hover:bg-white/10 hover:text-white cursor-pointer"
            >
              清空已完成
            </button>
          )}
          <button
            type="button"
            aria-label={collapsed ? '展开上传队列' : '折叠上传队列'}
            onClick={() => setCollapsed((v) => !v)}
            className="flex h-6 w-6 items-center justify-center rounded text-white/80 hover:bg-white/10 hover:text-white cursor-pointer"
          >
            {collapsed ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="max-h-[320px] overflow-y-auto bg-white">
          {items.map((item) => (
            <UploadQueueRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
