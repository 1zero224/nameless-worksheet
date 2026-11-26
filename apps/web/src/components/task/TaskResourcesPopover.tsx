import { ExternalLink, Folder, FolderDown, Paperclip } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/overlays.js';
import { cn } from '@/components/ui/primitives.js';

export interface TaskResourcesPopoverProps {
  taskId: string;
  taskTitle: string;
  worksheetId: string;
  workName?: string | null;
  stageColumnName?: string;
  onOpenDetail: (target: { worksheetId: string; taskId: string }) => void;
  className?: string;
}

/**
 * 任务可下载资源快速查看弹层（用于看板卡片与我的任务卡片）。
 * 阶段 3 接入 R2 文件与网盘入口后，直接在此展示可一键下载的最新版文件与网盘链接。
 */
export function TaskResourcesPopover({
  taskId,
  taskTitle,
  worksheetId,
  workName,
  stageColumnName,
  onOpenDetail,
  className,
}: TaskResourcesPopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={`card-resources-btn-${taskId}`}
          aria-label={`查看可下载资源 ${taskTitle}`}
          title="快速查看可下载资源"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-black/[0.06] hover:text-zinc-900 cursor-pointer',
            open && 'bg-black/[0.08] text-zinc-950',
            className,
          )}
        >
          <FolderDown className="h-3.5 w-3.5" strokeWidth={1.85} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        data-testid={`task-resources-popover-${taskId}`}
        onClick={(e) => e.stopPropagation()}
        className="w-72 p-3"
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

        <div className="mt-2.5 space-y-2.5">
          {workName && (
            <div className="rounded-lg border border-black/[0.07] bg-[#fafafa] px-2.5 py-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-800">
                <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-400" strokeWidth={1.75} />
                <span className="truncate">作品共用：{workName}</span>
              </div>
              <p className="mt-1 text-xs text-zinc-400">暂无整片原片或共用附件</p>
            </div>
          )}

          <div className="rounded-lg border border-dashed border-black/[0.12] bg-[#fafafa]/70 px-2.5 py-3 text-center">
            <Paperclip
              className="mx-auto h-4 w-4 text-zinc-400"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <div className="mt-1 text-xs font-medium text-zinc-600">暂无可下载文件或网盘链接</div>
            <div className="mt-0.5 text-[11px] text-zinc-400">
              阶段 3 接入文件上传与网盘入口后可在此一键下载
            </div>
          </div>
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
  );
}
