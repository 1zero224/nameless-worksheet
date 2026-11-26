import { describe, expect, it, vi } from 'vitest';
import type {
  FingerprintWorkerRequest,
  FingerprintWorkerResponse,
} from '@/workers/fingerprint.worker.js';
import { computeFileFingerprint, type FingerprintError, type WorkerLike } from './fingerprint.js';

function createMockWorker() {
  const terminated = vi.fn();
  const posted: FingerprintWorkerRequest[] = [];
  const worker: WorkerLike & {
    emit: (msg: FingerprintWorkerResponse) => void;
    terminated: typeof terminated;
    posted: FingerprintWorkerRequest[];
  } = {
    onmessage: null,
    onerror: null,
    posted,
    terminated,
    postMessage(msg) {
      posted.push(msg);
    },
    terminate() {
      terminated();
    },
    emit(msg) {
      worker.onmessage?.({ data: msg } as MessageEvent<FingerprintWorkerResponse>);
    },
  };
  return worker;
}

describe('T7 computeFileFingerprint（进度、取消中止与卡顿超时）', () => {
  it('按分块回报实时进度并在完成后返回 SHA-256 且终止 Worker', async () => {
    const mock = createMockWorker();
    const progressEvents: Array<{ processedBytes: number; percent: number }> = [];
    const blob = new Blob([new Uint8Array(100)]);

    const promise = computeFileFingerprint(blob, {
      stallTimeoutMs: 5_000,
      workerFactory: () => mock,
      onProgress: (p) =>
        progressEvents.push({ processedBytes: p.processedBytes, percent: p.percent }),
    });

    expect(mock.posted).toHaveLength(1);
    mock.emit({ type: 'progress', processedBytes: 50, totalBytes: 100 });
    mock.emit({ type: 'progress', processedBytes: 100, totalBytes: 100 });
    mock.emit({ type: 'done', sha256: 'a'.repeat(64) });

    const hash = await promise;
    expect(hash).toBe('a'.repeat(64));
    expect(progressEvents).toEqual([
      { processedBytes: 50, percent: 50 },
      { processedBytes: 100, percent: 100 },
    ]);
    expect(mock.terminated).toHaveBeenCalledTimes(1);
  });

  it('取消 AbortSignal 时立即中止 Worker 并抛出 ABORTED', async () => {
    const mock = createMockWorker();
    const ac = new AbortController();
    const blob = new Blob([new Uint8Array(100)]);

    const promise = computeFileFingerprint(blob, {
      signal: ac.signal,
      stallTimeoutMs: 5_000,
      workerFactory: () => mock,
    });

    ac.abort();
    await expect(promise).rejects.toMatchObject({
      name: 'FingerprintError',
      code: 'ABORTED',
    } satisfies Partial<FingerprintError>);
    expect(mock.terminated).toHaveBeenCalledTimes(1);
  });

  it('读盘无进展超过 stallTimeoutMs 时立即终止 Worker 并抛出 STALL_TIMEOUT', async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockWorker();
      const blob = new Blob([new Uint8Array(100)]);

      const promise = computeFileFingerprint(blob, {
        stallTimeoutMs: 15_000,
        workerFactory: () => mock,
      });

      // 前 10 秒有一次进展 -> 看门狗重置，不应超时
      vi.advanceTimersByTime(10_000);
      mock.emit({ type: 'progress', processedBytes: 25, totalBytes: 100 });
      expect(mock.terminated).not.toHaveBeenCalled();

      // 之后 15 秒无新进展 -> 触发 STALL_TIMEOUT
      vi.advanceTimersByTime(15_001);
      await expect(promise).rejects.toMatchObject({
        name: 'FingerprintError',
        code: 'STALL_TIMEOUT',
      } satisfies Partial<FingerprintError>);
      expect(mock.terminated).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
