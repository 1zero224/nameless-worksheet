import type {
  ArtifactDetail,
  ArtifactScope,
  TaskArtifactsResponse,
  WorkArtifactsResponse,
} from '@nw/shared';
import { useQuery } from '@tanstack/react-query';
import { MoreHorizontal, PanelRightOpen, Plus, Upload, X } from 'lucide-react';
import { apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { LocationActionRow, sortVersionLocations } from '@/components/artifact/ArtifactCardList.js';
import {
  buildDefaultArtifactName,
  buildScopeTags,
  type ScopeTagItem,
} from '@/components/artifact/utils.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/overlays.js';
import type { FilePreviewTarget } from '@/components/upload/FilePreviewModal.js';

export type QuickPopoverTarget =
  | {
      kind: 'stage';
      worksheetId: string;
      worksheetName: string;
      workName?: string | null;
      taskId: string;
      taskTitle: string;
      stageColumnId: string;
      stageColumnName: string;
    }
  | {
      kind: 'work';
      worksheetId: string;
      worksheetName: string;
      workId: string;
      workName: string;
      focusArtifactId?: string;
    };

export interface QuickCreateRequest {
  scope: ArtifactScope;
  scopeLabel: string;
  scopeTags: ScopeTagItem[];
  defaultName: string;
  worksheetId: string;
}

export function ArtifactQuickPopoverContent({
  target,
  onClose,
  onRequestCreate,
  onRequestCreateVersion,
  onRequestAddLocation,
  onRequestAttachFile,
  onRequestPreview,
  onOpenTaskDetail,
}: {
  target: QuickPopoverTarget;
  onClose: () => void;
  onRequestCreate: (req: QuickCreateRequest) => void;
  onRequestCreateVersion: (artifact: ArtifactDetail) => void;
  onRequestAddLocation: (artifact: ArtifactDetail) => void;
  onRequestAttachFile?: (artifact: ArtifactDetail) => void;
  onRequestPreview?: (preview: FilePreviewTarget) => void;
  onOpenTaskDetail?: (taskId: string) => void;
}) {
  const workQuery = useQuery<WorkArtifactsResponse>({
    queryKey:
      target.kind === 'work' ? queryKeys.workArtifacts(target.workId) : ['work-art', 'none'],
    queryFn: () =>
      apiFetch<WorkArtifactsResponse>(
        `/api/works/${target.kind === 'work' ? target.workId : ''}/artifacts`,
      ),
    enabled: target.kind === 'work',
  });

  const taskQuery = useQuery<TaskArtifactsResponse>({
    queryKey:
      target.kind === 'stage' ? queryKeys.taskArtifacts(target.taskId) : ['task-art', 'none'],
    queryFn: () =>
      apiFetch<TaskArtifactsResponse>(
        `/api/tasks/${target.kind === 'stage' ? target.taskId : ''}/artifacts`,
      ),
    enabled: target.kind === 'stage',
  });

  const isLoading = target.kind === 'work' ? workQuery.isLoading : taskQuery.isLoading;
  const rawArtifacts: ArtifactDetail[] =
    target.kind === 'work'
      ? (workQuery.data?.artifacts ?? [])
      : (taskQuery.data?.stageArtifacts[target.stageColumnId] ?? []);

  // 如果是从单个作品胶囊点入，把该资源排到最前方便一眼取用
  const artifacts =
    target.kind === 'work' && target.focusArtifactId
      ? [
          ...rawArtifacts.filter((a) => a.id === target.focusArtifactId),
          ...rawArtifacts.filter((a) => a.id !== target.focusArtifactId),
        ]
      : rawArtifacts;

  const handleOpenCreate = () => {
    const createScope: ArtifactScope =
      target.kind === 'work'
        ? { kind: 'work', workId: target.workId }
        : { kind: 'stage', taskId: target.taskId, stageColumnId: target.stageColumnId };

    const scopeLabel =
      target.kind === 'work'
        ? `${target.worksheetName} · ${target.workName}`
        : [target.worksheetName, target.workName, target.taskTitle, target.stageColumnName]
            .filter(Boolean)
            .join(' - ');

    const scopeTags =
      target.kind === 'work'
        ? buildScopeTags({ worksheetName: target.worksheetName, workName: target.workName })
        : buildScopeTags({
            worksheetName: target.worksheetName,
            workName: target.workName,
            taskTitle: target.taskTitle,
            stageColumnName: target.stageColumnName,
          });

    const defaultName =
      target.kind === 'stage'
        ? buildDefaultArtifactName({
            workName: target.workName,
            taskTitle: target.taskTitle,
            stageColumnName: target.stageColumnName,
          })
        : '';

    onClose();
    onRequestCreate({
      scope: createScope,
      scopeLabel,
      scopeTags,
      defaultName,
      worksheetId: target.worksheetId,
    });
  };

  return (
    <div data-testid="artifact-quick-popover" className="space-y-2.5">
      <div className="flex items-start justify-between gap-2 border-b border-black/[0.06] pb-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-zinc-950">
            {target.kind === 'work' ? '作品共用资源' : `${target.stageColumnName} · 工序资源`}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-zinc-500">
            {target.kind === 'work' ? target.workName : target.taskTitle}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-testid="quick-popover-add-btn"
            onClick={handleOpenCreate}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-zinc-900 px-2 text-[11px] font-medium text-white hover:bg-zinc-800 cursor-pointer"
          >
            <Plus className="h-3 w-3" />
            添加
          </button>
          <button
            type="button"
            aria-label="关闭资源浮层"
            data-testid="quick-popover-close-btn"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-800 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="py-5 text-center text-xs text-zinc-400">正在加载资源…</div>
      ) : artifacts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-black/[0.1] bg-[#fafafa] px-3 py-4 text-center text-xs text-zinc-400">
          暂无资源，点击右上角「添加」上传文件或粘贴网盘链接
        </div>
      ) : (
        <div className="no-scrollbar max-h-[300px] divide-y divide-black/[0.06] overflow-y-auto">
          {artifacts.map((art) => {
            const latest = art.latestVersion;
            return (
              <div
                key={art.id}
                data-testid={`quick-art-${art.id}`}
                className="space-y-1 py-2 first:pt-0.5 last:pb-0.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className="truncate text-[12.5px] font-medium text-zinc-800"
                      title={art.name}
                    >
                      {art.name}
                    </span>
                    {latest && (
                      <span className="inline-flex shrink-0 items-center overflow-hidden rounded-full bg-zinc-900 text-white">
                        <span className="pl-1.5 pr-1 py-0 text-[10px] font-medium tabular-nums">
                          v{latest.versionNumber}
                        </span>
                        <button
                          type="button"
                          aria-label="更新版本"
                          title="更新版本"
                          onClick={() => {
                            onClose();
                            onRequestCreateVersion(art);
                          }}
                          className="group/ver inline-flex items-center gap-0.5 border-l border-white/20 px-1 py-0 text-[10px] font-medium text-white/90 hover:bg-white/15 hover:text-white cursor-pointer"
                        >
                          <Plus className="h-2.5 w-2.5 shrink-0" />
                          <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-150 group-hover/ver:max-w-[26px] group-hover/ver:opacity-100 group-focus-visible/ver:max-w-[26px] group-focus-visible/ver:opacity-100">
                            更新
                          </span>
                        </button>
                      </span>
                    )}
                  </div>
                  {latest && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`更多操作 ${art.name}`}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-800 cursor-pointer"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[132px]">
                        {onRequestAttachFile && !latest.locations.some((l) => l.type === 'r2') && (
                          <DropdownMenuItem
                            onSelect={() => {
                              onClose();
                              onRequestAttachFile(art);
                            }}
                          >
                            <Upload className="h-3.5 w-3.5 text-zinc-400" />
                            上传文件
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onSelect={() => {
                            onClose();
                            onRequestAddLocation(art);
                          }}
                        >
                          <Plus className="h-3.5 w-3.5 text-zinc-400" />
                          补充多网盘
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>

                {latest?.note && <div className="text-[11px] text-zinc-500">{latest.note}</div>}

                {latest && latest.locations.length > 0 ? (
                  <div className="ml-1.5 space-y-0.5 border-l-2 border-zinc-200/85 pl-2.5">
                    {sortVersionLocations(latest.locations).map((loc) => (
                      <LocationActionRow
                        key={loc.id}
                        artifact={art}
                        versionNumber={latest.versionNumber}
                        location={loc}
                        compact
                        onPreview={
                          onRequestPreview
                            ? (p) => {
                                onClose();
                                onRequestPreview(p);
                              }
                            : undefined
                        }
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
      )}

      {target.kind === 'stage' && onOpenTaskDetail && (
        <div className="flex justify-end border-t border-black/[0.06] pt-1.5">
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenTaskDetail(target.taskId);
            }}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-black/[0.04] hover:text-zinc-900 cursor-pointer"
          >
            <PanelRightOpen className="h-3 w-3" />
            在详情侧栏管理全部
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 锚定在指定矩形坐标上的轻量快速取用浮层（用于 Canvas 工序格角标点击，与工序格编辑器一致靠左对齐）。
 */
export function AnchoredArtifactQuickPopover({
  anchorRect,
  target,
  onClose,
  onRequestCreate,
  onRequestCreateVersion,
  onRequestAddLocation,
  onRequestAttachFile,
  onRequestPreview,
  onOpenTaskDetail,
}: {
  anchorRect: { x: number; y: number; width: number; height: number };
  target: QuickPopoverTarget;
  onClose: () => void;
  onRequestCreate: (req: QuickCreateRequest) => void;
  onRequestCreateVersion: (artifact: ArtifactDetail) => void;
  onRequestAddLocation: (artifact: ArtifactDetail) => void;
  onRequestAttachFile?: (artifact: ArtifactDetail) => void;
  onRequestPreview?: (preview: FilePreviewTarget) => void;
  onOpenTaskDetail?: (taskId: string) => void;
}) {
  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverAnchor asChild>
        <div
          className="pointer-events-none absolute"
          style={{
            left: anchorRect.x,
            top: anchorRect.y,
            width: anchorRect.width,
            height: anchorRect.height,
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="w-[min(360px,calc(100vw-1.5rem))] p-3"
      >
        <ArtifactQuickPopoverContent
          target={target}
          onClose={onClose}
          onRequestCreate={onRequestCreate}
          onRequestCreateVersion={onRequestCreateVersion}
          onRequestAddLocation={onRequestAddLocation}
          onRequestAttachFile={onRequestAttachFile}
          onRequestPreview={onRequestPreview}
          onOpenTaskDetail={onOpenTaskDetail}
        />
      </PopoverContent>
    </Popover>
  );
}
