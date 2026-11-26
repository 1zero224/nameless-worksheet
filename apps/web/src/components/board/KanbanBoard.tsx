import { type BoardCard, type BoardColumn, PRIORITY_LABELS, STAGE_STATUS_LABELS } from '@nw/shared';
import {
  ChevronDown,
  ChevronRight,
  Filter,
  Folder,
  Hand,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import {
  BOARD_CARD_STATE_STYLES,
  type BoardCardVisualState,
  PRIORITY_STYLES,
  WORKSHEET_COLOR_STYLES,
} from '@/components/ui/colors.js';
import { cn } from '@/components/ui/primitives.js';

// 看板列头浅彩胶囊配色（低饱和、通透、高可读）
const COLUMN_PILL_STYLES = [
  'bg-sky-100/90 text-sky-900',
  'bg-amber-100/90 text-amber-900',
  'bg-emerald-100/90 text-emerald-900',
  'bg-violet-100/90 text-violet-900',
  'bg-rose-100/90 text-rose-900',
  'bg-zinc-200/80 text-zinc-800',
] as const;

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

/**
 * 构建单列内的展示条目：
 * - 无作品任务 → 独立任务卡
 * - 同列内同一作品只有 1 条任务 → 不套折叠壳，直接平铺为带作品眉标的独立卡片
 * - 同列内同一作品 >= 2 条任务 → 聚合为默认展开的作品父容器
 */
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
  onSelectWorkFilter?: (target: { worksheetId: string; workId: string }) => void;
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
  onSelectWorkFilter,
}: KanbanBoardProps) {
  const [collapsedCols, setCollapsedCols] = useState<Set<string>>(new Set());
  // 作品父容器（>=2条）默认展开，收起项记入 collapsedGroups
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // 跨列悬停同作品联动高亮
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
            'flex flex-wrap gap-1 border-t border-black/[0.06] pt-1.5',
            compact ? 'mt-1.5' : 'mt-2',
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
                className="inline-flex items-center gap-0.5 rounded border border-red-200/90 bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-red-700 transition-colors hover:border-red-300 hover:bg-red-50 disabled:opacity-50 cursor-pointer"
              >
                <Hand className="h-2.5 w-2.5" />
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
          'truncate text-[10px] text-zinc-400',
          compact ? 'mt-1' : 'mt-1.5 border-t border-black/[0.05] pt-1.5',
        )}
      >
        还缺 {otherMissing.map((m) => m.name).join(' · ')}
      </div>
    );
  };

  return (
    <div
      data-testid="board-columns"
      className="no-scrollbar flex min-h-0 flex-1 gap-3.5 overflow-x-auto bg-white p-3.5"
    >
      {boardColumns.map((bc, colIdx) => {
        const colCards = cardsByBoardCol.get(bc.id) ?? [];
        const displayItems = buildColumnDisplayItems(colCards);
        const isCollapsed = collapsedCols.has(bc.id);
        const pillStyle =
          COLUMN_PILL_STYLES[colIdx % COLUMN_PILL_STYLES.length] ?? COLUMN_PILL_STYLES[0];

        if (isCollapsed) {
          return (
            <div
              key={bc.id}
              data-testid={`board-col-${bc.id}`}
              data-board-column-name={bc.name}
              data-collapsed="true"
              className="flex h-full w-12 shrink-0 flex-col items-center rounded-xl border border-black/[0.06] bg-[#f8f8fa] py-2.5 transition-[width] duration-200"
            >
              <button
                type="button"
                onClick={() => toggleColumnCollapsed(bc.id)}
                aria-label={`展开列 ${bc.name}`}
                title={`展开「${bc.name}」列`}
                className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-900 cursor-pointer"
              >
                <PanelLeftOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
              <span className="mt-2 rounded-full bg-white px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-zinc-500 ring-1 ring-black/[0.06]">
                {colCards.length}
              </span>
              <button
                type="button"
                onClick={() => toggleColumnCollapsed(bc.id)}
                className="mt-3 flex flex-1 items-start justify-center cursor-pointer"
              >
                <span
                  className={cn(
                    'rounded-md px-1 py-2 text-xs font-medium tracking-wider [writing-mode:vertical-rl]',
                    pillStyle,
                  )}
                >
                  {bc.name}
                </span>
              </button>
            </div>
          );
        }

        return (
          <div
            key={bc.id}
            data-testid={`board-col-${bc.id}`}
            data-board-column-name={bc.name}
            data-collapsed="false"
            className="flex h-full min-h-0 w-[280px] shrink-0 flex-col rounded-xl border border-black/[0.06] bg-[#f8f8fa] transition-[width] duration-200 sm:w-[292px]"
          >
            {/* 列头 */}
            <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <h2
                  className={cn(
                    'truncate rounded-md px-2 py-0.5 text-xs font-semibold leading-tight',
                    pillStyle,
                  )}
                >
                  {bc.name}
                </h2>
                <span className="rounded-full bg-white px-2 py-0.25 text-[11px] font-medium tabular-nums text-zinc-500 ring-1 ring-black/[0.06]">
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
                <PanelLeftClose className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </div>

            {/* 卡片列表 */}
            <div className="no-scrollbar min-h-0 flex-1 space-y-2.5 overflow-y-auto px-2.5 pb-3">
              {displayItems.length === 0 ? (
                <div className="rounded-lg border border-dashed border-black/[0.08] bg-white/50 py-8 text-center text-xs text-zinc-400">
                  暂无任务
                </div>
              ) : (
                displayItems.map((item) => {
                  if (item.kind === 'standalone') {
                    const { card, workKey } = item;
                    const cardState = getBoardCardState(card);
                    const stateStyle = BOARD_CARD_STATE_STYLES[cardState];
                    const wsColor =
                      WORKSHEET_COLOR_STYLES[card.worksheetColor] ?? WORKSHEET_COLOR_STYLES.sky;
                    const currentStageMissing = card.missingStages.find(
                      (ms) => ms.columnId === card.stageColumnId,
                    );
                    const currentClaimKey = `${card.taskId}:${card.stageColumnId}`;
                    const claimingCurrent = claimingKeys.has(currentClaimKey);
                    const isWorkHighlighted = Boolean(workKey && hoveredWorkKey === workKey);
                    const mine = isAssignedToMe(card);

                    return (
                      <div
                        key={item.key}
                        data-testid={`board-card-${card.taskId}-${card.boardColumnId}`}
                        data-card-state={cardState}
                        data-work-name={card.workName ?? undefined}
                        onPointerEnter={workKey ? () => setHoveredWorkKey(workKey) : undefined}
                        onPointerLeave={
                          workKey
                            ? () => setHoveredWorkKey((prev) => (prev === workKey ? null : prev))
                            : undefined
                        }
                        className={cn(
                          'rounded-lg border p-3 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-all hover:shadow-[0_2px_8px_rgba(0,0,0,0.05)]',
                          stateStyle.card,
                          isWorkHighlighted && 'ring-2 ring-indigo-400/75',
                        )}
                      >
                        {/* 同列仅 1 条任务的作品：不折叠，顶部展示可点击作品眉标 */}
                        {card.workId && card.workName && (
                          <div className="mb-1.5 flex items-center justify-between gap-1.5">
                            {onSelectWorkFilter ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectWorkFilter({
                                    worksheetId: card.worksheetId,
                                    workId: card.workId!,
                                  });
                                }}
                                title={`仅看作品「${card.workName}」`}
                                aria-label={`筛选作品 ${card.workName}`}
                                className="inline-flex min-w-0 items-center gap-1 rounded bg-indigo-50/90 px-1.5 py-0.5 text-[11px] font-medium text-indigo-800 transition-colors hover:bg-indigo-100/80 cursor-pointer"
                              >
                                <Folder
                                  className="h-3 w-3 shrink-0 text-indigo-500"
                                  strokeWidth={1.75}
                                />
                                <span className="truncate">{card.workName}</span>
                              </button>
                            ) : (
                              <span className="inline-flex min-w-0 items-center gap-1 rounded bg-indigo-50/90 px-1.5 py-0.5 text-[11px] font-medium text-indigo-800">
                                <Folder
                                  className="h-3 w-3 shrink-0 text-indigo-500"
                                  strokeWidth={1.75}
                                />
                                <span className="truncate">{card.workName}</span>
                              </span>
                            )}
                          </div>
                        )}

                        {/* 第 1 层：标题 + 仅高/紧急优先级角标 */}
                        <div className="flex items-start justify-between gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              onOpenDetail({
                                worksheetId: card.worksheetId,
                                taskId: card.taskId,
                              })
                            }
                            title={
                              card.divisionNote
                                ? `${card.taskTitle} — ${card.divisionNote}`
                                : card.taskTitle
                            }
                            className="min-w-0 flex-1 text-left text-[13px] font-semibold leading-snug text-zinc-950 hover:text-blue-600 cursor-pointer"
                          >
                            {card.taskTitle}
                          </button>

                          {card.priority !== 'normal' && (
                            <span
                              className={cn(
                                'shrink-0 rounded border px-1.5 py-0 text-[10px] font-medium leading-4',
                                PRIORITY_STYLES[card.priority],
                              )}
                            >
                              {PRIORITY_LABELS[card.priority]}
                            </span>
                          )}
                        </div>

                        {/* 第 2 层：本列「工序 · 负责人 · 状态」+ 缺人直接认领 */}
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
                            <span
                              className={cn('h-1.5 w-1.5 shrink-0 rounded-full', stateStyle.dot)}
                            />
                            <span className={cn('truncate', stateStyle.statusText)}>
                              {formatStageStatusLine(card)}
                            </span>
                            {mine && (
                              <span className="shrink-0 rounded bg-black/[0.06] px-1 py-0 text-[10px] font-medium text-zinc-700">
                                我
                              </span>
                            )}
                          </div>

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
                              className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded border border-red-300/90 bg-white/95 px-1.5 text-[11px] font-medium text-red-700 transition-colors hover:border-red-400 hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                            >
                              <Hand className="h-2.5 w-2.5" />
                              {claimingCurrent ? '认领中…' : '认领'}
                            </button>
                          )}
                        </div>

                        {/* 极简来源 */}
                        {showWorksheetSource && (
                          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-400">
                            <span
                              className={cn('h-1.5 w-1.5 shrink-0 rounded-full', wsColor.dot)}
                            />
                            <span className="truncate">{card.worksheetName}</span>
                          </div>
                        )}

                        {/* 其他未轮到工序缺人提示 */}
                        {renderOtherMissing(card, false)}
                      </div>
                    );
                  }

                  // 作品父容器（同列 >= 2 条任务，默认展开，支持收起与跨列同作品高亮）
                  const collapseKey = `${bc.id}:${item.key}`;
                  const isExpanded = !collapsedGroups.has(collapseKey);
                  const wsColor =
                    WORKSHEET_COLOR_STYLES[item.worksheetColor] ?? WORKSHEET_COLOR_STYLES.sky;
                  const inProgressCount = item.cards.filter(
                    (c) => getBoardCardState(c) === 'in_progress',
                  ).length;
                  const missingCount = item.cards.filter(
                    (c) => getBoardCardState(c) === 'missing',
                  ).length;
                  const waitingCount = item.cards.length - inProgressCount - missingCount;
                  const isWorkHighlighted = hoveredWorkKey === item.workKey;

                  return (
                    <section
                      key={collapseKey}
                      aria-label={`作品 ${item.workName}`}
                      data-testid={`board-work-group-${item.workId}-${bc.id}`}
                      data-work-name={item.workName}
                      data-expanded={isExpanded ? 'true' : 'false'}
                      onPointerEnter={() => setHoveredWorkKey(item.workKey)}
                      onPointerLeave={() =>
                        setHoveredWorkKey((prev) => (prev === item.workKey ? null : prev))
                      }
                      className={cn(
                        'overflow-hidden rounded-lg border border-indigo-200/80 border-l-[3px] border-l-indigo-500 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-all hover:border-indigo-300',
                        isWorkHighlighted &&
                          'ring-2 ring-indigo-400/75 shadow-[0_2px_10px_rgba(79,70,229,0.12)]',
                      )}
                    >
                      {/* 作品父容器极简头部 */}
                      <div className="bg-[#EEF2FF]/65 px-2.5 py-2">
                        <div className="flex items-start justify-between gap-1.5">
                          <button
                            type="button"
                            onClick={() => toggleGroupCollapsed(collapseKey)}
                            aria-expanded={isExpanded}
                            aria-label={
                              isExpanded
                                ? `收起作品 ${item.workName} 分段`
                                : `展开作品 ${item.workName} 分段`
                            }
                            className="flex min-w-0 flex-1 items-start gap-1.5 text-left cursor-pointer"
                          >
                            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-indigo-600">
                              {isExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1">
                                <Folder
                                  className="h-3.5 w-3.5 shrink-0 text-indigo-500"
                                  strokeWidth={1.75}
                                />
                                <span className="truncate text-[13px] font-semibold leading-snug text-indigo-950">
                                  {item.workName}
                                </span>
                              </div>
                            </div>
                          </button>

                          <div className="flex shrink-0 items-center gap-1">
                            {onSelectWorkFilter && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectWorkFilter({
                                    worksheetId: item.worksheetId,
                                    workId: item.workId,
                                  });
                                }}
                                title={`仅看作品「${item.workName}」`}
                                aria-label={`筛选作品 ${item.workName}`}
                                className="flex h-5 w-5 items-center justify-center rounded text-indigo-500/80 transition-colors hover:bg-indigo-200/60 hover:text-indigo-900 cursor-pointer"
                              >
                                <Filter className="h-3 w-3" strokeWidth={1.75} />
                              </button>
                            )}
                            <span className="rounded-full bg-white/90 px-1.5 py-0 text-[10px] font-medium tabular-nums text-indigo-800 ring-1 ring-indigo-200/70">
                              {item.cards.length} 段
                            </span>
                          </div>
                        </div>

                        {/* 第二行：来源 + 黄/红/白三色状态分布微条 */}
                        <div className="mt-1.5 flex items-center justify-between gap-2 pl-5">
                          {showWorksheetSource ? (
                            <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-indigo-900/65">
                              <span
                                className={cn('h-1.5 w-1.5 shrink-0 rounded-full', wsColor.dot)}
                              />
                              <span className="truncate">{item.worksheetName}</span>
                            </span>
                          ) : (
                            <span />
                          )}

                          <div className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums">
                            {inProgressCount > 0 && (
                              <span className="inline-flex items-center gap-0.5 text-amber-800 font-medium">
                                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                                {inProgressCount}
                              </span>
                            )}
                            {missingCount > 0 && (
                              <span className="inline-flex items-center gap-0.5 text-red-700 font-medium">
                                <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                                {missingCount}
                              </span>
                            )}
                            {waitingCount > 0 && (
                              <span className="inline-flex items-center gap-0.5 text-zinc-500">
                                <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" />
                                {waitingCount}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* 展开区：带左侧靛蓝导轨 + 独立状态底色迷你子卡 */}
                      <AnimatePresence initial={false}>
                        {isExpanded && (
                          <motion.div
                            key="segments"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                            className="overflow-hidden border-t border-indigo-200/60 bg-[#EEF2FF]/30"
                          >
                            <div className="p-2">
                              <div className="space-y-1.5 border-l-2 border-indigo-300/75 pl-2">
                                {item.cards.map((card) => {
                                  const cardState = getBoardCardState(card);
                                  const stateStyle = BOARD_CARD_STATE_STYLES[cardState];
                                  const currentStageMissing = card.missingStages.find(
                                    (ms) => ms.columnId === card.stageColumnId,
                                  );
                                  const currentClaimKey = `${card.taskId}:${card.stageColumnId}`;
                                  const claimingCurrent = claimingKeys.has(currentClaimKey);
                                  const mine = isAssignedToMe(card);

                                  return (
                                    <div
                                      key={`${card.taskId}:${card.boardColumnId}`}
                                      data-testid={`board-card-${card.taskId}-${card.boardColumnId}`}
                                      data-card-state={cardState}
                                      className={cn(
                                        'rounded-md border px-2.5 py-2 shadow-[0_1px_1px_rgba(0,0,0,0.02)] transition-colors',
                                        stateStyle.subCard,
                                      )}
                                    >
                                      <div className="flex items-start justify-between gap-1.5">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            onOpenDetail({
                                              worksheetId: card.worksheetId,
                                              taskId: card.taskId,
                                            })
                                          }
                                          title={
                                            card.divisionNote
                                              ? `${card.taskTitle} — ${card.divisionNote}`
                                              : card.taskTitle
                                          }
                                          className="min-w-0 flex-1 text-left text-xs font-semibold leading-snug text-zinc-900 hover:text-blue-600 cursor-pointer"
                                        >
                                          {card.taskTitle}
                                        </button>

                                        {card.priority !== 'normal' && (
                                          <span
                                            className={cn(
                                              'shrink-0 rounded border px-1 py-0 text-[10px] font-medium leading-4',
                                              PRIORITY_STYLES[card.priority],
                                            )}
                                          >
                                            {PRIORITY_LABELS[card.priority]}
                                          </span>
                                        )}
                                      </div>

                                      <div className="mt-1.5 flex items-center justify-between gap-1.5">
                                        <div className="flex min-w-0 items-center gap-1 text-[11px]">
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
                                            <span className="shrink-0 rounded bg-black/[0.06] px-1 py-0 text-[10px] font-medium text-zinc-700">
                                              我
                                            </span>
                                          )}
                                        </div>

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
                                            className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded border border-red-300/90 bg-white/95 px-1.5 text-[10px] font-medium text-red-700 transition-colors hover:border-red-400 hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                                          >
                                            <Hand className="h-2.5 w-2.5" />
                                            {claimingCurrent ? '认领中…' : '认领'}
                                          </button>
                                        )}
                                      </div>

                                      {renderOtherMissing(card, true)}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </section>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
