import type {
  ArtifactDetail,
  ArtifactScope,
  TaskArtifactsResponse,
  WorkArtifactsResponse,
} from '@nw/shared';
import { useQuery } from '@tanstack/react-query';
import { PanelRightOpen, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { LocationActionRow } from '@/components/artifact/ArtifactCardList.js';
import { CreateArtifactModal } from '@/components/artifact/ArtifactFormModal.js';
import {
  CreateVersionModal,
  LocationFormModal,
} from '@/components/artifact/VersionAndLocationModals.js';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/overlays.js';

export type QuickPopoverTarget =
  | {
      kind: 'stage';
      worksheetId: string;
      taskId: string;
      taskTitle: string;
      stageColumnId: string;
      stageColumnName: string;
    }
  | {
      kind: 'work';
      worksheetId: string;
      workId: string;
      workName: string;
      focusArtifactId?: string;
    };

export function ArtifactQuickPopoverContent({
  target,
  onClose,
  onOpenTaskDetail,
}: {
  target: QuickPopoverTarget;
  onClose: () => void;
  onOpenTaskDetail?: (taskId: string) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [versionArtifact, setVersionArtifact] = useState<ArtifactDetail | null>(null);
  const [locationArtifact, setLocationArtifact] = useState<ArtifactDetail | null>(null);

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

  const createScope: ArtifactScope =
    target.kind === 'work'
      ? { kind: 'work', workId: target.workId }
      : { kind: 'stage', taskId: target.taskId, stageColumnId: target.stageColumnId };

  const scopeLabel =
    target.kind === 'work'
      ? `作品「${target.workName}」共用`
      : `任务「${target.taskTitle}」· ${target.stageColumnName}`;

  const defaultName = target.kind === 'stage' ? target.stageColumnName : '';

  return (
    <div data-testid="artifact-quick-popover" className="space-y-2.5">
      <div className="flex items-start justify-between gap-2 border-b border-black/[0.06] pb-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-zinc-950">
            {target.kind === 'work' ? `作品共用资源` : `${target.stageColumnName} · 工序资源`}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-zinc-500">
            {target.kind === 'work' ? target.workName : target.taskTitle}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-testid="quick-popover-add-btn"
            onClick={() => setCreateOpen(true)}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-zinc-900 px-2 text-[11px] font-medium text-white hover:bg-zinc-800 cursor-pointer"
          >
            <Plus className="h-3 w-3" />
            添加资源
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
          暂无资源，点击右上角「添加资源」粘贴网盘链接
        </div>
      ) : (
        <div className="no-scrollbar max-h-[300px] space-y-2 overflow-y-auto">
          {artifacts.map((art) => {
            const latest = art.latestVersion;
            return (
              <div
                key={art.id}
                data-testid={`quick-art-${art.id}`}
                className="rounded-lg border border-black/[0.07] bg-white p-2 space-y-1.5"
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs font-semibold text-zinc-900">{art.name}</span>
                    {latest && (
                      <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0 text-[10px] font-medium text-zinc-700 tabular-nums">
                        v{latest.versionNumber}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setVersionArtifact(art)}
                      className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-black/[0.04] hover:text-zinc-900 cursor-pointer"
                    >
                      + 新版本
                    </button>
                    {latest && (
                      <button
                        type="button"
                        onClick={() => setLocationArtifact(art)}
                        className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-black/[0.04] hover:text-zinc-900 cursor-pointer"
                      >
                        + 入口
                      </button>
                    )}
                  </div>
                </div>

                {latest?.note && <div className="text-[11px] text-zinc-500">{latest.note}</div>}

                {latest && latest.locations.length > 0 ? (
                  <div className="space-y-1">
                    {latest.locations.map((loc) => (
                      <LocationActionRow
                        key={loc.id}
                        artifact={art}
                        versionNumber={latest.versionNumber}
                        location={loc}
                        compact
                      />
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-zinc-400">待补充入口</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {target.kind === 'stage' && onOpenTaskDetail && (
        <div className="flex justify-end border-t border-black/[0.06] pt-2">
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenTaskDetail(target.taskId);
            }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-black/[0.05] hover:text-zinc-950 cursor-pointer"
          >
            <PanelRightOpen className="h-3.5 w-3.5" />
            在详情侧栏中管理全部历史
          </button>
        </div>
      )}

      <CreateArtifactModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        scope={createScope}
        scopeLabel={scopeLabel}
        defaultName={defaultName}
        worksheetId={target.worksheetId}
      />

      <CreateVersionModal
        open={Boolean(versionArtifact)}
        onOpenChange={(o) => {
          if (!o) setVersionArtifact(null);
        }}
        artifact={versionArtifact}
      />

      <LocationFormModal
        open={Boolean(locationArtifact && locationArtifact.latestVersion)}
        onOpenChange={(o) => {
          if (!o) setLocationArtifact(null);
        }}
        target={
          locationArtifact?.latestVersion
            ? {
                mode: 'create',
                artifact: locationArtifact,
                versionId: locationArtifact.latestVersion.id,
                versionNumber: locationArtifact.latestVersion.versionNumber,
              }
            : null
        }
      />
    </div>
  );
}

/**
 * 锚定在指定矩形坐标上的轻量快速取用浮层（用于 Canvas 工序格角标点击）。
 */
export function AnchoredArtifactQuickPopover({
  anchorRect,
  target,
  onClose,
  onOpenTaskDetail,
}: {
  anchorRect: { x: number; y: number; width: number; height: number };
  target: QuickPopoverTarget;
  onClose: () => void;
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
      <PopoverContent align="end" sideOffset={6} className="w-[min(360px,calc(100vw-1.5rem))] p-3">
        <ArtifactQuickPopoverContent
          target={target}
          onClose={onClose}
          onOpenTaskDetail={onOpenTaskDetail}
        />
      </PopoverContent>
    </Popover>
  );
}
