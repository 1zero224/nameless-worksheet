import type {
  FingerprintWorkerRequest,
  FingerprintWorkerResponse,
} from '@/workers/fingerprint.worker.js';

export const DEFAULT_FINGERPRINT_STALL_TIMEOUT_MS = 15_000;
export const DEFAULT_FINGERPRINT_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB

export type FingerprintErrorCode = 'ABORTED' | 'STALL_TIMEOUT' | 'ERROR';

export class FingerprintError extends Error {
  constructor(
    readonly code: FingerprintErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FingerprintError';
  }
}

export interface FingerprintProgress {
  processedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface WorkerLike {
  onmessage: ((ev: MessageEvent<FingerprintWorkerResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: FingerprintWorkerRequest): void;
  terminate(): void;
}

export interface ComputeFingerprintOptions {
  signal?: AbortSignal;
  onProgress?: (progress: FingerprintProgress) => void;
  stallTimeoutMs?: number;
  chunkSizeBytes?: number;
  workerFactory?: () => WorkerLike;
}

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL('../workers/fingerprint.worker.ts', import.meta.url), {
    type: 'module',
  });
}

/**
 * 在独立 Web Worker 中按 4 MiB 分块流式计算文件 SHA-256 指纹：
 * - 不阻塞主线程、不将整文件读入内存；
 * - 实时回调进度；
 * - 支持 AbortSignal 随时取消并立即 terminate Worker；
 * - 内置 15 秒无进展卡顿看门狗，超时立即终止并返回明确错误。
 */
export function computeFileFingerprint(
  file: Blob,
  opts: ComputeFingerprintOptions = {},
): Promise<string> {
  const {
    signal,
    onProgress,
    stallTimeoutMs = DEFAULT_FINGERPRINT_STALL_TIMEOUT_MS,
    chunkSizeBytes = DEFAULT_FINGERPRINT_CHUNK_BYTES,
    workerFactory = defaultWorkerFactory,
  } = opts;

  if (signal?.aborted) {
    return Promise.reject(new FingerprintError('ABORTED', '已取消文件指纹计算'));
  }

  return new Promise<string>((resolve, reject) => {
    const worker = workerFactory();
    let settled = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
    };

    const fail = (err: FingerprintError) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        worker.terminate();
      } catch {
        // ignore terminate failure
      }
      reject(err);
    };

    const succeed = (sha256: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        worker.terminate();
      } catch {
        // ignore terminate failure
      }
      resolve(sha256);
    };

    const resetStallTimer = () => {
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        fail(
          new FingerprintError(
            'STALL_TIMEOUT',
            '读取本地文件超时，可能磁盘休眠或被占用，可重试或跳过续传检查直接上传',
          ),
        );
      }, stallTimeoutMs);
    };

    const onAbort = () => {
      fail(new FingerprintError('ABORTED', '已取消文件指纹计算'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (ev: MessageEvent<FingerprintWorkerResponse>) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === 'progress') {
        resetStallTimer();
        const percent =
          msg.totalBytes > 0
            ? Math.min(100, Math.round((msg.processedBytes / msg.totalBytes) * 100))
            : 100;
        onProgress?.({
          processedBytes: msg.processedBytes,
          totalBytes: msg.totalBytes,
          percent,
        });
      } else if (msg.type === 'done') {
        succeed(msg.sha256);
      } else if (msg.type === 'error') {
        fail(new FingerprintError('ERROR', msg.message || '读取本地文件失败'));
      }
    };

    worker.onerror = (ev: ErrorEvent) => {
      fail(new FingerprintError('ERROR', ev.message || '指纹计算线程发生异常'));
    };

    resetStallTimer();
    worker.postMessage({ type: 'hash', file, chunkSizeBytes });
  });
}
