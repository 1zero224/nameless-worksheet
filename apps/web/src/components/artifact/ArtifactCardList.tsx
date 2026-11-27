import {
  type ArtifactDetail,
  type ArtifactVersionDetail,
  CLOUD_PROVIDER_LABELS,
  formatFileSize,
  formatShareInfo,
  type PreviewKind,
  type ResourceLocation,
} from '@nw/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  History,
  KeyRound,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  Share2,
  Trash2,
  Upload,
} from 'lucide-react';
import { useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { EditArtifactModal } from '@/components/artifact/ArtifactFormModal.js';
import {
  copyToClipboard,
  invalidateArtifactQueries,
  isSafeExternalUrl,
} from '@/components/artifact/utils.js';
import {
  AttachFileToVersionModal,
  CreateVersionModal,
  LocationFormModal,
} from '@/components/artifact/VersionAndLocationModals.js';
import {
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useToast,
} from '@/components/ui/overlays.js';
import { cn } from '@/components/ui/primitives.js';
import { FilePreviewModal, type FilePreviewTarget } from '@/components/upload/FilePreviewModal.js';

function renderFileTypeIcon(kind: PreviewKind | null) {
  switch (kind) {
    case 'text':
      return <FileText className="h-3.5 w-3.5 shrink-0 text-sky-600" strokeWidth={1.75} />;
    case 'image':
      return <FileImage className="h-3.5 w-3.5 shrink-0 text-emerald-600" strokeWidth={1.75} />;
    case 'video':
      return <FileVideo className="h-3.5 w-3.5 shrink-0 text-indigo-600" strokeWidth={1.75} />;
    case 'audio':
      return <FileAudio className="h-3.5 w-3.5 shrink-0 text-amber-600" strokeWidth={1.75} />;
    default:
      return <File className="h-3.5 w-3.5 shrink-0 text-zinc-500" strokeWidth={1.75} />;
  }
}

export function sortVersionLocations(locations: ResourceLocation[]): ResourceLocation[] {
  return [...locations].sort((a, b) => {
    if (a.type === b.type) return 0;
    return a.type === 'r2' ? -1 : 1;
  });
}

export function LocationActionRow({
  artifact,
  versionNumber,
  location,
  compact = false,
  onPreview,
  onEdit,
  onDelete,
}: {
  artifact: ArtifactDetail;
  versionNumber: number;
  location: ResourceLocation;
  compact?: boolean;
  onPreview?: (target: FilePreviewTarget) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { pushToast } = useToast();
  const [copiedCode, setCopiedCode] = useState(false);

  // R2 文件行：原文件名·大小 + 直接下载 + 预览 + 悬浮移除（无提取码与分享按钮）
  if (location.type === 'r2') {
    const filename = location.originalFilename ?? artifact.name;
    const sizeText = location.sizeBytes !== null ? formatFileSize(location.sizeBytes) : '';
    const downloadUrl = `/api/resource-locations/${location.id}/download`;
    const canInlinePreview = Boolean(
      location.previewKind && location.previewKind !== 'unsupported',
    );

    return (
      <div
        data-testid={`location-row-${location.id}`}
        data-location-type="r2"
        className={cn(
          'group/loc flex items-center justify-between gap-2 rounded-[2px] transition-colors hover:bg-black/[0.035]',
          compact ? 'px-1 py-0.5' : 'px-1.5 py-1 hover:bg-zinc-100/70',
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPreview?.({ artifactName: artifact.name, versionNumber, location });
            }}
            title={`${filename}${sizeText ? ` (${sizeText})` : ''}`}
            className="inline-flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs font-medium text-zinc-900 transition-colors hover:bg-black/[0.04] cursor-pointer"
          >
            {renderFileTypeIcon(location.previewKind)}
            <span className="truncate">{filename}</span>
          </button>

          {sizeText && (
            <span className="shrink-0 text-[11px] text-zinc-400 tabular-nums">{sizeText}</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <a
            href={downloadUrl}
            data-testid={`location-download-${location.id}`}
            aria-label="下载文件"
            title={`下载 ${filename}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[2px] px-1.5 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-black/[0.05] hover:text-zinc-950"
          >
            <Download className="h-3 w-3" />
            <span>下载</span>
          </a>

          {onPreview && (
            <button
              type="button"
              data-testid={`location-preview-${location.id}`}
              aria-label={canInlinePreview ? '在线预览' : '查看文件详情'}
              title={canInlinePreview ? '在线预览' : '查看文件信息与下载'}
              onClick={(e) => {
                e.stopPropagation();
                onPreview({ artifactName: artifact.name, versionNumber, location });
              }}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[2px] px-1.5 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-black/[0.05] hover:text-zinc-950 cursor-pointer"
            >
              <Eye className="h-3 w-3" />
              <span>{canInlinePreview ? '预览' : '详情'}</span>
            </button>
          )}

          {onDelete && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="文件操作"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-opacity hover:bg-black/[0.05] hover:text-zinc-800 cursor-pointer',
                    compact &&
                      'sm:opacity-0 sm:group-hover/loc:opacity-100 sm:focus-visible:opacity-100 data-[state=open]:opacity-100',
                  )}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[124px]">
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 className="h-3.5 w-3.5" />
                  移除文件
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    );
  }

  const providerLabel = location.provider ? CLOUD_PROVIDER_LABELS[location.provider] : '链接';
  const safeUrl = isSafeExternalUrl(location.url) ? location.url : null;

  const handleCopyCode = async () => {
    if (!location.extractCode) return;
    const ok = await copyToClipboard(location.extractCode);
    if (ok) {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 1500);
    }
    pushToast({
      message: ok ? `已复制提取码：${location.extractCode}` : '复制失败，请手动复制',
      variant: ok ? 'success' : 'error',
    });
  };

  const handleCopyShare = async () => {
    const text = formatShareInfo(artifact.name, versionNumber, location);
    const ok = await copyToClipboard(text);
    pushToast({
      message: ok ? '已复制完整分享信息' : '复制失败，请手动复制',
      variant: ok ? 'success' : 'error',
    });
  };

  return (
    <div
      data-testid={`location-row-${location.id}`}
      className={cn(
        'group/loc flex items-center justify-between gap-2 rounded-[2px] transition-colors hover:bg-black/[0.035]',
        compact ? 'px-1 py-0.5' : 'px-1.5 py-1 hover:bg-zinc-100/70',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
        {safeUrl ? (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`location-open-${location.id}`}
            aria-label="打开链接"
            title={`打开 ${providerLabel} 链接`}
            onClick={(e) => e.stopPropagation()}
            className="group/link inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-zinc-800 transition-colors hover:bg-blue-50 hover:text-blue-700"
          >
            {location.isFolder ? (
              <Folder className="h-3.5 w-3.5 shrink-0 text-amber-600" strokeWidth={1.75} />
            ) : (
              <Link2
                className="h-3.5 w-3.5 shrink-0 text-zinc-400 group-hover/link:text-blue-600"
                strokeWidth={1.75}
              />
            )}
            <span>{providerLabel}</span>
            <ExternalLink className="h-3 w-3 shrink-0 text-zinc-300 transition-colors group-hover/link:text-blue-600" />
          </a>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 px-1 py-0.5 text-xs font-medium text-zinc-700">
            <Link2 className="h-3.5 w-3.5 shrink-0 text-zinc-400" strokeWidth={1.75} />
            <span>{providerLabel}</span>
          </span>
        )}

        {location.extractCode && (
          <button
            type="button"
            data-testid={`location-copy-code-${location.id}`}
            aria-label="复制提取码"
            title={`点击复制提取码：${location.extractCode}`}
            onClick={(e) => {
              e.stopPropagation();
              void handleCopyCode();
            }}
            className={cn(
              'inline-flex h-5 shrink-0 items-center gap-1 rounded-[2px] px-1 font-mono text-[11px] transition-colors cursor-pointer',
              copiedCode
                ? 'text-emerald-700 bg-emerald-500/[0.08]'
                : 'text-zinc-600 hover:bg-black/[0.05] hover:text-zinc-950',
            )}
          >
            {copiedCode ? (
              <Check className="h-2.5 w-2.5 text-emerald-600" />
            ) : (
              <KeyRound className="h-2.5 w-2.5 text-zinc-400" />
            )}
            <span>{location.extractCode}</span>
            {!copiedCode && <Copy className="h-2.5 w-2.5 text-zinc-400" />}
          </button>
        )}

        <button
          type="button"
          data-testid={`location-copy-share-${location.id}`}
          aria-label="复制分享信息"
          title="复制包含名称、链接与提取码的完整分享信息"
          onClick={(e) => {
            e.stopPropagation();
            void handleCopyShare();
          }}
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1 text-[11px] font-medium text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-800 cursor-pointer"
        >
          <Share2 className="h-3 w-3" />
          {!compact && <span>分享</span>}
        </button>

        {location.note && (
          <span className="min-w-0 truncate text-[11px] text-zinc-400" title={location.note}>
            {location.note}
          </span>
        )}
      </div>

      {(onEdit || onDelete) && (
        <div className="flex shrink-0 items-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="多网盘操作"
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-opacity hover:bg-black/[0.05] hover:text-zinc-800 cursor-pointer',
                  compact &&
                    'sm:opacity-0 sm:group-hover/loc:opacity-100 sm:focus-visible:opacity-100 data-[state=open]:opacity-100',
                )}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[128px]">
              {onEdit && (
                <DropdownMenuItem onSelect={onEdit}>
                  <Pencil className="h-3.5 w-3.5 text-zinc-400" />
                  编辑网盘链接
                </DropdownMenuItem>
              )}
              {onDelete && (
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 className="h-3.5 w-3.5" />
                  移除网盘链接
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

export function ArtifactCardList({
  artifacts,
  highlightedArtifactId = null,
  compact = false,
  variant = 'card',
  emptyText = '暂无资源',
}: {
  artifacts: ArtifactDetail[];
  highlightedArtifactId?: string | null;
  compact?: boolean;
  variant?: 'card' | 'list';
  emptyText?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());
  const [editingArtifact, setEditingArtifact] = useState<ArtifactDetail | null>(null);
  const [versionArtifact, setVersionArtifact] = useState<ArtifactDetail | null>(null);
  const [attachFileTarget, setAttachFileTarget] = useState<{
    artifact: ArtifactDetail;
    versionId: string;
    versionNumber: number;
  } | null>(null);
  const [previewTarget, setPreviewTarget] = useState<FilePreviewTarget | null>(null);
  const [locationTarget, setLocationTarget] = useState<
    | { mode: 'create'; artifact: ArtifactDetail; versionId: string; versionNumber: number }
    | {
        mode: 'edit';
        artifact: ArtifactDetail;
        versionNumber: number;
        location: ResourceLocation;
      }
    | null
  >(null);
  const [deletingVersion, setDeletingVersion] = useState<{
    artifact: ArtifactDetail;
    version: ArtifactVersionDetail;
    isLatest: boolean;
    fallbackVersionNumber: number | null;
  } | null>(null);

  const deleteArtifactMutation = useMutation({
    mutationFn: (art: ArtifactDetail) => apiFetch(`/api/artifacts/${art.id}`, { method: 'DELETE' }),
    onSuccess: (_res, art) => {
      invalidateArtifactQueries(queryClient, {
        worksheetId: art.worksheetId,
        workId: art.workId,
        taskId: art.taskId,
      });
      pushToast({
        message: `已删除资源「${art.name}」`,
        variant: 'info',
        actionLabel: '撤销',
        onAction: async () => {
          await apiFetch(`/api/artifacts/${art.id}/restore`, { method: 'POST' });
          invalidateArtifactQueries(queryClient, {
            worksheetId: art.worksheetId,
            workId: art.workId,
            taskId: art.taskId,
          });
          pushToast({ message: `已恢复资源「${art.name}」`, variant: 'success' });
        },
      });
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '删除资源失败',
        variant: 'error',
      });
    },
  });

  const deleteVersionMutation = useMutation({
    mutationFn: ({ version }: { artifact: ArtifactDetail; version: ArtifactVersionDetail }) =>
      apiFetch(`/api/artifact-versions/${version.id}`, { method: 'DELETE' }),
    onSuccess: (_res, { artifact, version }) => {
      setDeletingVersion(null);
      invalidateArtifactQueries(queryClient, {
        worksheetId: artifact.worksheetId,
        workId: artifact.workId,
        taskId: artifact.taskId,
      });
      pushToast({
        message: `已删除「${artifact.name}」v${version.versionNumber}`,
        variant: 'info',
        actionLabel: '撤销',
        onAction: async () => {
          await apiFetch(`/api/artifact-versions/${version.id}/restore`, { method: 'POST' });
          invalidateArtifactQueries(queryClient, {
            worksheetId: artifact.worksheetId,
            workId: artifact.workId,
            taskId: artifact.taskId,
          });
          pushToast({
            message: `已恢复「${artifact.name}」v${version.versionNumber}`,
            variant: 'success',
          });
        },
      });
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '删除版本失败',
        variant: 'error',
      });
    },
  });

  const deleteLocationMutation = useMutation({
    mutationFn: ({ location }: { artifact: ArtifactDetail; location: ResourceLocation }) =>
      apiFetch(`/api/resource-locations/${location.id}`, { method: 'DELETE' }),
    onSuccess: (_res, { artifact, location }) => {
      invalidateArtifactQueries(queryClient, {
        worksheetId: artifact.worksheetId,
        workId: artifact.workId,
        taskId: artifact.taskId,
      });
      const isR2 = location.type === 'r2';
      pushToast({
        message: isR2
          ? `已移除「${artifact.name}」的文件`
          : `已移除「${artifact.name}」的一个网盘链接`,
        variant: 'info',
        actionLabel: '撤销',
        onAction: async () => {
          await apiFetch(`/api/resource-locations/${location.id}/restore`, { method: 'POST' });
          invalidateArtifactQueries(queryClient, {
            worksheetId: artifact.worksheetId,
            workId: artifact.workId,
            taskId: artifact.taskId,
          });
          pushToast({ message: isR2 ? '文件已恢复' : '网盘链接已恢复', variant: 'success' });
        },
      });
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '移除网盘链接失败',
        variant: 'error',
      });
    },
  });

  const toggleHistory = (artifactId: string) => {
    setExpandedHistory((prev) => {
      const next = new Set(prev);
      if (next.has(artifactId)) next.delete(artifactId);
      else next.add(artifactId);
      return next;
    });
  };

  if (artifacts.length === 0) {
    return (
      <div
        className={cn(
          'text-center text-xs text-zinc-400',
          variant === 'list' ? 'py-2' : 'border-y border-black/[0.06] py-6',
        )}
      >
        {emptyText}
      </div>
    );
  }

  return (
    <div
      className={cn(
        variant === 'list'
          ? 'divide-y divide-black/[0.06]'
          : 'divide-y divide-black/[0.07] border-y border-black/[0.08] bg-white',
      )}
      data-testid="artifact-list"
    >
      {artifacts.map((art) => {
        const latest = art.latestVersion;
        const isHistoryOpen = expandedHistory.has(art.id);
        const isHighlighted = highlightedArtifactId === art.id;
        const actorName = latest ? latest.createdBy.displayName : art.createdBy.displayName;
        const timeStr = new Date(latest ? latest.createdAt : art.updatedAt).toLocaleString(
          'zh-CN',
          {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          },
        );
        const hasMultipleVersions = art.versions.length > 1;

        return (
          <div
            key={art.id}
            data-testid={`artifact-card-${art.id}`}
            className={cn(
              'transition-all',
              variant === 'list'
                ? 'py-1.5 first:pt-1 last:pb-0.5'
                : cn('bg-white', compact ? 'py-2.5' : 'py-3.5 px-1'),
              isHighlighted && 'ring-2 ring-zinc-900 bg-zinc-50/70',
            )}
          >
            {/* 头部：资源名优先 + 极简版本文字标识 + 精简操作 */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  className={cn(
                    'truncate',
                    compact
                      ? 'text-[12.5px] font-medium text-zinc-800'
                      : 'text-sm font-semibold text-zinc-950',
                  )}
                  title={`${art.name} · ${actorName} 更新于 ${timeStr}`}
                >
                  {art.name}
                </span>
                {latest ? (
                  <button
                    type="button"
                    data-testid={`artifact-add-version-${art.id}`}
                    aria-label="更新版本"
                    title="更新版本"
                    onClick={() => setVersionArtifact(art)}
                    className="group/ver relative inline-flex min-w-[24px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-900 px-1.5 py-0.5 text-[10.5px] font-medium leading-none text-white transition-[min-width,background-color] duration-200 ease-out hover:min-w-[36px] hover:bg-zinc-700 focus-visible:min-w-[36px] focus-visible:bg-zinc-700 focus-visible:outline-none cursor-pointer"
                  >
                    <span
                      data-testid={`artifact-latest-badge-${art.id}`}
                      className="whitespace-nowrap tabular-nums opacity-100 transition-opacity duration-75 group-hover/ver:opacity-0 group-focus-visible/ver:opacity-0"
                    >
                      v{latest.versionNumber}
                    </span>
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 flex items-center justify-center whitespace-nowrap opacity-0 transition-opacity delay-75 duration-150 group-hover/ver:opacity-100 group-focus-visible/ver:opacity-100"
                    >
                      更新
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid={`artifact-add-version-${art.id}`}
                    aria-label="更新版本"
                    title="更新版本"
                    onClick={() => setVersionArtifact(art)}
                    className="group/ver relative inline-flex min-w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10.5px] font-medium leading-none text-zinc-600 transition-colors duration-200 ease-out hover:bg-zinc-200 hover:text-zinc-950 focus-visible:bg-zinc-200 focus-visible:outline-none cursor-pointer"
                  >
                    <span className="whitespace-nowrap opacity-100 transition-opacity duration-75 group-hover/ver:opacity-0 group-focus-visible/ver:opacity-0">
                      暂无版本
                    </span>
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 flex items-center justify-center whitespace-nowrap opacity-0 transition-opacity delay-75 duration-150 group-hover/ver:opacity-100 group-focus-visible/ver:opacity-100"
                    >
                      更新
                    </span>
                  </button>
                )}
                {!compact && (
                  <span className="hidden shrink-0 text-[11px] text-zinc-400 sm:inline">
                    {actorName} · {timeStr}
                  </span>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-0.5">
                {hasMultipleVersions && (
                  <button
                    type="button"
                    data-testid={`artifact-history-toggle-${art.id}`}
                    title="展开查看全部历史版本"
                    onClick={() => toggleHistory(art.id)}
                    className="inline-flex h-6 items-center gap-0.5 rounded-md px-1.5 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-black/[0.04] hover:text-zinc-900 cursor-pointer"
                  >
                    {isHistoryOpen ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    <History className="h-3 w-3" />
                    <span className="tabular-nums">{art.versions.length}</span>
                  </button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      data-testid={`artifact-menu-${art.id}`}
                      aria-label={`资源操作 ${art.name}`}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-800 cursor-pointer"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[144px]">
                    {latest && !latest.locations.some((l) => l.type === 'r2') && (
                      <DropdownMenuItem
                        data-testid={`artifact-attach-file-${art.id}`}
                        onSelect={() =>
                          setAttachFileTarget({
                            artifact: art,
                            versionId: latest.id,
                            versionNumber: latest.versionNumber,
                          })
                        }
                      >
                        <Upload className="h-3.5 w-3.5 text-zinc-400" />
                        上传文件
                      </DropdownMenuItem>
                    )}
                    {latest && (
                      <DropdownMenuItem
                        data-testid={`artifact-add-location-${art.id}`}
                        onSelect={() =>
                          setLocationTarget({
                            mode: 'create',
                            artifact: art,
                            versionId: latest.id,
                            versionNumber: latest.versionNumber,
                          })
                        }
                      >
                        <Plus className="h-3.5 w-3.5 text-zinc-400" />
                        补充多网盘
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => setEditingArtifact(art)}>
                      <Pencil className="h-3.5 w-3.5 text-zinc-400" />
                      改名 / 移动归属
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => deleteArtifactMutation.mutate(art)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除资源
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {latest?.note && <p className="mt-1 text-xs text-zinc-500">{latest.note}</p>}

            {/* 最新版本的文件与多网盘列表（并列展示，左侧树形引导线明确从属层级） */}
            {latest && (
              <div
                className={cn(
                  'mt-1.5 space-y-0.5',
                  compact && 'ml-1.5 border-l-2 border-zinc-200/85 pl-2.5',
                )}
              >
                {latest.locations.length === 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-white/70 px-2 py-1 text-xs text-zinc-400">
                    <span>暂无文件或网盘链接</span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        data-testid={`artifact-empty-upload-${art.id}`}
                        onClick={() =>
                          setAttachFileTarget({
                            artifact: art,
                            versionId: latest.id,
                            versionNumber: latest.versionNumber,
                          })
                        }
                        className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-black/[0.05] cursor-pointer"
                      >
                        <Upload className="h-3 w-3" />
                        上传文件
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setLocationTarget({
                            mode: 'create',
                            artifact: art,
                            versionId: latest.id,
                            versionNumber: latest.versionNumber,
                          })
                        }
                        className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-black/[0.05] cursor-pointer"
                      >
                        <Plus className="h-3 w-3" />
                        添加网盘
                      </button>
                    </div>
                  </div>
                ) : (
                  sortVersionLocations(latest.locations).map((loc) => (
                    <LocationActionRow
                      key={loc.id}
                      artifact={art}
                      versionNumber={latest.versionNumber}
                      location={loc}
                      compact={compact}
                      onPreview={setPreviewTarget}
                      onEdit={
                        loc.type === 'cloud_link'
                          ? () =>
                              setLocationTarget({
                                mode: 'edit',
                                artifact: art,
                                versionNumber: latest.versionNumber,
                                location: loc,
                              })
                          : undefined
                      }
                      onDelete={() =>
                        deleteLocationMutation.mutate({ artifact: art, location: loc })
                      }
                    />
                  ))
                )}
              </div>
            )}

            {/* 展开的版本历史 */}
            {isHistoryOpen && (
              <div
                data-testid={`artifact-history-${art.id}`}
                className="mt-2.5 space-y-1.5 border-t border-black/[0.06] pt-2"
              >
                <div className="text-[11px] font-medium text-zinc-400">全部版本历史</div>
                {art.versions.length === 0 ? (
                  <div className="text-xs text-zinc-400">暂无历史版本</div>
                ) : (
                  <div className="divide-y divide-black/[0.05] rounded-md bg-[#fafafa]/80 px-2">
                    {art.versions.map((ver) => {
                      const isLatest = latest?.id === ver.id;
                      const remainingOther = art.versions.find((v) => v.id !== ver.id) ?? null;
                      return (
                        <div
                          key={ver.id}
                          data-testid={`version-item-${ver.id}`}
                          className="space-y-1 py-1.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5 text-xs">
                              <span className="font-semibold text-zinc-900 tabular-nums">
                                v{ver.versionNumber}
                              </span>
                              {isLatest && (
                                <span className="rounded bg-emerald-50 px-1.5 py-0 text-[10px] font-medium text-emerald-700">
                                  最新
                                </span>
                              )}
                              <span className="text-[11px] text-zinc-400">
                                {ver.createdBy.displayName} ·{' '}
                                {new Date(ver.createdAt).toLocaleString('zh-CN', {
                                  month: 'numeric',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </span>
                            </div>
                            <div className="flex items-center gap-1">
                              {!ver.locations.some((l) => l.type === 'r2') && (
                                <button
                                  type="button"
                                  data-testid={`version-attach-file-${ver.id}`}
                                  onClick={() =>
                                    setAttachFileTarget({
                                      artifact: art,
                                      versionId: ver.id,
                                      versionNumber: ver.versionNumber,
                                    })
                                  }
                                  className="inline-flex h-5 items-center gap-0.5 rounded px-1.5 text-[11px] text-zinc-500 hover:bg-black/[0.05] hover:text-zinc-900 cursor-pointer"
                                >
                                  <Upload className="h-2.5 w-2.5" />
                                  上传文件
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  setLocationTarget({
                                    mode: 'create',
                                    artifact: art,
                                    versionId: ver.id,
                                    versionNumber: ver.versionNumber,
                                  })
                                }
                                className="inline-flex h-5 items-center gap-0.5 rounded px-1.5 text-[11px] text-zinc-500 hover:bg-black/[0.05] hover:text-zinc-900 cursor-pointer"
                              >
                                <Plus className="h-2.5 w-2.5" />
                                多网盘
                              </button>
                              <button
                                type="button"
                                data-testid={`delete-version-${ver.id}`}
                                onClick={() => {
                                  if (isLatest) {
                                    setDeletingVersion({
                                      artifact: art,
                                      version: ver,
                                      isLatest: true,
                                      fallbackVersionNumber: remainingOther?.versionNumber ?? null,
                                    });
                                  } else {
                                    deleteVersionMutation.mutate({ artifact: art, version: ver });
                                  }
                                }}
                                className="inline-flex h-5 items-center gap-0.5 rounded px-1.5 text-[11px] text-red-600 hover:bg-red-50 cursor-pointer"
                              >
                                <Trash2 className="h-2.5 w-2.5" />
                                删除
                              </button>
                            </div>
                          </div>
                          {ver.note && <div className="text-xs text-zinc-500">{ver.note}</div>}
                          {ver.locations.length === 0 ? (
                            <div className="ml-1.5 border-l-2 border-zinc-200/75 pl-2 text-[11px] text-zinc-400">
                              暂无文件或网盘链接
                            </div>
                          ) : (
                            <div className="ml-1.5 space-y-0.5 border-l-2 border-zinc-200/75 pl-2">
                              {sortVersionLocations(ver.locations).map((loc) => (
                                <LocationActionRow
                                  key={loc.id}
                                  artifact={art}
                                  versionNumber={ver.versionNumber}
                                  location={loc}
                                  compact
                                  onPreview={setPreviewTarget}
                                  onEdit={
                                    loc.type === 'cloud_link'
                                      ? () =>
                                          setLocationTarget({
                                            mode: 'edit',
                                            artifact: art,
                                            versionNumber: ver.versionNumber,
                                            location: loc,
                                          })
                                      : undefined
                                  }
                                  onDelete={() =>
                                    deleteLocationMutation.mutate({ artifact: art, location: loc })
                                  }
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* 改名 / 移动归属弹窗 */}
      <EditArtifactModal
        open={Boolean(editingArtifact)}
        onOpenChange={(o) => {
          if (!o) setEditingArtifact(null);
        }}
        artifact={editingArtifact}
      />

      {/* 登记新版本弹窗 */}
      <CreateVersionModal
        open={Boolean(versionArtifact)}
        onOpenChange={(o) => {
          if (!o) setVersionArtifact(null);
        }}
        artifact={versionArtifact}
      />

      {/* 补充/编辑网盘入口弹窗 */}
      <LocationFormModal
        open={Boolean(locationTarget)}
        onOpenChange={(o) => {
          if (!o) setLocationTarget(null);
        }}
        target={locationTarget}
      />

      {/* 补传文件到已有版本弹窗 */}
      <AttachFileToVersionModal
        open={Boolean(attachFileTarget)}
        onOpenChange={(o) => {
          if (!o) setAttachFileTarget(null);
        }}
        target={attachFileTarget}
      />

      {/* 安全在线预览弹窗 */}
      <FilePreviewModal
        open={Boolean(previewTarget)}
        onOpenChange={(o) => {
          if (!o) setPreviewTarget(null);
        }}
        target={previewTarget}
      />

      {/* 删除最新版二次确认弹窗 */}
      <ConfirmDialog
        open={Boolean(deletingVersion)}
        onOpenChange={(o) => {
          if (!o) setDeletingVersion(null);
        }}
        title="确认删除最新版本"
        message={
          deletingVersion
            ? deletingVersion.fallbackVersionNumber !== null
              ? `确定删除「${deletingVersion.artifact.name}」的当前最新版本 v${deletingVersion.version.versionNumber} 吗？删除后将自动回退显示 v${deletingVersion.fallbackVersionNumber}，稍后可在修改记录中恢复。`
              : `确定删除「${deletingVersion.artifact.name}」的唯一版本 v${deletingVersion.version.versionNumber} 吗？删除后该资源将暂无可用版本，稍后可在修改记录中恢复。`
            : ''
        }
        confirmLabel="确认删除"
        pending={deleteVersionMutation.isPending}
        onConfirm={() => {
          if (!deletingVersion) return;
          deleteVersionMutation.mutate({
            artifact: deletingVersion.artifact,
            version: deletingVersion.version,
          });
        }}
      />
    </div>
  );
}
