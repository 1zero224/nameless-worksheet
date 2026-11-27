import { type MyTaskItem, PRIORITY_LABELS } from '@nw/shared';
import { Check, Folder, ListTodo, PanelLeftClose, PanelLeftOpen, Play, Share2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { TaskResourcesPopover } from '@/components/task/TaskResourcesPopover.js';
import { BOARD_CARD_STATE_STYLES, PRIORITY_STYLES } from '@/components/ui/colors.js';
import { cn } from '@/components/ui/primitives.js';

const PANEL_SPRING = { type: 'spring', stiffness: 420, damping: 36 } as const;
const CARD_SPRING = {
  layout: { type: 'spring', stiffness: 460, damping: 34 },
  opacity: { duration: 0.16 },
} as const;

const INLINE_ACTION_BTN_BASE =
  'inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs font-medium transition-colors duration-150 active:scale-[0.97] disabled:opacity-50 cursor-pointer';

export interface MyTasksListContentProps {
  myInProgress: MyTaskItem[];
  myPending: MyTaskItem[];
  updatingKey: string | null;
  onStart: (item: MyTaskItem) => void;
  onComplete: (item: MyTaskItem) => void;
  onOpenDetail: (target: { worksheetId: string; taskId: string }) => void;
  onShare?: (item: MyTaskItem) => void;
}

export function MyTasksListContent({
  myInProgress,
  myPending,
  updatingKey,
  onStart,
  onComplete,
  onOpenDetail,
  onShare,
}: MyTasksListContentProps) {
  const totalCount = myInProgress.length + myPending.length;

  if (totalCount === 0) {
    return (
      <div className="rounded-lg border border-dashed border-black/[0.08] bg-white/70 px-3 py-6 text-center text-xs text-zinc-400">
        当前没有认领中的任务
        <div className="mt-1 text-xs text-zinc-400/80">可在右侧看板直接点击「空缺」认领</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 进行中（浅黄，点击整卡打开详情） */}
      <div>
        <div className="mb-1.5 flex items-center justify-between px-0.5">
          <div className="flex items-center gap-1.5">
            <span
              className={cn('h-1.5 w-1.5 rounded-full', BOARD_CARD_STATE_STYLES.in_progress.dot)}
            />
            <span className="text-xs font-semibold text-zinc-700">进行中</span>
          </div>
          <span className="rounded-full bg-black/[0.05] px-2 py-0 text-xs font-medium tabular-nums text-zinc-500">
            {myInProgress.length}
          </span>
        </div>

        {myInProgress.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/[0.08] bg-[#fafafa]/70 py-2.5 text-center text-xs text-zinc-400">
            暂无进行中工序
          </div>
        ) : (
          <div data-testid="my-tasks-in-progress-list" className="space-y-1.5">
            <AnimatePresence mode="popLayout" initial={false}>
              {myInProgress.map((item) => {
                const itemKey = `${item.taskId}:${item.stageColumnId}`;
                const busy = updatingKey === itemKey;
                const stateStyle = BOARD_CARD_STATE_STYLES.in_progress;
                const openItemDetail = () =>
                  onOpenDetail({ worksheetId: item.worksheetId, taskId: item.taskId });

                return (
                  <motion.div
                    key={itemKey}
                    layout="position"
                    initial={{ opacity: 0, y: 6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={CARD_SPRING}
                    role="button"
                    tabIndex={0}
                    onClick={openItemDetail}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openItemDetail();
                      }
                    }}
                    data-testid={`my-in-progress-item-${item.taskId}-${item.stageColumnId}`}
                    data-card-state="in_progress"
                    className={cn(
                      'group cursor-pointer rounded-lg border px-2.5 py-2 transition-[border-color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60',
                      stateStyle.card,
                    )}
                  >
                    {item.workName && (
                      <div className="mb-0.5 flex items-center gap-1 text-xs text-zinc-500">
                        <Folder className="h-3 w-3 shrink-0 text-zinc-400" strokeWidth={1.75} />
                        <span className="truncate font-medium">{item.workName}</span>
                      </div>
                    )}

                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 items-start gap-1.5">
                        <span
                          title={
                            item.divisionNote
                              ? `${item.taskTitle} — ${item.divisionNote}`
                              : item.taskTitle
                          }
                          className={cn(
                            'min-w-0 text-left text-[13.5px] font-semibold leading-snug transition-colors',
                            stateStyle.title,
                          )}
                        >
                          {item.taskTitle}
                        </span>
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
                        className="mt-0.5 max-w-[40%] shrink-0 truncate text-xs text-zinc-400"
                      >
                        {item.worksheetName}
                      </span>
                    </div>

                    <div className="mt-1.5 flex items-center justify-between gap-1.5">
                      <div className="flex min-w-0 items-center gap-1.5 text-xs">
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', stateStyle.dot)} />
                        <span className={cn('truncate', stateStyle.statusText)}>
                          {item.stageColumnName} · 进行中
                        </span>
                      </div>

                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            onComplete(item);
                          }}
                          className={cn(INLINE_ACTION_BTN_BASE, stateStyle.actionBtn)}
                        >
                          <Check className="h-3 w-3" strokeWidth={2} />
                          完成
                        </button>

                        {onShare && (
                          <button
                            type="button"
                            data-testid={`my-task-share-btn-${item.taskId}-${item.stageColumnId}`}
                            aria-label={`分享 ${item.stageColumnName} 工序`}
                            title={`复制「${item.stageColumnName}」工序交接分享`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onShare(item);
                            }}
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-black/[0.06] hover:text-zinc-900 cursor-pointer"
                          >
                            <Share2 className="h-3.5 w-3.5" strokeWidth={1.85} />
                          </button>
                        )}

                        <TaskResourcesPopover
                          taskId={item.taskId}
                          taskTitle={item.taskTitle}
                          worksheetId={item.worksheetId}
                          workName={item.workName}
                          stageColumnId={item.stageColumnId}
                          stageColumnName={item.stageColumnName}
                          resourceCount={item.resourceCount}
                          onOpenDetail={onOpenDetail}
                        />
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* 已认领待开始（纯白，点击整卡打开详情） */}
      <div>
        <div className="mb-1.5 flex items-center justify-between px-0.5">
          <div className="flex items-center gap-1.5">
            <span className={cn('h-1.5 w-1.5 rounded-full', BOARD_CARD_STATE_STYLES.waiting.dot)} />
            <span className="text-xs font-semibold text-zinc-600">待开始</span>
          </div>
          <span className="rounded-full bg-black/[0.05] px-2 py-0 text-xs font-medium tabular-nums text-zinc-500">
            {myPending.length}
          </span>
        </div>

        {myPending.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/[0.08] bg-[#fafafa]/70 py-2.5 text-center text-xs text-zinc-400">
            暂无待开始工序
          </div>
        ) : (
          <div data-testid="my-tasks-pending-list" className="space-y-1.5">
            <AnimatePresence mode="popLayout" initial={false}>
              {myPending.map((item) => {
                const itemKey = `${item.taskId}:${item.stageColumnId}`;
                const busy = updatingKey === itemKey;
                const stateStyle = BOARD_CARD_STATE_STYLES.waiting;
                const openItemDetail = () =>
                  onOpenDetail({ worksheetId: item.worksheetId, taskId: item.taskId });

                return (
                  <motion.div
                    key={itemKey}
                    layout="position"
                    initial={{ opacity: 0, y: 6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={CARD_SPRING}
                    role="button"
                    tabIndex={0}
                    onClick={openItemDetail}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openItemDetail();
                      }
                    }}
                    data-testid={`my-pending-item-${item.taskId}-${item.stageColumnId}`}
                    data-card-state="waiting"
                    className={cn(
                      'group cursor-pointer rounded-lg border px-2.5 py-2 transition-[border-color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60',
                      stateStyle.card,
                    )}
                  >
                    {item.workName && (
                      <div className="mb-0.5 flex items-center gap-1 text-xs text-zinc-500">
                        <Folder className="h-3 w-3 shrink-0 text-zinc-400" strokeWidth={1.75} />
                        <span className="truncate font-medium">{item.workName}</span>
                      </div>
                    )}

                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 items-start gap-1.5">
                        <span
                          title={
                            item.divisionNote
                              ? `${item.taskTitle} — ${item.divisionNote}`
                              : item.taskTitle
                          }
                          className={cn(
                            'min-w-0 text-left text-[13.5px] font-semibold leading-snug transition-colors',
                            stateStyle.title,
                          )}
                        >
                          {item.taskTitle}
                        </span>
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
                        className="mt-0.5 max-w-[40%] shrink-0 truncate text-xs text-zinc-400"
                      >
                        {item.worksheetName}
                      </span>
                    </div>

                    <div className="mt-1.5 flex items-center justify-between gap-1.5">
                      <div className="flex min-w-0 items-center gap-1.5 text-xs">
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', stateStyle.dot)} />
                        <span className={cn('truncate', stateStyle.statusText)}>
                          {item.stageColumnName} · 未开始
                        </span>
                      </div>

                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            onStart(item);
                          }}
                          className={cn(INLINE_ACTION_BTN_BASE, stateStyle.actionBtn)}
                        >
                          <Play className="h-2.5 w-2.5 fill-current opacity-80" />
                          开始
                        </button>

                        {onShare && (
                          <button
                            type="button"
                            data-testid={`my-task-share-btn-${item.taskId}-${item.stageColumnId}`}
                            aria-label={`分享 ${item.stageColumnName} 工序`}
                            title={`复制「${item.stageColumnName}」工序进度与资源链接`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onShare(item);
                            }}
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.06] hover:text-zinc-900 cursor-pointer"
                          >
                            <Share2 className="h-3.5 w-3.5" strokeWidth={1.85} />
                          </button>
                        )}

                        <TaskResourcesPopover
                          taskId={item.taskId}
                          taskTitle={item.taskTitle}
                          worksheetId={item.worksheetId}
                          workName={item.workName}
                          stageColumnId={item.stageColumnId}
                          stageColumnName={item.stageColumnName}
                          resourceCount={item.resourceCount}
                          onOpenDetail={onOpenDetail}
                        />
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
  onShare,
}: MyTasksRailProps) {
  const totalCount = myInProgress.length + myPending.length;

  return (
    <motion.section
      layout
      transition={PANEL_SPRING}
      aria-label="我的任务"
      data-testid="my-in-progress-bar"
      data-collapsed={collapsed ? 'true' : 'false'}
      className={cn(
        'hidden h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-black/[0.08] bg-white md:flex',
        collapsed
          ? 'w-[52px] min-w-[52px] max-w-[52px]'
          : 'w-[clamp(244px,19vw,288px)] min-w-[244px] max-w-[288px]',
      )}
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
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-900 cursor-pointer"
          >
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <span className="mt-2 rounded-full bg-zinc-100 px-2 py-0.25 text-xs font-medium tabular-nums text-zinc-500">
            {totalCount}
          </span>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="mt-3 flex flex-1 items-start justify-center cursor-pointer"
          >
            <span className="text-xs font-semibold tracking-wider text-zinc-900 [writing-mode:vertical-rl]">
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
          className="flex h-full min-h-0 w-full flex-col"
        >
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-black/[0.06] bg-white px-3">
            <div className="flex min-w-0 items-center gap-2">
              <ListTodo className="h-3.5 w-3.5 shrink-0 text-zinc-500" strokeWidth={1.75} />
              <h2 className="truncate text-sm font-semibold text-zinc-900">我的任务</h2>
              <span className="rounded-full bg-zinc-100 px-2 py-0 text-xs font-medium tabular-nums text-zinc-500">
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
              onShare={onShare}
            />
          </div>
        </motion.div>
      )}
    </motion.section>
  );
}
