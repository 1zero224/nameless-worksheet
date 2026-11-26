import { normalizeCellText, normalizeSingleLine } from './normalize.js';

/**
 * 阶段 5 第 7.1 节确认的 25 组真实人名合并映射（19 组现行 + 6 组留念表）。
 * key 均为规范化后的别名（含大小写变体），value 为标准显示名。
 */
const CANONICAL_NAME_ENTRIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  // 现行 12 表 19 组
  ['山里的耗子', ['山里的耗子', '耗子']],
  ['斗笠斗笠', ['斗笠斗笠', '斗笠']],
  ['辣味糖果', ['辣味糖果', '糖果']],
  ['黑猫一吱', ['黑猫一吱', '黑猫']],
  ['涟聆', ['涟聆', '涟宝', '莲聆']],
  ['tyb0v0', ['tyb0v0', 'tyb0v1']],
  ['Dori', ['Dori', 'dori', 'ドリドリ']],
  ['Asama', ['Asama', 'asama']],
  ['hibike', ['hibike', 'Hibike']],
  ['Rain_Jack', ['Rain_Jack', 'RainJack']],
  ['giddens', ['giddens', 'Giddens']],
  ['Kinoko', ['Kinoko', 'kinoko']],
  ['书包', ['书包', '书包是笨蛋']],
  ['魚捲', ['魚捲', '鱼捲']],
  ['淋雨RA1N', ['淋雨RA1N', 'RA1N']],
  ['しめめし', ['しめめし', '〆飯', '〆めし']],
  ['uz', ['uz', 'uz(日文)', 'uz（日文）']],
  ['3t', ['3t', '3t已一校']],
  ['二狗', ['二狗', '狗圣帝君']],
  // 留念表额外 6 组（uz 复用上方）
  ['彗星型黎翘', ['彗星型黎翘', '彗星']],
  ['外协机械帕鲁', ['外协机械帕鲁', '帕鲁']],
  ['生姜がない', ['生姜がない', '生姜']],
  ['鬼明0', ['鬼明0', '鬼明']],
  ['ShiNyuan', ['ShiNyuan', 'shinyuan']],
];

const EXACT_ALIAS_MAP = new Map<string, string>();
const LOWER_ALIAS_MAP = new Map<string, string>();

for (const [canonical, aliases] of CANONICAL_NAME_ENTRIES) {
  const c = normalizeSingleLine(canonical);
  EXACT_ALIAS_MAP.set(c, c);
  LOWER_ALIAS_MAP.set(c.toLowerCase(), c);
  for (const a of aliases) {
    const n = normalizeSingleLine(a);
    EXACT_ALIAS_MAP.set(n, c);
    LOWER_ALIAS_MAP.set(n.toLowerCase(), c);
  }
}

export function canonicalizePersonName(raw: string): string {
  const s = normalizeSingleLine(raw);
  if (!s) return '';
  return EXACT_ALIAS_MAP.get(s) ?? LOWER_ALIAS_MAP.get(s.toLowerCase()) ?? s;
}

/** 精确「不适用」词表（第 7.1 节） */
export const NA_KEYWORDS = new Set(['/', '\\', '-', '官中', '不用翻', '微博已翻']);

/** 明确不是真实用户的占位/词条 */
const NON_PERSON_EXACT = new Set([
  '无',
  '暂无',
  '待定',
  '空缺',
  '无须',
  '无需',
  '不需要',
  '跳过',
  '取消',
  '未开始',
  '已完成',
  '群文件',
  'anilive',
  'anilive涟聆',
]);

const TEXT_ONLY_ASSIGNEES = new Set(['GPT', 'gpt']);

export interface ParsedStageCellContent {
  /** 标准用户显示名（将映射为 userId / 待认领用户） */
  userDisplayNames: string[];
  /** 纯文本负责人（如 GPT，不建用户） */
  textAssignees: string[];
  /** 提取到的备注说明 */
  notes: string[];
  /** 若单元格整体命中精确 na 词表 */
  isNa: boolean;
  /** 若单元格写了「进行中」 */
  isInProgressKeyword: boolean;
  /** 若备注中显式含「校对：xxx」可补充到校对列 */
  extraProofreaderNames: string[];
}

function stripPartPrefix(token: string): { body: string; prefixNote: string | null } {
  const m = /^(Part\s*[\d.\-~～到至]+)\s*[:：]\s*(.+)$/i.exec(token);
  if (m) {
    return { body: m[2]!.trim(), prefixNote: m[1]!.trim() };
  }
  return { body: token, prefixNote: null };
}

/**
 * 解析工序格内的负责人与备注文本。
 * @param allowSpaceSplit 漫画表等存在空格分隔多人时启用
 */
export function parseStageCellText(
  rawText: string,
  opts?: { allowSpaceSplit?: boolean },
): ParsedStageCellContent {
  const cleaned = normalizeCellText(rawText);
  const result: ParsedStageCellContent = {
    userDisplayNames: [],
    textAssignees: [],
    notes: [],
    isNa: false,
    isInProgressKeyword: false,
    extraProofreaderNames: [],
  };

  if (!cleaned) return result;

  // 整格命中精确 na 词表
  if (NA_KEYWORDS.has(cleaned)) {
    result.isNa = true;
    result.notes.push(cleaned);
    return result;
  }

  // 整格「进行中」
  if (cleaned === '进行中') {
    result.isInProgressKeyword = true;
    return result;
  }

  // 整格「扣下当校对题」
  if (cleaned === '扣下当校对题') {
    result.notes.push(cleaned);
    return result;
  }

  const userSet = new Set<string>();
  const textSet = new Set<string>();
  const extraProofSet = new Set<string>();

  const addUser = (rawName: string) => {
    const canon = canonicalizePersonName(rawName);
    if (!canon) return;
    if (NA_KEYWORDS.has(canon)) return;
    if (TEXT_ONLY_ASSIGNEES.has(canon)) {
      textSet.add('GPT');
      return;
    }
    if (NON_PERSON_EXACT.has(canon.toLowerCase())) return;
    if (/^https?:\/\//i.test(canon)) return;
    // 排除纯标点或纯数字
    if (/^[\d\s.,:;!?~～\-_/\\+()（）[\]【】]+$/.test(canon)) return;
    userSet.add(canon);
  };

  // 先按行拆分：如果某行明显是中文长句/提示语（如“别急，以后晚点发”），归入 note
  const lines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const candidateChunks: string[] = [];

  for (const line of lines) {
    if (
      line.includes('别急') ||
      line.includes('以后晚点发') ||
      line.includes('暂缓') ||
      line.includes('撞车') ||
      line.includes('扣下当校对题') ||
      (line.length >= 12 && /[，。！？、]/.test(line) && !/^[Part\s\d]/i.test(line))
    ) {
      result.notes.push(line);
      continue;
    }
    candidateChunks.push(line);
  }

  for (const chunk of candidateChunks) {
    // 提取括号备注，同时保留括号前主体；但先处理特殊内嵌斜杠如「竹叶（歌轴）/养得累」
    // 按常见多人分隔符切分（注意不切括号内部）
    const tokens: string[] = [];
    let current = '';
    let depth = 0;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      if (ch === '(' || ch === '（' || ch === '[' || ch === '【') {
        depth++;
        current += ch;
      } else if (ch === ')' || ch === '）' || ch === ']' || ch === '】') {
        depth = Math.max(0, depth - 1);
        current += ch;
      } else if (
        depth === 0 &&
        (ch === '、' ||
          ch === '/' ||
          ch === ',' ||
          ch === '，' ||
          ch === '+' ||
          ch === '&' ||
          ch === '＆' ||
          (opts?.allowSpaceSplit && ch === ' '))
      ) {
        if (current.trim()) tokens.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) tokens.push(current.trim());

    for (const rawToken of tokens) {
      const { body, prefixNote } = stripPartPrefix(rawToken);
      if (prefixNote) result.notes.push(`${prefixNote}`);

      if (NA_KEYWORDS.has(body)) {
        result.notes.push(body);
        continue;
      }
      if (body === '进行中') {
        result.isInProgressKeyword = true;
        continue;
      }

      // 提取全部括号内容（含全角/半角）
      const bracketNotes: string[] = [];
      const withoutBrackets = body
        .replace(/[（(]([^）)]+)[）)]/g, (_m, inner: string) => {
          const t = inner.trim();
          if (t) {
            bracketNotes.push(t);
            // 检测「校对：斗笠」
            const proofMatch = /^校对\s*[:：]\s*(.+)$/.exec(t);
            if (proofMatch?.[1]) {
              const pn = canonicalizePersonName(proofMatch[1]);
              if (pn) extraProofSet.add(pn);
            }
          }
          return '';
        })
        .trim();

      // 特殊精确别名（如 3t已一校、uz(日文)）优先查完整 body 或 withoutBrackets
      if (EXACT_ALIAS_MAP.has(body) || LOWER_ALIAS_MAP.has(body.toLowerCase())) {
        const canon = canonicalizePersonName(body);
        addUser(canon);
        if (body !== canon) {
          // 保留后缀说明进备注（如 已一校、日文）
          if (bracketNotes.length > 0) {
            result.notes.push(...bracketNotes);
          } else {
            const suffix = body.slice(canon.length).trim();
            if (suffix) result.notes.push(suffix);
          }
        }
        continue;
      }

      // 处理「Dori二校」「xxx一校」「xxx初校」等后缀
      let namePart = withoutBrackets;
      const stageSuffixMatch = /^(.+?)(已一校|已二校|一校|二校|初校|复校|终校)$/.exec(namePart);
      if (stageSuffixMatch?.[1] && stageSuffixMatch[2]) {
        namePart = stageSuffixMatch[1].trim();
        result.notes.push(stageSuffixMatch[2]);
      }

      if (bracketNotes.length > 0) {
        result.notes.push(...bracketNotes);
      }

      if (namePart) {
        addUser(namePart);
      }
    }
  }

  result.userDisplayNames = [...userSet];
  result.textAssignees = [...textSet];
  result.extraProofreaderNames = [...extraProofSet];
  return result;
}
