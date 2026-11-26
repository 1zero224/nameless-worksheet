import {
  type CloudProvider,
  type ColumnType,
  isValidHttpUrl,
  type PublishStatus,
  parseShareText,
  type StageStatus,
  type WorksheetColor,
  type WorksheetKind,
  type WorksheetPlacement,
} from '@nw/shared';
import {
  classifyFillHex,
  formatExcelDuration,
  normalizeCellText,
  normalizeNullableCellText,
  normalizeSingleLine,
  parseCalendarDateString,
  truncateChars,
} from './normalize.js';
import { canonicalizePersonName, parseStageCellText } from './people.js';
import {
  getCell,
  getCellText,
  type XlsxRow,
  type XlsxSheet,
  type XlsxWorkbook,
} from './xlsx-reader.js';

export interface PlannedColumn {
  key: string;
  name: string;
  type: ColumnType;
  boardColumnName: string | null;
  width: number;
}

export interface PlannedStageCell {
  columnKey: string;
  userDisplayNames: string[];
  textAssignees: string[];
  status: StageStatus;
  note: string;
}

export interface PlannedTask {
  sourceKey: string;
  workName: string | null;
  title: string;
  divisionNote: string;
  publishStatus: PublishStatus;
  publishedAt: string | null;
  publishUrl: string | null;
  customValues: Record<string, string | null>;
  stageCells: PlannedStageCell[];
}

export interface PlannedWorkArtifact {
  sourceKey: string;
  workName: string;
  name: string;
  provider: CloudProvider;
  url: string;
  extractCode: string | null;
  note: string;
}

export interface PlannedWorksheet {
  sourceKey: string;
  name: string;
  kind: WorksheetKind;
  placement: WorksheetPlacement;
  color: WorksheetColor;
  columns: PlannedColumn[];
  works: string[];
  tasks: PlannedTask[];
  workArtifacts: PlannedWorkArtifact[];
  warnings: string[];
}

export interface ImportPlan {
  worksheets: PlannedWorksheet[];
  /** 所有需要确保存在的用户标准显示名（去重排序，含 12 制作表 + 6 留念表早期人员） */
  userDisplayNames: string[];
  warnings: string[];
}

/** 最终顶栏顺序：12 制作表 → 4 杂项自由表 → 6 留念自由表；⭐翻译对照表⭐ 放 /docs */
export const ORDERED_TARGET_SHEETS: ReadonlyArray<{
  name: string;
  kind: WorksheetKind;
  placement: WorksheetPlacement;
  color: WorksheetColor;
}> = [
  // 12 现行制作表
  { name: '长视频全熟', kind: 'task', placement: 'topbar', color: 'sky' },
  { name: '切片熟肉', kind: 'task', placement: 'topbar', color: 'blue' },
  { name: '中短视频', kind: 'task', placement: 'topbar', color: 'indigo' },
  { name: '刺刺广播2025-2026', kind: 'task', placement: 'topbar', color: 'violet' },
  { name: '总集篇', kind: 'task', placement: 'topbar', color: 'rose' },
  { name: '杂志', kind: 'task', placement: 'topbar', color: 'amber' },
  { name: '漫画', kind: 'task', placement: 'topbar', color: 'orange' },
  { name: '歌曲翻译', kind: 'task', placement: 'topbar', color: 'emerald' },
  { name: '周报', kind: 'task', placement: 'topbar', color: 'teal' },
  { name: '广播剧', kind: 'task', placement: 'topbar', color: 'pink' },
  { name: 'BD评论音轨', kind: 'task', placement: 'topbar', color: 'slate' },
  { name: '直播与转播', kind: 'task', placement: 'topbar', color: 'red' },
  // 通用文档在线表
  { name: '⭐翻译对照表⭐', kind: 'free', placement: 'docs', color: 'amber' },
  // 4 张杂项自由表
  { name: '首页', kind: 'free', placement: 'topbar', color: 'slate' },
  { name: '相关收益', kind: 'free', placement: 'topbar', color: 'emerald' },
  { name: '赞助奖品清单', kind: 'free', placement: 'topbar', color: 'amber' },
  { name: '2025除夕抽奖奖项', kind: 'free', placement: 'topbar', color: 'rose' },
  // 6 张留念自由表
  { name: '刺刺广播（留念用）', kind: 'free', placement: 'topbar', color: 'slate' },
  { name: 'WEB广播（留念用）', kind: 'free', placement: 'topbar', color: 'slate' },
  { name: 'GBC广播（留念用）', kind: 'free', placement: 'topbar', color: 'slate' },
  { name: '动漫工作表（留念用）', kind: 'free', placement: 'topbar', color: 'slate' },
  { name: '工作人员（留念用）', kind: 'free', placement: 'topbar', color: 'slate' },
  { name: '视频（留念用）', kind: 'free', placement: 'topbar', color: 'slate' },
];

function rowHasAnyText(row: XlsxRow, maxCol = 30): boolean {
  for (let c = 1; c <= maxCol; c++) {
    const cell = row.cells.get(c);
    if (cell && (cell.text !== '' || cell.hyperlink)) return true;
  }
  return false;
}

function rowColors(row: XlsxRow, cols: number[]): Set<ReturnType<typeof classifyFillHex>> {
  const s = new Set<ReturnType<typeof classifyFillHex>>();
  for (const c of cols) {
    const hex = row.cells.get(c)?.fillHex;
    const cls = classifyFillHex(hex);
    if (cls !== 'none') s.add(cls);
  }
  return s;
}

function isRowAllGreen(row: XlsxRow, cols: number[]): boolean {
  let greenCount = 0;
  let otherCount = 0;
  for (const c of cols) {
    const cls = classifyFillHex(row.cells.get(c)?.fillHex);
    if (cls === 'green') greenCount++;
    else if (cls !== 'none') otherCount++;
  }
  return greenCount >= Math.max(2, Math.floor(cols.length * 0.5)) && otherCount === 0;
}

function isRowMostlyGray(row: XlsxRow, cols: number[]): boolean {
  let grayCount = 0;
  for (const c of cols) {
    if (classifyFillHex(row.cells.get(c)?.fillHex) === 'gray') grayCount++;
  }
  return grayCount >= Math.max(2, Math.floor(cols.length * 0.4));
}

function formatLinkOrTextCell(
  sheet: XlsxSheet,
  rowNum: number,
  col: number,
  inherit = false,
): string | null {
  const cell = getCell(sheet, rowNum, col, inherit);
  if (!cell) return null;
  if (cell.hyperlink && isValidHttpUrl(cell.hyperlink)) {
    if (cell.text && cell.text !== cell.hyperlink && !cell.text.includes('http')) {
      return `${cell.text} ${cell.hyperlink}`;
    }
    return cell.hyperlink;
  }
  return normalizeNullableCellText(cell.text);
}

function formatLinkOnlyCell(
  sheet: XlsxSheet,
  rowNum: number,
  col: number,
  inherit = false,
): string | null {
  const cell = getCell(sheet, rowNum, col, inherit);
  if (!cell) return null;
  if (cell.hyperlink && isValidHttpUrl(cell.hyperlink)) return cell.hyperlink;
  if (cell.text && isValidHttpUrl(cell.text)) return cell.text;
  return null;
}

function formatDurationMaybeRaw(text: string): string | null {
  const t = normalizeSingleLine(text);
  if (!t) return null;
  // 处理切片熟肉 R29 等未设时间格式的小数分数（0 < n < 1）
  if (/^0\.\d{3,}$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n) && n > 0 && n < 1) {
      return formatExcelDuration(n, false) ?? t;
    }
  }
  return t;
}

/**
 * 构建单个工序格：严格遵守第 7.1 节「无色单元格绝不静默判为 done」红线。
 */
function buildStageCell(
  sheet: XlsxSheet,
  rowNum: number,
  cols: number[],
  columnKey: string,
  opts?: {
    inheritMerge?: boolean;
    blueMeansInProgress?: boolean;
    allowSpaceSplit?: boolean;
    rowIsPublished?: boolean;
  },
): { cell: PlannedStageCell; extraProofreaders: string[] } {
  const users = new Set<string>();
  const texts = new Set<string>();
  const notes: string[] = [];
  const extraProof = new Set<string>();

  let hasGreen = false;
  let hasYellow = false;
  let hasBlue = false;
  let anyNa = false;
  let anyInProgressKeyword = false;

  for (const col of cols) {
    const cellObj = getCell(sheet, rowNum, col, opts?.inheritMerge ?? false);
    const directCell = sheet.rowMap.get(rowNum)?.cells.get(col);
    const fill = classifyFillHex(directCell?.fillHex ?? cellObj?.fillHex);
    if (fill === 'green') hasGreen = true;
    else if (fill === 'yellow') hasYellow = true;
    else if (fill === 'blue') hasBlue = true;

    const rawText = cellObj?.text ?? '';
    if (!rawText) continue;

    const parsed = parseStageCellText(rawText, { allowSpaceSplit: opts?.allowSpaceSplit });
    for (const u of parsed.userDisplayNames) users.add(u);
    for (const t of parsed.textAssignees) texts.add(t);
    for (const n of parsed.notes) notes.push(n);
    for (const p of parsed.extraProofreaderNames) extraProof.add(p);
    if (parsed.isNa) anyNa = true;
    if (parsed.isInProgressKeyword) anyInProgressKeyword = true;
  }

  let status: StageStatus = 'not_started';
  if (anyNa && users.size === 0 && texts.size === 0) {
    status = 'na';
  } else if (hasYellow || anyInProgressKeyword) {
    status = 'in_progress';
  } else if (hasBlue && opts?.blueMeansInProgress) {
    status = 'in_progress';
  } else if (hasGreen) {
    status = 'done';
  } else {
    // 严格红线：无色单元格即使有负责人也必须判 not_started（绝不静默判 done）
    status = 'not_started';
  }

  const dedupedNotes = [...new Set(notes.map((n) => n.trim()).filter(Boolean))];
  return {
    cell: {
      columnKey,
      userDisplayNames: [...users],
      textAssignees: [...texts],
      status,
      note: truncateChars(dedupedNotes.join('；'), 200),
    },
    extraProofreaders: [...extraProof],
  };
}

function addWorkOrdered(works: string[], name: string | null): string | null {
  if (!name) return null;
  const clean = truncateChars(normalizeSingleLine(name), 80);
  if (!clean) return null;
  if (!works.includes(clean)) works.push(clean);
  return clean;
}

function parseDateWithFallback(raw: string): { date: string | null; leftoverNote: string | null } {
  const t = normalizeSingleLine(raw);
  if (!t || t === '\\' || t === '/' || t === '-') return { date: null, leftoverNote: null };
  // 支持「片源：2025.09.21」
  const stripped = t.replace(/^片源\s*[:：]\s*/, '');
  const parsed = parseCalendarDateString(stripped);
  if (parsed) return { date: parsed, leftoverNote: null };
  return { date: null, leftoverNote: t };
}

function deriveFreeTitle(
  customValues: Record<string, string | null>,
  cols: PlannedColumn[],
): string {
  for (const col of cols) {
    const v = customValues[col.key];
    if (v) {
      const oneLine = v.replace(/\s+/g, ' ').trim();
      if (oneLine) return truncateChars(oneLine, 200);
    }
  }
  return '';
}

function shouldSkipTemplateBroadcastGarbage(title: string): boolean {
  return /^刺刺广播\s*#\d+/.test(title.trim());
}

// ============================================================================
// 12 张现行制作工作表专表映射
// ============================================================================

function mapLongVideoSheet(sheet: XlsxSheet): PlannedWorksheet {
  const columns: PlannedColumn[] = [
    { key: 'axis', name: '时轴', type: 'stage', boardColumnName: '时轴', width: 160 },
    { key: 'trans', name: '翻译', type: 'stage', boardColumnName: '翻译', width: 160 },
    { key: 'proof', name: '校对', type: 'stage', boardColumnName: '校对', width: 160 },
    { key: 'post', name: '后期', type: 'stage', boardColumnName: null, width: 140 },
    { key: 'encode', name: '压制', type: 'stage', boardColumnName: null, width: 140 },
    { key: 'source', name: '源', type: 'text', boardColumnName: null, width: 200 },
    { key: 'filename', name: '文件命名', type: 'text', boardColumnName: null, width: 180 },
  ];

  const works: string[] = [];
  const tasks: PlannedTask[] = [];
  const workArtifacts: PlannedWorkArtifact[] = [];
  const warnings: string[] = [];
  let currentWork: string | null = null;
  let currentWorkShelved = false;

  for (const row of sheet.rows) {
    if (row.rowNumber <= 2) continue;
    if (!rowHasAnyText(row, 11)) continue;

    const c1 = row.cells.get(1);
    const c2 = row.cells.get(2);
    const isRedBanner =
      classifyFillHex(c2?.fillHex) === 'red' || classifyFillHex(c1?.fillHex) === 'red';
    const isGrayBanner =
      c2?.fillHex?.toUpperCase() === '#939393' &&
      !row.cells.get(3)?.text &&
      !row.cells.get(4)?.text &&
      Boolean(c2?.text);

    if (isRedBanner || isGrayBanner) {
      const bannerTitle = normalizeSingleLine(c2?.text || c1?.text || '');
      if (bannerTitle) {
        currentWork = addWorkOrdered(works, bannerTitle);
        currentWorkShelved = isGrayBanner;
      }
      continue;
    }

    // 检查是否整行灰块（如 R13–R17）
    const rowGray = currentWorkShelved || isRowMostlyGray(row, [1, 2, 3, 4, 5, 6]);

    // 标题 = A + B（合并分段继承 B）
    const pPart = normalizeSingleLine(getCellText(sheet, row.rowNumber, 1, false));
    const segPart = normalizeSingleLine(getCellText(sheet, row.rowNumber, 2, true));
    let title = [pPart, segPart].filter(Boolean).join(' ').trim();

    // 跳过仅含文件命名示例/无任务主体的尾部空行（如 R135/R139 仅 C11 有命名示例且无分段/无负责人）
    const hasStagePerson = [3, 4, 5, 6, 9].some((c) => Boolean(row.cells.get(c)?.text));
    if (!title && !hasStagePerson) continue;
    if (!title) {
      title = `分段 R${row.rowNumber}`;
    }

    // 检查 C8/C9 是否有百度网盘分享文本（I124 / I133 位于 C9）
    let sourceText = formatLinkOrTextCell(sheet, row.rowNumber, 8, true);
    const c9Direct = row.cells.get(9);
    const c9Text = c9Direct?.text ?? '';
    let encodeColHasShareText = false;
    if (c9Text.includes('pan.baidu.com') || c9Text.includes('通过网盘分享的文件')) {
      encodeColHasShareText = true;
      const parsed = parseShareText(c9Text);
      const url =
        parsed.url ??
        (c9Direct?.hyperlink && isValidHttpUrl(c9Direct.hyperlink) ? c9Direct.hyperlink : null);
      if (url && currentWork) {
        const artifactName = truncateChars(parsed.suggestedName ?? `${currentWork} 原片`, 120);
        workArtifacts.push({
          sourceKey: `长视频全熟:R${row.rowNumber}:C9:work_artifact`,
          workName: currentWork,
          name: artifactName,
          provider: parsed.provider ?? 'baidu',
          url,
          extractCode: parsed.extractCode,
          note: '从原工作簿「长视频全熟」自动迁移',
        });
      }
      // 不把网盘分享长文本误当作压制负责人
      if (!sourceText) sourceText = '百度网盘（已挂作品共用资源）';
    } else if (c9Text === '群文件') {
      encodeColHasShareText = true;
      sourceText = sourceText ? `${sourceText} / 群文件` : '群文件';
    }

    const stageAxis = buildStageCell(sheet, row.rowNumber, [3], 'axis', { inheritMerge: true });
    const stageTrans = buildStageCell(sheet, row.rowNumber, [4], 'trans', { inheritMerge: true });
    const stageProof = buildStageCell(sheet, row.rowNumber, [5], 'proof', { inheritMerge: true });
    const stagePost = buildStageCell(sheet, row.rowNumber, [6], 'post', { inheritMerge: false });
    const stageEncode = encodeColHasShareText
      ? {
          cell: {
            columnKey: 'encode',
            userDisplayNames: [],
            textAssignees: [],
            status: 'not_started' as const,
            note: '',
          },
          extraProofreaders: [],
        }
      : buildStageCell(sheet, row.rowNumber, [9], 'encode', { inheritMerge: false });

    // 发布日期（G = C7）
    const rawDate = getCellText(sheet, row.rowNumber, 7, true);
    const { date: publishedAt, leftoverNote: dateLeftover } = parseDateWithFallback(rawDate);

    // 备注（J = C10）
    const rawNote = normalizeCellText(getCellText(sheet, row.rowNumber, 10, false));
    const divisionNoteParts = [rawNote, dateLeftover ? `日期备注：${dateLeftover}` : ''].filter(
      Boolean,
    );
    const divisionNote = truncateChars(divisionNoteParts.join('\n'), 500);

    const filenameVal = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 11, false));

    let publishStatus: PublishStatus = 'unpublished';
    if (rowGray) {
      publishStatus = 'shelved';
    } else if (row.hidden || isRowAllGreen(row, [1, 2, 3, 4, 5, 6])) {
      publishStatus = 'published';
    }

    tasks.push({
      sourceKey: `长视频全熟:R${row.rowNumber}`,
      workName: currentWork,
      title: truncateChars(title, 200),
      divisionNote,
      publishStatus,
      publishedAt,
      publishUrl: null,
      customValues: {
        source: sourceText ? truncateChars(sourceText, 2000) : null,
        filename: filenameVal ? truncateChars(filenameVal, 2000) : null,
      },
      stageCells: [
        stageAxis.cell,
        stageTrans.cell,
        stageProof.cell,
        stagePost.cell,
        stageEncode.cell,
      ],
    });
  }

  return {
    sourceKey: 'sheet:长视频全熟',
    name: '长视频全熟',
    kind: 'task',
    placement: 'topbar',
    color: 'sky',
    columns,
    works,
    tasks,
    workArtifacts,
    warnings,
  };
}

function mapClipSheet(sheet: XlsxSheet): PlannedWorksheet {
  const columns: PlannedColumn[] = [
    { key: 'clip', name: '切片', type: 'stage', boardColumnName: null, width: 130 },
    { key: 'axis', name: '时轴', type: 'stage', boardColumnName: '时轴', width: 150 },
    { key: 'trans', name: '翻译', type: 'stage', boardColumnName: '翻译', width: 150 },
    { key: 'proof', name: '校对', type: 'stage', boardColumnName: '校对', width: 150 },
    { key: 'art', name: '美工/封面', type: 'stage', boardColumnName: null, width: 140 },
    { key: 'post', name: '后期', type: 'stage', boardColumnName: null, width: 140 },
    { key: 'duration', name: '时长', type: 'text', boardColumnName: null, width: 110 },
    { key: 'draftTitle', name: '拟标题', type: 'text', boardColumnName: null, width: 180 },
    { key: 'source', name: '源', type: 'text', boardColumnName: null, width: 220 },
  ];

  const works: string[] = [];
  const tasks: PlannedTask[] = [];
  let currentWork: string | null = null;

  for (const row of sheet.rows) {
    if (row.rowNumber <= 2) continue;
    if (!rowHasAnyText(row, 12)) continue;

    const c1 = row.cells.get(1);
    const c1Text = normalizeSingleLine(c1?.text ?? '');

    // R30 红底 Avoid Note 为作品横幅
    if (classifyFillHex(c1?.fillHex) === 'red' && c1Text) {
      currentWork = addWorkOrdered(works, c1Text);
      continue;
    }

    // 跳过 R72–R73 分隔提示行
    if (
      c1Text.includes('以上为旧活') ||
      c1Text.includes('以下为新活') ||
      c1Text.includes('隐藏已完成的任务时请勿隐藏')
    ) {
      currentWork = null;
      continue;
    }

    // Avoid Note 下方歌切结束后（离开 R31..R48 或不再以歌切开头且无该作品关联）退出作品分组
    if (currentWork && row.rowNumber > 48) {
      currentWork = null;
    }

    // 跳过空白占位模板行（如 R121..199 仅填了固定前缀且无任何其他内容）
    const otherColsHaveData = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].some((c) => {
      const cell = row.cells.get(c);
      return Boolean(cell?.text || cell?.hyperlink);
    });
    if (c1Text === '【广播】「刺刺广播~从川崎到世界~」' && !otherColsHaveData) {
      continue;
    }

    const inheritedTitle = normalizeSingleLine(getCellText(sheet, row.rowNumber, 1, true));
    const duration = formatDurationMaybeRaw(getCellText(sheet, row.rowNumber, 2, false));
    if (!inheritedTitle && !otherColsHaveData) continue;

    // A3:A4 合并分段继承（同一视频拆成两段时拼入时段避免重名）
    const isMergedTitleChild = !c1Text && Boolean(inheritedTitle);
    const title =
      isMergedTitleChild && duration
        ? `${inheritedTitle} (${duration})`
        : inheritedTitle || `切片 R${row.rowNumber}`;

    const isGray = isRowMostlyGray(row, [1, 2, 3, 4, 5, 6, 7, 8]);
    let publishStatus: PublishStatus = 'unpublished';
    if (isGray) {
      publishStatus = 'shelved';
    } else if (row.hidden || isRowAllGreen(row, [1, 2, 3, 4, 5, 7])) {
      publishStatus = 'published';
    }

    const stageClip = buildStageCell(sheet, row.rowNumber, [3], 'clip', { inheritMerge: true });
    const stageAxis = buildStageCell(sheet, row.rowNumber, [4], 'axis', { inheritMerge: true });
    const stageTrans = buildStageCell(sheet, row.rowNumber, [5], 'trans', { inheritMerge: false });
    const stageProof = buildStageCell(sheet, row.rowNumber, [7], 'proof', { inheritMerge: true });
    const stageArt = buildStageCell(sheet, row.rowNumber, [9], 'art', { inheritMerge: true });
    const stagePost = buildStageCell(sheet, row.rowNumber, [6, 10], 'post', { inheritMerge: true });

    const draftTitle = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 8, false));
    const { date: publishedAt, leftoverNote } = parseDateWithFallback(
      getCellText(sheet, row.rowNumber, 11, true),
    );
    const sourceVal = formatLinkOrTextCell(sheet, row.rowNumber, 12, true);

    tasks.push({
      sourceKey: `切片熟肉:R${row.rowNumber}`,
      workName: currentWork,
      title: truncateChars(title, 200),
      divisionNote: leftoverNote ? truncateChars(leftoverNote, 500) : '',
      publishStatus,
      publishedAt,
      publishUrl: null,
      customValues: {
        duration,
        draftTitle: draftTitle ? truncateChars(draftTitle, 2000) : null,
        source: sourceVal ? truncateChars(sourceVal, 2000) : null,
      },
      stageCells: [
        stageClip.cell,
        stageAxis.cell,
        stageTrans.cell,
        stageProof.cell,
        stageArt.cell,
        stagePost.cell,
      ],
    });
  }

  return {
    sourceKey: 'sheet:切片熟肉',
    name: '切片熟肉',
    kind: 'task',
    placement: 'topbar',
    color: 'blue',
    columns,
    works,
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

function mapMidShortVideoSheet(sheet: XlsxSheet): PlannedWorksheet {
  const columns: PlannedColumn[] = [
    { key: 'axis', name: '时轴', type: 'stage', boardColumnName: '时轴', width: 150 },
    { key: 'trans', name: '翻译', type: 'stage', boardColumnName: '翻译', width: 150 },
    { key: 'proof', name: '校对', type: 'stage', boardColumnName: '校对', width: 150 },
    { key: 'titleCol', name: '标题', type: 'stage', boardColumnName: null, width: 130 },
    { key: 'art', name: '美工/封面', type: 'stage', boardColumnName: null, width: 140 },
    { key: 'post', name: '后期', type: 'stage', boardColumnName: null, width: 140 },
    { key: 'duration', name: '时长', type: 'text', boardColumnName: null, width: 120 },
    { key: 'needTrans', name: '是否翻译', type: 'text', boardColumnName: null, width: 100 },
    { key: 'source', name: '源', type: 'text', boardColumnName: null, width: 200 },
  ];

  const works: string[] = [];
  const tasks: PlannedTask[] = [];

  for (const row of sheet.rows) {
    if (row.rowNumber <= 2) continue;
    if (!rowHasAnyText(row, 11)) continue;

    // A8:A9（5th幕后花絮）归为同一作品
    const is5thMerge = row.rowNumber === 8 || row.rowNumber === 9;
    const rawA = normalizeSingleLine(getCellText(sheet, row.rowNumber, 1, true));
    const duration = formatDurationMaybeRaw(getCellText(sheet, row.rowNumber, 2, false));
    if (!rawA) continue;

    let workName: string | null = null;
    let title = rawA;
    if (is5thMerge) {
      workName = addWorkOrdered(works, rawA);
      title = duration ? `${rawA} (${duration})` : `${rawA} P${row.rowNumber - 7}`;
    }

    const publishStatus: PublishStatus =
      row.hidden || isRowAllGreen(row, [1, 2, 3, 4, 5, 6]) ? 'published' : 'unpublished';

    const stageAxis = buildStageCell(sheet, row.rowNumber, [4], 'axis', { inheritMerge: true });
    const stageTrans = buildStageCell(sheet, row.rowNumber, [5], 'trans', { inheritMerge: false });
    const stageProof = buildStageCell(sheet, row.rowNumber, [6], 'proof', { inheritMerge: false });
    const stageTitle = buildStageCell(sheet, row.rowNumber, [7], 'titleCol', {
      inheritMerge: false,
    });
    const stageArt = buildStageCell(sheet, row.rowNumber, [8], 'art', { inheritMerge: false });
    const stagePost = buildStageCell(sheet, row.rowNumber, [9], 'post', { inheritMerge: false });

    const needTrans = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 3, true));
    const { date: publishedAt, leftoverNote } = parseDateWithFallback(
      getCellText(sheet, row.rowNumber, 10, false),
    );
    const source = formatLinkOrTextCell(sheet, row.rowNumber, 11, false);

    tasks.push({
      sourceKey: `中短视频:R${row.rowNumber}`,
      workName,
      title: truncateChars(title, 200),
      divisionNote: leftoverNote ? truncateChars(leftoverNote, 500) : '',
      publishStatus,
      publishedAt,
      publishUrl: null,
      customValues: {
        duration,
        needTrans,
        source: source ? truncateChars(source, 2000) : null,
      },
      stageCells: [
        stageAxis.cell,
        stageTrans.cell,
        stageProof.cell,
        stageTitle.cell,
        stageArt.cell,
        stagePost.cell,
      ],
    });
  }

  return {
    sourceKey: 'sheet:中短视频',
    name: '中短视频',
    kind: 'task',
    placement: 'topbar',
    color: 'indigo',
    columns,
    works,
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

function mapRadio2025Sheet(sheet: XlsxSheet): PlannedWorksheet {
  const columns: PlannedColumn[] = [
    { key: 'axis', name: '时轴', type: 'stage', boardColumnName: '时轴', width: 150 },
    { key: 'trans', name: '翻译', type: 'stage', boardColumnName: '翻译', width: 150 },
    { key: 'proof', name: '校对', type: 'stage', boardColumnName: '校对', width: 150 },
    { key: 'titleCol', name: '标题', type: 'stage', boardColumnName: null, width: 130 },
    { key: 'art', name: '美工/封面', type: 'stage', boardColumnName: null, width: 140 },
    { key: 'post', name: '后期', type: 'stage', boardColumnName: null, width: 140 },
    { key: 'cast', name: '出场成员', type: 'text', boardColumnName: null, width: 150 },
    { key: 'mode', name: '全熟/切片', type: 'text', boardColumnName: null, width: 110 },
    { key: 'source', name: '源', type: 'text', boardColumnName: null, width: 180 },
  ];

  const tasks: PlannedTask[] = [];
  for (const row of sheet.rows) {
    if (row.rowNumber <= 2) continue;
    const title = normalizeSingleLine(getCellText(sheet, row.rowNumber, 1, false));
    if (!title) continue;

    const publishStatus: PublishStatus = isRowAllGreen(row, [1, 2, 3, 4, 6, 8, 12])
      ? 'published'
      : 'unpublished';

    const stageAxis = buildStageCell(sheet, row.rowNumber, [4, 5], 'axis');
    const stageTrans = buildStageCell(sheet, row.rowNumber, [6, 7], 'trans');
    const stageProof = buildStageCell(sheet, row.rowNumber, [8], 'proof');
    const stageTitle = buildStageCell(sheet, row.rowNumber, [9], 'titleCol');
    const stageArt = buildStageCell(sheet, row.rowNumber, [10], 'art');
    const stagePost = buildStageCell(sheet, row.rowNumber, [11], 'post');

    const cast = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 2, false));
    const mode = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 3, false));
    const { date: publishedAt, leftoverNote } = parseDateWithFallback(
      getCellText(sheet, row.rowNumber, 12, false),
    );
    const source = formatLinkOrTextCell(sheet, row.rowNumber, 13, false);

    tasks.push({
      sourceKey: `刺刺广播2025-2026:R${row.rowNumber}`,
      workName: null,
      title: truncateChars(title, 200),
      divisionNote: leftoverNote ? truncateChars(leftoverNote, 500) : '',
      publishStatus,
      publishedAt,
      publishUrl: null,
      customValues: {
        cast,
        mode,
        source: source ? truncateChars(source, 2000) : null,
      },
      stageCells: [
        stageAxis.cell,
        stageTrans.cell,
        stageProof.cell,
        stageTitle.cell,
        stageArt.cell,
        stagePost.cell,
      ],
    });
  }

  return {
    sourceKey: 'sheet:刺刺广播2025-2026',
    name: '刺刺广播2025-2026',
    kind: 'task',
    placement: 'topbar',
    color: 'violet',
    columns,
    works: [],
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

function mapRecapSheet(sheet: XlsxSheet): PlannedWorksheet {
  const columns: PlannedColumn[] = [
    { key: 'axis', name: '时轴', type: 'stage', boardColumnName: '时轴', width: 150 },
    { key: 'trans', name: '新内容翻译', type: 'stage', boardColumnName: '翻译', width: 150 },
    { key: 'proof', name: '校对', type: 'stage', boardColumnName: '校对', width: 150 },
    { key: 'post', name: '后期', type: 'stage', boardColumnName: null, width: 130 },
    { key: 'encode', name: '压制', type: 'stage', boardColumnName: null, width: 130 },
    { key: 'source', name: '源', type: 'text', boardColumnName: null, width: 140 },
    { key: 'newPos', name: '新内容位置', type: 'text', boardColumnName: null, width: 220 },
  ];

  const works: string[] = [];
  const tasks: PlannedTask[] = [];
  let currentWork: string | null = null;
  const sheetInstruction = normalizeCellText(getCellText(sheet, 2, 11, false));
  let instructionAttached = false;

  for (const row of sheet.rows) {
    if (row.rowNumber <= 2) continue;
    if (!rowHasAnyText(row, 10)) continue;

    const c2 = row.cells.get(2);
    if (
      classifyFillHex(c2?.fillHex) === 'red' ||
      classifyFillHex(row.cells.get(1)?.fillHex) === 'red'
    ) {
      const name = normalizeSingleLine(c2?.text ?? '');
      if (name) currentWork = addWorkOrdered(works, name);
      continue;
    }

    const pPart = normalizeSingleLine(getCellText(sheet, row.rowNumber, 1, false));
    const segPart = normalizeSingleLine(getCellText(sheet, row.rowNumber, 2, false));
    const title = [pPart, segPart].filter(Boolean).join(' ').trim();
    if (!title) continue;

    const publishStatus: PublishStatus = isRowAllGreen(row, [1, 2, 3, 4, 5, 6])
      ? 'published'
      : 'unpublished';

    const stageAxis = buildStageCell(sheet, row.rowNumber, [3], 'axis');
    const stageTrans = buildStageCell(sheet, row.rowNumber, [4], 'trans');
    const stageProof = buildStageCell(sheet, row.rowNumber, [5], 'proof');
    const stagePost = buildStageCell(sheet, row.rowNumber, [6], 'post');
    const stageEncode = buildStageCell(sheet, row.rowNumber, [9], 'encode', { inheritMerge: true });

    const { date: publishedAt } = parseDateWithFallback(
      getCellText(sheet, row.rowNumber, 7, false),
    );
    const source = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 8, true));
    const newPos = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 10, false));

    let divisionNote = '';
    if (!instructionAttached && sheetInstruction) {
      divisionNote = truncateChars(sheetInstruction, 500);
      instructionAttached = true;
    }

    tasks.push({
      sourceKey: `总集篇:R${row.rowNumber}`,
      workName: currentWork,
      title: truncateChars(title, 200),
      divisionNote,
      publishStatus,
      publishedAt,
      publishUrl: null,
      customValues: {
        source,
        newPos: newPos ? truncateChars(newPos, 2000) : null,
      },
      stageCells: [
        stageAxis.cell,
        stageTrans.cell,
        stageProof.cell,
        stagePost.cell,
        stageEncode.cell,
      ],
    });
  }

  return {
    sourceKey: 'sheet:总集篇',
    name: '总集篇',
    kind: 'task',
    placement: 'topbar',
    color: 'rose',
    columns,
    works,
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

function mapMagazineSheet(sheet: XlsxSheet): PlannedWorksheet {
  const columns: PlannedColumn[] = [
    { key: 'trans', name: '翻译', type: 'stage', boardColumnName: '翻译', width: 150 },
    { key: 'proof', name: '校对', type: 'stage', boardColumnName: '校对', width: 150 },
    { key: 'typeset', name: '嵌字/排版', type: 'stage', boardColumnName: '嵌字', width: 150 },
    { key: 'issue', name: '杂志期刊', type: 'text', boardColumnName: null, width: 180 },
    { key: 'interviewees', name: '受访人员', type: 'text', boardColumnName: null, width: 160 },
    { key: 'source', name: '源/链接', type: 'text', boardColumnName: null, width: 220 },
  ];

  // 需聚合为作品横幅的期刊前缀/系列（按第 7.2 节规范）
  const GROUPED_ISSUES = [
    '剧场版总集篇场刊·前篇',
    'GBC公式 MAKING BOOK',
    '剧场版总集篇场刊·后篇',
    '剧场版总集篇特典',
  ];

  const works: string[] = [];
  const tasks: PlannedTask[] = [];
  let activeGroupWork: string | null = null;

  for (const row of sheet.rows) {
    if (row.rowNumber <= 3) continue; // 跳过 R1 表头与 R2–R3 提示行
    if (!rowHasAnyText(row, 10)) continue;

    const rawF = normalizeSingleLine(getCellText(sheet, row.rowNumber, 6, false));
    const rawB = normalizeSingleLine(getCellText(sheet, row.rowNumber, 2, false));

    // 跳过 R4–R12 复制模板残留的「刺刺广播 #2–#12」垃圾行
    if (shouldSkipTemplateBroadcastGarbage(rawF)) continue;

    const title = rawF || rawB;
    if (!title) continue;

    let workName: string | null = null;
    if (GROUPED_ISSUES.includes(rawB)) {
      activeGroupWork = addWorkOrdered(works, rawB);
      workName = activeGroupWork;
    } else if (activeGroupWork && (rawB === '-' || rawB === '')) {
      workName = activeGroupWork;
    } else {
      activeGroupWork = null;
      workName = null;
    }

    const colJFill = classifyFillHex(row.cells.get(10)?.fillHex);
    const allGreenAI = isRowAllGreen(row, [1, 2, 3, 4, 5, 6, 7, 8, 9]);

    let publishStatus: PublishStatus = 'unpublished';
    let extraWarnNote = '';
    if (allGreenAI && colJFill === 'yellow') {
      // R94–R101：A–I 绿底但 J 列标黄 → 已完成未发布并留备注
      publishStatus = 'unpublished';
      extraWarnNote = '原表 J 列标黄待核对';
    } else if (allGreenAI) {
      publishStatus = 'published';
    }

    const stageTrans = buildStageCell(sheet, row.rowNumber, [3], 'trans');
    const stageProof = buildStageCell(sheet, row.rowNumber, [4], 'proof');
    const stageTypeset = buildStageCell(sheet, row.rowNumber, [5], 'typeset');

    const { date: publishedAt, leftoverNote } = parseDateWithFallback(
      getCellText(sheet, row.rowNumber, 1, false),
    );
    const issueVal = rawB && rawB !== '-' ? rawB : workName;
    const interviewees = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 7, false));
    const source =
      formatLinkOrTextCell(sheet, row.rowNumber, 8, false) ??
      formatLinkOnlyCell(sheet, row.rowNumber, 6, false);
    const noteI = normalizeCellText(getCellText(sheet, row.rowNumber, 9, false));
    const divisionNote = truncateChars(
      [noteI, extraWarnNote, leftoverNote ? `日期备注：${leftoverNote}` : '']
        .filter(Boolean)
        .join('\n'),
      500,
    );

    tasks.push({
      sourceKey: `杂志:R${row.rowNumber}`,
      workName,
      title: truncateChars(title, 200),
      divisionNote,
      publishStatus,
      publishedAt,
      publishUrl: null,
      customValues: {
        issue: issueVal,
        interviewees,
        source: source ? truncateChars(source, 2000) : null,
      },
      stageCells: [stageTrans.cell, stageProof.cell, stageTypeset.cell],
    });
  }

  return {
    sourceKey: 'sheet:杂志',
    name: '杂志',
    kind: 'task',
    placement: 'topbar',
    color: 'amber',
    columns,
    works,
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

function mapMangaSheet(sheet: XlsxSheet): PlannedWorksheet {
  const columns: PlannedColumn[] = [
    { key: 'trans', name: '翻译', type: 'stage', boardColumnName: '翻译', width: 150 },
    { key: 'proof', name: '校对', type: 'stage', boardColumnName: '校对', width: 150 },
    { key: 'typeset', name: '嵌字/排版', type: 'stage', boardColumnName: '嵌字', width: 150 },
    { key: 'origName', name: '漫画原名', type: 'text', boardColumnName: null, width: 220 },
    { key: 'source', name: '图源/链接', type: 'text', boardColumnName: null, width: 200 },
    { key: 'noteCol', name: '备注', type: 'text', boardColumnName: null, width: 180 },
  ];

  const tasks: PlannedTask[] = [];
  let inSecondSection = false;

  for (const row of sheet.rows) {
    if (row.rowNumber <= 2) continue;
    if (!rowHasAnyText(row, 11)) continue;

    const c1 = normalizeSingleLine(getCellText(sheet, row.rowNumber, 1, false));
    const c2 = normalizeSingleLine(getCellText(sheet, row.rowNumber, 2, false));
    const c4 = normalizeSingleLine(getCellText(sheet, row.rowNumber, 4, false));

    // 跳过 R3–R11 隐藏的「刺刺广播 #2–#12」模板残留行
    if (shouldSkipTemplateBroadcastGarbage(c4)) continue;

    // 跳过 R19–R21 说明/第二套表头行
    if (
      c1.includes('漫画发布注意事项') ||
      c1 === '①' ||
      c1 === '②' ||
      c2.includes('在漫画空行新增')
    ) {
      inSecondSection = true;
      continue;
    }

    if (!inSecondSection) {
      // 上半区（R12–R14 等）：C1=日期, C2=漫画名, C3=人员, C4=标题, C5=源, C6..9=翻译, C10=校对, C11=嵌字
      const title = c4 || c2 || c1;
      if (!title) continue;

      const { date: publishedAt, leftoverNote } = parseDateWithFallback(c1);
      const publishStatus: PublishStatus = isRowAllGreen(row, [1, 2, 4, 6, 10, 11])
        ? 'published'
        : 'unpublished';

      const stageTrans = buildStageCell(sheet, row.rowNumber, [6, 7, 8, 9], 'trans', {
        blueMeansInProgress: true,
        allowSpaceSplit: true,
      });
      const stageProof = buildStageCell(sheet, row.rowNumber, [10], 'proof', {
        blueMeansInProgress: true,
        allowSpaceSplit: true,
      });
      const stageTypeset = buildStageCell(sheet, row.rowNumber, [11], 'typeset', {
        blueMeansInProgress: true,
        allowSpaceSplit: true,
      });

      const source = formatLinkOrTextCell(sheet, row.rowNumber, 5, false);
      const staffNote = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 3, false));

      tasks.push({
        sourceKey: `漫画:R${row.rowNumber}`,
        workName: null,
        title: truncateChars(title, 200),
        divisionNote: leftoverNote ? truncateChars(leftoverNote, 500) : '',
        publishStatus,
        publishedAt,
        publishUrl: null,
        customValues: {
          origName: c2 || null,
          source: source ? truncateChars(source, 2000) : null,
          noteCol: staffNote,
        },
        stageCells: [stageTrans.cell, stageProof.cell, stageTypeset.cell],
      });
    } else {
      // 下半区（R22–R26）：C1=标题, C2=译者, C3=嵌字, C4=图源, C5=发布动态链接, C6/C10/C11 可选补充
      const title = c1;
      if (!title) continue;

      const publishStatus: PublishStatus = isRowAllGreen(row, [1, 2, 3])
        ? 'published'
        : 'unpublished';

      // R23 同时填了 C2/C6、C10、C3/C11；合并去重
      const transCols = row.cells.get(6)?.text ? [6] : [2];
      const stageTrans = buildStageCell(sheet, row.rowNumber, transCols, 'trans', {
        blueMeansInProgress: true,
        allowSpaceSplit: true,
      });
      const stageProof = buildStageCell(sheet, row.rowNumber, [10], 'proof', {
        blueMeansInProgress: true,
        allowSpaceSplit: true,
      });
      // 若译者栏括号中显式写了「（校对：斗笠）」且校对栏为空，则写入校对格
      if (
        stageProof.cell.userDisplayNames.length === 0 &&
        stageTrans.extraProofreaders.length > 0
      ) {
        stageProof.cell.userDisplayNames = [...stageTrans.extraProofreaders];
        if (stageTrans.cell.status === 'done') stageProof.cell.status = 'done';
      }
      const typesetCols = row.cells.get(11)?.text ? [3, 11] : [3];
      const stageTypeset = buildStageCell(sheet, row.rowNumber, typesetCols, 'typeset', {
        blueMeansInProgress: true,
        allowSpaceSplit: true,
      });

      const source = normalizeNullableCellText(c4);
      const publishUrl = formatLinkOnlyCell(sheet, row.rowNumber, 5, false);

      tasks.push({
        sourceKey: `漫画:R${row.rowNumber}`,
        workName: null,
        title: truncateChars(title, 200),
        divisionNote: '',
        publishStatus,
        publishedAt: null,
        publishUrl,
        customValues: {
          origName: null,
          source,
          noteCol: null,
        },
        stageCells: [stageTrans.cell, stageProof.cell, stageTypeset.cell],
      });
    }
  }

  return {
    sourceKey: 'sheet:漫画',
    name: '漫画',
    kind: 'task',
    placement: 'topbar',
    color: 'orange',
    columns,
    works: [],
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

function mapSongTranslationSheet(sheet: XlsxSheet): PlannedWorksheet {
  const columns: PlannedColumn[] = [
    { key: 'draft', name: '初版', type: 'stage', boardColumnName: null, width: 150 },
    { key: 'jpLyrics', name: '日文歌词', type: 'stage', boardColumnName: null, width: 140 },
    { key: 'trans', name: '全曲翻译', type: 'stage', boardColumnName: '翻译', width: 150 },
    { key: 'proof', name: '校对', type: 'stage', boardColumnName: '校对', width: 150 },
    { key: 'polish', name: '润色', type: 'stage', boardColumnName: null, width: 140 },
    { key: 'songId', name: '编号', type: 'text', boardColumnName: null, width: 90 },
    { key: 'zhTitle', name: '中文译名', type: 'text', boardColumnName: null, width: 180 },
    { key: 'albumNote', name: '专辑/备注', type: 'text', boardColumnName: null, width: 180 },
  ];

  const works: string[] = [];
  const tasks: PlannedTask[] = [];
  let currentWork: string | null = null;

  for (const row of sheet.rows) {
    if (row.rowNumber <= 2) continue;
    if (!rowHasAnyText(row, 11)) continue;

    const c1 = normalizeSingleLine(getCellText(sheet, row.rowNumber, 1, false));
    const c2 = normalizeSingleLine(getCellText(sheet, row.rowNumber, 2, false));

    // 3 个跨行横幅（R3 / R44 / R48：「以下为无刺有刺的单曲」等）
    if (c1 && !c2) {
      const cleanedBanner = c1.replace(/^以下为/, '').trim();
      currentWork = addWorkOrdered(works, cleanedBanner || c1);
      continue;
    }

    if (!c2) continue;

    const publishStatus: PublishStatus = isRowAllGreen(row, [1, 2, 3, 6, 7, 9])
      ? 'published'
      : 'unpublished';

    const stageDraft = buildStageCell(sheet, row.rowNumber, [3, 4], 'draft');
    const stageJp = buildStageCell(sheet, row.rowNumber, [5], 'jpLyrics');
    const stageTrans = buildStageCell(sheet, row.rowNumber, [6], 'trans');
    const stageProof = buildStageCell(sheet, row.rowNumber, [7], 'proof');
    const stagePolish = buildStageCell(sheet, row.rowNumber, [8], 'polish');

    const zhTitle = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 9, false));
    const { date: publishedAt, leftoverNote } = parseDateWithFallback(
      getCellText(sheet, row.rowNumber, 10, false),
    );
    const albumNote = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 11, true));

    tasks.push({
      sourceKey: `歌曲翻译:R${row.rowNumber}`,
      workName: currentWork,
      title: truncateChars(c2, 200),
      divisionNote: leftoverNote ? truncateChars(leftoverNote, 500) : '',
      publishStatus,
      publishedAt,
      publishUrl: null,
      customValues: {
        songId: c1 || null,
        zhTitle,
        albumNote,
      },
      stageCells: [
        stageDraft.cell,
        stageJp.cell,
        stageTrans.cell,
        stageProof.cell,
        stagePolish.cell,
      ],
    });
  }

  return {
    sourceKey: 'sheet:歌曲翻译',
    name: '歌曲翻译',
    kind: 'task',
    placement: 'topbar',
    color: 'emerald',
    columns,
    works,
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

function mapWeeklySheet(sheet: XlsxSheet): PlannedWorksheet {
  const columns: PlannedColumn[] = [
    { key: 'edit', name: '编辑', type: 'stage', boardColumnName: null, width: 170 },
    { key: 'prod', name: '制作', type: 'stage', boardColumnName: null, width: 160 },
    { key: 'art', name: '美工', type: 'stage', boardColumnName: null, width: 140 },
    { key: 'sub', name: '字幕', type: 'stage', boardColumnName: null, width: 140 },
  ];

  const tasks: PlannedTask[] = [];
  for (const row of sheet.rows) {
    if (row.rowNumber <= 2) continue;
    const title = normalizeSingleLine(getCellText(sheet, row.rowNumber, 1, false));
    if (!title) continue;

    const publishStatus: PublishStatus =
      row.hidden || isRowAllGreen(row, [1, 2, 5, 7, 8]) ? 'published' : 'unpublished';

    const stageEdit = buildStageCell(sheet, row.rowNumber, [2, 3, 4], 'edit');
    const stageProd = buildStageCell(sheet, row.rowNumber, [5, 6], 'prod');
    const stageArt = buildStageCell(sheet, row.rowNumber, [7], 'art');
    const stageSub = buildStageCell(sheet, row.rowNumber, [8], 'sub');

    tasks.push({
      sourceKey: `周报:R${row.rowNumber}`,
      workName: null,
      title: truncateChars(title, 200),
      divisionNote: '',
      publishStatus,
      publishedAt: null,
      publishUrl: null,
      customValues: {},
      stageCells: [stageEdit.cell, stageProd.cell, stageArt.cell, stageSub.cell],
    });
  }

  return {
    sourceKey: 'sheet:周报',
    name: '周报',
    kind: 'task',
    placement: 'topbar',
    color: 'teal',
    columns,
    works: [],
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

function mapDramaSheet(sheet: XlsxSheet): PlannedWorksheet {
  const columns: PlannedColumn[] = [
    { key: 'axis', name: '时轴', type: 'stage', boardColumnName: '时轴', width: 150 },
    { key: 'trans', name: '翻译', type: 'stage', boardColumnName: '翻译', width: 150 },
    { key: 'proof', name: '校对', type: 'stage', boardColumnName: '校对', width: 150 },
    { key: 'art', name: '美工/封面', type: 'stage', boardColumnName: null, width: 130 },
    { key: 'post', name: '后期', type: 'stage', boardColumnName: null, width: 130 },
    { key: 'duration', name: '时长', type: 'text', boardColumnName: null, width: 110 },
    { key: 'source', name: '源', type: 'text', boardColumnName: null, width: 220 },
  ];

  const works: string[] = [];
  const tasks: PlannedTask[] = [];
  for (const row of sheet.rows) {
    if (row.rowNumber <= 2) continue;
    const title = normalizeSingleLine(getCellText(sheet, row.rowNumber, 1, false));
    if (!title) continue;

    const workRaw = normalizeSingleLine(getCellText(sheet, row.rowNumber, 3, true));
    const workName = addWorkOrdered(works, workRaw);

    const publishStatus: PublishStatus = isRowAllGreen(row, [1, 2, 4, 5, 6])
      ? 'published'
      : 'unpublished';

    const stageAxis = buildStageCell(sheet, row.rowNumber, [4], 'axis');
    const stageTrans = buildStageCell(sheet, row.rowNumber, [5], 'trans');
    const stageProof = buildStageCell(sheet, row.rowNumber, [6], 'proof');
    const stageArt = buildStageCell(sheet, row.rowNumber, [7], 'art');
    const stagePost = buildStageCell(sheet, row.rowNumber, [8], 'post');

    const duration = formatDurationMaybeRaw(getCellText(sheet, row.rowNumber, 2, false));
    const { date: publishedAt, leftoverNote } = parseDateWithFallback(
      getCellText(sheet, row.rowNumber, 9, false),
    );
    const source = formatLinkOrTextCell(sheet, row.rowNumber, 10, false);

    tasks.push({
      sourceKey: `广播剧:R${row.rowNumber}`,
      workName,
      title: truncateChars(title, 200),
      divisionNote: leftoverNote ? truncateChars(leftoverNote, 500) : '',
      publishStatus,
      publishedAt,
      publishUrl: null,
      customValues: {
        duration,
        source: source ? truncateChars(source, 2000) : null,
      },
      stageCells: [stageAxis.cell, stageTrans.cell, stageProof.cell, stageArt.cell, stagePost.cell],
    });
  }

  return {
    sourceKey: 'sheet:广播剧',
    name: '广播剧',
    kind: 'task',
    placement: 'topbar',
    color: 'pink',
    columns,
    works,
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

function mapBdCommentarySheet(sheet: XlsxSheet): PlannedWorksheet {
  // 首页标“暂时关闭”，默认全部 boardColumnName = null 避免未开工旧坑刷屏首页看板
  const columns: PlannedColumn[] = [
    { key: 'axis', name: '轴', type: 'stage', boardColumnName: null, width: 150 },
    { key: 'trans', name: '翻译', type: 'stage', boardColumnName: null, width: 150 },
    { key: 'proof', name: '校对', type: 'stage', boardColumnName: null, width: 150 },
    { key: 'edit', name: '剪辑', type: 'stage', boardColumnName: null, width: 130 },
    { key: 'cast', name: '出场人员', type: 'text', boardColumnName: null, width: 160 },
    { key: 'source', name: '源', type: 'text', boardColumnName: null, width: 160 },
  ];

  const works: string[] = [];
  const tasks: PlannedTask[] = [];

  for (const row of sheet.rows) {
    if (row.rowNumber <= 2) continue;
    if (!rowHasAnyText(row, 9)) continue;

    const vol = normalizeSingleLine(getCellText(sheet, row.rowNumber, 1, true));
    const seg = normalizeSingleLine(getCellText(sheet, row.rowNumber, 3, false));
    if (!vol && !seg) continue;

    const workName = addWorkOrdered(works, vol);
    const title = seg || vol;

    const stageAxis = buildStageCell(sheet, row.rowNumber, [4], 'axis');
    const stageTrans = buildStageCell(sheet, row.rowNumber, [5], 'trans');
    const stageProof = buildStageCell(sheet, row.rowNumber, [6], 'proof');
    const stageEdit = buildStageCell(sheet, row.rowNumber, [7], 'edit');

    const cast = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 2, true));
    const { date: publishedAt, leftoverNote } = parseDateWithFallback(
      getCellText(sheet, row.rowNumber, 8, false),
    );
    const source = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 9, true));

    tasks.push({
      sourceKey: `BD评论音轨:R${row.rowNumber}`,
      workName,
      title: truncateChars(title, 200),
      divisionNote: leftoverNote ? truncateChars(leftoverNote, 500) : '',
      publishStatus: 'unpublished',
      publishedAt,
      publishUrl: null,
      customValues: {
        cast,
        source,
      },
      stageCells: [stageAxis.cell, stageTrans.cell, stageProof.cell, stageEdit.cell],
    });
  }

  return {
    sourceKey: 'sheet:BD评论音轨',
    name: 'BD评论音轨',
    kind: 'task',
    placement: 'topbar',
    color: 'slate',
    columns,
    works,
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

function mapLivestreamSheet(sheet: XlsxSheet): PlannedWorksheet {
  const columns: PlannedColumn[] = [
    { key: 'owner', name: '转播/直播负责人', type: 'stage', boardColumnName: null, width: 160 },
    { key: 'liveTime', name: '直播时间', type: 'text', boardColumnName: null, width: 130 },
    { key: 'content', name: '直播内容', type: 'text', boardColumnName: null, width: 180 },
    { key: 'isRestream', name: '是否转播', type: 'text', boardColumnName: null, width: 100 },
    { key: 'liveUrl', name: '直播网址', type: 'link', boardColumnName: null, width: 220 },
  ];

  const works: string[] = [];
  const tasks: PlannedTask[] = [];

  for (const row of sheet.rows) {
    if (row.rowNumber <= 2) continue;

    // 左块：转播表（C1..C6）
    const leftTitle = normalizeSingleLine(getCellText(sheet, row.rowNumber, 1, false));
    if (leftTitle) {
      const workName = addWorkOrdered(works, '转播表');
      const publishStatus: PublishStatus = isRowAllGreen(row, [1, 2, 3, 4, 5, 6])
        ? 'published'
        : 'unpublished';
      const stageOwner = buildStageCell(sheet, row.rowNumber, [5], 'owner');
      const liveTime = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 2, false));
      const content = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 3, false));
      const isRestream = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 4, false));
      const liveUrl = formatLinkOnlyCell(sheet, row.rowNumber, 6, false);

      tasks.push({
        sourceKey: `直播与转播:L:R${row.rowNumber}`,
        workName,
        title: truncateChars(leftTitle, 200),
        divisionNote: '',
        publishStatus,
        publishedAt: null,
        publishUrl: null,
        customValues: { liveTime, content, isRestream, liveUrl },
        stageCells: [stageOwner.cell],
      });
    }

    // 右块：字幕组直播表（C8..C11）
    const rightTitle = normalizeSingleLine(getCellText(sheet, row.rowNumber, 8, false));
    if (rightTitle) {
      const workName = addWorkOrdered(works, '字幕组直播表');
      const publishStatus: PublishStatus = isRowAllGreen(row, [8, 9, 10, 11])
        ? 'published'
        : 'unpublished';
      const stageOwner = buildStageCell(sheet, row.rowNumber, [11], 'owner');
      const liveTime = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 9, false));
      const content = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 10, false));

      tasks.push({
        sourceKey: `直播与转播:R:R${row.rowNumber}`,
        workName,
        title: truncateChars(rightTitle, 200),
        divisionNote: '',
        publishStatus,
        publishedAt: null,
        publishUrl: null,
        customValues: { liveTime, content, isRestream: null, liveUrl: null },
        stageCells: [stageOwner.cell],
      });
    }
  }

  return {
    sourceKey: 'sheet:直播与转播',
    name: '直播与转播',
    kind: 'task',
    placement: 'topbar',
    color: 'red',
    columns,
    works,
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

// ============================================================================
// 第二组：⭐翻译对照表⭐（/docs 在线自由表格）
// ============================================================================

function mapGlossarySheet(sheet: XlsxSheet): PlannedWorksheet {
  const columns: PlannedColumn[] = [
    { key: 'orig', name: '日文/原词', type: 'text', boardColumnName: null, width: 200 },
    { key: 'zh', name: '中文译名', type: 'text', boardColumnName: null, width: 200 },
    { key: 'desc', name: '说明/声优', type: 'text', boardColumnName: null, width: 220 },
    { key: 'role', name: '角色/补充', type: 'text', boardColumnName: null, width: 160 },
    { key: 'note', name: '备注', type: 'text', boardColumnName: null, width: 240 },
  ];

  const works: string[] = [];
  const tasks: PlannedTask[] = [];

  // 4 个红列分隔的并行块：
  // 块 1: 通用日语 (C1..C4)
  // 块 2: 剧中成员名 (C6..C10)
  // 块 3: 广播用 (C12..C15)
  // 块 4: 制作岗位 (C17..C20)
  const blocks: Array<{
    workName: string;
    keyPrefix: string;
    extract: (rowNum: number) => Record<string, string | null>;
  }> = [
    {
      workName: '通用日语',
      keyPrefix: 'jp',
      extract: (r) => ({
        orig: normalizeNullableCellText(getCellText(sheet, r, 1, false)),
        zh: normalizeNullableCellText(getCellText(sheet, r, 2, false)),
        desc: normalizeNullableCellText(getCellText(sheet, r, 3, false)),
        role: null,
        note: normalizeNullableCellText(getCellText(sheet, r, 4, true)),
      }),
    },
    {
      workName: '剧中成员名',
      keyPrefix: 'cast',
      extract: (r) => ({
        orig: normalizeNullableCellText(getCellText(sheet, r, 6, false)),
        zh: normalizeNullableCellText(getCellText(sheet, r, 7, false)),
        desc: normalizeNullableCellText(getCellText(sheet, r, 8, false)),
        role: normalizeNullableCellText(getCellText(sheet, r, 9, false)),
        note: normalizeNullableCellText(getCellText(sheet, r, 10, false)),
      }),
    },
    {
      workName: '广播用',
      keyPrefix: 'radio',
      extract: (r) => ({
        orig: normalizeNullableCellText(getCellText(sheet, r, 12, false)),
        zh: normalizeNullableCellText(getCellText(sheet, r, 13, false)),
        desc: normalizeNullableCellText(getCellText(sheet, r, 14, false)),
        role: null,
        note: normalizeNullableCellText(getCellText(sheet, r, 15, false)),
      }),
    },
    {
      workName: '制作岗位',
      keyPrefix: 'staff',
      extract: (r) => ({
        orig: normalizeNullableCellText(getCellText(sheet, r, 17, false)),
        zh: normalizeNullableCellText(getCellText(sheet, r, 18, false)),
        desc: normalizeNullableCellText(getCellText(sheet, r, 19, false)),
        role: null,
        note: normalizeNullableCellText(getCellText(sheet, r, 20, false)),
      }),
    },
  ];

  for (const blk of blocks) {
    let addedInBlock = false;
    for (const row of sheet.rows) {
      if (row.rowNumber <= 1) continue;
      // 检查本块自身是否有未继承文本（避免因 C4 合并区间在空白行重复生成空词条）
      const rawOwnHasContent =
        blk.keyPrefix === 'jp'
          ? [1, 2, 3].some((c) => Boolean(row.cells.get(c)?.text))
          : blk.keyPrefix === 'cast'
            ? [6, 7, 8, 9, 10].some((c) => Boolean(row.cells.get(c)?.text))
            : blk.keyPrefix === 'radio'
              ? [12, 13, 14, 15].some((c) => Boolean(row.cells.get(c)?.text))
              : [17, 18, 19, 20].some((c) => Boolean(row.cells.get(c)?.text));
      if (!rawOwnHasContent) continue;

      const vals = blk.extract(row.rowNumber);
      const truncatedVals: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(vals)) {
        truncatedVals[k] = v ? truncateChars(v, 2000) : null;
      }

      if (!addedInBlock) {
        addWorkOrdered(works, blk.workName);
        addedInBlock = true;
      }

      tasks.push({
        sourceKey: `⭐翻译对照表⭐:${blk.keyPrefix}:R${row.rowNumber}`,
        workName: blk.workName,
        title: deriveFreeTitle(truncatedVals, columns),
        divisionNote: '',
        publishStatus: 'unpublished',
        publishedAt: null,
        publishUrl: null,
        customValues: truncatedVals,
        stageCells: [],
      });
    }
  }

  return {
    sourceKey: 'sheet:⭐翻译对照表⭐',
    name: '⭐翻译对照表⭐',
    kind: 'free',
    placement: 'docs',
    color: 'amber',
    columns,
    works,
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

// ============================================================================
// 第三组：4 张杂项自由表
// ============================================================================

function mapHomeIndexSheet(sheet: XlsxSheet): PlannedWorksheet {
  const columns: PlannedColumn[] = [
    { key: 'cat', name: '子表类型', type: 'text', boardColumnName: null, width: 120 },
    { key: 'name', name: '子表名称', type: 'text', boardColumnName: null, width: 180 },
    { key: 'desc', name: '子表内容', type: 'text', boardColumnName: null, width: 320 },
    { key: 'note', name: '说明与备注', type: 'text', boardColumnName: null, width: 340 },
  ];

  const tasks: PlannedTask[] = [];
  for (const row of sheet.rows) {
    if (row.rowNumber <= 6) {
      // R2 标题或 R6 表头跳过；但保留 R6 C6 的填表规范
      if (row.rowNumber === 6) {
        const ruleNote = normalizeNullableCellText(getCellText(sheet, 6, 6, false));
        if (ruleNote) {
          const vals = {
            cat: '填表规范',
            name: '通用说明',
            desc: null,
            note: truncateChars(ruleNote, 2000),
          };
          tasks.push({
            sourceKey: `首页:R6`,
            workName: null,
            title: deriveFreeTitle(vals, columns),
            divisionNote: '',
            publishStatus: 'unpublished',
            publishedAt: null,
            publishUrl: null,
            customValues: vals,
            stageCells: [],
          });
        }
      }
      continue;
    }

    const cat = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 2, true));
    const name = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 3, false));
    const desc = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 4, false));
    const note = normalizeNullableCellText(getCellText(sheet, row.rowNumber, 6, false));
    if (!name && !desc && !note) continue;

    const vals = {
      cat,
      name,
      desc: desc ? truncateChars(desc, 2000) : null,
      note: note ? truncateChars(note, 2000) : null,
    };
    tasks.push({
      sourceKey: `首页:R${row.rowNumber}`,
      workName: null,
      title: deriveFreeTitle(vals, columns),
      divisionNote: '',
      publishStatus: 'unpublished',
      publishedAt: null,
      publishUrl: null,
      customValues: vals,
      stageCells: [],
    });
  }

  return {
    sourceKey: 'sheet:首页',
    name: '首页',
    kind: 'free',
    placement: 'topbar',
    color: 'slate',
    columns,
    works: [],
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

function mapRevenueSheet(sheet: XlsxSheet): PlannedWorksheet {
  const colDefs: Array<{ key: string; name: string; col: number; width: number }> = [
    { key: 'c1', name: '提现金额', col: 1, width: 110 },
    { key: 'c2', name: '预计扣除税费', col: 2, width: 120 },
    { key: 'c3', name: '预计到账金额', col: 3, width: 120 },
    { key: 'c4', name: '提现时间', col: 4, width: 120 },
    { key: 'c5', name: '到账时间', col: 5, width: 120 },
    { key: 'c6', name: '提现截图', col: 6, width: 130 },
    { key: 'c7', name: '收入备注', col: 7, width: 180 },
    { key: 'c8', name: '支出金额', col: 8, width: 110 },
    { key: 'c9', name: '手续费等', col: 9, width: 110 },
    { key: 'c10', name: '用途', col: 10, width: 180 },
    { key: 'c11', name: '支付时间', col: 11, width: 120 },
    { key: 'c12', name: '支付截图', col: 12, width: 130 },
    { key: 'c13', name: '支出备注', col: 13, width: 220 },
    { key: 'c14', name: '剩余金额', col: 14, width: 110 },
  ];
  const columns: PlannedColumn[] = colDefs.map((d) => ({
    key: d.key,
    name: d.name,
    type: 'text',
    boardColumnName: null,
    width: d.width,
  }));

  const tasks: PlannedTask[] = [];

  // R1 红底联络提示作为首行说明保留
  const r1Notice = normalizeNullableCellText(getCellText(sheet, 1, 1, false));
  if (r1Notice) {
    const vals: Record<string, string | null> = {};
    for (const d of colDefs) vals[d.key] = null;
    vals.c7 = truncateChars(r1Notice, 2000);
    tasks.push({
      sourceKey: '相关收益:R1',
      workName: null,
      title: deriveFreeTitle(vals, columns),
      divisionNote: '',
      publishStatus: 'unpublished',
      publishedAt: null,
      publishUrl: null,
      customValues: vals,
      stageCells: [],
    });
  }

  for (const row of sheet.rows) {
    if (row.rowNumber <= 4) continue;
    // 跳过仅第 14 列重复显示结余公式值的末尾空行（如 R77–R80）
    const hasCoreData = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].some((c) =>
      Boolean(row.cells.get(c)?.text),
    );
    if (!hasCoreData) continue;

    const vals: Record<string, string | null> = {};
    for (const d of colDefs) {
      const raw = getCellText(
        sheet,
        row.rowNumber,
        d.col,
        d.col === 6 || d.col === 7 || d.col === 11 || d.col === 13,
      );
      let cleaned = normalizeNullableCellText(raw);
      if (cleaned && (d.col === 4 || d.col === 5 || d.col === 11)) {
        const parsed = parseCalendarDateString(cleaned);
        if (parsed) cleaned = parsed;
      }
      vals[d.key] = cleaned ? truncateChars(cleaned, 2000) : null;
    }

    tasks.push({
      sourceKey: `相关收益:R${row.rowNumber}`,
      workName: null,
      title: deriveFreeTitle(vals, columns),
      divisionNote: '',
      publishStatus: 'unpublished',
      publishedAt: null,
      publishUrl: null,
      customValues: vals,
      stageCells: [],
    });
  }

  return {
    sourceKey: 'sheet:相关收益',
    name: '相关收益',
    kind: 'free',
    placement: 'topbar',
    color: 'emerald',
    columns,
    works: [],
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

function mapSimpleFreeSheet(
  sheet: XlsxSheet,
  opts: {
    headerRow: number;
    dataStartRow: number;
    colSpecs: Array<{
      key: string;
      name: string;
      cols: number[];
      width?: number;
      isLink?: boolean;
      isDuration?: boolean;
      isDate?: boolean;
    }>;
    color: WorksheetColor;
    skipGarbageBroadcast?: boolean;
    extractPeopleCols?: number[];
    extraUsersSink?: Set<string>;
  },
): PlannedWorksheet {
  const columns: PlannedColumn[] = opts.colSpecs.map((spec) => ({
    key: spec.key,
    name: spec.name,
    type: 'text',
    boardColumnName: null,
    width: spec.width ?? 160,
  }));

  const tasks: PlannedTask[] = [];
  for (const row of sheet.rows) {
    if (row.rowNumber < opts.dataStartRow) continue;
    const allCols = opts.colSpecs.flatMap((s) => s.cols);
    const hasAny = allCols.some((c) => {
      const cell = row.cells.get(c);
      return Boolean(cell?.text || cell?.hyperlink);
    });
    if (!hasAny) continue;

    // 跳过部分留念表中模板复制残留的刺刺广播行（仅在显式开启时）
    if (opts.skipGarbageBroadcast) {
      const c1 = normalizeSingleLine(getCellText(sheet, row.rowNumber, 1, false));
      const restEmpty = allCols.filter((c) => c > 4).every((c) => !row.cells.get(c)?.text);
      if (shouldSkipTemplateBroadcastGarbage(c1) && row.hidden && restEmpty) continue;
    }

    const vals: Record<string, string | null> = {};
    for (const spec of opts.colSpecs) {
      const parts: string[] = [];
      for (const c of spec.cols) {
        const raw = spec.isLink
          ? formatLinkOrTextCell(sheet, row.rowNumber, c, false)
          : normalizeNullableCellText(getCellText(sheet, row.rowNumber, c, false));
        if (!raw) continue;
        let v = raw;
        if (spec.isDuration) {
          v = formatDurationMaybeRaw(v) ?? v;
        } else if (spec.isDate) {
          v = parseCalendarDateString(v) ?? v;
        }
        parts.push(v);
      }
      const joined = parts.length > 0 ? truncateChars(parts.join(' / '), 2000) : null;
      vals[spec.key] = joined;
    }

    // 提取留念表早期人员用于预创建待认领用户
    if (opts.extractPeopleCols && opts.extraUsersSink) {
      for (const c of opts.extractPeopleCols) {
        const t = getCellText(sheet, row.rowNumber, c, false);
        if (!t) continue;
        const parsed = parseStageCellText(t, { allowSpaceSplit: false });
        for (const u of parsed.userDisplayNames) {
          opts.extraUsersSink.add(u);
        }
      }
    }

    tasks.push({
      sourceKey: `${sheet.name}:R${row.rowNumber}`,
      workName: null,
      title: deriveFreeTitle(vals, columns),
      divisionNote: '',
      publishStatus: 'unpublished',
      publishedAt: null,
      publishUrl: null,
      customValues: vals,
      stageCells: [],
    });
  }

  return {
    sourceKey: `sheet:${sheet.name}`,
    name: sheet.name,
    kind: 'free',
    placement: 'topbar',
    color: opts.color,
    columns,
    works: [],
    tasks,
    workArtifacts: [],
    warnings: [],
  };
}

// ============================================================================
// 主规划入口：将整个 XlsxWorkbook 转为有序的 ImportPlan
// ============================================================================

export function buildImportPlan(wb: XlsxWorkbook): ImportPlan {
  const worksheets: PlannedWorksheet[] = [];
  const allUsers = new Set<string>();
  const warnings: string[] = [];
  const memorialExtraUsers = new Set<string>();

  for (const target of ORDERED_TARGET_SHEETS) {
    const sheet = wb.sheetByName.get(target.name);
    if (!sheet) {
      warnings.push(`工作簿中缺少工作表「${target.name}」，已跳过`);
      continue;
    }

    let planned: PlannedWorksheet;
    switch (target.name) {
      case '长视频全熟':
        planned = mapLongVideoSheet(sheet);
        break;
      case '切片熟肉':
        planned = mapClipSheet(sheet);
        break;
      case '中短视频':
        planned = mapMidShortVideoSheet(sheet);
        break;
      case '刺刺广播2025-2026':
        planned = mapRadio2025Sheet(sheet);
        break;
      case '总集篇':
        planned = mapRecapSheet(sheet);
        break;
      case '杂志':
        planned = mapMagazineSheet(sheet);
        break;
      case '漫画':
        planned = mapMangaSheet(sheet);
        break;
      case '歌曲翻译':
        planned = mapSongTranslationSheet(sheet);
        break;
      case '周报':
        planned = mapWeeklySheet(sheet);
        break;
      case '广播剧':
        planned = mapDramaSheet(sheet);
        break;
      case 'BD评论音轨':
        planned = mapBdCommentarySheet(sheet);
        break;
      case '直播与转播':
        planned = mapLivestreamSheet(sheet);
        break;
      case '⭐翻译对照表⭐':
        planned = mapGlossarySheet(sheet);
        break;
      case '首页':
        planned = mapHomeIndexSheet(sheet);
        break;
      case '相关收益':
        planned = mapRevenueSheet(sheet);
        break;
      case '赞助奖品清单':
        planned = mapSimpleFreeSheet(sheet, {
          headerRow: 1,
          dataStartRow: 2,
          color: 'amber',
          colSpecs: [
            { key: 'c1', name: '奖品名称', cols: [1], width: 180 },
            { key: 'c2', name: '奖品类型', cols: [2], width: 120 },
            { key: 'c3', name: '奖品数量', cols: [3], width: 100 },
            { key: 'c4', name: '赞助人', cols: [4], width: 120 },
            { key: 'c5', name: '在哪个活动中送出', cols: [5], width: 180 },
            { key: 'c6', name: '获奖者', cols: [6], width: 120 },
            { key: 'c7', name: '送出时间', cols: [7], width: 130, isDate: true },
            { key: 'c8', name: '是否收货', cols: [8], width: 100 },
          ],
        });
        break;
      case '2025除夕抽奖奖项':
        planned = mapSimpleFreeSheet(sheet, {
          headerRow: 1,
          dataStartRow: 2,
          color: 'rose',
          colSpecs: [
            { key: 'c1', name: '奖品名', cols: [1], width: 240 },
            { key: 'c2', name: '单位', cols: [2], width: 100 },
            { key: 'c3', name: '人数', cols: [3], width: 90 },
            { key: 'c4', name: '赞助商', cols: [4], width: 160 },
          ],
        });
        break;
      case '刺刺广播（留念用）':
        planned = mapSimpleFreeSheet(sheet, {
          headerRow: 1,
          dataStartRow: 2,
          color: 'slate',
          extractPeopleCols: [4, 5, 6, 7],
          extraUsersSink: memorialExtraUsers,
          colSpecs: [
            { key: 'c1', name: '作品/系列标题', cols: [1], width: 220 },
            { key: 'c2', name: '发布日期', cols: [2], width: 120, isDate: true },
            { key: 'c3', name: '时长', cols: [3], width: 110, isDuration: true },
            { key: 'c4', name: '打轴', cols: [4], width: 130 },
            { key: 'c5', name: '翻译', cols: [5], width: 130 },
            { key: 'c6', name: '校对', cols: [6], width: 130 },
            { key: 'c7', name: '轴校', cols: [7], width: 130 },
            { key: 'c8', name: '备注', cols: [8], width: 180 },
          ],
        });
        break;
      case 'WEB广播（留念用）':
        planned = mapSimpleFreeSheet(sheet, {
          headerRow: 1,
          dataStartRow: 2,
          color: 'slate',
          extractPeopleCols: [5, 6, 7, 8],
          extraUsersSink: memorialExtraUsers,
          colSpecs: [
            { key: 'c1', name: '作品/系列标题', cols: [1], width: 220, isLink: true },
            { key: 'c2', name: '发布日期', cols: [2], width: 120, isDate: true },
            { key: 'c3', name: '内容', cols: [3], width: 220, isLink: true },
            { key: 'c4', name: '时长', cols: [4], width: 110, isDuration: true },
            { key: 'c5', name: '切片', cols: [5], width: 120 },
            { key: 'c6', name: '打轴', cols: [6], width: 120 },
            { key: 'c7', name: '翻译', cols: [7], width: 120 },
            { key: 'c8', name: '校对', cols: [8], width: 120 },
          ],
        });
        break;
      case 'GBC广播（留念用）':
        planned = mapSimpleFreeSheet(sheet, {
          headerRow: 1,
          dataStartRow: 2,
          color: 'slate',
          extractPeopleCols: [4, 5, 6, 7],
          extraUsersSink: memorialExtraUsers,
          colSpecs: [
            { key: 'c1', name: '广播集数+部分', cols: [1], width: 180 },
            { key: 'c2', name: '发布日期', cols: [2], width: 120, isDate: true },
            { key: 'c3', name: '时长', cols: [3], width: 110, isDuration: true },
            { key: 'c4', name: '打轴', cols: [4], width: 130 },
            { key: 'c5', name: '翻译', cols: [5], width: 130 },
            { key: 'c6', name: '校对', cols: [6], width: 130 },
            { key: 'c7', name: '轴校', cols: [7], width: 130 },
          ],
        });
        break;
      case '动漫工作表（留念用）':
        planned = mapSimpleFreeSheet(sheet, {
          headerRow: 1,
          dataStartRow: 3,
          color: 'slate',
          extractPeopleCols: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
          extraUsersSink: memorialExtraUsers,
          colSpecs: [
            { key: 'c1', name: '话数', cols: [1], width: 110 },
            { key: 'c2', name: '日期', cols: [2], width: 120, isDate: true },
            { key: 'c3', name: '打轴 1/5', cols: [3], width: 110 },
            { key: 'c4', name: '打轴 2/6', cols: [4], width: 110 },
            { key: 'c5', name: '打轴 3', cols: [5], width: 110 },
            { key: 'c6', name: '打轴 4', cols: [6], width: 110 },
            { key: 'c7', name: '轴校', cols: [7], width: 110 },
            { key: 'c8', name: '翻译 1/5', cols: [8], width: 110 },
            { key: 'c9', name: '翻译 2/6', cols: [9], width: 110 },
            { key: 'c10', name: '翻译 3', cols: [10], width: 110 },
            { key: 'c11', name: '翻译 4', cols: [11], width: 110 },
            { key: 'c12', name: '1校 P1', cols: [12], width: 110 },
            { key: 'c13', name: '1校 P2', cols: [13], width: 110 },
            { key: 'c14', name: '填轴支援', cols: [14], width: 110 },
            { key: 'c15', name: '2校', cols: [15], width: 110 },
            { key: 'c16', name: '压制', cols: [16], width: 110 },
            { key: 'c17', name: '重置校对', cols: [17], width: 150 },
          ],
        });
        break;
      case '工作人员（留念用）':
        planned = mapSimpleFreeSheet(sheet, {
          headerRow: 2,
          dataStartRow: 3,
          color: 'slate',
          extractPeopleCols: [1, 6],
          extraUsersSink: memorialExtraUsers,
          colSpecs: [
            { key: 'c1', name: '翻译-名字', cols: [1], width: 130 },
            { key: 'c2', name: '翻译-水平', cols: [2], width: 150 },
            { key: 'c3', name: '翻译-aeg', cols: [3], width: 110 },
            { key: 'c4', name: '翻译-已接', cols: [4], width: 90 },
            { key: 'c5', name: '翻译-目前情况', cols: [5], width: 160 },
            { key: 'c6', name: '时轴-名字', cols: [6], width: 130 },
            { key: 'c7', name: '时轴-准确度', cols: [7], width: 130 },
            { key: 'c8', name: '时轴-已接', cols: [8], width: 90 },
            { key: 'c9', name: '时轴-目前情况', cols: [9], width: 160 },
          ],
        });
        break;
      case '视频（留念用）':
        planned = mapSimpleFreeSheet(sheet, {
          headerRow: 1,
          dataStartRow: 2,
          color: 'slate',
          extractPeopleCols: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
          extraUsersSink: memorialExtraUsers,
          colSpecs: [
            { key: 'c1', name: '作品/系列标题', cols: [1], width: 240, isLink: true },
            { key: 'c2', name: '发布日期', cols: [2], width: 130, isDate: true },
            { key: 'c3', name: '时长', cols: [3], width: 110, isDuration: true },
            { key: 'c4', name: '打轴', cols: [4, 5, 6, 7, 8, 9], width: 160 },
            { key: 'c5', name: '翻译', cols: [10, 11, 12, 13, 14, 15], width: 160 },
            { key: 'c6', name: '校对', cols: [16], width: 130 },
            { key: 'c7', name: '轴校', cols: [17], width: 130 },
          ],
        });
        break;
      default:
        continue;
    }

    worksheets.push(planned);
    warnings.push(...planned.warnings);

    // 收集 12 张制作表中的全部标准用户显示名
    for (const task of planned.tasks) {
      for (const cell of task.stageCells) {
        for (const name of cell.userDisplayNames) {
          allUsers.add(canonicalizePersonName(name));
        }
      }
    }
  }

  // 合并 6 张留念表提取到的早期人员（过滤明显非人名词条）
  for (const name of memorialExtraUsers) {
    const canon = canonicalizePersonName(name);
    if (!canon) continue;
    // 跳过如「注：绿色为已经发布…」「伟大，无需重制」「动漫评论」等说明词条
    if (
      canon.startsWith('注：') ||
      canon.startsWith('注:') ||
      canon.includes('伟大') ||
      canon.includes('已经发布') ||
      canon.includes('动漫评论') ||
      canon.includes('字幕组') ||
      canon.includes('优先进行') ||
      canon.length > 24
    ) {
      continue;
    }
    allUsers.add(canon);
  }

  return {
    worksheets,
    userDisplayNames: [...allUsers].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    warnings,
  };
}
