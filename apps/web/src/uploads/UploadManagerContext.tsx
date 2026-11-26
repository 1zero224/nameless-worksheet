import {
  type ArtifactScope,
  type CompleteUploadResponse,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MULTIPART_THRESHOLD_BYTES,
  DEFAULT_PART_SIZE_BYTES,
  DEFAULT_UPLOAD_CONCURRENCY,
  type ListUploadPartsResponse,
  type SignUploadPartResponse,
  TEXT_PREVIEW_MAX_BYTES,
  type UploadConfigResponse,
  type UploadSessionDetail,
  type UploadSessionInitResponse,
  type UploadSessionMode,
} from '@nw/shared';
import { useQueryClient } from '@tanstack/react-query';
import AwsS3, { type AwsBody } from '@uppy/aws-s3';
import Uppy, { type Meta, type UppyFile } from '@uppy/core';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { invalidateArtifactQueries } from '@/components/artifact/utils.js';
import { useToast } from '@/components/ui/overlays.js';
import { computeFileFingerprint, FingerprintError } from '@/uploads/fingerprint.js';
import {
  loadResumableRecords,
  type ResumableUploadRecord,
  removeResumableRecord,
  saveResumableRecord,
} from '@/uploads/resumable-store.js';

export type QueueItemStatus =
  | 'fingerprinting'
  | 'uploading'
  | 'verifying'
  | 'completed'
  | 'conflict'
  | 'error'
  | 'resumable';

export interface UploadTargetRequest {
  mode: UploadSessionMode;
  scope?: ArtifactScope;
  name?: string;
  versionNote?: string;
  artifactId?: string;
  versionId?: string;
  worksheetId?: string | null;
  workId?: string | null;
  taskId?: string | null;
  targetLabel: string;
}

export interface EnqueueUploadInput {
  file: File;
  target: UploadTargetRequest;
  skipResume?: boolean;
}

export interface UploadQueueItem {
  id: string;
  uppyFileId: string | null;
  sessionId: string | null;
  mode: UploadSessionMode;
  targetLabel: string;
  filename: string;
  sizeBytes: number;
  status: QueueItemStatus;
  fingerprintProcessedBytes: number;
  fingerprintPercent: number;
  fingerprintStalled: boolean;
  bytesUploaded: number;
  uploadPercent: number;
  speedBps: number;
  etaSec: number | null;
  resumed: boolean;
  errorMessage: string | null;
  abortFailed: boolean;
  canPromoteToVersion: boolean;
  target: UploadTargetRequest;
  resumableRecord?: ResumableUploadRecord;
}

interface ActiveSessionMeta {
  itemId: string;
  sessionId: string;
  isMultipart: boolean;
  partSizeBytes: number | null;
  mimeType: string;
  singlePutUrl?: string;
  target: UploadTargetRequest;
  completed?: boolean;
}

type UploadMeta = Meta & {
  itemId?: string;
};

interface UploadManagerContextValue {
  config: UploadConfigResponse;
  items: UploadQueueItem[];
  hasActiveUploads: boolean;
  enqueueUpload: (input: EnqueueUploadInput) => void;
  cancelItem: (itemId: string) => Promise<void>;
  skipFingerprintAndUpload: (itemId: string) => void;
  retryItem: (itemId: string) => void;
  resumeWithFile: (itemId: string, file: File) => void;
  promoteConflictToVersion: (itemId: string) => Promise<void>;
  dismissItem: (itemId: string) => void;
  clearCompleted: () => void;
}

const DEFAULT_CONFIG: UploadConfigResponse = {
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  multipartThresholdBytes: DEFAULT_MULTIPART_THRESHOLD_BYTES,
  partSizeBytes: DEFAULT_PART_SIZE_BYTES,
  concurrency: DEFAULT_UPLOAD_CONCURRENCY,
  textPreviewMaxBytes: TEXT_PREVIEW_MAX_BYTES,
};

const UploadManagerContext = createContext<UploadManagerContextValue | null>(null);

function makeLocalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `up-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function UploadManagerProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [config, setConfig] = useState<UploadConfigResponse>(DEFAULT_CONFIG);
  const configRef = useRef<UploadConfigResponse>(DEFAULT_CONFIG);
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const itemsRef = useRef<UploadQueueItem[]>([]);

  // 内存映射：队列项 -> File / 指纹 AbortController / 速度采样 / Uppy 会话元数据
  const filesRef = useRef(new Map<string, File>());
  const fpControllersRef = useRef(new Map<string, AbortController>());
  const sessionMetaByFileIdRef = useRef(new Map<string, ActiveSessionMeta>());
  const speedTrackerRef = useRef(
    new Map<string, { lastBytes: number; lastTs: number; emaBps: number }>(),
  );

  const updateItems = useCallback((updater: (prev: UploadQueueItem[]) => UploadQueueItem[]) => {
    setItems((prev) => {
      const next = updater(prev);
      itemsRef.current = next;
      return next;
    });
  }, []);

  const patchItem = useCallback(
    (itemId: string, patch: Partial<UploadQueueItem>) => {
      updateItems((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
      );
    },
    [updateItems],
  );

  // 拉取服务端真实上传配置 + 从 localStorage 恢复未过期分片断点
  useEffect(() => {
    if (!active) {
      updateItems(() => []);
      return;
    }

    let cancelled = false;
    apiFetch<UploadConfigResponse>('/api/uploads/config', { skipAuthRedirect: true })
      .then((cfg) => {
        if (cancelled) return;
        configRef.current = cfg;
        setConfig(cfg);
      })
      .catch(() => {
        // 保持默认配置兜底
      });

    const saved = loadResumableRecords();
    if (saved.length > 0) {
      updateItems((prev) => {
        const existingSessionIds = new Set(prev.map((p) => p.sessionId).filter(Boolean));
        const restored: UploadQueueItem[] = saved
          .filter((rec) => !existingSessionIds.has(rec.sessionId))
          .map((rec) => ({
            id: `resume-${rec.sessionId}`,
            uppyFileId: null,
            sessionId: rec.sessionId,
            mode: rec.mode,
            targetLabel: rec.targetLabel,
            filename: rec.originalFilename,
            sizeBytes: rec.sizeBytes,
            status: 'resumable',
            fingerprintProcessedBytes: 0,
            fingerprintPercent: 0,
            fingerprintStalled: false,
            bytesUploaded: 0,
            uploadPercent: 0,
            speedBps: 0,
            etaSec: null,
            resumed: true,
            errorMessage: null,
            abortFailed: false,
            canPromoteToVersion: false,
            target: {
              mode: rec.mode,
              scope: rec.scope,
              name: rec.artifactName,
              versionNote: rec.versionNote,
              artifactId: rec.artifactId,
              versionId: rec.versionId,
              worksheetId: rec.worksheetId,
              workId: rec.workId,
              taskId: rec.taskId,
              targetLabel: rec.targetLabel,
            },
            resumableRecord: rec,
          }));
        return restored.length > 0 ? [...prev, ...restored] : prev;
      });
    }

    return () => {
      cancelled = true;
    };
  }, [active, updateItems]);

  // 服务端完成提交（单次 PUT 与分片共用）
  const finalizeSessionOnServer = useCallback(
    async (meta: ActiveSessionMeta): Promise<void> => {
      if (meta.completed) return;
      patchItem(meta.itemId, {
        status: 'verifying',
        uploadPercent: 100,
        speedBps: 0,
        etaSec: null,
        errorMessage: null,
      });

      try {
        const done = await apiFetch<CompleteUploadResponse>(
          `/api/uploads/sessions/${meta.sessionId}/complete`,
          { method: 'POST', body: {} },
        );
        meta.completed = true;
        removeResumableRecord(meta.sessionId);
        filesRef.current.delete(meta.itemId);
        speedTrackerRef.current.delete(meta.itemId);

        patchItem(meta.itemId, {
          status: 'completed',
          bytesUploaded: done.artifact.latestVersion?.sizeBytes ?? 0,
          uploadPercent: 100,
          errorMessage: null,
          canPromoteToVersion: false,
        });

        invalidateArtifactQueries(queryClient, {
          worksheetId: done.artifact.worksheetId ?? meta.target.worksheetId ?? null,
          workId: done.artifact.workId ?? meta.target.workId ?? null,
          taskId: done.artifact.taskId ?? meta.target.taskId ?? null,
        });
        pushToast({
          message: `已保存「${done.artifact.name}」`,
          variant: 'success',
        });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'VERSION_ALREADY_HAS_FILE') {
          meta.completed = true;
          patchItem(meta.itemId, {
            status: 'conflict',
            canPromoteToVersion: true,
            errorMessage: err.message,
          });
          return;
        }
        const message = err instanceof Error ? err.message : '服务端校验失败，请重试';
        patchItem(meta.itemId, {
          status: 'error',
          errorMessage: message,
        });
        throw err;
      }
    },
    [patchItem, pushToast, queryClient],
  );

  // 初始化 Headless Uppy + AwsS3 插件（严禁引入 @uppy/dashboard）
  const uppyRef = useRef<Uppy<UploadMeta, AwsBody> | null>(null);
  const finalizeRef = useRef(finalizeSessionOnServer);
  finalizeRef.current = finalizeSessionOnServer;

  if (!uppyRef.current) {
    const uppy = new Uppy<UploadMeta, AwsBody>({
      id: 'nw-r2-uploader',
      autoProceed: false,
      allowMultipleUploadBatches: true,
    });

    uppy.use(AwsS3, {
      limit: DEFAULT_UPLOAD_CONCURRENCY,
      retryDelays: [500, 1500, 3000, 5000],
      shouldUseMultipart: (file) => {
        const meta = sessionMetaByFileIdRef.current.get(file.id);
        return Boolean(meta?.isMultipart);
      },
      getChunkSize: (file: { size: number }) => {
        // 查找对应文件会话的 partSizeBytes
        for (const meta of sessionMetaByFileIdRef.current.values()) {
          if (meta.partSizeBytes) return meta.partSizeBytes;
        }
        return Math.max(configRef.current.partSizeBytes, Math.ceil(file.size / 10_000));
      },
      getUploadParameters: async (file) => {
        const meta = sessionMetaByFileIdRef.current.get(file.id);
        if (!meta?.singlePutUrl) {
          throw new Error('缺少单次上传签名地址');
        }
        return {
          method: 'PUT',
          url: meta.singlePutUrl,
          headers: {
            'Content-Type': meta.mimeType,
          },
        };
      },
      createMultipartUpload: async (file) => {
        const meta = sessionMetaByFileIdRef.current.get(file.id);
        if (!meta) throw new Error('上传会话未初始化');
        return {
          uploadId: meta.sessionId,
          key: meta.sessionId,
        };
      },
      listParts: async (_file, { uploadId }) => {
        const res = await apiFetch<ListUploadPartsResponse>(
          `/api/uploads/sessions/${uploadId}/parts`,
        );
        return res.parts.map((p) => ({
          PartNumber: p.partNumber,
          Size: p.size,
          ETag: p.etag,
        }));
      },
      signPart: async (_file, { uploadId, partNumber, body }) => {
        const res = await apiFetch<SignUploadPartResponse>(
          `/api/uploads/sessions/${uploadId}/parts/${partNumber}/sign`,
          {
            method: 'POST',
            body: { contentLength: body.size },
          },
        );
        return {
          method: 'PUT',
          url: res.url,
        };
      },
      completeMultipartUpload: async (file) => {
        const meta = sessionMetaByFileIdRef.current.get(file.id);
        if (!meta) throw new Error('上传会话未找到');
        await finalizeRef.current(meta);
        return { location: '' };
      },
      abortMultipartUpload: async () => {
        // 取消由 cancelItem 显式调用 POST /api/uploads/sessions/:id/abort 并反馈失败重试
      },
    });

    uppy.on('upload-progress', (file, progress) => {
      if (!file) return;
      const meta = sessionMetaByFileIdRef.current.get(file.id);
      if (!meta) return;
      const total = progress.bytesTotal || file.size || 0;
      const uploaded = Math.min(total, progress.bytesUploaded);
      const now = Date.now();
      const tracker = speedTrackerRef.current.get(meta.itemId) ?? {
        lastBytes: uploaded,
        lastTs: now,
        emaBps: 0,
      };
      const dtSec = (now - tracker.lastTs) / 1000;
      let speedBps = tracker.emaBps;
      if (dtSec >= 0.35) {
        const inst = Math.max(0, (uploaded - tracker.lastBytes) / dtSec);
        speedBps = tracker.emaBps > 0 ? tracker.emaBps * 0.65 + inst * 0.35 : inst;
        speedTrackerRef.current.set(meta.itemId, {
          lastBytes: uploaded,
          lastTs: now,
          emaBps: speedBps,
        });
      }
      const remaining = Math.max(0, total - uploaded);
      const etaSec = speedBps > 1 ? Math.ceil(remaining / speedBps) : null;
      const pct = total > 0 ? Math.min(99, Math.round((uploaded / total) * 100)) : 0;

      patchItem(meta.itemId, {
        status: 'uploading',
        bytesUploaded: uploaded,
        uploadPercent: pct,
        speedBps,
        etaSec,
      });
    });

    uppy.on('upload-success', (file) => {
      if (!file) return;
      const meta = sessionMetaByFileIdRef.current.get(file.id);
      if (!meta) return;
      if (!meta.isMultipart && !meta.completed) {
        void finalizeRef.current(meta).catch(() => {
          // 错误已记录在 queue item 上
        });
      }
    });

    uppy.on('upload-error', (file, error) => {
      if (!file) return;
      const meta = sessionMetaByFileIdRef.current.get(file.id);
      if (!meta) return;
      // 若已进入 conflict（409 VERSION_ALREADY_HAS_FILE），不要覆盖 conflict 状态
      const current = itemsRef.current.find((i) => i.id === meta.itemId);
      if (current?.status === 'conflict' || current?.status === 'completed') {
        return;
      }
      patchItem(meta.itemId, {
        status: 'error',
        speedBps: 0,
        etaSec: null,
        errorMessage: error?.message || '上传失败，请重试',
      });
    });

    uppyRef.current = uppy;
  }

  // 同步服务端并发数配置到 AwsS3 插件
  useEffect(() => {
    const plugin = uppyRef.current?.getPlugin('AwsS3');
    if (plugin && typeof plugin.setOptions === 'function') {
      plugin.setOptions({ limit: config.concurrency });
    }
  }, [config.concurrency]);

  // 销毁 Uppy
  useEffect(() => {
    return () => {
      for (const ctrl of fpControllersRef.current.values()) {
        ctrl.abort();
      }
      fpControllersRef.current.clear();
      uppyRef.current?.destroy();
      uppyRef.current = null;
    };
  }, []);

  // 启动一次真实传输（从 session 初始化之后进入 Uppy）
  const startUppyTransfer = useCallback(
    (
      itemId: string,
      file: File,
      init: UploadSessionInitResponse,
      target: UploadTargetRequest,
      fingerprintSha256: string | null,
    ) => {
      const uppy = uppyRef.current;
      if (!uppy) return;

      if (init.isMultipart) {
        saveResumableRecord({
          sessionId: init.sessionId,
          mode: init.mode,
          targetLabel: target.targetLabel,
          artifactName: target.name,
          versionNote: target.versionNote,
          scope: target.scope,
          artifactId: target.artifactId,
          versionId: target.versionId,
          worksheetId: target.worksheetId,
          workId: target.workId,
          taskId: target.taskId,
          originalFilename: init.originalFilename,
          sizeBytes: file.size,
          mimeType: init.mimeType,
          fingerprintSha256,
          expiresAt: init.expiresAt,
          createdAt: new Date().toISOString(),
        });
      }

      const uploadedAlready = (init.uploadedParts ?? []).reduce((sum, p) => sum + p.size, 0);
      const initialPct =
        file.size > 0 ? Math.min(99, Math.round((uploadedAlready / file.size) * 100)) : 0;

      const uppyFileId = uppy.addFile({
        name: file.name,
        type: init.mimeType,
        data: file,
        meta: { itemId },
      });

      sessionMetaByFileIdRef.current.set(uppyFileId, {
        itemId,
        sessionId: init.sessionId,
        isMultipart: init.isMultipart,
        partSizeBytes: init.partSizeBytes,
        mimeType: init.mimeType,
        singlePutUrl: init.singlePutUrl,
        target,
      });

      speedTrackerRef.current.set(itemId, {
        lastBytes: uploadedAlready,
        lastTs: Date.now(),
        emaBps: 0,
      });

      if (init.isMultipart && init.resumed) {
        uppy.setFileState(uppyFileId, {
          s3Multipart: {
            uploadId: init.sessionId,
            key: init.sessionId,
          },
        } as unknown as Partial<UppyFile<UploadMeta, AwsBody>>);
      }

      patchItem(itemId, {
        uppyFileId,
        sessionId: init.sessionId,
        status: 'uploading',
        resumed: init.resumed,
        bytesUploaded: uploadedAlready,
        uploadPercent: initialPct,
        fingerprintStalled: false,
        errorMessage: null,
        abortFailed: false,
      });

      void uppy.upload();
    },
    [patchItem],
  );

  // 完整执行流程（指纹 -> 创建/复用会话 -> Uppy 传输）
  const runUploadFlow = useCallback(
    async (itemId: string, file: File, target: UploadTargetRequest, skipResume: boolean) => {
      const cfg = configRef.current;
      let fingerprintSha256: string | null = null;

      if (file.size > cfg.multipartThresholdBytes && !skipResume) {
        const controller = new AbortController();
        fpControllersRef.current.set(itemId, controller);
        patchItem(itemId, {
          status: 'fingerprinting',
          fingerprintProcessedBytes: 0,
          fingerprintPercent: 0,
          fingerprintStalled: false,
          errorMessage: null,
        });

        try {
          fingerprintSha256 = await computeFileFingerprint(file, {
            signal: controller.signal,
            onProgress: (p) => {
              patchItem(itemId, {
                fingerprintProcessedBytes: p.processedBytes,
                fingerprintPercent: p.percent,
              });
            },
          });
        } catch (err) {
          fpControllersRef.current.delete(itemId);
          if (err instanceof FingerprintError && err.code === 'ABORTED') {
            return;
          }
          const stalled = err instanceof FingerprintError && err.code === 'STALL_TIMEOUT';
          patchItem(itemId, {
            status: 'error',
            fingerprintStalled: stalled,
            errorMessage: err instanceof Error ? err.message : '计算文件指纹失败',
          });
          return;
        } finally {
          fpControllersRef.current.delete(itemId);
        }
      }

      // 创建或复用服务端上传会话
      patchItem(itemId, { status: 'uploading', errorMessage: null, fingerprintStalled: false });
      try {
        const basePayload = {
          filename: file.name,
          sizeBytes: file.size,
          mimeType: file.type || null,
          fingerprintSha256,
          skipResume,
          idempotencyKey: `nw-${makeLocalId()}`,
        };

        let body: Record<string, unknown>;
        if (target.mode === 'create_artifact') {
          body = {
            mode: 'create_artifact',
            scope: target.scope,
            name: target.name,
            ...(target.versionNote ? { versionNote: target.versionNote } : {}),
            ...basePayload,
          };
        } else if (target.mode === 'create_version') {
          body = {
            mode: 'create_version',
            artifactId: target.artifactId,
            ...(target.versionNote ? { versionNote: target.versionNote } : {}),
            ...basePayload,
          };
        } else {
          body = {
            mode: 'attach_version',
            versionId: target.versionId,
            ...basePayload,
          };
        }

        const init = await apiFetch<UploadSessionInitResponse>('/api/uploads/sessions', {
          method: 'POST',
          body,
        });
        startUppyTransfer(itemId, file, init, target, fingerprintSha256);
      } catch (err) {
        patchItem(itemId, {
          status: 'error',
          errorMessage: err instanceof ApiError ? err.message : '初始化上传会话失败',
        });
      }
    },
    [patchItem, startUppyTransfer],
  );

  const enqueueUpload = useCallback(
    ({ file, target, skipResume = false }: EnqueueUploadInput) => {
      const cfg = configRef.current;
      if (file.size <= 0) {
        pushToast({ message: '不支持上传 0 字节空文件', variant: 'error' });
        return;
      }
      if (file.size > cfg.maxFileBytes) {
        pushToast({ message: '文件超过体积上限，请改用网盘链接', variant: 'error' });
        return;
      }

      const id = makeLocalId();
      filesRef.current.set(id, file);

      const initialStatus: QueueItemStatus =
        file.size > cfg.multipartThresholdBytes && !skipResume ? 'fingerprinting' : 'uploading';

      const newItem: UploadQueueItem = {
        id,
        uppyFileId: null,
        sessionId: null,
        mode: target.mode,
        targetLabel: target.targetLabel,
        filename: file.name,
        sizeBytes: file.size,
        status: initialStatus,
        fingerprintProcessedBytes: 0,
        fingerprintPercent: 0,
        fingerprintStalled: false,
        bytesUploaded: 0,
        uploadPercent: 0,
        speedBps: 0,
        etaSec: null,
        resumed: false,
        errorMessage: null,
        abortFailed: false,
        canPromoteToVersion: false,
        target,
      };

      updateItems((prev) => [newItem, ...prev]);
      void runUploadFlow(id, file, target, skipResume);
    },
    [pushToast, runUploadFlow, updateItems],
  );

  const skipFingerprintAndUpload = useCallback(
    (itemId: string) => {
      const ctrl = fpControllersRef.current.get(itemId);
      if (ctrl) {
        ctrl.abort();
        fpControllersRef.current.delete(itemId);
      }
      const item = itemsRef.current.find((i) => i.id === itemId);
      const file = filesRef.current.get(itemId);
      if (!item || !file) return;
      void runUploadFlow(itemId, file, item.target, true);
    },
    [runUploadFlow],
  );

  const retryItem = useCallback(
    (itemId: string) => {
      const item = itemsRef.current.find((i) => i.id === itemId);
      if (!item) return;

      // 若是 Uppy 分片/单次上传中途失败且已有 sessionId，优先尝试 Uppy 原地重试
      if (item.uppyFileId && item.sessionId && uppyRef.current?.getFile(item.uppyFileId)) {
        const meta = sessionMetaByFileIdRef.current.get(item.uppyFileId);
        if (meta && !meta.completed) {
          patchItem(itemId, { status: 'uploading', errorMessage: null });
          void uppyRef.current.retryUpload(item.uppyFileId);
          return;
        }
      }

      const file = filesRef.current.get(itemId);
      if (!file) {
        pushToast({ message: '请重新选择本地文件以继续上传', variant: 'info' });
        return;
      }
      void runUploadFlow(itemId, file, item.target, false);
    },
    [patchItem, pushToast, runUploadFlow],
  );

  const resumeWithFile = useCallback(
    async (itemId: string, file: File) => {
      const item = itemsRef.current.find((i) => i.id === itemId);
      const rec = item?.resumableRecord;
      if (!item || !rec) return;

      if (file.size !== rec.sizeBytes) {
        patchItem(itemId, {
          errorMessage: '所选文件大小与中断前不一致，请重新选择原文件',
        });
        pushToast({ message: '所选文件大小与中断前不一致', variant: 'error' });
        return;
      }

      filesRef.current.set(itemId, file);

      // 计算指纹核对（避免大小相同但内容不同的文件误恢复）
      const controller = new AbortController();
      fpControllersRef.current.set(itemId, controller);
      patchItem(itemId, {
        status: 'fingerprinting',
        fingerprintProcessedBytes: 0,
        fingerprintPercent: 0,
        fingerprintStalled: false,
        errorMessage: null,
      });

      let computedSha256: string;
      try {
        computedSha256 = await computeFileFingerprint(file, {
          signal: controller.signal,
          onProgress: (p) => {
            patchItem(itemId, {
              fingerprintProcessedBytes: p.processedBytes,
              fingerprintPercent: p.percent,
            });
          },
        });
      } catch (err) {
        fpControllersRef.current.delete(itemId);
        if (err instanceof FingerprintError && err.code === 'ABORTED') return;
        const stalled = err instanceof FingerprintError && err.code === 'STALL_TIMEOUT';
        patchItem(itemId, {
          status: 'resumable',
          fingerprintStalled: stalled,
          errorMessage: err instanceof Error ? err.message : '计算文件指纹失败',
        });
        return;
      } finally {
        fpControllersRef.current.delete(itemId);
      }

      if (rec.fingerprintSha256 && computedSha256 !== rec.fingerprintSha256) {
        patchItem(itemId, {
          status: 'resumable',
          errorMessage: '所选文件内容与中断前不一致，无法续传原记录，请重选原文件或重新发起上传',
        });
        pushToast({ message: '文件内容与原记录不一致，已拒绝误恢复', variant: 'error' });
        return;
      }

      // 向服务端查询会话状态与已完成分片（失效自动自愈清理）
      try {
        const detail = await apiFetch<UploadSessionDetail>(
          `/api/uploads/sessions/${rec.sessionId}`,
        );
        if (detail.expired || detail.status !== 'uploading') {
          removeResumableRecord(rec.sessionId);
          updateItems((prev) => prev.filter((i) => i.id !== itemId));
          pushToast({
            message: '原上传会话已过期或已结束，已清理旧记录，请重新上传',
            variant: 'info',
          });
          return;
        }

        const initLike: UploadSessionInitResponse = {
          sessionId: detail.sessionId,
          mode: detail.mode,
          resumed: true,
          isMultipart: detail.isMultipart,
          partSizeBytes: detail.partSizeBytes,
          concurrency: configRef.current.concurrency,
          maxFileBytes: configRef.current.maxFileBytes,
          mimeType: detail.mimeType,
          originalFilename: detail.originalFilename,
          expiresAt: detail.expiresAt,
          uploadedParts: detail.uploadedParts,
        };
        startUppyTransfer(itemId, file, initLike, item.target, computedSha256);
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.status === 404 || err.status === 409 || err.status === 410)
        ) {
          removeResumableRecord(rec.sessionId);
          updateItems((prev) => prev.filter((i) => i.id !== itemId));
          pushToast({
            message: '原上传会话已失效，已自动清理记录，请重新上传',
            variant: 'info',
          });
          return;
        }
        patchItem(itemId, {
          status: 'resumable',
          errorMessage: err instanceof Error ? err.message : '恢复上传会话失败，请重试',
        });
      }
    },
    [patchItem, pushToast, startUppyTransfer, updateItems],
  );

  const cancelItem = useCallback(
    async (itemId: string) => {
      const ctrl = fpControllersRef.current.get(itemId);
      if (ctrl) {
        ctrl.abort();
        fpControllersRef.current.delete(itemId);
      }

      const item = itemsRef.current.find((i) => i.id === itemId);
      if (!item) return;

      // 先中止进行中的浏览器网络传输
      if (item.uppyFileId && uppyRef.current?.getFile(item.uppyFileId)) {
        sessionMetaByFileIdRef.current.delete(item.uppyFileId);
        uppyRef.current.removeFile(item.uppyFileId);
      }

      if (item.sessionId && item.status !== 'completed') {
        try {
          await apiFetch(`/api/uploads/sessions/${item.sessionId}/abort`, {
            method: 'POST',
            body: {},
          });
          removeResumableRecord(item.sessionId);
        } catch (err) {
          if (!(err instanceof ApiError && (err.status === 404 || err.status === 410))) {
            const message = err instanceof ApiError ? err.message : '云端取消失败，请点击重试取消';
            patchItem(itemId, {
              status: 'error',
              abortFailed: true,
              speedBps: 0,
              etaSec: null,
              errorMessage: message,
            });
            pushToast({ message, variant: 'error' });
            return;
          }
          removeResumableRecord(item.sessionId);
        }
      }

      filesRef.current.delete(itemId);
      speedTrackerRef.current.delete(itemId);
      updateItems((prev) => prev.filter((i) => i.id !== itemId));
    },
    [patchItem, pushToast, updateItems],
  );

  const promoteConflictToVersion = useCallback(
    async (itemId: string) => {
      const item = itemsRef.current.find((i) => i.id === itemId);
      if (!item?.sessionId) return;

      patchItem(itemId, { status: 'verifying', errorMessage: null });
      try {
        const done = await apiFetch<CompleteUploadResponse>(
          `/api/uploads/sessions/${item.sessionId}/promote-to-version`,
          { method: 'POST', body: {} },
        );
        removeResumableRecord(item.sessionId);
        filesRef.current.delete(itemId);
        patchItem(itemId, {
          status: 'completed',
          canPromoteToVersion: false,
          uploadPercent: 100,
          errorMessage: null,
        });
        invalidateArtifactQueries(queryClient, {
          worksheetId: done.artifact.worksheetId ?? item.target.worksheetId ?? null,
          workId: done.artifact.workId ?? item.target.workId ?? null,
          taskId: done.artifact.taskId ?? item.target.taskId ?? null,
        });
        pushToast({
          message: `已改存为「${done.artifact.name}」v${done.artifact.latestVersion?.versionNumber ?? ''}`,
          variant: 'success',
        });
      } catch (err) {
        patchItem(itemId, {
          status: 'conflict',
          errorMessage: err instanceof ApiError ? err.message : '改存新版本失败，请重试',
        });
      }
    },
    [patchItem, pushToast, queryClient],
  );

  const dismissItem = useCallback(
    (itemId: string) => {
      const item = itemsRef.current.find((i) => i.id === itemId);
      if (item?.sessionId && item.status === 'resumable') {
        void cancelItem(itemId);
        return;
      }
      filesRef.current.delete(itemId);
      speedTrackerRef.current.delete(itemId);
      updateItems((prev) => prev.filter((i) => i.id !== itemId));
    },
    [cancelItem, updateItems],
  );

  const clearCompleted = useCallback(() => {
    updateItems((prev) => prev.filter((i) => i.status !== 'completed'));
  }, [updateItems]);

  const hasActiveUploads = useMemo(
    () =>
      items.some(
        (i) =>
          i.status === 'fingerprinting' || i.status === 'uploading' || i.status === 'verifying',
      ),
    [items],
  );

  // 活跃上传时注册 beforeunload 防误关页面
  useEffect(() => {
    if (!hasActiveUploads) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasActiveUploads]);

  const value = useMemo<UploadManagerContextValue>(
    () => ({
      config,
      items,
      hasActiveUploads,
      enqueueUpload,
      cancelItem,
      skipFingerprintAndUpload,
      retryItem,
      resumeWithFile,
      promoteConflictToVersion,
      dismissItem,
      clearCompleted,
    }),
    [
      config,
      items,
      hasActiveUploads,
      enqueueUpload,
      cancelItem,
      skipFingerprintAndUpload,
      retryItem,
      resumeWithFile,
      promoteConflictToVersion,
      dismissItem,
      clearCompleted,
    ],
  );

  return <UploadManagerContext.Provider value={value}>{children}</UploadManagerContext.Provider>;
}

export function useUploadManager(): UploadManagerContextValue {
  const ctx = useContext(UploadManagerContext);
  if (!ctx) {
    throw new Error('useUploadManager must be used inside UploadManagerProvider');
  }
  return ctx;
}
