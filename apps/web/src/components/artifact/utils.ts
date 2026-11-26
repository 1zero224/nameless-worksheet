import { isValidArtifactUrl } from '@nw/shared';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/keys.js';

export function isSafeExternalUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && isValidArtifactUrl(url);
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 回落到 execCommand 复制
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export function invalidateArtifactQueries(
  queryClient: QueryClient,
  opts?: { worksheetId?: string | null; workId?: string | null; taskId?: string | null },
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.docsAll });
  void queryClient.invalidateQueries({ queryKey: queryKeys.docsChangeLogs });
  if (opts?.workId) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workArtifacts(opts.workId) });
  } else {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workArtifactsAll });
  }
  if (opts?.taskId) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskArtifacts(opts.taskId) });
  } else {
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskArtifactsAll });
  }
  if (opts?.worksheetId) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.worksheet(opts.worksheetId) });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.changeLogs(opts.worksheetId, null),
    });
    if (opts.taskId) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.changeLogs(opts.worksheetId, opts.taskId),
      });
    }
  }
  void queryClient.invalidateQueries({ queryKey: queryKeys.board });
  void queryClient.invalidateQueries({ queryKey: queryKeys.myTasks });
}
