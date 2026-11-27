import type { Assignee, StageStatus } from './worksheet.js';

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < B64URL_ALPHABET.length; i++) {
  B64URL_DECODE[B64URL_ALPHABET.charCodeAt(i)] = i;
}

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_UUID_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * 将标准 UUID 压缩为 22 位无状态 Base64URL 短码（128 bit -> 22 字符，零数据库映射表）。
 */
export function encodeShortUuid(uuid: string): string {
  const trimmed = uuid.trim();
  if (!CANONICAL_UUID_RE.test(trimmed)) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  const hex = trimmed.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  let out = '';
  for (let i = 0; i < 15; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    out +=
      B64URL_ALPHABET[b0 >> 2]! +
      B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]! +
      B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]! +
      B64URL_ALPHABET[b2 & 0x3f]!;
  }
  const last = bytes[15]!;
  out += B64URL_ALPHABET[last >> 2]! + B64URL_ALPHABET[(last & 0x03) << 4]!;
  return out;
}

/**
 * 将 22 位 Base64URL 短码（或兼容的标准 UUID）还原为小写标准 UUID；格式非法返回 null。
 */
export function decodeShortUuid(code: string): string | null {
  const trimmed = code.trim();
  if (CANONICAL_UUID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (!SHORT_UUID_RE.test(trimmed)) {
    return null;
  }

  const vals = new Uint8Array(22);
  for (let i = 0; i < 22; i++) {
    const charCode = trimmed.charCodeAt(i);
    if (charCode >= 128) return null;
    const v = B64URL_DECODE[charCode]!;
    if (v < 0) return null;
    vals[i] = v;
  }

  // 第 22 个字符的低 4 位必须为 0（16 bytes = 128 bits = 21*6 + 2）
  if ((vals[21]! & 0x0f) !== 0) {
    return null;
  }

  const bytes = new Uint8Array(16);
  let bi = 0;
  for (let i = 0; i < 20; i += 4) {
    const c0 = vals[i]!;
    const c1 = vals[i + 1]!;
    const c2 = vals[i + 2]!;
    const c3 = vals[i + 3]!;
    bytes[bi++] = (c0 << 2) | (c1 >> 4);
    bytes[bi++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    bytes[bi++] = ((c2 & 0x03) << 6) | c3;
  }
  bytes[15] = (vals[20]! << 2) | (vals[21]! >> 4);

  let hex = '';
  for (let i = 0; i < 16; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 生成无状态任务/工序快速分享短链：
 * - 任务级：`${origin}/t/${shortTaskId}`
 * - 工序级：`${origin}/t/${shortTaskId}/${shortStageColumnId}`
 */
export function buildTaskShareUrl(opts: {
  origin: string;
  taskId: string;
  stageColumnId?: string | null;
}): string {
  const base = opts.origin.replace(/\/+$/, '');
  const taskCode = encodeShortUuid(opts.taskId);
  if (opts.stageColumnId) {
    const stageCode = encodeShortUuid(opts.stageColumnId);
    return `${base}/t/${taskCode}/${stageCode}`;
  }
  return `${base}/t/${taskCode}`;
}

export interface ShareStageEntry {
  columnId: string;
  name: string;
  status: StageStatus;
  assignees: Assignee[];
  /** 已隐藏的工序列在整条任务分享中默认省略；若为本次指定分享的目标工序则保留展示 */
  hidden?: boolean;
  /** 可选：该工序下挂载的资源数量，用于目标工序提示 */
  artifactCount?: number;
}

export interface FormatTaskShareInput {
  workName?: string | null;
  taskTitle: string;
  stages: ShareStageEntry[];
  userMap: ReadonlyMap<string, string>;
  url: string;
  /** 指定工序分享时传入该工序列 ID */
  focusStageColumnId?: string | null;
}

/**
 * 与全站 5 态语义色对齐的行首圆点：
 * - 已完成 -> 🟢
 * - 进行中 -> 🟠
 * - 已认领未开始 -> ⚪
 * - 空缺（未开始且无负责人）-> 🔴
 */
export function getShareStageEmoji(status: StageStatus, assigneeCount: number): string {
  if (status === 'done') return '🟢';
  if (status === 'in_progress') return '🟠';
  if (status === 'not_started') {
    return assigneeCount > 0 ? '⚪' : '🔴';
  }
  return '⚪';
}

function formatStageAssignees(assignees: Assignee[], userMap: ReadonlyMap<string, string>): string {
  if (assignees.length === 0) return '空缺';
  return assignees
    .map((a) => (a.type === 'user' ? (userMap.get(a.userId) ?? '未知用户') : a.name))
    .join('、');
}

/**
 * 生成适合直接粘贴到聊天群的任务/工序快速分享纯文本（圆点居行首、不含工序备注与敏感信息）。
 */
export function formatTaskShareText(input: FormatTaskShareInput): string {
  const workName = input.workName?.trim() || null;
  const taskTitle = input.taskTitle.trim() || '未命名任务';
  const focusStage = input.focusStageColumnId
    ? (input.stages.find((s) => s.columnId === input.focusStageColumnId) ?? null)
    : null;

  const baseTitle = workName ? `${workName} - ${taskTitle}` : taskTitle;
  const header = focusStage ? `${baseTitle} · ${focusStage.name}` : baseTitle;

  const lines: string[] = [header];

  for (const stage of input.stages) {
    const isFocused = Boolean(focusStage && stage.columnId === focusStage.columnId);
    if (stage.status === 'na') continue;
    if (stage.hidden && !isFocused) continue;

    const emoji = getShareStageEmoji(stage.status, stage.assignees.length);
    const assigneeText = formatStageAssignees(stage.assignees, input.userMap);
    let line = `${emoji} ${stage.name}：${assigneeText}`;
    if (isFocused) {
      const suffix =
        typeof stage.artifactCount === 'number' && stage.artifactCount > 0
          ? `（本次分享 · ${stage.artifactCount} 个资源）`
          : '（本次分享）';
      line += suffix;
    }
    lines.push(line);
  }

  if (focusStage) {
    lines.push(`📎 查看「${focusStage.name}」工序资源：${input.url}`);
  } else {
    lines.push(`🔗 查看任务：${input.url}`);
  }

  return lines.join('\n');
}
