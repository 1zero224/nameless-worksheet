import { XMLParser } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';
import {
  formatExcelDuration,
  formatExcelSerialDate,
  isDateNumFmt,
  isDurationNumFmt,
  isDurationWithSeconds,
  normalizeCellText,
} from './normalize.js';

export interface MergeRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface XlsxCell {
  ref: string;
  row: number;
  col: number;
  rawValue: string | null;
  valueType: string | null;
  text: string;
  numFmtId: number;
  formatCode: string | null;
  fillHex: string | null;
  fontHex: string | null;
  hyperlink: string | null;
}

export interface XlsxRow {
  rowNumber: number;
  hidden: boolean;
  cells: Map<number, XlsxCell>;
}

export interface XlsxSheet {
  name: string;
  sheetId: string;
  relId: string;
  targetPath: string;
  state: 'visible' | 'hidden' | 'veryHidden';
  rows: XlsxRow[];
  rowMap: Map<number, XlsxRow>;
  merges: MergeRange[];
  maxRow: number;
  maxCol: number;
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
  sheetByName: Map<string, XlsxSheet>;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
  isArray: (name) =>
    [
      'sheet',
      'Relationship',
      'si',
      'r',
      'row',
      'c',
      'mergeCell',
      'hyperlink',
      'numFmt',
      'font',
      'fill',
      'xf',
    ].includes(name),
});

function asArray<T>(val: T | T[] | undefined | null): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

export function colLettersToIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n;
}

export function parseCellRef(ref: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (!m) return { row: 0, col: 0 };
  return { col: colLettersToIndex(m[1]!.toUpperCase()), row: Number(m[2]) };
}

function parseRangeRef(ref: string): MergeRange | null {
  const parts = ref.split(':');
  if (parts.length === 1) {
    const p = parseCellRef(parts[0]!);
    return p.row > 0 ? { startRow: p.row, endRow: p.row, startCol: p.col, endCol: p.col } : null;
  }
  if (parts.length !== 2) return null;
  const a = parseCellRef(parts[0]!);
  const b = parseCellRef(parts[1]!);
  if (a.row <= 0 || b.row <= 0) return null;
  return {
    startRow: Math.min(a.row, b.row),
    endRow: Math.max(a.row, b.row),
    startCol: Math.min(a.col, b.col),
    endCol: Math.max(a.col, b.col),
  };
}

// OOXML 标准 64 色索引调色板（常用前 64 项）
const INDEXED_PALETTE: readonly string[] = [
  '000000',
  'FFFFFF',
  'FF0000',
  '00FF00',
  '0000FF',
  'FFFF00',
  'FF00FF',
  '00FFFF',
  '000000',
  'FFFFFF',
  'FF0000',
  '00FF00',
  '0000FF',
  'FFFF00',
  'FF00FF',
  '00FFFF',
  '800000',
  '008000',
  '000080',
  '808000',
  '800080',
  '008080',
  'C0C0C0',
  '808080',
  '9999FF',
  '993366',
  'FFFFCC',
  'CCFFFF',
  '660066',
  'FF8080',
  '0066CC',
  'CCCCFF',
  '000080',
  'FF00FF',
  'FFFF00',
  '00FFFF',
  '800080',
  '800000',
  '008080',
  '0000FF',
  '00CCFF',
  'CCFFFF',
  'CCFFCC',
  'FFFF99',
  '99CCFF',
  'FF99CC',
  'CC99FF',
  'FFCC99',
  '3366FF',
  '33CCCC',
  '99CC00',
  'FFCC00',
  'FF9900',
  'FF6600',
  '666699',
  '969696',
  '003366',
  '339966',
  '003300',
  '333300',
  '993300',
  '993366',
  '333399',
  '333333',
];

const DEFAULT_THEME_COLORS: readonly string[] = [
  'FFFFFF',
  '000000',
  'E7E6E6',
  '44546A',
  '4472C4',
  'ED7D31',
  'A5A5A5',
  'FFC000',
  '5B9BD5',
  '70AD47',
  '0563C1',
  '954F72',
];

function applyTint(hex6: string, tint: number): string {
  if (!Number.isFinite(tint) || tint === 0) return `#${hex6.toUpperCase()}`;
  const r = Number.parseInt(hex6.slice(0, 2), 16) / 255;
  const g = Number.parseInt(hex6.slice(2, 4), 16) / 255;
  const b = Number.parseInt(hex6.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  if (tint < 0) {
    l = l * (1 + tint);
  } else {
    l = l * (1 - tint) + (1 - (1 - tint));
  }
  l = Math.max(0, Math.min(1, l));

  const hue2rgb = (p: number, q: number, tRaw: number): number => {
    let t = tRaw;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let nr: number;
  let ng: number;
  let nb: number;
  if (s === 0) {
    nr = ng = nb = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    nr = hue2rgb(p, q, h + 1 / 3);
    ng = hue2rgb(p, q, h);
    nb = hue2rgb(p, q, h - 1 / 3);
  }

  const toHex = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v * 255)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
}

function resolveColorNode(
  node: Record<string, unknown> | undefined | null,
  themeColors: readonly string[],
): string | null {
  if (!node || typeof node !== 'object') return null;
  const rgb = node['@_rgb'];
  if (typeof rgb === 'string' && rgb.length >= 6) {
    const hex6 = rgb.length === 8 ? rgb.slice(2) : rgb.slice(-6);
    return `#${hex6.toUpperCase()}`;
  }
  const themeAttr = node['@_theme'];
  if (themeAttr !== undefined) {
    const idx = Number(themeAttr);
    const base = themeColors[idx] ?? DEFAULT_THEME_COLORS[idx];
    if (base) {
      const tintAttr = node['@_tint'];
      const tint = tintAttr !== undefined ? Number(tintAttr) : 0;
      return applyTint(base, tint);
    }
  }
  const indexedAttr = node['@_indexed'];
  if (indexedAttr !== undefined) {
    const idx = Number(indexedAttr);
    if (idx >= 0 && idx < INDEXED_PALETTE.length) {
      return `#${INDEXED_PALETTE[idx]!}`;
    }
  }
  return null;
}

function parseThemeColors(zip: Record<string, Uint8Array>): string[] {
  const out = [...DEFAULT_THEME_COLORS];
  const bytes = zip['xl/theme/theme1.xml'];
  if (!bytes) return out;
  const doc = xmlParser.parse(strFromU8(bytes));
  const scheme = doc?.['a:theme']?.['a:themeElements']?.['a:clrScheme'];
  if (!scheme) return out;

  // OOXML 主题槽位顺序：0=lt1, 1=dk1, 2=lt2, 3=dk2, 4..9=accent1..6, 10=hlink, 11=folHlink
  const slotTags = [
    'a:lt1',
    'a:dk1',
    'a:lt2',
    'a:dk2',
    'a:accent1',
    'a:accent2',
    'a:accent3',
    'a:accent4',
    'a:accent5',
    'a:accent6',
    'a:hlink',
    'a:folHlink',
  ];
  for (let i = 0; i < slotTags.length; i++) {
    const slot = scheme[slotTags[i]!];
    if (!slot) continue;
    const srgb = slot['a:srgbClr']?.['@_val'];
    const sys = slot['a:sysClr']?.['@_lastClr'];
    const val = typeof srgb === 'string' ? srgb : typeof sys === 'string' ? sys : null;
    if (val && val.length === 6) {
      out[i] = val.toUpperCase();
    }
  }
  return out;
}

interface ParsedStyles {
  numFmtMap: Map<number, string>;
  xfs: Array<{ numFmtId: number; fillHex: string | null; fontHex: string | null }>;
}

function parseStyles(
  zip: Record<string, Uint8Array>,
  themeColors: readonly string[],
): ParsedStyles {
  const numFmtMap = new Map<number, string>();
  const xfs: Array<{ numFmtId: number; fillHex: string | null; fontHex: string | null }> = [];
  const bytes = zip['xl/styles.xml'];
  if (!bytes) return { numFmtMap, xfs };

  const doc = xmlParser.parse(strFromU8(bytes));
  const ss = doc?.styleSheet;
  if (!ss) return { numFmtMap, xfs };

  for (const nf of asArray(ss.numFmts?.numFmt)) {
    const id = Number(nf['@_numFmtId']);
    const code = nf['@_formatCode'];
    if (Number.isFinite(id) && typeof code === 'string') {
      numFmtMap.set(id, code);
    }
  }

  const fontHexes = asArray(ss.fonts?.font).map((f) => resolveColorNode(f?.color, themeColors));
  const fillHexes = asArray(ss.fills?.fill).map((f) => {
    const pf = f?.patternFill;
    if (!pf) return null;
    const pt = pf['@_patternType'];
    if (!pt || pt === 'none' || pt === 'gray125') return null;
    const fg = resolveColorNode(pf.fgColor, themeColors);
    if (fg && fg !== '#FFFFFF') return fg;
    const bg = resolveColorNode(pf.bgColor, themeColors);
    return bg && bg !== '#FFFFFF' ? bg : fg;
  });

  for (const xf of asArray(ss.cellXfs?.xf)) {
    const numFmtId = Number(xf['@_numFmtId'] ?? 0);
    const fillId = Number(xf['@_fillId'] ?? -1);
    const fontId = Number(xf['@_fontId'] ?? -1);
    const fillHex = fillId >= 0 ? (fillHexes[fillId] ?? null) : null;
    const fontHex = fontId >= 0 ? (fontHexes[fontId] ?? null) : null;
    xfs.push({
      numFmtId: Number.isFinite(numFmtId) ? numFmtId : 0,
      fillHex: fillHex === '#FFFFFF' ? null : fillHex,
      fontHex,
    });
  }

  return { numFmtMap, xfs };
}

function extractTextFromT(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)['#text'] ?? '');
  }
  return '';
}

function parseSharedStrings(zip: Record<string, Uint8Array>): string[] {
  const bytes = zip['xl/sharedStrings.xml'];
  if (!bytes) return [];
  const doc = xmlParser.parse(strFromU8(bytes));
  const list = asArray(doc?.sst?.si);
  return list.map((si) => {
    if (si.t !== undefined) {
      return extractTextFromT(si.t);
    }
    if (si.r !== undefined) {
      return asArray(si.r)
        .map((run) => extractTextFromT(run?.t))
        .join('');
    }
    return '';
  });
}

function resolveZipTarget(baseDir: string, target: string): string {
  if (target.startsWith('/')) {
    return target.slice(1);
  }
  const combined = baseDir ? `${baseDir}/${target}` : target;
  const parts: string[] = [];
  for (const seg of combined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function parseRelsMap(zip: Record<string, Uint8Array>, relsPath: string): Map<string, string> {
  const map = new Map<string, string>();
  const bytes = zip[relsPath];
  if (!bytes) return map;
  const doc = xmlParser.parse(strFromU8(bytes));
  for (const rel of asArray(doc?.Relationships?.Relationship)) {
    const id = rel['@_Id'];
    const target = rel['@_Target'];
    if (typeof id === 'string' && typeof target === 'string') {
      map.set(id, target);
    }
  }
  return map;
}

/**
 * 解析 .xlsx 二进制缓冲区，严格通过 xl/workbook.xml + xl/_rels/workbook.xml.rels 配对工作表。
 */
export function readXlsxWorkbook(buffer: Uint8Array): XlsxWorkbook {
  const zip = unzipSync(buffer);
  const wbBytes = zip['xl/workbook.xml'];
  if (!wbBytes) {
    throw new Error('无效的 .xlsx 文件：缺少 xl/workbook.xml');
  }

  const wbDoc = xmlParser.parse(strFromU8(wbBytes));
  const wbRels = parseRelsMap(zip, 'xl/_rels/workbook.xml.rels');
  const themeColors = parseThemeColors(zip);
  const styles = parseStyles(zip, themeColors);
  const sharedStrings = parseSharedStrings(zip);

  const sheets: XlsxSheet[] = [];
  const sheetByName = new Map<string, XlsxSheet>();

  for (const sheetNode of asArray(wbDoc?.workbook?.sheets?.sheet)) {
    const name = String(sheetNode['@_name'] ?? '');
    const sheetId = String(sheetNode['@_sheetId'] ?? '');
    const relId = String(sheetNode['@_r:id'] ?? '');
    const rawState = sheetNode['@_state'];
    const state: 'visible' | 'hidden' | 'veryHidden' =
      rawState === 'hidden' || rawState === 'veryHidden' ? rawState : 'visible';

    const relTarget = wbRels.get(relId);
    if (!relTarget) {
      throw new Error(`工作表「${name}」(${relId}) 在 workbook.xml.rels 中无对应目标`);
    }
    const targetPath = resolveZipTarget('xl', relTarget);
    const sheetBytes = zip[targetPath];
    if (!sheetBytes) {
      throw new Error(`工作表「${name}」对应的 XML 文件缺失：${targetPath}`);
    }

    // 解析 sheet 级关系（外部超链接）
    const slashIdx = targetPath.lastIndexOf('/');
    const sheetDir = slashIdx >= 0 ? targetPath.slice(0, slashIdx) : '';
    const sheetFile = slashIdx >= 0 ? targetPath.slice(slashIdx + 1) : targetPath;
    const sheetRelsPath = sheetDir
      ? `${sheetDir}/_rels/${sheetFile}.rels`
      : `_rels/${sheetFile}.rels`;
    const sheetRels = parseRelsMap(zip, sheetRelsPath);

    const sheetDoc = xmlParser.parse(strFromU8(sheetBytes));
    const ws = sheetDoc?.worksheet;

    // 解析超链接映射（ref -> url）
    const hyperlinkByRef = new Map<string, string>();
    for (const hl of asArray(ws?.hyperlinks?.hyperlink)) {
      const ref = hl['@_ref'];
      const rId = hl['@_r:id'];
      const location = hl['@_location'];
      if (typeof ref !== 'string') continue;
      const target = typeof rId === 'string' ? sheetRels.get(rId) : undefined;
      const url = target ?? (typeof location === 'string' ? location : null);
      if (!url) continue;
      // 如果 ref 是区间，展开或绑定首格
      const rng = parseRangeRef(ref);
      if (rng) {
        for (let r = rng.startRow; r <= rng.endRow; r++) {
          for (let c = rng.startCol; c <= rng.endCol; c++) {
            hyperlinkByRef.set(`${r}:${c}`, url);
          }
        }
      }
    }

    // 解析合并单元格
    const merges: MergeRange[] = [];
    for (const mc of asArray(ws?.mergeCells?.mergeCell)) {
      const ref = mc['@_ref'];
      if (typeof ref === 'string') {
        const rng = parseRangeRef(ref);
        if (rng) merges.push(rng);
      }
    }

    const rows: XlsxRow[] = [];
    const rowMap = new Map<number, XlsxRow>();
    let maxRow = 0;
    let maxCol = 0;

    for (const rowNode of asArray(ws?.sheetData?.row)) {
      const rowNumber = Number(rowNode['@_r'] ?? 0);
      if (!rowNumber) continue;
      const hidden = rowNode['@_hidden'] === '1' || rowNode['@_hidden'] === 'true';
      const cells = new Map<number, XlsxCell>();

      for (const cNode of asArray(rowNode.c)) {
        const ref = String(cNode['@_r'] ?? '');
        const { row, col } = parseCellRef(ref);
        if (!row || !col) continue;
        if (row > maxRow) maxRow = row;
        if (col > maxCol) maxCol = col;

        const valueType = cNode['@_t'] !== undefined ? String(cNode['@_t']) : null;
        const styleIdx = cNode['@_s'] !== undefined ? Number(cNode['@_s']) : -1;
        const xf = styleIdx >= 0 ? styles.xfs[styleIdx] : undefined;
        const numFmtId = xf?.numFmtId ?? 0;
        const formatCode = styles.numFmtMap.get(numFmtId) ?? null;

        let rawValue: string | null = null;
        let text = '';

        if (valueType === 's') {
          const idx = Number(extractTextFromT(cNode.v));
          const str = Number.isFinite(idx) ? (sharedStrings[idx] ?? '') : '';
          rawValue = str;
          text = normalizeCellText(str);
        } else if (valueType === 'inlineStr') {
          const isNode = cNode.is;
          let str = '';
          if (isNode?.t !== undefined) {
            str = extractTextFromT(isNode.t);
          } else if (isNode?.r !== undefined) {
            str = asArray(isNode.r)
              .map((run) => extractTextFromT(run?.t))
              .join('');
          }
          rawValue = str;
          text = normalizeCellText(str);
        } else if (valueType === 'str' || valueType === 'b' || valueType === 'e') {
          const str = extractTextFromT(cNode.v);
          rawValue = str;
          text = normalizeCellText(str);
        } else if (cNode.v !== undefined) {
          const str = extractTextFromT(cNode.v);
          rawValue = str;
          const num = Number(str);
          if (Number.isFinite(num)) {
            if (isDurationNumFmt(numFmtId, formatCode)) {
              text =
                formatExcelDuration(num, isDurationWithSeconds(numFmtId, formatCode)) ??
                normalizeCellText(str);
            } else if (isDateNumFmt(numFmtId, formatCode)) {
              text = formatExcelSerialDate(num) ?? normalizeCellText(str);
            } else {
              // 普通数字去掉浮点尾噪（如 12.300000000000001）
              text = Number.isInteger(num) ? String(num) : String(Number(num.toPrecision(12)));
            }
          } else {
            text = normalizeCellText(str);
          }
        }

        const hyperlink = hyperlinkByRef.get(`${row}:${col}`) ?? null;
        cells.set(col, {
          ref,
          row,
          col,
          rawValue,
          valueType,
          text,
          numFmtId,
          formatCode,
          fillHex: xf?.fillHex ?? null,
          fontHex: xf?.fontHex ?? null,
          hyperlink,
        });
      }

      const rowObj: XlsxRow = { rowNumber, hidden, cells };
      rows.push(rowObj);
      rowMap.set(rowNumber, rowObj);
    }

    rows.sort((a, b) => a.rowNumber - b.rowNumber);
    const sheetObj: XlsxSheet = {
      name,
      sheetId,
      relId,
      targetPath,
      state,
      rows,
      rowMap,
      merges,
      maxRow,
      maxCol,
    };
    sheets.push(sheetObj);
    sheetByName.set(name, sheetObj);
  }

  return { sheets, sheetByName };
}

/**
 * 查找指定单元格所在的合并区间；若无合并返回 null。
 */
export function findMergeRange(sheet: XlsxSheet, row: number, col: number): MergeRange | null {
  for (const m of sheet.merges) {
    if (row >= m.startRow && row <= m.endRow && col >= m.startCol && col <= m.endCol) {
      return m;
    }
  }
  return null;
}

/**
 * 读取指定单元格；若 inheritMerge=true 且本身为空，仅当处于合并区间内时向上读取主格。
 */
export function getCell(
  sheet: XlsxSheet,
  row: number,
  col: number,
  inheritMerge = false,
): XlsxCell | undefined {
  const direct = sheet.rowMap.get(row)?.cells.get(col);
  if (direct && (direct.text !== '' || direct.hyperlink)) {
    return direct;
  }
  if (!inheritMerge) return direct;
  const m = findMergeRange(sheet, row, col);
  if (!m) return direct;
  return sheet.rowMap.get(m.startRow)?.cells.get(m.startCol) ?? direct;
}

export function getCellText(
  sheet: XlsxSheet,
  row: number,
  col: number,
  inheritMerge = false,
): string {
  return getCell(sheet, row, col, inheritMerge)?.text ?? '';
}
