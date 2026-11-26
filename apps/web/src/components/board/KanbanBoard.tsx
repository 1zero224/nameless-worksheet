import { type BoardCard, type BoardColumn, PRIORITY_LABELS, STAGE_STATUS_LABELS } from '@nw/shared';
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  Flag,
  Folder,
  Hand,
  PanelLeftClose,
  PanelLeftOpen,
  UserRound,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { PRIORITY_STYLES, WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import { cn } from '@/components/ui/primitives.js';

// 参考 Teable 看板列头浅彩胶囊配色（低饱和、通透、高可读）
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
  card: BoardCard;
}

type ColumnDisplayItem = WorkGroupItem | StandaloneItem;

function buildColumnDisplayItems(colCards: BoardCard[]): ColumnDisplayItem[] {
  const items: ColumnDisplayItem[] = [];
  const workGroupMap = new Map<string, WorkGroupItem>();

  for (const card of colCards) {
    if (!card.workId || !card.workName) {
      items.push({
        kind: 'standalone',
        key: `${card.taskId}:${card.boardColumnId}`,
        card,
      });
      continue;
    }

    const groupKey = `${card.worksheetId}:${card.workId}`;
    const existing = workGroupMap.get(groupKey);
    if (existing) {
      existing.cards.push(card);
    } else {
      const group: WorkGroupItem = {
        kind: 'work-group',
        key: groupKey,
        worksheetId: card.worksheetId,
        worksheetName: card.worksheetName,
        worksheetColor: card.worksheetColor,
        workId: card.workId,
        workName: card.workName,
        cards: [card],
      };
      workGroupMap.set(groupKey, group);
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
  showWorksheetSource = true,
  onClaim,
  onOpenDetail,
  onSelectWorkFilter,
}: KanbanBoardProps) {
  const [collapsedCols, setCollapsedCols] = useState<Set<string>>(new Set());
  // 列内作品聚合卡默认折叠，点击展开（key = `${boardColumnId}:${worksheetId}:${workId}`）
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

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

  const toggleGroupExpanded = (groupKey: string) => {
    setExpandedGroups((prev) => {
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
            className="flex h-full min-h-0 w-[276px] shrink-0 flex-col rounded-xl border border-black/[0.06] bg-[#f8f8fa] transition-[width] duration-200 sm:w-[288px]"
          >
            {/* Teable 风格浅彩胶囊列头 */}
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

            {/* 卡片列表（隐藏系统滚动条，保留顺滑纵向滚轮与触控滚动） */}
            <div className="no-scrollbar min-h-0 flex-1 space-y-2.5 overflow-y-auto px-2.5 pb-3">
              {displayItems.length === 0 ? (
                <div className="rounded-lg border border-dashed border-black/[0.08] bg-white/50 py-8 text-center text-xs text-zinc-400">
                  暂无任务
                </div>
              ) : (
                displayItems.map((item) => {
                  if (item.kind === 'standalone') {
                    const { card } = item;
                    const wsColor =
                      WORKSHEET_COLOR_STYLES[card.worksheetColor] ?? WORKSHEET_COLOR_STYLES.sky;
                    const assigneesText = formatAssignees(card.stageAssignees);

                    return (
                      <div
                        key={item.key}
                        data-testid={`board-card-${card.taskId}-${card.boardColumnId}`}
                        className="rounded-lg border border-black/[0.07] bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-all hover:border-black/[0.15] hover:shadow-[0_2px_8px_rgba(0,0,0,0.05)]"
                      >
                        {/* 标题 */}
                        <button
                          type="button"
                          onClick={() =>
                            onOpenDetail({
                              worksheetId: card.worksheetId,
                              taskId: card.taskId,
                            })
                          }
                          className="block w-full text-left cursor-pointer"
                        >
                          <div className="text-[13px] font-semibold leading-snug text-zinc-950 hover:text-blue-600">
                            {card.taskTitle}
                          </div>
                          {card.divisionNote && (
                            <div className="mt-0.5 truncate text-[11px] text-zinc-400">
                              {card.divisionNote}
                            </div>
                          )}
                        </button>

                        {/* Teable 风格结构化字段行 */}
                        <div className="mt-2.5 space-y-2">
                          {card.priority !== 'normal' && (
                            <div className="flex items-center gap-2">
                              <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
                                <Flag className="h-3 w-3" strokeWidth={1.75} />
                                优先级
                              </span>
                              <span
                                className={cn(
                                  'rounded px-1.5 py-0.25 text-[11px] font-medium border',
                                  PRIORITY_STYLES[card.priority],
                                )}
                              >
                                {PRIORITY_LABELS[card.priority]}
                              </span>
                            </div>
                          )}

                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
                              <UserRound className="h-3 w-3" strokeWidth={1.75} />
                              负责人
                            </span>
                            <span
                              className={cn(
                                'rounded-md px-2 py-0.5 text-[11px] font-medium',
                                card.stageStatus === 'in_progress'
                                  ? 'bg-[#EFF6FF] text-blue-700'
                                  : 'bg-zinc-100 text-zinc-700',
                              )}
                            >
                              {assigneesText
                                ? `${assigneesText} · ${STAGE_STATUS_LABELS[card.stageStatus]}`
                                : `${STAGE_STATUS_LABELS[card.stageStatus]} · 缺人`}
                            </span>
                          </div>

                          {showWorksheetSource && (
                            <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                              <CircleDot className="h-3 w-3 shrink-0" strokeWidth={1.75} />
                              <span
                                className={cn('h-1.5 w-1.5 shrink-0 rounded-full', wsColor.dot)}
                              />
                              <span className="truncate text-zinc-500">{card.worksheetName}</span>
                            </div>
                          )}
                        </div>

                        {/* 缺人工序一键认领 */}
                        {card.missingStages.length > 0 && (
                          <div className="mt-2.5 flex flex-wrap gap-1 border-t border-black/[0.05] pt-2">
                            {card.missingStages.map((ms) => {
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
                                  className="inline-flex items-center gap-0.5 rounded-md border border-black/[0.1] bg-[#fafafa] px-2 py-0.5 text-[11px] font-medium text-zinc-700 transition-colors hover:border-blue-300 hover:bg-blue-50/70 hover:text-blue-700 disabled:opacity-50 cursor-pointer"
                                >
                                  <Hand className="h-2.5 w-2.5" />
                                  {claiming ? '认领中…' : `缺 ${ms.name}`}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  }

                  // 作品大标题聚合卡（默认折叠，柔和靛蓝左侧强调边呼应表格作品横幅）
                  const expandKey = `${bc.id}:${item.key}`;
                  const expanded = expandedGroups.has(expandKey);
                  const wsColor =
                    WORKSHEET_COLOR_STYLES[item.worksheetColor] ?? WORKSHEET_COLOR_STYLES.sky;
                  const inProgressCount = item.cards.filter(
                    (c) => c.stageStatus === 'in_progress',
                  ).length;
                  const missingCount = item.cards.filter((c) => c.missingStages.length > 0).length;
                  const activeRatio =
                    item.cards.length > 0
                      ? Math.round((inProgressCount / item.cards.length) * 100)
                      : 0;

                  return (
                    <div
                      key={expandKey}
                      data-testid={`board-work-group-${item.workId}-${bc.id}`}
                      data-work-name={item.workName}
                      className="overflow-hidden rounded-lg border border-indigo-200/75 border-l-[3px] border-l-indigo-500 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-all hover:border-indigo-300/90 hover:shadow-[0_2px_8px_rgba(79,70,229,0.07)]"
                    >
                      {/* 作品卡头部 */}
                      <div className="bg-[#EEF2FF]/45 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Folder
                              className="h-3.5 w-3.5 shrink-0 text-indigo-500"
                              strokeWidth={1.75}
                            />
                            {showWorksheetSource && (
                              <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-zinc-500">
                                <span
                                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', wsColor.dot)}
                                />
                                <span className="truncate">{item.worksheetName}</span>
                              </span>
                            )}
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
                                title={`按作品「${item.workName}」筛选`}
                                aria-label={`筛选作品 ${item.workName}`}
                                className="rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 ring-1 ring-indigo-200/70 transition-colors hover:bg-indigo-100/70 cursor-pointer"
                              >
                                仅看此作品
                              </button>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={() => toggleGroupExpanded(expandKey)}
                            aria-expanded={expanded}
                            aria-label={
                              expanded
                                ? `收起作品 ${item.workName} 分段`
                                : `展开作品 ${item.workName} 分段`
                            }
                            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/90 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 ring-1 ring-indigo-200/60 transition-colors hover:bg-indigo-100/60 cursor-pointer"
                          >
                            <span className="tabular-nums">{item.cards.length} 段</span>
                            {expanded ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => toggleGroupExpanded(expandKey)}
                          className="mt-1.5 block w-full text-left cursor-pointer"
                        >
                          <div className="text-[13px] font-semibold leading-snug text-indigo-950">
                            {item.workName}
                          </div>

                          <div className="mt-2 flex items-center gap-2">
                            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-indigo-100">
                              <span
                                className="block h-full rounded-full bg-indigo-500 transition-all"
                                style={{ width: `${activeRatio}%` }}
                              />
                            </span>
                            <span className="truncate text-[11px] text-indigo-900/70 tabular-nums">
                              进行中 {inProgressCount}
                              {missingCount > 0 ? ` · 缺人 ${missingCount}` : ''}
                            </span>
                          </div>
                        </button>
                      </div>

                      {/* motion 平滑展开内部各分段 */}
                      <AnimatePresence initial={false}>
                        {expanded && (
                          <motion.div
                            key="segments"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                            className="overflow-hidden border-t border-indigo-200/60 bg-white"
                          >
                            <div className="divide-y divide-black/[0.05]">
                              {item.cards.map((card) => {
                                const assigneesText = formatAssignees(card.stageAssignees);
                                return (
                                  <div
                                    key={`${card.taskId}:${card.boardColumnId}`}
                                    data-testid={`board-card-${card.taskId}-${card.boardColumnId}`}
                                    className="px-3 py-2 transition-colors hover:bg-black/[0.02]"
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          onOpenDetail({
                                            worksheetId: card.worksheetId,
                                            taskId: card.taskId,
                                          })
                                        }
                                        className="min-w-0 flex-1 truncate text-left text-xs font-medium text-zinc-900 hover:text-blue-600 cursor-pointer"
                                      >
                                        {card.taskTitle}
                                      </button>
                                      <span
                                        className={cn(
                                          'shrink-0 rounded px-1.5 py-0.25 text-[11px]',
                                          card.stageStatus === 'in_progress'
                                            ? 'bg-[#EFF6FF] font-medium text-blue-700'
                                            : 'bg-zinc-100 text-zinc-600',
                                        )}
                                      >
                                        {assigneesText
                                          ? `${assigneesText} · ${STAGE_STATUS_LABELS[card.stageStatus]}`
                                          : STAGE_STATUS_LABELS[card.stageStatus]}
                                      </span>
                                    </div>

                                    {card.missingStages.length > 0 && (
                                      <div className="mt-1.5 flex flex-wrap gap-1">
                                        {card.missingStages.map((ms) => {
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
                                              className="inline-flex items-center gap-0.5 rounded border border-black/[0.1] bg-[#fafafa] px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 transition-colors hover:border-blue-300 hover:bg-blue-50/70 hover:text-blue-700 disabled:opacity-50 cursor-pointer"
                                            >
                                              <Hand className="h-2.5 w-2.5" />
                                              {claiming ? '认领中…' : `缺 ${ms.name}`}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
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
