import { type BoardCard, type BoardColumn, PRIORITY_LABELS, STAGE_STATUS_LABELS } from '@nw/shared';
import { ChevronDown, Folder, Hand, Minimize2, PanelLeftOpen } from 'lucide-react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { TaskResourcesPopover } from '@/components/task/TaskResourcesPopover.js';
import {
  BOARD_CARD_STATE_STYLES,
  type BoardCardVisualState,
  PRIORITY_STYLES,
  WORKSHEET_COLOR_STYLES,
} from '@/components/ui/colors.js';
import { cn } from '@/components/ui/primitives.js';

// 参考 Teable 单选胶囊低饱和柔和配色
const COLUMN_PILL_STYLES = [
  'bg-sky-100/85 text-sky-900',
  'bg-amber-100/85 text-amber-900',
  'bg-emerald-100/85 text-emerald-900',
  'bg-violet-100/85 text-violet-900',
  'bg-rose-100/85 text-rose-900',
  'bg-zinc-200/80 text-zinc-800',
] as const;

const COLUMN_SPRING = { type: 'spring', stiffness: 420, damping: 36 } as const;
const CARD_TRANSITION = {
  layout: { type: 'spring', stiffness: 460, damping: 34 },
  opacity: { duration: 0.16 },
} as const;

const STATE_SORT_RANK: Record<BoardCardVisualState, number> = {
  missing: 0,
  in_progress: 1,
  waiting: 2,
};

interface WorkGroupItem {
  kind: 'work-group';
  key: string;
  workKey: string;
  worksheetId: string;
  worksheetName: string;
  worksheetColor: BoardCard['worksheetColor'];
  workId: string;
  workName: string;
  cards: BoardCard[];
}

interface StandaloneItem {
  kind: 'standalone';
  key: string;
  workKey: string | null;
  card: BoardCard;
}

type ColumnDisplayItem = WorkGroupItem | StandaloneItem;

function getBoardCardState(card: BoardCard): BoardCardVisualState {
  if (card.stageStatus === 'in_progress') return 'in_progress';
  if (card.stageStatus === 'not_started' && card.stageAssignees.length === 0) return 'missing';
  return 'waiting';
}

function getCardSortRank(card: BoardCard): number {
  return STATE_SORT_RANK[getBoardCardState(card)];
}

function getDisplayItemSortRank(item: ColumnDisplayItem): number {
  if (item.kind === 'standalone') return getCardSortRank(item.card);
  let best = 2;
  for (const c of item.cards) {
    const r = getCardSortRank(c);
    if (r < best) best = r;
  }
  return best;
}

function buildColumnDisplayItems(colCards: BoardCard[]): ColumnDisplayItem[] {
  const workCounts = new Map<string, number>();
  for (const card of colCards) {
    if (card.workId && card.workName) {
      const wk = `${card.worksheetId}:${card.workId}`;
      workCounts.set(wk, (workCounts.get(wk) ?? 0) + 1);
    }
  }

  const items: ColumnDisplayItem[] = [];
  const workGroupMap = new Map<string, WorkGroupItem>();

  for (const card of colCards) {
    const workKey = card.workId && card.workName ? `${card.worksheetId}:${card.workId}` : null;
    if (!workKey || (workCounts.get(workKey) ?? 0) < 2) {
      items.push({
        kind: 'standalone',
        key: `${card.taskId}:${card.boardColumnId}`,
        workKey,
        card,
      });
      continue;
    }

    const existing = workGroupMap.get(workKey);
    if (existing) {
      existing.cards.push(card);
    } else {
      const group: WorkGroupItem = {
        kind: 'work-group',
        key: workKey,
        workKey,
        worksheetId: card.worksheetId,
        worksheetName: card.worksheetName,
        worksheetColor: card.worksheetColor,
        workId: card.workId!,
        workName: card.workName!,
        cards: [card],
      };
      workGroupMap.set(workKey, group);
      items.push(group);
    }
  }

  for (const group of workGroupMap.values()) {
    group.cards.sort((a, b) => getCardSortRank(a) - getCardSortRank(b));
  }

  items.sort((a, b) => getDisplayItemSortRank(a) - getDisplayItemSortRank(b));

  return items;
}

export interface KanbanBoardProps {
  boardColumns: BoardColumn[];
  cards: BoardCard[];
  userMap: Map<string, string>;
  claimingKeys: Set<string>;
  currentUserId?: string | null;
  onlyMissing?: boolean;
  showWorksheetSource?: boolean;
  onClaim: (taskId: string, columnId: string, stageName: string) => void | Promise<void>;
  onOpenDetail: (target: { worksheetId: string; taskId: string }) => void;
}

export function KanbanBoard({
  boardColumns,
  cards,
  userMap,
  claimingKeys,
  currentUserId = null,
  onlyMissing = false,
  showWorksheetSource = true,
  onClaim,
  onOpenDetail,
}: KanbanBoardProps) {
  const [collapsedCols, setCollapsedCols] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [hoveredWorkKey, setHoveredWorkKey] = useState<string | null>(null);

  const cardsByBoardCol = useMemo(() => {
    const map = new Map<string, BoardCard[]>();
    for (const bc of boardColumns) {
      map.set(bc.id, []);
    }
    for (const card of cards) {
      const list = map.get(card.boardColumnId);
      if (list) list.push(card);
    }
    return map;
  }, [boardColumns, cards]);

  const toggleColumnCollapsed = (colId: string) => {
    setCollapsedCols((prev) => {
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId);
      else next.add(colId);
      return next;
    });
  };

  const toggleGroupCollapsed = (groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const formatAssignees = (assignees: BoardCard['stageAssignees']) =>
    assignees
      .map((a) => (a.type === 'user' ? (userMap.get(a.userId) ?? '未知用户') : a.name))
      .join('、');

  const formatStageStatusLine = (card: BoardCard) => {
    const assigneesText = formatAssignees(card.stageAssignees);
    if (assigneesText) {
      return `${card.stageColumnName} · ${assigneesText} · ${STAGE_STATUS_LABELS[card.stageStatus]}`;
    }
    if (card.stageStatus === 'in_progress') {
      return `${card.stageColumnName} · 缺人 · ${STAGE_STATUS_LABELS.in_progress}`;
    }
    return `${card.stageColumnName} · 缺人`;
  };

  const isAssignedToMe = (card: BoardCard) =>
    Boolean(
      currentUserId &&
        card.stageAssignees.some((a) => a.type === 'user' && a.userId === currentUserId),
    );

  const renderOtherMissing = (card: BoardCard, compact = false) => {
    const otherMissing = card.missingStages.filter((ms) => ms.columnId !== card.stageColumnId);
    if (otherMissing.length === 0) return null;

    if (onlyMissing) {
      return (
        <div
          className={cn(
            'relative z-10 flex flex-wrap gap-1 border-t border-black/[0.06] pt-1',
            compact ? 'mt-1' : 'mt-1.5',
          )}
        >
          {otherMissing.map((ms) => {
            const claimKey = `${card.taskId}:${ms.columnId}`;
            const claiming = claimingKeys.has(claimKey);
            return (
              <button
                key={ms.columnId}
                type="button"
                disabled={claiming}
                onClick={(e) => {
                  e.stopPropagation();
                  void onClaim(card.taskId, ms.columnId, ms.name);
                }}
                className="inline-flex items-center gap-0.5 rounded border border-red-200/90 bg-white/95 px-1.5 py-0.5 text-xs font-medium text-red-700 transition-all duration-150 hover:border-red-300 hover:bg-red-50 active:scale-95 disabled:opacity-50 cursor-pointer"
              >
                <Hand className="h-3 w-3" />
                {claiming ? '认领中…' : `缺 ${ms.name}`}
              </button>
            );
          })}
        </div>
      );
    }

    return (
      <div
        className={cn(
          'pointer-events-none relative z-10 truncate text-xs text-zinc-400',
          compact ? 'mt-0.5' : 'mt-1 border-t border-black/[0.05] pt-1',
        )}
      >
        还缺 {otherMissing.map((m) => m.name).join(' · ')}
      </div>
    );
  };

  return (
    <LayoutGroup id="kanban-board">
      <div
        data-testid="board-columns"
        className="no-scrollbar flex min-h-0 flex-1 gap-3.5 overflow-x-auto bg-white p-3"
      >
        {boardColumns.map((bc, colIdx) => {
          const colCards = cardsByBoardCol.get(bc.id) ?? [];
          const displayItems = buildColumnDisplayItems(colCards);
          const isCollapsed = collapsedCols.has(bc.id);
          const pillStyle =
            COLUMN_PILL_STYLES[colIdx % COLUMN_PILL_STYLES.length] ?? COLUMN_PILL_STYLES[0];

          return (
            <motion.div
              key={bc.id}
              layout
              initial={false}
              animate={{ width: isCollapsed ? 52 : 308 }}
              transition={COLUMN_SPRING}
              data-testid={`board-col-${bc.id}`}
              data-board-column-name={bc.name}
              data-collapsed={isCollapsed ? 'true' : 'false'}
              className={cn(
                'flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-xl border border-black/[0.08] bg-[#f4f4f5]/75',
                isCollapsed && 'hover:bg-zinc-200/60 transition-colors',
              )}
            >
              {isCollapsed ? (
                <motion.div
                  key="col-collapsed"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.16 }}
                  className="flex h-full flex-col items-center py-2.5"
                >
                  <button
                    type="button"
                    onClick={() => toggleColumnCollapsed(bc.id)}
                    aria-label={`展开列 ${bc.name}`}
                    title={`展开「${bc.name}」列`}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.06] hover:text-zinc-900 cursor-pointer"
                  >
                    <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                  <span className="mt-2 rounded-full border border-black/[0.08] bg-white px-2 py-0.25 text-xs font-medium tabular-nums text-zinc-500">
                    {colCards.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleColumnCollapsed(bc.id)}
                    className="mt-2.5 flex flex-1 items-start justify-center cursor-pointer"
                  >
                    <span
                      className={cn(
                        'rounded-md px-1.5 py-2 text-xs font-medium tracking-wider [writing-mode:vertical-rl]',
                        pillStyle,
                      )}
                    >
                      {bc.name}
                    </span>
                  </button>
                </motion.div>
              ) : (
                <motion.div
                  key="col-expanded"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.16 }}
                  className="flex h-full min-h-0 w-[308px] flex-col"
                >
                  {/* Teable 双层列顶栏 */}
                  <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-black/[0.07] bg-white px-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <h2
                        className={cn(
                          'truncate rounded-md px-2 py-0.5 text-sm font-semibold leading-5',
                          pillStyle,
                        )}
                      >
                        {bc.name}
                      </h2>
                      <span className="shrink-0 rounded-full border border-black/[0.08] bg-white px-2 py-0 text-xs font-medium tabular-nums text-zinc-500">
                        {colCards.length}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleColumnCollapsed(bc.id)}
                      aria-label={`折叠列 ${bc.name}`}
                      title={`竖向折叠「${bc.name}」列`}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-800 cursor-pointer"
                    >
                      <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                  </div>

                  {/* 紧凑卡片列表 */}
                  <div className="no-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
                    {displayItems.length === 0 ? (
                      <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-black/[0.08] bg-white/60 text-xs text-zinc-400">
                        暂无任务
                      </div>
                    ) : (
                      <AnimatePresence mode="popLayout" initial={false}>
                        {displayItems.map((item) => {
                          if (item.kind === 'standalone') {
                            const { card, workKey } = item;
                            const cardState = getBoardCardState(card);
                            const stateStyle = BOARD_CARD_STATE_STYLES[cardState];
                            const wsColor =
                              WORKSHEET_COLOR_STYLES[card.worksheetColor] ??
                              WORKSHEET_COLOR_STYLES.sky;
                            const currentStageMissing = card.missingStages.find(
                              (ms) => ms.columnId === card.stageColumnId,
                            );
                            const currentClaimKey = `${card.taskId}:${card.stageColumnId}`;
                            const claimingCurrent = claimingKeys.has(currentClaimKey);
                            const isWorkHighlighted = Boolean(
                              workKey && hoveredWorkKey === workKey,
                            );
                            const mine = isAssignedToMe(card);
                            const openCardDetail = () =>
                              onOpenDetail({
                                worksheetId: card.worksheetId,
                                taskId: card.taskId,
                              });

                            return (
                              <motion.div
                                key={item.key}
                                layout="position"
                                initial={{ opacity: 0, y: 6, scale: 0.98 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.96 }}
                                transition={CARD_TRANSITION}
                                role="button"
                                tabIndex={0}
                                onClick={openCardDetail}
                                onKeyDown={(e) => {
                                  if (e.target !== e.currentTarget) return;
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    openCardDetail();
                                  }
                                }}
                                data-testid={`board-card-${card.taskId}-${card.boardColumnId}`}
                                data-card-state={cardState}
                                data-work-name={card.workName ?? undefined}
                                onPointerEnter={
                                  workKey ? () => setHoveredWorkKey(workKey) : undefined
                                }
                                onPointerLeave={
                                  workKey
                                    ? () =>
                                        setHoveredWorkKey((prev) =>
                                          prev === workKey ? null : prev,
                                        )
                                    : undefined
                                }
                                className={cn(
                                  'group cursor-pointer rounded-lg border px-2.5 py-2 transition-[border-color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/70',
                                  stateStyle.card,
                                  isWorkHighlighted && 'ring-2 ring-zinc-400/75',
                                )}
                              >
                                {card.workId && card.workName && (
                                  <div className="mb-0.5 flex items-center gap-1 text-xs text-zinc-500">
                                    <Folder
                                      className="h-3 w-3 shrink-0 text-zinc-400"
                                      strokeWidth={1.75}
                                    />
                                    <span className="truncate font-medium">{card.workName}</span>
                                  </div>
                                )}

                                {/* 第 1 层：标题 + 优先级角标（左） | 所属工作表（右） */}
                                <div className="flex items-start justify-between gap-2">
                                  <div className="flex min-w-0 flex-1 items-start gap-1.5">
                                    <span
                                      title={
                                        card.divisionNote
                                          ? `${card.taskTitle} — ${card.divisionNote}`
                                          : card.taskTitle
                                      }
                                      className="min-w-0 text-left text-sm font-semibold leading-snug text-zinc-950 transition-colors group-hover:text-blue-600"
                                    >
                                      {card.taskTitle}
                                    </span>

                                    {card.priority !== 'normal' && (
                                      <span
                                        className={cn(
                                          'mt-0.5 shrink-0 rounded border px-1 py-0 text-[11px] font-medium leading-4',
                                          PRIORITY_STYLES[card.priority],
                                        )}
                                      >
                                        {PRIORITY_LABELS[card.priority]}
                                      </span>
                                    )}
                                  </div>

                                  {showWorksheetSource && (
                                    <span
                                      title={card.worksheetName}
                                      className="mt-0.5 inline-flex max-w-[40%] shrink-0 items-center gap-1 text-xs text-zinc-400"
                                    >
                                      <span
                                        className={cn(
                                          'h-1.5 w-1.5 shrink-0 rounded-full',
                                          wsColor.dot,
                                        )}
                                      />
                                      <span className="truncate">{card.worksheetName}</span>
                                    </span>
                                  )}
                                </div>

                                {/* 第 2 层：本列「工序 · 负责人 · 状态」+ 认领 / 快速查看可下载资源 */}
                                <div className="mt-1.5 flex items-center justify-between gap-1.5">
                                  <div className="flex min-w-0 items-center gap-1.5 text-xs">
                                    <span
                                      className={cn(
                                        'h-1.5 w-1.5 shrink-0 rounded-full',
                                        stateStyle.dot,
                                      )}
                                    />
                                    <span className={cn('truncate', stateStyle.statusText)}>
                                      {formatStageStatusLine(card)}
                                    </span>
                                    {mine && (
                                      <span className="shrink-0 rounded bg-black/[0.06] px-1 py-0 text-[11px] font-medium text-zinc-700">
                                        我
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex shrink-0 items-center gap-0.5">
                                    {currentStageMissing && (
                                      <button
                                        type="button"
                                        disabled={claimingCurrent}
                                        aria-label={`认领 ${currentStageMissing.name}`}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void onClaim(
                                            card.taskId,
                                            currentStageMissing.columnId,
                                            currentStageMissing.name,
                                          );
                                        }}
                                        className="mr-0.5 inline-flex h-6 shrink-0 items-center gap-0.5 rounded border border-red-300/90 bg-white/95 px-1.5 text-xs font-medium text-red-700 transition-all duration-150 hover:border-red-400 hover:bg-red-50 active:scale-95 disabled:opacity-50 cursor-pointer"
                                      >
                                        <Hand className="h-3 w-3" />
                                        {claimingCurrent ? '认领中…' : '认领'}
                                      </button>
                                    )}

                                    <TaskResourcesPopover
                                      taskId={card.taskId}
                                      taskTitle={card.taskTitle}
                                      worksheetId={card.worksheetId}
                                      workName={card.workName}
                                      stageColumnName={card.stageColumnName}
                                      onOpenDetail={onOpenDetail}
                                    />
                                  </div>
                                </div>

                                {renderOtherMissing(card, false)}
                              </motion.div>
                            );
                          }

                          // 作品父容器（扁平无阴影 + 树形引导线）
                          const collapseKey = `${bc.id}:${item.key}`;
                          const isExpanded = !collapsedGroups.has(collapseKey);
                          const wsColor =
                            WORKSHEET_COLOR_STYLES[item.worksheetColor] ??
                            WORKSHEET_COLOR_STYLES.sky;
                          const missingCount = item.cards.filter(
                            (c) => getBoardCardState(c) === 'missing',
                          ).length;
                          const inProgressCount = item.cards.filter(
                            (c) => getBoardCardState(c) === 'in_progress',
                          ).length;
                          const waitingCount = item.cards.length - missingCount - inProgressCount;
                          const isWorkHighlighted = hoveredWorkKey === item.workKey;

                          return (
                            <motion.section
                              key={collapseKey}
                              layout="position"
                              initial={{ opacity: 0, y: 6, scale: 0.98 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.96 }}
                              transition={CARD_TRANSITION}
                              aria-label={`作品 ${item.workName}`}
                              data-testid={`board-work-group-${item.workId}-${bc.id}`}
                              data-work-name={item.workName}
                              data-expanded={isExpanded ? 'true' : 'false'}
                              onPointerEnter={() => setHoveredWorkKey(item.workKey)}
                              onPointerLeave={() =>
                                setHoveredWorkKey((prev) => (prev === item.workKey ? null : prev))
                              }
                              className={cn(
                                'overflow-hidden rounded-lg border border-black/[0.08] bg-white transition-[border-color] duration-150 hover:border-black/[0.16]',
                                isWorkHighlighted && 'ring-2 ring-zinc-400/75',
                              )}
                            >
                              <button
                                type="button"
                                onClick={() => toggleGroupCollapsed(collapseKey)}
                                aria-expanded={isExpanded}
                                aria-label={
                                  isExpanded
                                    ? `收起作品 ${item.workName} 分段`
                                    : `展开作品 ${item.workName} 分段`
                                }
                                className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left transition-colors hover:bg-black/[0.02] cursor-pointer"
                              >
                                <span className="flex min-w-0 flex-1 items-center gap-1">
                                  <motion.span
                                    initial={false}
                                    animate={{ rotate: isExpanded ? 0 : -90 }}
                                    transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
                                    className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500"
                                  >
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  </motion.span>
                                  <span className="truncate text-sm font-semibold leading-snug text-zinc-950">
                                    {item.workName}
                                  </span>
                                </span>

                                {showWorksheetSource && (
                                  <span
                                    title={item.worksheetName}
                                    className="inline-flex max-w-[40%] shrink-0 items-center gap-1 text-xs text-zinc-400"
                                  >
                                    <span
                                      className={cn(
                                        'h-1.5 w-1.5 shrink-0 rounded-full',
                                        wsColor.dot,
                                      )}
                                    />
                                    <span className="truncate">{item.worksheetName}</span>
                                  </span>
                                )}
                              </button>

                              {/* 折叠态摘要 */}
                              <AnimatePresence initial={false}>
                                {!isExpanded && (
                                  <motion.div
                                    key="summary"
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
                                    className="overflow-hidden border-t border-black/[0.05]"
                                  >
                                    <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 pl-7 text-xs text-zinc-500">
                                      <span className="tabular-nums">{item.cards.length} 段</span>
                                      <div className="flex items-center gap-2 text-xs tabular-nums">
                                        {missingCount > 0 && (
                                          <span className="inline-flex items-center gap-1 font-medium text-red-700">
                                            <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                                            缺人 {missingCount}
                                          </span>
                                        )}
                                        {inProgressCount > 0 && (
                                          <span className="inline-flex items-center gap-1 font-medium text-amber-800">
                                            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                                            进行中 {inProgressCount}
                                          </span>
                                        )}
                                        {waitingCount > 0 && (
                                          <span className="inline-flex items-center gap-1 text-zinc-500">
                                            <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" />
                                            待开始 {waitingCount}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </motion.div>
                                )}
                              </AnimatePresence>

                              {/* 展开态：简洁树形引导线 ├─ / └─ + 点击整卡打开详情 */}
                              <AnimatePresence initial={false}>
                                {isExpanded && (
                                  <motion.div
                                    key="segments"
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                                    className="overflow-hidden"
                                  >
                                    <div className="px-2.5 pb-2 pt-0.5">
                                      {item.cards.map((card, idx) => {
                                        const isLast = idx === item.cards.length - 1;
                                        const cardState = getBoardCardState(card);
                                        const stateStyle = BOARD_CARD_STATE_STYLES[cardState];
                                        const currentStageMissing = card.missingStages.find(
                                          (ms) => ms.columnId === card.stageColumnId,
                                        );
                                        const currentClaimKey = `${card.taskId}:${card.stageColumnId}`;
                                        const claimingCurrent = claimingKeys.has(currentClaimKey);
                                        const mine = isAssignedToMe(card);
                                        const openChildDetail = () =>
                                          onOpenDetail({
                                            worksheetId: card.worksheetId,
                                            taskId: card.taskId,
                                          });

                                        return (
                                          <motion.div
                                            key={`${card.taskId}:${card.boardColumnId}`}
                                            layout="position"
                                            transition={CARD_TRANSITION}
                                            data-tree-branch={isLast ? 'last' : 'middle'}
                                            className={cn('relative pl-5', !isLast && 'pb-1.5')}
                                          >
                                            {!isLast && (
                                              <span
                                                aria-hidden="true"
                                                className="pointer-events-none absolute top-0 bottom-0 left-[7px] w-[1.5px] bg-zinc-300/80"
                                              />
                                            )}
                                            <span
                                              aria-hidden="true"
                                              className={cn(
                                                'pointer-events-none absolute left-[7px] w-[11px] rounded-bl-[5px] border-b-[1.5px] border-l-[1.5px] border-zinc-300/80',
                                                isLast ? 'top-0 h-[17px]' : 'top-[9px] h-[8px]',
                                              )}
                                            />

                                            <div
                                              data-testid={`board-card-${card.taskId}-${card.boardColumnId}`}
                                              data-card-state={cardState}
                                              className={cn(
                                                'group relative rounded-md border px-2 py-1.5 transition-[border-color,background-color] duration-150 focus-within:ring-2 focus-within:ring-zinc-400/70',
                                                stateStyle.subCard,
                                              )}
                                            >
                                              <button
                                                type="button"
                                                aria-label={`打开任务 ${card.taskTitle} 详情`}
                                                title={
                                                  card.divisionNote
                                                    ? `${card.taskTitle} — ${card.divisionNote}`
                                                    : card.taskTitle
                                                }
                                                onClick={openChildDetail}
                                                className="absolute inset-0 z-0 cursor-pointer rounded-md focus:outline-none"
                                              />

                                              <div className="pointer-events-none relative z-10 flex items-start justify-between gap-1.5">
                                                <span className="min-w-0 flex-1 text-left text-[13.5px] font-semibold leading-snug text-zinc-900 transition-colors group-hover:text-blue-600">
                                                  {card.taskTitle}
                                                </span>

                                                {card.priority !== 'normal' && (
                                                  <span
                                                    className={cn(
                                                      'shrink-0 rounded border px-1 py-0 text-[11px] font-medium leading-4',
                                                      PRIORITY_STYLES[card.priority],
                                                    )}
                                                  >
                                                    {PRIORITY_LABELS[card.priority]}
                                                  </span>
                                                )}
                                              </div>

                                              <div className="pointer-events-none relative z-10 mt-1 flex items-center justify-between gap-1">
                                                <div className="flex min-w-0 items-center gap-1 text-xs">
                                                  <span
                                                    className={cn(
                                                      'h-1.5 w-1.5 shrink-0 rounded-full',
                                                      stateStyle.dot,
                                                    )}
                                                  />
                                                  <span
                                                    className={cn(
                                                      'truncate',
                                                      stateStyle.statusText,
                                                    )}
                                                  >
                                                    {formatStageStatusLine(card)}
                                                  </span>
                                                  {mine && (
                                                    <span className="shrink-0 rounded bg-black/[0.06] px-1 py-0 text-[11px] font-medium text-zinc-700">
                                                      我
                                                    </span>
                                                  )}
                                                </div>

                                                <div className="pointer-events-auto flex shrink-0 items-center gap-0.5">
                                                  {currentStageMissing && (
                                                    <button
                                                      type="button"
                                                      disabled={claimingCurrent}
                                                      aria-label={`认领 ${currentStageMissing.name}`}
                                                      onClick={(e) => {
                                                        e.stopPropagation();
                                                        void onClaim(
                                                          card.taskId,
                                                          currentStageMissing.columnId,
                                                          currentStageMissing.name,
                                                        );
                                                      }}
                                                      className="mr-0.5 inline-flex h-5 shrink-0 items-center gap-0.5 rounded border border-red-300/90 bg-white/95 px-1.5 text-xs font-medium text-red-700 transition-all duration-150 hover:border-red-400 hover:bg-red-50 active:scale-95 disabled:opacity-50 cursor-pointer"
                                                    >
                                                      <Hand className="h-2.5 w-2.5" />
                                                      {claimingCurrent ? '认领中…' : '认领'}
                                                    </button>
                                                  )}

                                                  <TaskResourcesPopover
                                                    taskId={card.taskId}
                                                    taskTitle={card.taskTitle}
                                                    worksheetId={card.worksheetId}
                                                    workName={card.workName}
                                                    stageColumnName={card.stageColumnName}
                                                    onOpenDetail={onOpenDetail}
                                                    className="h-5 w-5"
                                                  />
                                                </div>
                                              </div>

                                              {renderOtherMissing(card, true)}
                                            </div>
                                          </motion.div>
                                        );
                                      })}
                                    </div>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </motion.section>
                          );
                        })}
                      </AnimatePresence>
                    )}
                  </div>
                </motion.div>
              )}
            </motion.div>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
