import { type MyTaskItem, PRIORITY_LABELS } from '@nw/shared';
import { Check, Folder, ListTodo, PanelLeftClose, PanelLeftOpen, Play } from 'lucide-react';
import { PRIORITY_STYLES, WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import { cn } from '@/components/ui/primitives.js';

export interface MyTasksListContentProps {
  myInProgress: MyTaskItem[];
  myPending: MyTaskItem[];
  updatingKey: string | null;
  onStart: (item: MyTaskItem) => void;
  onComplete: (item: MyTaskItem) => void;
  onOpenDetail: (target: { worksheetId: string; taskId: string }) => void;
}

export function MyTasksListContent({
  myInProgress,
  myPending,
  updatingKey,
  onStart,
  onComplete,
  onOpenDetail,
}: MyTasksListContentProps) {
  const totalCount = myInProgress.length + myPending.length;

  if (totalCount === 0) {
    return (
      <div className="rounded-lg border border-dashed border-black/[0.08] bg-white/60 px-3 py-8 text-center text-xs text-zinc-400">
        当前没有认领中的任务
        <div className="mt-1 text-[11px] text-zinc-400/80">可在右侧看板直接点击「认领」</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 进行中（浅黄） */}
      <div>
        <div className="mb-1.5 flex items-center justify-between px-0.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            <span className="text-[11px] font-semibold text-zinc-700">进行中</span>
          </div>
          <span className="rounded-full bg-amber-100/90 px-1.5 py-0 text-[10px] font-medium tabular-nums text-amber-900">
            {myInProgress.length}
          </span>
        </div>

        {myInProgress.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/[0.07] bg-white/50 py-3 text-center text-[11px] text-zinc-400">
            暂无进行中工序
          </div>
        ) : (
          <div data-testid="my-tasks-in-progress-list" className="space-y-2">
            {myInProgress.map((item) => {
              const itemKey = `${item.taskId}:${item.stageColumnId}`;
              const busy = updatingKey === itemKey;
              const wsColor =
                WORKSHEET_COLOR_STYLES[item.worksheetColor] ?? WORKSHEET_COLOR_STYLES.sky;
              return (
                <div
                  key={itemKey}
                  data-testid={`my-in-progress-item-${item.taskId}-${item.stageColumnId}`}
                  data-card-state="in_progress"
                  className="rounded-lg border border-amber-200/90 border-l-[3px] border-l-amber-400 bg-[#FEFCE8] p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors hover:border-amber-300 hover:bg-[#FEF9C3]/70"
                >
                  {item.workName && (
                    <div className="mb-1 flex items-center gap-1 text-[11px] text-indigo-700/90">
                      <Folder className="h-3 w-3 shrink-0 text-indigo-500" strokeWidth={1.75} />
                      <span className="truncate font-medium">{item.workName}</span>
                    </div>
                  )}

                  <div className="flex items-start justify-between gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        onOpenDetail({ worksheetId: item.worksheetId, taskId: item.taskId })
                      }
                      title={
                        item.divisionNote
                          ? `${item.taskTitle} — ${item.divisionNote}`
                          : item.taskTitle
                      }
                      className="min-w-0 flex-1 text-left text-[13px] font-semibold leading-snug text-zinc-950 hover:text-blue-600 cursor-pointer"
                    >
                      {item.taskTitle}
                    </button>
                    {item.priority !== 'normal' && (
                      <span
                        className={cn(
                          'shrink-0 rounded border px-1 py-0 text-[10px] font-medium leading-4',
                          PRIORITY_STYLES[item.priority],
                        )}
                      >
                        {PRIORITY_LABELS[item.priority]}
                      </span>
                    )}
                  </div>

                  <div className="mt-2 flex items-center justify-between gap-1.5">
                    <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', wsColor.dot)} />
                      <span className="truncate text-amber-900 font-medium">
                        {item.stageColumnName} · 进行中
                      </span>
                    </div>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onComplete(item)}
                      className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded border border-emerald-300/90 bg-white/90 px-1.5 text-[11px] font-medium text-emerald-800 transition-colors hover:bg-emerald-50 hover:border-emerald-400 disabled:opacity-50 cursor-pointer"
                    >
                      <Check className="h-3 w-3" strokeWidth={2.25} />
                      完成
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 已认领待开始（纯白） */}
      <div>
        <div className="mb-1.5 flex items-center justify-between px-0.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-zinc-300" />
            <span className="text-[11px] font-semibold text-zinc-600">待开始</span>
          </div>
          <span className="rounded-full bg-white px-1.5 py-0 text-[10px] font-medium tabular-nums text-zinc-500 ring-1 ring-black/[0.08]">
            {myPending.length}
          </span>
        </div>

        {myPending.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/[0.07] bg-white/50 py-3 text-center text-[11px] text-zinc-400">
            暂无待开始工序
          </div>
        ) : (
          <div data-testid="my-tasks-pending-list" className="space-y-2">
            {myPending.map((item) => {
              const itemKey = `${item.taskId}:${item.stageColumnId}`;
              const busy = updatingKey === itemKey;
              const wsColor =
                WORKSHEET_COLOR_STYLES[item.worksheetColor] ?? WORKSHEET_COLOR_STYLES.sky;
              return (
                <div
                  key={itemKey}
                  data-testid={`my-pending-item-${item.taskId}-${item.stageColumnId}`}
                  data-card-state="waiting"
                  className="rounded-lg border border-black/[0.08] bg-white p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors hover:border-black/[0.15]"
                >
                  {item.workName && (
                    <div className="mb-1 flex items-center gap-1 text-[11px] text-indigo-700/90">
                      <Folder className="h-3 w-3 shrink-0 text-indigo-500" strokeWidth={1.75} />
                      <span className="truncate font-medium">{item.workName}</span>
                    </div>
                  )}

                  <div className="flex items-start justify-between gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        onOpenDetail({ worksheetId: item.worksheetId, taskId: item.taskId })
                      }
                      title={
                        item.divisionNote
                          ? `${item.taskTitle} — ${item.divisionNote}`
                          : item.taskTitle
                      }
                      className="min-w-0 flex-1 text-left text-[13px] font-semibold leading-snug text-zinc-950 hover:text-blue-600 cursor-pointer"
                    >
                      {item.taskTitle}
                    </button>
                    {item.priority !== 'normal' && (
                      <span
                        className={cn(
                          'shrink-0 rounded border px-1 py-0 text-[10px] font-medium leading-4',
                          PRIORITY_STYLES[item.priority],
                        )}
                      >
                        {PRIORITY_LABELS[item.priority]}
                      </span>
                    )}
                  </div>

                  <div className="mt-2 flex items-center justify-between gap-1.5">
                    <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', wsColor.dot)} />
                      <span className="truncate text-zinc-600">
                        {item.stageColumnName} · 未开始
                      </span>
                    </div>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onStart(item)}
                      className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded border border-amber-300/90 bg-amber-50/80 px-1.5 text-[11px] font-medium text-amber-900 transition-colors hover:bg-amber-100 hover:border-amber-400 disabled:opacity-50 cursor-pointer"
                    >
                      <Play className="h-2.5 w-2.5 fill-current" />
                      开始
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export interface MyTasksRailProps extends MyTasksListContentProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function MyTasksRail({
  myInProgress,
  myPending,
  updatingKey,
  collapsed,
  onToggleCollapsed,
  onStart,
  onComplete,
  onOpenDetail,
}: MyTasksRailProps) {
  const totalCount = myInProgress.length + myPending.length;

  if (collapsed) {
    return (
      <section
        aria-label="我的任务"
        data-testid="my-in-progress-bar"
        data-collapsed="true"
        className="hidden h-full w-12 shrink-0 flex-col items-center border-r border-black/[0.08] bg-[#fafafa] py-3 transition-[width] duration-200 md:flex"
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="展开我的任务"
          title="展开「我的任务」面板"
          className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-900 cursor-pointer"
        >
          <PanelLeftOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
        <span
          className={cn(
            'mt-2 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums ring-1',
            myInProgress.length > 0
              ? 'bg-amber-100/90 text-amber-900 ring-amber-300/70'
              : 'bg-white text-zinc-500 ring-black/[0.08]',
          )}
        >
          {totalCount}
        </span>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="mt-3 flex flex-1 items-start justify-center cursor-pointer"
        >
          <span className="rounded-md bg-zinc-200/75 px-1 py-2 text-xs font-medium tracking-wider text-zinc-800 [writing-mode:vertical-rl]">
            我的任务
          </span>
        </button>
      </section>
    );
  }

  return (
    <section
      aria-label="我的任务"
      data-testid="my-in-progress-bar"
      data-collapsed="false"
      className="hidden h-full min-h-0 w-[264px] shrink-0 flex-col border-r border-black/[0.08] bg-[#fafafa] transition-[width] duration-200 md:flex lg:w-[276px]"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-black/[0.06] px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <ListTodo className="h-3.5 w-3.5 shrink-0 text-zinc-600" strokeWidth={1.75} />
          <h2 className="truncate text-xs font-semibold text-zinc-900">我的任务</h2>
          <span className="rounded-full bg-white px-1.5 py-0 text-[11px] font-medium tabular-nums text-zinc-600 ring-1 ring-black/[0.08]">
            {totalCount}
          </span>
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="折叠我的任务"
          title="折叠「我的任务」面板"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-800 cursor-pointer"
        >
          <PanelLeftClose className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-2.5">
        <MyTasksListContent
          myInProgress={myInProgress}
          myPending={myPending}
          updatingKey={updatingKey}
          onStart={onStart}
          onComplete={onComplete}
          onOpenDetail={onOpenDetail}
        />
      </div>
    </section>
  );
}
