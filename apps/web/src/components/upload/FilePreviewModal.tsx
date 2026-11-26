import { formatFileSize, type PreviewUrlResponse, type ResourceLocation } from '@nw/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Download,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Loader2,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { ModalDialog } from '@/components/ui/overlays.js';
import { Alert, cn } from '@/components/ui/primitives.js';

export interface FilePreviewTarget {
  artifactName: string;
  versionNumber: number;
  location: ResourceLocation;
}

type TextEncodingOption = 'auto' | 'utf-8' | 'gb18030' | 'shift-jis' | 'utf-16le' | 'utf-16be';

const ENCODING_OPTIONS: Array<{ value: TextEncodingOption; label: string }> = [
  { value: 'auto', label: '自动识别' },
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'gb18030', label: 'GB18030' },
  { value: 'shift-jis', label: 'Shift-JIS' },
  { value: 'utf-16le', label: 'UTF-16LE' },
  { value: 'utf-16be', label: 'UTF-16BE' },
];

function scoreDecodedText(text: string): number {
  let bad = 0;
  let goodCjk = 0;
  const limit = Math.min(text.length, 4000);
  for (let i = 0; i < limit; i++) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd) {
      bad += 10;
    } else if (code < 0x09 || (code >= 0x0e && code < 0x20)) {
      bad += 5;
    } else if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3000 && code <= 0x303f)
    ) {
      goodCjk += 2;
    }
  }
  return goodCjk - bad;
}

function detectTextEncoding(bytes: Uint8Array): Exclude<TextEncodingOption, 'auto'> {
  // 1. BOM 优先
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'utf-16le';
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'utf-16be';
  }

  // 2. 严格 UTF-8 验证
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    // 非 UTF-8，回退比较 GB18030 与 Shift-JIS
  }

  let best: Exclude<TextEncodingOption, 'auto'> = 'gb18030';
  let bestScore = -Infinity;
  for (const enc of ['gb18030', 'shift-jis'] as const) {
    try {
      const decoded = new TextDecoder(enc, { fatal: false }).decode(bytes);
      const score = scoreDecodedText(decoded);
      if (score > bestScore) {
        bestScore = score;
        best = enc;
      }
    } catch {
      // ignore unsupported decoder
    }
  }
  return best;
}

function decodeTextBytes(
  bytes: Uint8Array,
  encoding: TextEncodingOption,
): { text: string; resolvedEncoding: Exclude<TextEncodingOption, 'auto'> } {
  const resolved = encoding === 'auto' ? detectTextEncoding(bytes) : encoding;
  try {
    const text = new TextDecoder(resolved, { fatal: false }).decode(bytes);
    return { text, resolvedEncoding: resolved };
  } catch {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return { text, resolvedEncoding: 'utf-8' };
  }
}

export function FilePreviewModal({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: FilePreviewTarget | null;
}) {
  const locationId = target?.location.id ?? null;
  const downloadHref = locationId ? `/api/resource-locations/${locationId}/download` : '#';

  const [encoding, setEncoding] = useState<TextEncodingOption>('auto');
  const [rawBytes, setRawBytes] = useState<Uint8Array | null>(null);
  const [textFetchLoading, setTextFetchLoading] = useState(false);
  const [textFetchError, setTextFetchError] = useState<string | null>(null);
  const [imageZoomActual, setImageZoomActual] = useState(false);
  const [mediaError, setMediaError] = useState(false);

  const { data, isLoading, error } = useQuery<PreviewUrlResponse>({
    queryKey: ['location-preview-url', locationId],
    queryFn: () =>
      apiFetch<PreviewUrlResponse>(`/api/resource-locations/${locationId}/preview-url`),
    enabled: Boolean(open && locationId),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!open || !locationId) return;
    setEncoding('auto');
    setRawBytes(null);
    setTextFetchError(null);
    setImageZoomActual(false);
    setMediaError(false);
  }, [open, locationId]);

  // 拉取安全文本原始字节（绝不修改原字节、绝不渲染 HTML）
  useEffect(() => {
    if (!open || !data || data.previewKind !== 'text' || !data.url || data.tooLargeForPreview) {
      return;
    }
    const controller = new AbortController();
    setTextFetchLoading(true);
    setTextFetchError(null);

    fetch(data.url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`拉取预览内容失败（HTTP ${res.status}）`);
        const buf = await res.arrayBuffer();
        if (!controller.signal.aborted) {
          setRawBytes(new Uint8Array(buf));
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setTextFetchError(err instanceof Error ? err.message : '加载文本预览失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setTextFetchLoading(false);
      });

    return () => controller.abort();
  }, [open, data]);

  const decodedText = useMemo(() => {
    if (!rawBytes) return null;
    return decodeTextBytes(rawBytes, encoding);
  }, [rawBytes, encoding]);

  const textLines = useMemo(() => {
    if (!decodedText) return [];
    return decodedText.text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((text, idx) => ({ lineNo: idx + 1, text }));
  }, [decodedText]);

  const displayFilename =
    data?.filename ?? target?.location.originalFilename ?? target?.artifactName ?? '文件';
  const displaySize = data?.sizeBytes ?? target?.location.sizeBytes ?? 0;

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title={target ? `${target.artifactName} · v${target.versionNumber}` : '文件预览'}
      maxWidthClass="max-w-4xl"
    >
      <div className="space-y-3" data-testid="file-preview-modal">
        {/* 顶部文件元数据与主下载按钮 */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-black/[0.06] bg-[#fafafa] px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-zinc-900" title={displayFilename}>
              {displayFilename}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
              <span className="tabular-nums">{formatFileSize(displaySize)}</span>
              {data?.mimeType && (
                <>
                  <span>·</span>
                  <span>{data.mimeType}</span>
                </>
              )}
            </div>
          </div>

          <a
            href={downloadHref}
            data-testid="preview-download-btn"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-xs font-medium text-white transition-colors hover:bg-zinc-800"
          >
            <Download className="h-3.5 w-3.5" />
            下载文件
          </a>
        </div>

        {/* 主预览区 */}
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-14 text-xs text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在获取安全预览地址…
          </div>
        ) : error ? (
          <Alert variant="error">
            {error instanceof ApiError ? error.message : '获取预览地址失败，请直接下载文件'}
          </Alert>
        ) : !data ? null : data.previewKind === 'text' ? (
          data.tooLargeForPreview ? (
            <div
              data-testid="preview-text-too-large"
              className="flex flex-col items-center justify-center rounded-lg border border-dashed border-black/[0.12] bg-[#fafafa] px-4 py-12 text-center"
            >
              <FileText className="h-8 w-8 text-zinc-400" strokeWidth={1.5} />
              <div className="mt-2 text-sm font-medium text-zinc-800">
                文本文件超过 5 MiB，暂不支持在线预览
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                当前体积 {formatFileSize(data.sizeBytes)}，请点击下方按钮下载到本地查看
              </div>
              <a
                href={downloadHref}
                className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800"
              >
                <Download className="h-3.5 w-3.5" />
                下载原文件
              </a>
            </div>
          ) : (
            <div className="space-y-2" data-testid="preview-text-view">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <label htmlFor="preview-encoding-select" className="text-zinc-500">
                    字符编码
                  </label>
                  <select
                    id="preview-encoding-select"
                    data-testid="preview-encoding-select"
                    value={encoding}
                    onChange={(e) => setEncoding(e.target.value as TextEncodingOption)}
                    className="h-7 rounded-md border border-black/[0.12] bg-white px-2 text-xs text-zinc-800 outline-none focus:border-zinc-900"
                  >
                    {ENCODING_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  {decodedText && encoding === 'auto' && (
                    <span className="text-[11px] text-zinc-400">
                      当前识别：{decodedText.resolvedEncoding.toUpperCase()}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-zinc-400 tabular-nums">
                  共 {textLines.length} 行 · 只读预览（不改原文件）
                </span>
              </div>

              {textFetchLoading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-xs text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在加载文本内容…
                </div>
              ) : textFetchError ? (
                <Alert variant="error">{textFetchError}</Alert>
              ) : (
                <div
                  data-testid="preview-text-content"
                  className="max-h-[58vh] overflow-auto rounded-lg border border-black/[0.08] bg-[#fafafa] font-mono text-xs leading-5"
                >
                  <table className="w-full border-collapse">
                    <tbody>
                      {textLines.map((row) => (
                        <tr key={row.lineNo} className="hover:bg-black/[0.025]">
                          <td className="w-12 select-none border-r border-black/[0.06] bg-zinc-100/60 px-2 py-0 text-right align-top text-[11px] text-zinc-400 tabular-nums">
                            {row.lineNo}
                          </td>
                          <td className="whitespace-pre-wrap break-all px-3 py-0 text-zinc-900">
                            {row.text || '\u00A0'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        ) : data.previewKind === 'image' && data.url ? (
          <div className="space-y-2" data-testid="preview-image-view">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setImageZoomActual((v) => !v)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-black/[0.1] bg-white px-2 text-xs text-zinc-700 hover:bg-zinc-50 cursor-pointer"
              >
                {imageZoomActual ? (
                  <>
                    <Minimize2 className="h-3.5 w-3.5" />
                    适应窗口
                  </>
                ) : (
                  <>
                    <Maximize2 className="h-3.5 w-3.5" />
                    100% 原尺寸
                  </>
                )}
              </button>
            </div>
            <div className="flex max-h-[60vh] items-center justify-center overflow-auto rounded-lg border border-black/[0.08] bg-[#fafafa] p-3">
              <img
                src={data.url}
                alt={data.filename}
                className={cn(
                  'rounded',
                  imageZoomActual ? 'max-w-none' : 'max-h-[55vh] max-w-full object-contain',
                )}
              />
            </div>
          </div>
        ) : data.previewKind === 'video' && data.url ? (
          <div data-testid="preview-video-view">
            {mediaError ? (
              <div
                data-testid="preview-media-fallback"
                className="flex flex-col items-center justify-center rounded-lg border border-dashed border-black/[0.12] bg-[#fafafa] px-4 py-12 text-center"
              >
                <FileVideo className="h-8 w-8 text-zinc-400" strokeWidth={1.5} />
                <div className="mt-2 text-sm font-medium text-zinc-800">
                  当前浏览器不支持此视频编码
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  请下载后使用本地播放器观看（或使用网盘在线观看）
                </div>
                <a
                  href={downloadHref}
                  className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800"
                >
                  <Download className="h-3.5 w-3.5" />
                  下载视频文件
                </a>
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-black/[0.08] bg-black">
                <video
                  controls
                  playsInline
                  src={data.url}
                  onError={() => setMediaError(true)}
                  className="max-h-[60vh] w-full"
                >
                  <track kind="captions" />
                </video>
              </div>
            )}
          </div>
        ) : data.previewKind === 'audio' && data.url ? (
          <div data-testid="preview-audio-view">
            {mediaError ? (
              <div
                data-testid="preview-media-fallback"
                className="flex flex-col items-center justify-center rounded-lg border border-dashed border-black/[0.12] bg-[#fafafa] px-4 py-10 text-center"
              >
                <FileAudio className="h-8 w-8 text-zinc-400" strokeWidth={1.5} />
                <div className="mt-2 text-sm font-medium text-zinc-800">
                  当前浏览器不支持此音频编码，请下载后本地播放
                </div>
                <a
                  href={downloadHref}
                  className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800"
                >
                  <Download className="h-3.5 w-3.5" />
                  下载音频文件
                </a>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-black/[0.08] bg-[#fafafa] px-4 py-10">
                <FileAudio className="h-8 w-8 text-zinc-500" strokeWidth={1.5} />
                <audio
                  controls
                  src={data.url}
                  onError={() => setMediaError(true)}
                  className="w-full max-w-md"
                >
                  <track kind="captions" />
                </audio>
              </div>
            )}
          </div>
        ) : (
          <div
            data-testid="preview-unsupported-view"
            className="flex flex-col items-center justify-center rounded-lg border border-dashed border-black/[0.12] bg-[#fafafa] px-4 py-12 text-center"
          >
            {data.filename.toLowerCase().endsWith('.svg') ? (
              <FileImage className="h-8 w-8 text-zinc-400" strokeWidth={1.5} />
            ) : (
              <File className="h-8 w-8 text-zinc-400" strokeWidth={1.5} />
            )}
            <div className="mt-2 text-sm font-medium text-zinc-800">暂不支持在线预览此文件类型</div>
            <div className="mt-1 text-xs text-zinc-500">
              {data.filename} · {formatFileSize(data.sizeBytes)} · {data.mimeType}
            </div>
            <a
              href={downloadHref}
              className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800"
            >
              <Download className="h-3.5 w-3.5" />
              下载文件
            </a>
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
