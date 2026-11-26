/// <reference lib="webworker" />
import { createSHA256 } from 'hash-wasm';

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB

export interface FingerprintWorkerRequest {
  type: 'hash';
  file: Blob;
  chunkSizeBytes?: number;
}

export type FingerprintWorkerResponse =
  | { type: 'progress'; processedBytes: number; totalBytes: number }
  | { type: 'done'; sha256: string }
  | { type: 'error'; message: string };

self.onmessage = async (event: MessageEvent<FingerprintWorkerRequest>) => {
  const msg = event.data;
  if (!msg || msg.type !== 'hash') return;

  try {
    const file = msg.file;
    const chunkSize = msg.chunkSizeBytes ?? DEFAULT_CHUNK_BYTES;
    const totalBytes = file.size;
    const hasher = await createSHA256();
    hasher.init();

    let offset = 0;
    while (offset < totalBytes) {
      const end = Math.min(offset + chunkSize, totalBytes);
      const buf = await file.slice(offset, end).arrayBuffer();
      hasher.update(new Uint8Array(buf));
      offset = end;

      const progressMsg: FingerprintWorkerResponse = {
        type: 'progress',
        processedBytes: offset,
        totalBytes,
      };
      self.postMessage(progressMsg);
    }

    const doneMsg: FingerprintWorkerResponse = {
      type: 'done',
      sha256: hasher.digest('hex'),
    };
    self.postMessage(doneMsg);
  } catch (err) {
    const errMsg: FingerprintWorkerResponse = {
      type: 'error',
      message: err instanceof Error ? err.message : '读取本地文件失败',
    };
    self.postMessage(errMsg);
  }
};
