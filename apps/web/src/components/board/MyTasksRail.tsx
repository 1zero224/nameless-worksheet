import { type MyTaskItem, PRIORITY_LABELS } from '@nw/shared';
import {
  Check,
  Folder,
  ListTodo,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Play,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { TaskResourcesPopover } from '@/components/task/TaskResourcesPopover.js';
import { PRIORITY_STYLES, WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import { cn } from '@/components/ui/primitives.js';

const PANEL_SPRING = { type: 'spring', stiffness: 420, damping: 36 } as const;
const CARD_SPRING = {
  layout: { type: 'spring', stiffness: 460, damping: 34 },
  opacity: { duration: 0.16 },
} as const;

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
      <div className="rounded-lg border border-dashed border-black/[0.08] bg-white/70 px-3 py-6 text-center text-xs text-zinc-400">
        当前没有认领中的任务
        <div className="mt-1 text-xs text-zinc-400/80">可在右侧看板直接点击「认领」</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 进行中（浅黄） */}
      <div>
        <div className="mb-1.5 flex items-center justify-between px-0.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            <span className="text-xs font-semibold text-zinc-700">进行中</span>
          </div>
          <span className="rounded-full border border-amber-200/90 bg-amber-50 px-2 py-0 text-xs font-medium tabular-nums text-amber-900">
            {myInProgress.length}
          </span>
        </div>

        {myInProgress.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/[0.07] bg-white/60 py-2.5 text-center text-xs text-zinc-400">
            暂无进行中工序
          </div>
        ) : (
          <div data-testid="my-tasks-in-progress-list" className="space-y-1.5">
            <AnimatePresence mode="popLayout" initial={false}>
              {myInProgress.map((item) => {
                const itemKey = `${item.taskId}:${item.stageColumnId}`;
                const busy = updatingKey === itemKey;
                const wsColor =
                  WORKSHEET_COLOR_STYLES[item.worksheetColor] ?? WORKSHEET_COLOR_STYLES.sky;
                return (
                  <motion.div
                    key={itemKey}
                    layout="position"
                    initial={{ opacity: 0, y: 6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={CARD_SPRING}
                    data-testid={`my-in-progress-item-${item.taskId}-${item.stageColumnId}`}
                    data-card-state="in_progress"
                    className="rounded-lg border border-amber-200/90 border-l-[3px] border-l-amber-400 bg-[#FEFCE8] px-2.5 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[border-color,background-color,box-shadow] duration-150 hover:border-amber-300 hover:bg-[#FEF9C3]/75 hover:shadow-[0_4px_12px_-4px_rgba(0,0,0,0.08)]"
                  >
                    {item.workName && (
                      <div className="mb-0.5 flex items-center gap-1 text-xs text-zinc-500">
                        <Folder className="h-3 w-3 shrink-0 text-zinc-400" strokeWidth={1.75} />
                        <span className="truncate font-medium">{item.workName}</span>
                      </div>
                    )}

                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 items-start gap-1">
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
                          className="min-w-0 text-left text-sm font-semibold leading-snug text-zinc-950 transition-colors hover:text-blue-600 cursor-pointer"
                        >
                          {item.taskTitle}
                        </button>
                        {item.priority !== 'normal' && (
                          <span
                            className={cn(
                              'mt-0.5 shrink-0 rounded border px-1 py-0 text-[11px] font-medium leading-4',
                              PRIORITY_STYLES[item.priority],
                            )}
                          >
                            {PRIORITY_LABELS[item.priority]}
                          </span>
                        )}
                      </div>

                      <span
                        title={item.worksheetName}
                        className="mt-0.5 inline-flex max-w-[40%] shrink-0 items-center gap-1 text-xs text-zinc-400"
                      >
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', wsColor.dot)} />
                        <span className="truncate">{item.worksheetName}</span>
                      </span>
                    </div>

                    <div className="mt-1.5 flex items-center justify-between gap-1">
                      <span className="truncate text-xs font-medium text-amber-900">
                        {item.stageColumnName} · 进行中
                      </span>

                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onComplete(item)}
                          className="mr-0.5 inline-flex h-6 shrink-0 items-center gap-0.5 rounded border border-emerald-300/90 bg-white/95 px-1.5 text-xs font-medium text-emerald-800 transition-all duration-150 hover:border-emerald-400 hover:bg-emerald-50 active:scale-95 disabled:opacity-50 cursor-pointer"
                        >
                          <Check className="h-3 w-3" strokeWidth={2.25} />
                          完成
                        </button>

                        <TaskResourcesPopover
                          taskId={item.taskId}
                          taskTitle={item.taskTitle}
                          worksheetId={item.worksheetId}
                          workName={item.workName}
                          stageColumnName={item.stageColumnName}
                          onOpenDetail={onOpenDetail}
                        />

                        <button
                          type="button"
                          data-testid={`my-task-detail-btn-${item.taskId}-${item.stageColumnId}`}
                          aria-label={`查看任务详情 ${item.taskTitle}`}
                          title="查看任务详情"
                          onClick={() =>
                            onOpenDetail({ worksheetId: item.worksheetId, taskId: item.taskId })
                          }
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-black/[0.06] hover:text-zinc-900 cursor-pointer"
                        >
                          <PanelRightOpen className="h-3.5 w-3.5" strokeWidth={1.85} />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* 已认领待开始（纯白） */}
      <div>
        <div className="mb-1.5 flex items-center justify-between px-0.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-zinc-300" />
            <span className="text-xs font-semibold text-zinc-600">待开始</span>
          </div>
          <span className="rounded-full border border-black/[0.08] bg-white px-2 py-0 text-xs font-medium tabular-nums text-zinc-500">
            {myPending.length}
          </span>
        </div>

        {myPending.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/[0.07] bg-white/60 py-2.5 text-center text-xs text-zinc-400">
            暂无待开始工序
          </div>
        ) : (
          <div data-testid="my-tasks-pending-list" className="space-y-1.5">
            <AnimatePresence mode="popLayout" initial={false}>
              {myPending.map((item) => {
                const itemKey = `${item.taskId}:${item.stageColumnId}`;
                const busy = updatingKey === itemKey;
                const wsColor =
                  WORKSHEET_COLOR_STYLES[item.worksheetColor] ?? WORKSHEET_COLOR_STYLES.sky;
                return (
                  <motion.div
                    key={itemKey}
                    layout="position"
                    initial={{ opacity: 0, y: 6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={CARD_SPRING}
                    data-testid={`my-pending-item-${item.taskId}-${item.stageColumnId}`}
                    data-card-state="waiting"
                    className="rounded-lg border border-black/[0.08] bg-white px-2.5 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[border-color,box-shadow] duration-150 hover:border-black/[0.16] hover:shadow-[0_4px_12px_-4px_rgba(0,0,0,0.08)]"
                  >
                    {item.workName && (
                      <div className="mb-0.5 flex items-center gap-1 text-xs text-zinc-500">
                        <Folder className="h-3 w-3 shrink-0 text-zinc-400" strokeWidth={1.75} />
                        <span className="truncate font-medium">{item.workName}</span>
                      </div>
                    )}

                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 items-start gap-1">
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
                          className="min-w-0 text-left text-sm font-semibold leading-snug text-zinc-950 transition-colors hover:text-blue-600 cursor-pointer"
                        >
                          {item.taskTitle}
                        </button>
                        {item.priority !== 'normal' && (
                          <span
                            className={cn(
                              'mt-0.5 shrink-0 rounded border px-1 py-0 text-[11px] font-medium leading-4',
                              PRIORITY_STYLES[item.priority],
                            )}
                          >
                            {PRIORITY_LABELS[item.priority]}
                          </span>
                        )}
                      </div>

                      <span
                        title={item.worksheetName}
                        className="mt-0.5 inline-flex max-w-[40%] shrink-0 items-center gap-1 text-xs text-zinc-400"
                      >
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', wsColor.dot)} />
                        <span className="truncate">{item.worksheetName}</span>
                      </span>
                    </div>

                    <div className="mt-1.5 flex items-center justify-between gap-1">
                      <span className="truncate text-xs text-zinc-600">
                        {item.stageColumnName} · 未开始
                      </span>

                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onStart(item)}
                          className="mr-0.5 inline-flex h-6 shrink-0 items-center gap-0.5 rounded border border-amber-300/90 bg-amber-50/85 px-1.5 text-xs font-medium text-amber-900 transition-all duration-150 hover:border-amber-400 hover:bg-amber-100 active:scale-95 disabled:opacity-50 cursor-pointer"
                        >
                          <Play className="h-2.5 w-2.5 fill-current" />
                          开始
                        </button>

                        <TaskResourcesPopover
                          taskId={item.taskId}
                          taskTitle={item.taskTitle}
                          worksheetId={item.worksheetId}
                          workName={item.workName}
                          stageColumnName={item.stageColumnName}
                          onOpenDetail={onOpenDetail}
                        />

                        <button
                          type="button"
                          data-testid={`my-task-detail-btn-${item.taskId}-${item.stageColumnId}`}
                          aria-label={`查看任务详情 ${item.taskTitle}`}
                          title="查看任务详情"
                          onClick={() =>
                            onOpenDetail({ worksheetId: item.worksheetId, taskId: item.taskId })
                          }
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-black/[0.06] hover:text-zinc-900 cursor-pointer"
                        >
                          <PanelRightOpen className="h-3.5 w-3.5" strokeWidth={1.85} />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
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

  return (
    <motion.section
      layout
      initial={false}
      animate={{ width: collapsed ? 52 : 292 }}
      transition={PANEL_SPRING}
      aria-label="我的任务"
      data-testid="my-in-progress-bar"
      data-collapsed={collapsed ? 'true' : 'false'}
      className="hidden h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-black/[0.08] bg-[#f4f4f5]/65 md:flex"
    >
      {collapsed ? (
        <motion.div
          key="collapsed"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.16 }}
          className="flex h-full flex-col items-center py-2.5"
        >
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="展开我的任务"
            title="展开「我的任务」面板"
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.06] hover:text-zinc-900 cursor-pointer"
          >
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <span
            className={cn(
              'mt-2 rounded-full border px-2 py-0.25 text-xs font-medium tabular-nums',
              myInProgress.length > 0
                ? 'border-amber-200/90 bg-amber-50 text-amber-900'
                : 'border-black/[0.08] bg-white text-zinc-500',
            )}
          >
            {totalCount}
          </span>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="mt-2.5 flex flex-1 items-start justify-center cursor-pointer"
          >
            <span className="rounded-md bg-white px-1.5 py-2 text-xs font-medium tracking-wider text-zinc-700 shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-black/[0.06] [writing-mode:vertical-rl]">
              我的任务
            </span>
          </button>
        </motion.div>
      ) : (
        <motion.div
          key="expanded"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.16 }}
          className="flex h-full min-h-0 w-[292px] flex-col"
        >
          {/* 对齐 Teable 看板白底顶栏（紧凑 h-10 border-b bg-white） */}
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-black/[0.07] bg-white px-3">
            <div className="flex min-w-0 items-center gap-2">
              <ListTodo className="h-4 w-4 shrink-0 text-zinc-600" strokeWidth={1.75} />
              <h2 className="truncate text-sm font-semibold text-zinc-950">我的任务</h2>
              <span className="rounded-full border border-black/[0.08] bg-white px-2 py-0 text-xs font-medium tabular-nums text-zinc-500">
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
        </motion.div>
      )}
    </motion.section>
  );
}
