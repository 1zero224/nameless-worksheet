import { type BoardCard, type BoardColumn, PRIORITY_LABELS, STAGE_STATUS_LABELS } from '@nw/shared';
import { ChevronDown, Folder, Minimize2, PanelLeftOpen, Plus } from 'lucide-react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { TaskResourcesPopover } from '@/components/task/TaskResourcesPopover.js';
import {
  BOARD_CARD_STATE_STYLES,
  type BoardCardVisualState,
  PRIORITY_STYLES,
} from '@/components/ui/colors.js';
import { cn } from '@/components/ui/primitives.js';

const COLUMN_SPRING = { type: 'spring', stiffness: 420, damping: 36 } as const;
const CARD_TRANSITION = {
  layout: { type: 'spring', stiffness: 460, damping: 34 },
  opacity: { duration: 0.16 },
} as const;

const INLINE_ACTION_BTN_BASE =
  'inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs font-medium transition-colors duration-150 active:scale-[0.97] disabled:opacity-50 cursor-pointer';

const DRAG_SCROLL_THRESHOLD = 6;

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

  // 横向滚动提示（左右渐隐）与触摸屏式手拖滑动
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false, overflow: false });
  const [isDragScrolling, setIsDragScrolling] = useState(false);
  const suppressClickRef = useRef(false);
  const momentumRafRef = useRef<number | null>(null);

  const stopMomentum = useCallback(() => {
    if (momentumRafRef.current !== null) {
      cancelAnimationFrame(momentumRafRef.current);
      momentumRafRef.current = null;
    }
  }, []);

  const updateScrollEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth > 2;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft < el.scrollWidth - el.clientWidth - 4;
    setScrollEdges((prev) =>
      prev.left === left && prev.right === right && prev.overflow === overflow
        ? prev
        : { left, right, overflow },
    );
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateScrollEdges();
    const ro = new ResizeObserver(() => updateScrollEdges());
    ro.observe(el);
    const mo = new MutationObserver(() => {
      requestAnimationFrame(updateScrollEdges);
    });
    mo.observe(el, { childList: true, attributes: true, attributeFilter: ['data-collapsed'] });
    el.addEventListener('scroll', updateScrollEdges, { passive: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener('scroll', updateScrollEdges);
      stopMomentum();
    };
  }, [updateScrollEdges, stopMomentum]);

  const handleScrollerPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // 仅处理鼠标左键拖拽；触摸屏走浏览器原生顺滑惯性滚动
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        'input, textarea, select, [contenteditable="true"], [data-radix-popper-content-wrapper]',
      )
    ) {
      return;
    }

    const el = scrollerRef.current;
    if (!el || el.scrollWidth <= el.clientWidth + 2) return;

    stopMomentum();
    const startX = e.clientX;
    const startScrollLeft = el.scrollLeft;
    let moved = false;
    let lastX = startX;
    let lastTime = performance.now();
    let velocity = 0;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_SCROLL_THRESHOLD) return;
      if (!moved) {
        moved = true;
        setIsDragScrolling(true);
      }
      moveEvent.preventDefault();
      el.scrollLeft = startScrollLeft - dx;

      const now = performance.now();
      const dt = Math.max(now - lastTime, 1);
      const instantVelocity = (moveEvent.clientX - lastX) / dt;
      velocity = velocity * 0.65 + instantVelocity * 0.35;
      lastX = moveEvent.clientX;
      lastTime = now;
    };

    const finishDrag = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      if (!moved) return;

      setIsDragScrolling(false);
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);

      // 松手后的轻惯性滑行（贴近触摸屏手感）
      let v = velocity * 16;
      if (Math.abs(v) > 1.2) {
        const step = () => {
          const node = scrollerRef.current;
          if (!node || Math.abs(v) < 0.35) {
            momentumRafRef.current = null;
            return;
          }
          node.scrollLeft -= v;
          v *= 0.91;
          momentumRafRef.current = requestAnimationFrame(step);
        };
        momentumRafRef.current = requestAnimationFrame(step);
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
  };

  const handleScrollerClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    suppressClickRef.current = false;
  };

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
        <div className={cn('relative z-10 flex flex-wrap gap-1', compact ? 'mt-1' : 'mt-1.5')}>
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
                className={cn(INLINE_ACTION_BTN_BASE, BOARD_CARD_STATE_STYLES.missing.actionBtn)}
              >
                <Plus className="h-3 w-3" strokeWidth={2} />
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
          'pointer-events-none relative z-10 truncate text-[11.5px] text-zinc-400',
          compact ? 'mt-0.5' : 'mt-1',
        )}
      >
        还缺 {otherMissing.map((m) => m.name).join(' · ')}
      </div>
    );
  };

  return (
    <LayoutGroup id="kanban-board">
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[#fafafa]">
        <div
          ref={scrollerRef}
          data-testid="board-columns"
          onPointerDown={handleScrollerPointerDown}
          onClickCapture={handleScrollerClickCapture}
          onWheel={stopMomentum}
          className={cn(
            'board-scrollbar flex min-h-0 flex-1 gap-3 overflow-x-auto p-3 pb-2',
            scrollEdges.overflow && !isDragScrolling && 'cursor-grab',
            isDragScrolling && 'cursor-grabbing select-none',
          )}
        >
          {boardColumns.map((bc) => {
            const colCards = cardsByBoardCol.get(bc.id) ?? [];
            const displayItems = buildColumnDisplayItems(colCards);
            const isCollapsed = collapsedCols.has(bc.id);

            return (
              <motion.div
                key={bc.id}
                layout
                transition={COLUMN_SPRING}
                onLayoutAnimationComplete={updateScrollEdges}
                data-testid={`board-col-${bc.id}`}
                data-board-column-name={bc.name}
                data-collapsed={isCollapsed ? 'true' : 'false'}
                className={cn(
                  'flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-black/[0.08] bg-white',
                  isCollapsed
                    ? 'w-[52px] min-w-[52px] max-w-[52px] shrink-0 grow-0 hover:bg-zinc-50 transition-colors'
                    : 'min-w-[256px] max-w-[420px] flex-1',
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
                      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-900 cursor-pointer"
                    >
                      <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                    <span className="mt-2 rounded-full bg-zinc-100 px-2 py-0.25 text-xs font-medium tabular-nums text-zinc-500">
                      {colCards.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleColumnCollapsed(bc.id)}
                      className="mt-3 flex flex-1 items-start justify-center cursor-pointer"
                    >
                      <span className="text-xs font-semibold tracking-wider text-zinc-900 [writing-mode:vertical-rl]">
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
                    className="flex h-full min-h-0 w-full flex-col"
                  >
                    {/* 极简纯白列顶栏：无背景黑字标题 + 轻计数 */}
                    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-black/[0.06] bg-white px-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <h2 className="truncate text-sm font-semibold leading-5 text-zinc-900">
                          {bc.name}
                        </h2>
                        <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0 text-xs font-medium tabular-nums text-zinc-500">
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

                    {/* 纯白列内容区 */}
                    <div className="no-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto bg-white p-2.5">
                      {displayItems.length === 0 ? (
                        <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-black/[0.08] bg-[#fafafa]/70 text-xs text-zinc-400">
                          暂无任务
                        </div>
                      ) : (
                        <AnimatePresence mode="popLayout" initial={false}>
                          {displayItems.map((item) => {
                            if (item.kind === 'standalone') {
                              const { card, workKey } = item;
                              const cardState = getBoardCardState(card);
                              const stateStyle = BOARD_CARD_STATE_STYLES[cardState];
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
                                    'group cursor-pointer rounded-lg border px-2.5 py-2 transition-[border-color,background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60',
                                    stateStyle.card,
                                    isWorkHighlighted && 'ring-1 ring-zinc-900/20',
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
                                        className={cn(
                                          'min-w-0 text-left text-[13.5px] font-semibold leading-snug transition-colors',
                                          stateStyle.title,
                                        )}
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
                                        className="mt-0.5 max-w-[40%] shrink-0 truncate text-xs text-zinc-400"
                                      >
                                        {card.worksheetName}
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
                                        <span
                                          className={cn(
                                            'shrink-0 rounded px-1 py-0 text-[11px] font-medium',
                                            stateStyle.meTag,
                                          )}
                                        >
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
                                          className={cn(
                                            INLINE_ACTION_BTN_BASE,
                                            stateStyle.actionBtn,
                                          )}
                                        >
                                          <Plus className="h-3 w-3" strokeWidth={2} />
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
                                  'overflow-hidden rounded-lg border border-black/[0.10] bg-white transition-[border-color,box-shadow] duration-150 hover:border-black/[0.18]',
                                  isWorkHighlighted && 'border-zinc-300 ring-1 ring-zinc-900/20',
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
                                  className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left transition-colors hover:bg-zinc-50/80 cursor-pointer"
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
                                    <span className="truncate text-[13.5px] font-semibold leading-snug text-zinc-900">
                                      {item.workName}
                                    </span>
                                  </span>

                                  {showWorksheetSource && (
                                    <span
                                      title={item.worksheetName}
                                      className="max-w-[40%] shrink-0 truncate text-xs text-zinc-400"
                                    >
                                      {item.worksheetName}
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
                                            <span className="inline-flex items-center gap-1 font-medium text-red-900/85">
                                              <span className="h-1.5 w-1.5 rounded-full bg-red-500/80" />
                                              缺人 {missingCount}
                                            </span>
                                          )}
                                          {inProgressCount > 0 && (
                                            <span className="inline-flex items-center gap-1 font-medium text-amber-900/90">
                                              <span className="h-1.5 w-1.5 rounded-full bg-amber-500/85" />
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
                                                  className="pointer-events-none absolute top-0 bottom-0 left-[7px] w-[1.5px] bg-zinc-200"
                                                />
                                              )}
                                              <span
                                                aria-hidden="true"
                                                className={cn(
                                                  'pointer-events-none absolute left-[7px] w-[11px] rounded-bl-[5px] border-b-[1.5px] border-l-[1.5px] border-zinc-200',
                                                  isLast ? 'top-0 h-[17px]' : 'top-[9px] h-[8px]',
                                                )}
                                              />

                                              <div
                                                data-testid={`board-card-${card.taskId}-${card.boardColumnId}`}
                                                data-card-state={cardState}
                                                className={cn(
                                                  'group relative rounded-md border px-2 py-1.5 transition-[border-color,background-color] duration-150 focus-within:ring-2 focus-within:ring-zinc-400/60',
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
                                                  <span
                                                    className={cn(
                                                      'min-w-0 flex-1 text-left text-[13.5px] font-semibold leading-snug transition-colors',
                                                      stateStyle.title,
                                                    )}
                                                  >
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

                                                <div className="pointer-events-none relative z-10 mt-1.5 flex items-center justify-between gap-1">
                                                  <div className="flex min-w-0 items-center gap-1.5 text-xs">
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
                                                      <span
                                                        className={cn(
                                                          'shrink-0 rounded px-1 py-0 text-[11px] font-medium',
                                                          stateStyle.meTag,
                                                        )}
                                                      >
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
                                                        className={cn(
                                                          INLINE_ACTION_BTN_BASE,
                                                          stateStyle.actionBtn,
                                                        )}
                                                      >
                                                        <Plus className="h-3 w-3" strokeWidth={2} />
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

        {/* 左右边缘柔和渐隐，提示看板区可横向滑动 */}
        {scrollEdges.left && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-[#fafafa] to-transparent"
          />
        )}
        {scrollEdges.right && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-[#fafafa] to-transparent"
          />
        )}
      </div>
    </LayoutGroup>
  );
}
