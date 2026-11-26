import {
  type ArtifactDetail,
  type ArtifactVersionDetail,
  CLOUD_PROVIDER_LABELS,
  formatShareInfo,
  type ResourceLocation,
} from '@nw/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File as FileIcon,
  Folder,
  History,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  Share2,
  Trash2,
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

export function LocationActionRow({
  artifact,
  versionNumber,
  location,
  compact = false,
  onEdit,
  onDelete,
}: {
  artifact: ArtifactDetail;
  versionNumber: number;
  location: ResourceLocation;
  compact?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { pushToast } = useToast();
  const providerLabel = location.provider ? CLOUD_PROVIDER_LABELS[location.provider] : '链接';
  const safeUrl = isSafeExternalUrl(location.url) ? location.url : null;

  const handleCopyCode = async () => {
    if (!location.extractCode) return;
    const ok = await copyToClipboard(location.extractCode);
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
        'flex flex-wrap items-center justify-between gap-2 rounded-md border border-black/[0.06] bg-[#fafafa] px-2.5 py-1.5',
        compact && 'px-2 py-1',
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs">
        {location.isFolder ? (
          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-600" strokeWidth={1.75} />
        ) : (
          <FileIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500" strokeWidth={1.75} />
        )}
        <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[11px] font-medium text-zinc-800 ring-1 ring-black/[0.08]">
          {providerLabel}
        </span>
        <span className="shrink-0 text-[11px] text-zinc-400">
          {location.isFolder ? '文件夹' : '文件'}
        </span>
        {location.extractCode && (
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-700">
            <KeyRound className="h-2.5 w-2.5 text-zinc-400" />
            {location.extractCode}
          </span>
        )}
        {location.expiresAt && (
          <span className="shrink-0 text-[11px] text-zinc-400 tabular-nums">
            至 {location.expiresAt}
          </span>
        )}
        {location.note && (
          <span className="truncate text-[11px] text-zinc-500" title={location.note}>
            {location.note}
          </span>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {safeUrl && (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`location-open-${location.id}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-black/[0.1] bg-white px-2 text-[11px] font-medium text-zinc-800 transition-colors hover:border-zinc-400 hover:text-zinc-950"
          >
            <ExternalLink className="h-3 w-3" />
            打开链接
          </a>
        )}
        {location.extractCode && (
          <button
            type="button"
            data-testid={`location-copy-code-${location.id}`}
            onClick={(e) => {
              e.stopPropagation();
              void handleCopyCode();
            }}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-black/[0.1] bg-white px-2 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-black/[0.04] hover:text-zinc-950 cursor-pointer"
          >
            <Copy className="h-3 w-3" />
            复制提取码
          </button>
        )}
        <button
          type="button"
          data-testid={`location-copy-share-${location.id}`}
          onClick={(e) => {
            e.stopPropagation();
            void handleCopyShare();
          }}
          title="复制包含名称、链接与提取码的完整分享信息"
          className="inline-flex h-6 items-center gap-1 rounded-md border border-black/[0.1] bg-white px-2 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-black/[0.04] hover:text-zinc-950 cursor-pointer"
        >
          <Share2 className="h-3 w-3" />
          <span className={compact ? 'sr-only' : 'inline'}>复制分享信息</span>
        </button>

        {(onEdit || onDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="入口操作"
                onClick={(e) => e.stopPropagation()}
                className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-800 cursor-pointer"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[120px]">
              {onEdit && (
                <DropdownMenuItem onSelect={onEdit}>
                  <Pencil className="h-3.5 w-3.5 text-zinc-400" />
                  编辑入口
                </DropdownMenuItem>
              )}
              {onDelete && (
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 className="h-3.5 w-3.5" />
                  移除入口
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

export function ArtifactCardList({
  artifacts,
  highlightedArtifactId = null,
  compact = false,
  emptyText = '暂无资源',
}: {
  artifacts: ArtifactDetail[];
  highlightedArtifactId?: string | null;
  compact?: boolean;
  emptyText?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());
  const [editingArtifact, setEditingArtifact] = useState<ArtifactDetail | null>(null);
  const [versionArtifact, setVersionArtifact] = useState<ArtifactDetail | null>(null);
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
      pushToast({
        message: `已移除「${artifact.name}」的一个网盘入口`,
        variant: 'info',
        actionLabel: '撤销',
        onAction: async () => {
          await apiFetch(`/api/resource-locations/${location.id}/restore`, { method: 'POST' });
          invalidateArtifactQueries(queryClient, {
            worksheetId: artifact.worksheetId,
            workId: artifact.workId,
            taskId: artifact.taskId,
          });
          pushToast({ message: '网盘入口已恢复', variant: 'success' });
        },
      });
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '移除入口失败',
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
      <div className="rounded-lg border border-dashed border-black/[0.1] bg-[#fafafa] px-3 py-4 text-center text-xs text-zinc-400">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="space-y-2.5" data-testid="artifact-list">
      {artifacts.map((art) => {
        const latest = art.latestVersion;
        const isHistoryOpen = expandedHistory.has(art.id);
        const isHighlighted = highlightedArtifactId === art.id;

        return (
          <div
            key={art.id}
            data-testid={`artifact-card-${art.id}`}
            className={cn(
              'rounded-lg border border-black/[0.08] bg-white transition-all',
              compact ? 'p-2.5' : 'p-3.5',
              isHighlighted && 'ring-2 ring-zinc-900 bg-zinc-50/70',
            )}
          >
            {/* 头部：资源名 + 版本徽章 + 操作按钮 */}
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-semibold text-zinc-950">{art.name}</span>
                  {latest ? (
                    <span
                      data-testid={`artifact-latest-badge-${art.id}`}
                      className="rounded-full bg-zinc-900 px-2 py-0.5 text-[11px] font-medium text-white tabular-nums"
                    >
                      v{latest.versionNumber}
                    </span>
                  ) : (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500">
                      暂无版本
                    </span>
                  )}
                  <span className="text-[11px] text-zinc-400">
                    {latest ? latest.createdBy.displayName : art.createdBy.displayName} ·{' '}
                    {new Date(latest ? latest.createdAt : art.updatedAt).toLocaleString('zh-CN', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                {latest?.note && <p className="mt-1 text-xs text-zinc-600">{latest.note}</p>}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <button
                  type="button"
                  data-testid={`artifact-add-version-${art.id}`}
                  onClick={() => setVersionArtifact(art)}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-black/[0.1] bg-white px-2 text-[11px] font-medium text-zinc-700 hover:bg-black/[0.04] hover:text-zinc-950 cursor-pointer"
                >
                  <Plus className="h-3 w-3" />
                  新版本
                </button>
                {latest && (
                  <button
                    type="button"
                    data-testid={`artifact-add-location-${art.id}`}
                    onClick={() =>
                      setLocationTarget({
                        mode: 'create',
                        artifact: art,
                        versionId: latest.id,
                        versionNumber: latest.versionNumber,
                      })
                    }
                    className="inline-flex h-6 items-center gap-1 rounded-md border border-black/[0.1] bg-white px-2 text-[11px] font-medium text-zinc-700 hover:bg-black/[0.04] hover:text-zinc-950 cursor-pointer"
                  >
                    <Plus className="h-3 w-3" />
                    补充入口
                  </button>
                )}
                <button
                  type="button"
                  data-testid={`artifact-history-toggle-${art.id}`}
                  onClick={() => toggleHistory(art.id)}
                  className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-zinc-500 hover:bg-black/[0.04] hover:text-zinc-900 cursor-pointer"
                >
                  {isHistoryOpen ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  <History className="h-3 w-3" />
                  历史 ({art.versions.length})
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      data-testid={`artifact-menu-${art.id}`}
                      aria-label={`资源操作 ${art.name}`}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-800 cursor-pointer"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[144px]">
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

            {/* 最新版本的入口列表 */}
            {latest && (
              <div className="mt-2.5 space-y-1.5">
                {latest.locations.length === 0 ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-black/[0.12] bg-[#fafafa] px-2.5 py-2 text-xs text-zinc-500">
                    <span>待补充入口</span>
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
                      className="inline-flex items-center gap-1 rounded-md border border-black/[0.1] bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-black/[0.04] cursor-pointer"
                    >
                      <Plus className="h-3 w-3" />
                      添加入口
                    </button>
                  </div>
                ) : (
                  latest.locations.map((loc) => (
                    <LocationActionRow
                      key={loc.id}
                      artifact={art}
                      versionNumber={latest.versionNumber}
                      location={loc}
                      compact={compact}
                      onEdit={() =>
                        setLocationTarget({
                          mode: 'edit',
                          artifact: art,
                          versionNumber: latest.versionNumber,
                          location: loc,
                        })
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
                className="mt-3 space-y-2 border-t border-black/[0.06] pt-2.5"
              >
                <div className="text-[11px] font-medium text-zinc-500">
                  全部版本历史（按版本号倒序）
                </div>
                {art.versions.length === 0 ? (
                  <div className="text-xs text-zinc-400">暂无历史版本</div>
                ) : (
                  art.versions.map((ver) => {
                    const isLatest = latest?.id === ver.id;
                    const remainingOther = art.versions.find((v) => v.id !== ver.id) ?? null;
                    return (
                      <div
                        key={ver.id}
                        data-testid={`version-item-${ver.id}`}
                        className="rounded-md border border-black/[0.07] bg-white p-2 space-y-1.5"
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
                              {new Date(ver.createdAt).toLocaleString('zh-CN')}
                            </span>
                          </div>
                          <div className="flex items-center gap-1">
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
                              className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] text-zinc-600 hover:bg-black/[0.04] cursor-pointer"
                            >
                              <Plus className="h-3 w-3" />
                              入口
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
                              className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] text-red-600 hover:bg-red-50 cursor-pointer"
                            >
                              <Trash2 className="h-3 w-3" />
                              删除
                            </button>
                          </div>
                        </div>
                        {ver.note && <div className="text-xs text-zinc-600">{ver.note}</div>}
                        {ver.locations.length === 0 ? (
                          <div className="text-[11px] text-zinc-400">待补充入口</div>
                        ) : (
                          <div className="space-y-1">
                            {ver.locations.map((loc) => (
                              <LocationActionRow
                                key={loc.id}
                                artifact={art}
                                versionNumber={ver.versionNumber}
                                location={loc}
                                compact
                                onEdit={() =>
                                  setLocationTarget({
                                    mode: 'edit',
                                    artifact: art,
                                    versionNumber: ver.versionNumber,
                                    location: loc,
                                  })
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
                  })
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
