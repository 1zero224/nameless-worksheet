import type { ArtifactDetail, TaskArtifactsResponse } from '@nw/shared';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Folder, FolderDown, Paperclip } from 'lucide-react';
import { useState } from 'react';
import { apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { LocationActionRow, sortVersionLocations } from '@/components/artifact/ArtifactCardList.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/overlays.js';
import { cn } from '@/components/ui/primitives.js';
import { FilePreviewModal, type FilePreviewTarget } from '@/components/upload/FilePreviewModal.js';

export interface TaskResourcesPopoverProps {
  taskId: string;
  taskTitle: string;
  worksheetId: string;
  workName?: string | null;
  stageColumnId?: string;
  stageColumnName?: string;
  resourceCount?: number;
  onOpenDetail: (target: { worksheetId: string; taskId: string }) => void;
  className?: string;
}

function CompactArtifactBlock({
  title,
  icon,
  artifacts,
  onPreview,
}: {
  title: string;
  icon?: React.ReactNode;
  artifacts: ArtifactDetail[];
  onPreview: (target: FilePreviewTarget) => void;
}) {
  if (artifacts.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1 text-[11px] font-semibold text-zinc-600">
        {icon}
        <span className="truncate">{title}</span>
      </div>
      <div className="divide-y divide-black/[0.06] rounded-lg bg-[#fafafa]/70 px-2">
        {artifacts.map((art) => {
          const latest = art.latestVersion;
          return (
            <div key={art.id} data-testid={`popover-art-${art.id}`} className="space-y-1 py-1.5">
              <div className="flex items-center justify-between gap-1.5">
                <span className="truncate text-xs font-medium text-zinc-900" title={art.name}>
                  {art.name}
                </span>
                {latest && (
                  <span className="shrink-0 rounded-full bg-zinc-900 px-1.5 py-0 text-[10px] font-medium text-white tabular-nums">
                    v{latest.versionNumber}
                  </span>
                )}
              </div>
              {latest && latest.locations.length > 0 ? (
                <div className="ml-1.5 space-y-0.5 border-l-2 border-zinc-200/85 pl-2.5">
                  {sortVersionLocations(latest.locations).map((loc) => (
                    <LocationActionRow
                      key={loc.id}
                      artifact={art}
                      versionNumber={latest.versionNumber}
                      location={loc}
                      compact
                      onPreview={onPreview}
                    />
                  ))}
                </div>
              ) : (
                <div className="ml-1.5 border-l-2 border-zinc-200/75 pl-2.5 text-[11px] text-zinc-400">
                  暂无文件或网盘链接
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 任务资源快速取用弹层（用于首页看板卡片与左侧「我的任务」卡片）。
 * 一次拉取作品共用 / 本列工序 / 任务其他资源，支持一键打开链接、复制提取码与复制完整分享信息。
 */
export function TaskResourcesPopover({
  taskId,
  taskTitle,
  worksheetId,
  workName,
  stageColumnId,
  stageColumnName,
  resourceCount = 0,
  onOpenDetail,
  className,
}: TaskResourcesPopoverProps) {
  const [open, setOpen] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<FilePreviewTarget | null>(null);

  const handlePreview = (target: FilePreviewTarget) => {
    setOpen(false);
    setPreviewTarget(target);
  };

  const { data, isLoading } = useQuery<TaskArtifactsResponse>({
    queryKey: queryKeys.taskArtifacts(taskId),
    queryFn: () => apiFetch<TaskArtifactsResponse>(`/api/tasks/${taskId}/artifacts`),
    enabled: open,
  });

  const workArtifacts = data?.workArtifacts ?? [];
  const currentStageArtifacts =
    stageColumnId && data ? (data.stageArtifacts[stageColumnId] ?? []) : [];
  const otherStageArtifacts = data
    ? Object.entries(data.stageArtifacts)
        .filter(([cid]) => cid !== stageColumnId)
        .flatMap(([, list]) => list)
    : [];
  const otherTaskArtifacts = [...(data?.taskArtifacts ?? []), ...otherStageArtifacts];
  const hasAny =
    workArtifacts.length > 0 || currentStageArtifacts.length > 0 || otherTaskArtifacts.length > 0;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid={`card-resources-btn-${taskId}`}
            aria-label={`查看资源 ${taskTitle}`}
            title={resourceCount > 0 ? `快速取用资源（${resourceCount}）` : '快速查看资源'}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'inline-flex h-6 shrink-0 items-center justify-center gap-0.5 rounded-md px-1 text-zinc-500 transition-colors hover:bg-black/[0.06] hover:text-zinc-900 cursor-pointer',
              resourceCount > 0 && 'text-zinc-800',
              open && 'bg-black/[0.08] text-zinc-950',
              className,
            )}
          >
            <FolderDown className="h-3.5 w-3.5" strokeWidth={1.85} />
            {resourceCount > 0 && (
              <span
                data-testid={`card-resources-count-${taskId}`}
                className="text-[10.5px] font-semibold tabular-nums leading-none"
              >
                {resourceCount}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={6}
          data-testid={`task-resources-popover-${taskId}`}
          onClick={(e) => e.stopPropagation()}
          className="w-[min(352px,calc(100vw-1.5rem))] p-3"
        >
          <div className="flex items-start justify-between gap-2 border-b border-black/[0.07] pb-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-zinc-950">可下载资源</div>
              <div className="mt-0.5 truncate text-xs text-zinc-500" title={taskTitle}>
                {taskTitle}
              </div>
            </div>
            {stageColumnName && (
              <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600">
                {stageColumnName}
              </span>
            )}
          </div>

          <div className="no-scrollbar mt-2.5 max-h-[300px] space-y-2.5 overflow-y-auto">
            {isLoading ? (
              <div className="py-5 text-center text-xs text-zinc-400">正在加载资源…</div>
            ) : !hasAny ? (
              <div className="space-y-2">
                {workName && (
                  <div className="rounded-lg border border-black/[0.07] bg-[#fafafa] px-2.5 py-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-800">
                      <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-400" strokeWidth={1.75} />
                      <span className="truncate">作品共用：{workName}</span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-400">暂无共用资源</p>
                  </div>
                )}
                <div className="rounded-lg border border-dashed border-black/[0.12] bg-[#fafafa]/70 px-2.5 py-4 text-center">
                  <Paperclip
                    className="mx-auto h-4 w-4 text-zinc-400"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <div className="mt-1 text-xs font-medium text-zinc-600">暂无资源或网盘链接</div>
                  <div className="mt-0.5 text-[11px] text-zinc-400">
                    可打开任务详情或工作表添加资源
                  </div>
                </div>
              </div>
            ) : (
              <>
                <CompactArtifactBlock
                  title={workName ? `作品共用：${workName}` : '所属作品共用'}
                  icon={<Folder className="h-3 w-3 shrink-0 text-indigo-500" />}
                  artifacts={workArtifacts}
                  onPreview={handlePreview}
                />
                {stageColumnName && (
                  <CompactArtifactBlock
                    title={`本列工序 · ${stageColumnName}`}
                    artifacts={currentStageArtifacts}
                    onPreview={handlePreview}
                  />
                )}
                <CompactArtifactBlock
                  title="任务其他资源"
                  artifacts={otherTaskArtifacts}
                  onPreview={handlePreview}
                />
              </>
            )}
          </div>

          <div className="mt-2.5 flex justify-end border-t border-black/[0.06] pt-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenDetail({ worksheetId, taskId });
              }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-black/[0.05] hover:text-zinc-950 cursor-pointer"
            >
              <span>打开任务详情</span>
              <ExternalLink className="h-3 w-3" />
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <FilePreviewModal
        open={Boolean(previewTarget)}
        onOpenChange={(o) => {
          if (!o) setPreviewTarget(null);
        }}
        target={previewTarget}
      />
    </>
  );
}
