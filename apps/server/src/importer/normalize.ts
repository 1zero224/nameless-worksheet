import { isValidCalendarDate } from '@nw/shared';

// biome-ignore lint/suspicious/noControlCharactersInRegex: 清洗除换行外的控制字符
const NON_LF_CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;
const EDGE_WS_RE = /^[\s\u3000]+|[\s\u3000]+$/g;

/**
 * 阶段 5 显式文本归一化白名单：
 * - Unicode NFC 规范化
 * - \r\n / \r 统一转为 \n
 * - 去除首尾半角与全角空白
 * - 清除除 \n 外的控制字符
 */
export function normalizeCellText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(NON_LF_CONTROL_RE, '')
    .replace(EDGE_WS_RE, '');
}

export function normalizeNullableCellText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = normalizeCellText(raw);
  return cleaned === '' ? null : cleaned;
}

export function normalizeSingleLine(raw: string): string {
  return normalizeCellText(raw).replace(/\s+/g, ' ').trim();
}

export function truncateChars(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 31);

/**
 * Excel 1900 日期序列号转 YYYY-MM-DD（含 1900 闰年偏移）。
 */
export function formatExcelSerialDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 200000) return null;
  const wholeDays = Math.floor(serial);
  // Excel 误把 1900-02-29 当作第 60 天，>= 60 时需减 1 天
  const adjustedDays = wholeDays >= 60 ? wholeDays - 1 : wholeDays;
  const dt = new Date(EXCEL_EPOCH_UTC_MS + adjustedDays * 86_400_000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  const formatted = `${y}-${m}-${d}`;
  return isValidCalendarDate(formatted) ? formatted : null;
}

/**
 * Excel 时间/时长分数（如 0.46875 -> 11:15）精准转为 HH:MM 或 HH:MM:SS。
 */
export function formatExcelDuration(serial: number, includeSeconds = false): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const totalSeconds = Math.round(serial * 86_400);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  if (includeSeconds || seconds > 0) {
    const ss = String(seconds).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${hh}:${mm}`;
}

export function isDurationNumFmt(numFmtId: number, formatCode: string | null): boolean {
  // Excel 内建时间格式 18-21, 45-47 及自定义 300/301 等
  if ((numFmtId >= 18 && numFmtId <= 21) || (numFmtId >= 45 && numFmtId <= 47)) {
    return true;
  }
  if (!formatCode) return false;
  // 去掉引号内文字与条件区
  const cleaned = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase();
  const hasTime = cleaned.includes('h:') || cleaned.includes(':m') || cleaned.includes(':s');
  const hasDate = cleaned.includes('y') || cleaned.includes('d');
  return hasTime && !hasDate;
}

export function isDurationWithSeconds(numFmtId: number, formatCode: string | null): boolean {
  if (numFmtId === 19 || numFmtId === 21 || numFmtId === 46 || numFmtId === 47) return true;
  if (!formatCode) return false;
  const cleaned = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase();
  return cleaned.includes('s');
}

export function isDateNumFmt(numFmtId: number, formatCode: string | null): boolean {
  if ((numFmtId >= 14 && numFmtId <= 17) || numFmtId === 22 || numFmtId === 72) {
    return true;
  }
  if (!formatCode) return false;
  const cleaned = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase();
  return cleaned.includes('y') || (cleaned.includes('m') && cleaned.includes('d'));
}

/**
 * 将常见合法单日文本（2024.09.21 / 2025.11.7 / 2025.06..22 / 2025年1月3日 / 2025/1/3）归一化为 YYYY-MM-DD。
 * 无法形成单个合法公历日期的值返回 null（不猜测）。
 */
export function parseCalendarDateString(raw: string): string | null {
  const s = normalizeSingleLine(raw);
  if (!s) return null;
  // 纠正双点笔误如 2025.06..22
  const fixed = s.replace(/\.{2,}/g, '.');
  const m = /^(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})日?$/.exec(fixed);
  if (!m) return null;
  const y = m[1]!;
  const mo = m[2]!.padStart(2, '0');
  const d = m[3]!.padStart(2, '0');
  const iso = `${y}-${mo}-${d}`;
  return isValidCalendarDate(iso) ? iso : null;
}

/**
 * 解析颜色分类（遵循阶段 5 第 7.1 节色值定义）。
 */
export type SemanticColor = 'green' | 'yellow' | 'blue' | 'gray' | 'red' | 'none';

const GREEN_HEX = new Set([
  '#92D050',
  '#A1CE63',
  '#C3EAD5',
  '#A9D08E',
  '#C6EFCE',
  '#00B050',
  '#70AD47',
]);
const YELLOW_HEX = new Set(['#FFC000', '#FEFB54', '#FFFF00', '#FFD966', '#FFF2CC', '#FFE699']);
const BLUE_HEX = new Set(['#8CDDFA', '#00B0F0', '#9BC2E6', '#BDD7EE', '#5B9BD5']);
const GRAY_HEX = new Set([
  '#939393',
  '#BFBFBF',
  '#D8D8D8',
  '#A5A5A5',
  '#A6A6A6',
  '#808080',
  '#D9D9D9',
  '#C9C9C9',
]);
const RED_HEX = new Set(['#FF0000', '#C00000', '#E06666', '#F4CCCC', '#FF4D4F']);

export function classifyFillHex(hex: string | null | undefined): SemanticColor {
  if (!hex) return 'none';
  const upper = hex.toUpperCase();
  if (upper === '#FFFFFF' || upper === '#000000') return 'none';
  if (GREEN_HEX.has(upper)) return 'green';
  if (YELLOW_HEX.has(upper)) return 'yellow';
  if (BLUE_HEX.has(upper)) return 'blue';
  if (GRAY_HEX.has(upper)) return 'gray';
  if (RED_HEX.has(upper)) return 'red';
  return 'none';
}
