import {
  type BoardStageSummary,
  buildTaskShareUrl,
  type ColumnConfig,
  formatTaskShareText,
  getEffectiveStageCell,
  type ShareStageEntry,
  type TaskDetail,
  type WorksheetArtifactSummary,
} from '@nw/shared';
import { copyToClipboard } from '@/components/artifact/utils.js';

export function buildStagesFromTaskDetail(
  task: TaskDetail,
  columns: ColumnConfig[],
  artifactSummary?: WorksheetArtifactSummary | null,
): ShareStageEntry[] {
  return columns
    .filter((c) => c.type === 'stage')
    .map((col) => {
      const cell = getEffectiveStageCell(task, col.id);
      const badge = artifactSummary?.stageBadges[`${task.id}:${col.id}`];
      return {
        columnId: col.id,
        name: col.name,
        status: cell.status,
        assignees: cell.assignees,
        ...(col.hidden ? { hidden: true } : {}),
        ...(badge && badge.artifactCount > 0 ? { artifactCount: badge.artifactCount } : {}),
      };
    });
}

export function buildStagesFromBoardSummary(
  stageProgress: BoardStageSummary[] | undefined,
  overrideStage?: { columnId: string; status?: BoardStageSummary['status'] },
): ShareStageEntry[] {
  if (!stageProgress) return [];
  return stageProgress.map((s) => ({
    columnId: s.columnId,
    name: s.name,
    status:
      overrideStage && s.columnId === overrideStage.columnId && overrideStage.status
        ? overrideStage.status
        : s.status,
    assignees: s.assignees,
    ...(s.hidden ? { hidden: true } : {}),
    ...(typeof s.artifactCount === 'number' && s.artifactCount > 0
      ? { artifactCount: s.artifactCount }
      : {}),
  }));
}

export async function copyTaskOrStageShare(opts: {
  taskId: string;
  taskTitle: string;
  workName?: string | null;
  stages: ShareStageEntry[];
  userMap: ReadonlyMap<string, string>;
  focusStageColumnId?: string | null;
  focusStageName?: string | null;
}): Promise<{ ok: boolean; text: string; message: string }> {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = buildTaskShareUrl({
    origin,
    taskId: opts.taskId,
    stageColumnId: opts.focusStageColumnId ?? null,
  });
  const text = formatTaskShareText({
    workName: opts.workName ?? null,
    taskTitle: opts.taskTitle,
    stages: opts.stages,
    userMap: opts.userMap,
    url,
    focusStageColumnId: opts.focusStageColumnId ?? null,
  });
  const ok = await copyToClipboard(text);
  const stageLabel =
    opts.focusStageName ??
    (opts.focusStageColumnId
      ? (opts.stages.find((s) => s.columnId === opts.focusStageColumnId)?.name ?? null)
      : null);
  const message = ok
    ? stageLabel
      ? `已复制「${stageLabel}」工序分享`
      : '已复制任务进度与链接'
    : '复制失败，请手动复制';
  return { ok, text, message };
}
