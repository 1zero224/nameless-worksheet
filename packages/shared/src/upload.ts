import { z } from 'zod';
import type { ArtifactDetail } from './artifact.js';
import { artifactNameSchema, artifactScopeSchema, versionNoteSchema } from './artifact.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配控制字符以做清洗与拒绝
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配控制字符以做校验
const HAS_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

// ---- 常量与枚举 ----

export const UPLOAD_SESSION_MODES = [
  'create_artifact',
  'create_version',
  'attach_version',
] as const;
export const uploadSessionModeSchema = z.enum(UPLOAD_SESSION_MODES, { error: '上传模式无效' });
export type UploadSessionMode = z.infer<typeof uploadSessionModeSchema>;

export const UPLOAD_SESSION_STATUSES = ['uploading', 'completed', 'aborted', 'expired'] as const;
export const uploadSessionStatusSchema = z.enum(UPLOAD_SESSION_STATUSES, {
  error: '上传会话状态无效',
});
export type UploadSessionStatus = z.infer<typeof uploadSessionStatusSchema>;

export const PREVIEW_KINDS = ['text', 'image', 'video', 'audio', 'unsupported'] as const;
export const previewKindSchema = z.enum(PREVIEW_KINDS);
export type PreviewKind = z.infer<typeof previewKindSchema>;

export const TEXT_PREVIEW_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB
export const DEFAULT_MULTIPART_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MiB
export const DEFAULT_PART_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB
export const DEFAULT_UPLOAD_CONCURRENCY = 3;
export const MAX_MULTIPART_PARTS = 10_000;

const TEXT_EXTENSIONS = new Set([
  '.ass',
  '.ssa',
  '.srt',
  '.txt',
  '.vtt',
  '.lrc',
  '.json',
  '.xml',
  '.md',
  '.log',
]);

const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

const VIDEO_EXTENSIONS: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
};

const AUDIO_EXTENSIONS: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
};

const SAFE_IMAGE_MIMES = new Set(Object.values(IMAGE_EXTENSIONS));
const SAFE_VIDEO_MIMES = new Set(Object.values(VIDEO_EXTENSIONS));
const SAFE_AUDIO_MIMES = new Set(Object.values(AUDIO_EXTENSIONS));

// ---- 文件名清洗、扩展名、MIME 与预览类型判定 ----

export function getFileExtension(filename: string): string {
  const clean = filename.trim();
  const lastDot = clean.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === clean.length - 1) return '';
  const ext = clean.slice(lastDot).toLowerCase();
  if (ext.length > 16 || /\s/.test(ext)) return '';
  return ext;
}

/**
 * 清洗原始文件名：
 * - 保留中文、日文、韩文、空格与常见符号；
 * - 去除控制字符、路径分隔符（/、\）与连续点（..）防路径穿越；
 * - 截断至最多 255 个字符并尽可能保留扩展名；
 * - 空文件名兜底 `untitled`。
 */
export function sanitizeFilename(raw: string): string {
  const normalized = raw.normalize('NFC').replace(CONTROL_RE, '');
  // 若带路径分隔符，取最后一个非空段
  const segments = normalized.split(/[/\\]+/).filter((seg) => seg.trim().length > 0);
  let name = segments.length > 0 ? (segments[segments.length - 1] ?? '') : '';

  // 清除任何残留路径穿越序列 `..`
  name = name.replace(/\.{2,}/g, '.');
  // 去除前导/尾随空白与前导孤立点
  name = name.trim().replace(/^\.+/, '').trim();
  // 去除尾随孤立点（Windows/常见文件系统兼容）
  name = name.replace(/\.+$/, '').trim();

  if (!name) return 'untitled';

  const chars = [...name];
  if (chars.length <= 255) return name;

  const ext = getFileExtension(name);
  const extChars = [...ext];
  if (extChars.length > 0 && extChars.length <= 20) {
    const baseMax = 255 - extChars.length;
    const base = chars.slice(0, baseMax).join('').trimEnd();
    return base ? `${base}${ext}` : `untitled${ext}`;
  }
  return chars.slice(0, 255).join('').trimEnd() || 'untitled';
}

export function normalizeMimeType(raw: string | null | undefined, filename: string): string {
  const ext = getFileExtension(filename);
  if (ext === '.svg') return 'application/octet-stream';

  if (raw) {
    const base = raw.split(';')[0]?.trim().toLowerCase() ?? '';
    if (base && MIME_RE.test(base) && base !== 'image/svg+xml' && base !== 'text/html') {
      return base;
    }
  }

  if (ext && IMAGE_EXTENSIONS[ext]) return IMAGE_EXTENSIONS[ext];
  if (ext && VIDEO_EXTENSIONS[ext]) return VIDEO_EXTENSIONS[ext];
  if (ext && AUDIO_EXTENSIONS[ext]) return AUDIO_EXTENSIONS[ext];
  if (ext && TEXT_EXTENSIONS.has(ext)) return 'text/plain';
  return 'application/octet-stream';
}

/**
 * 判定在线预览类型（严格白名单；显式拒绝 .svg 及 HTML/脚本类文件内联预览）。
 */
export function detectPreviewKind(filename: string, mimeType?: string | null): PreviewKind {
  const ext = getFileExtension(filename);
  if (ext) {
    if (ext === '.svg' || ext === '.html' || ext === '.htm' || ext === '.xhtml') {
      return 'unsupported';
    }
    if (TEXT_EXTENSIONS.has(ext)) return 'text';
    if (ext in IMAGE_EXTENSIONS) return 'image';
    if (ext in VIDEO_EXTENSIONS) return 'video';
    if (ext in AUDIO_EXTENSIONS) return 'audio';
    return 'unsupported';
  }

  const mime = mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (
    !mime ||
    mime === 'image/svg+xml' ||
    mime === 'text/html' ||
    mime === 'application/xhtml+xml'
  ) {
    return 'unsupported';
  }
  if (SAFE_IMAGE_MIMES.has(mime)) return 'image';
  if (SAFE_VIDEO_MIMES.has(mime)) return 'video';
  if (SAFE_AUDIO_MIMES.has(mime)) return 'audio';
  if (mime === 'text/plain' || mime === 'text/vtt' || mime === 'application/json') return 'text';
  return 'unsupported';
}

/**
 * 为在线预览签名 URL 返回安全的 ResponseContentType（绝不返回 text/html 或 image/svg+xml）。
 */
export function getSafePreviewContentType(
  filename: string,
  previewKind: PreviewKind,
  mimeType?: string | null,
): string | undefined {
  const ext = getFileExtension(filename);
  if (previewKind === 'text') return 'application/octet-stream';
  if (previewKind === 'image') {
    if (ext && IMAGE_EXTENSIONS[ext]) return IMAGE_EXTENSIONS[ext];
    const mime = mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
    return SAFE_IMAGE_MIMES.has(mime) ? mime : 'application/octet-stream';
  }
  if (previewKind === 'video') {
    if (ext && VIDEO_EXTENSIONS[ext]) return VIDEO_EXTENSIONS[ext];
    const mime = mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
    return SAFE_VIDEO_MIMES.has(mime) ? mime : 'video/mp4';
  }
  if (previewKind === 'audio') {
    if (ext && AUDIO_EXTENSIONS[ext]) return AUDIO_EXTENSIONS[ext];
    const mime = mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
    return SAFE_AUDIO_MIMES.has(mime) ? mime : 'audio/mpeg';
  }
  return undefined;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 1 : 1)} MB`;
  const gb = mb / 1024;
  if (gb < 1024) return `${gb.toFixed(2)} GB`;
  const tb = gb / 1024;
  return `${tb.toFixed(2)} TB`;
}

// ---- 请求体 Zod Schema ----

export const uploadFilenameSchema = z
  .string({ error: '请选择要上传的文件' })
  .refine((s) => s.trim().length > 0, { error: '文件名不能为空' })
  .transform(sanitizeFilename);

export const uploadSizeBytesSchema = z
  .number({ error: '文件大小必须是数字' })
  .int({ error: '文件大小必须是整数' })
  .min(1, { error: '不支持上传 0 字节空文件' });

export const fingerprintSha256Schema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SHA256_RE, { error: '文件指纹格式无效' });

export const idempotencyKeySchema = z
  .string({ error: '缺少请求幂等键' })
  .trim()
  .min(16, { error: '幂等键长度无效' })
  .max(128, { error: '幂等键长度无效' })
  .refine((s) => !HAS_CONTROL_RE.test(s), { error: '幂等键不能包含控制字符' });

const uploadFileCommonFields = {
  filename: uploadFilenameSchema,
  sizeBytes: uploadSizeBytesSchema,
  mimeType: z.string().max(200).nullable().optional(),
  fingerprintSha256: fingerprintSha256Schema.nullable().optional(),
  skipResume: z.boolean().optional().default(false),
  idempotencyKey: idempotencyKeySchema,
};

export const createUploadSessionBodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('create_artifact'),
    scope: artifactScopeSchema,
    name: artifactNameSchema,
    versionNote: versionNoteSchema.optional(),
    ...uploadFileCommonFields,
  }),
  z.object({
    mode: z.literal('create_version'),
    artifactId: z.uuid({ error: '资源 ID 无效' }),
    versionNote: versionNoteSchema.optional(),
    ...uploadFileCommonFields,
  }),
  z.object({
    mode: z.literal('attach_version'),
    versionId: z.uuid({ error: '版本 ID 无效' }),
    ...uploadFileCommonFields,
  }),
]);
export type CreateUploadSessionBody = z.infer<typeof createUploadSessionBodySchema>;

export const signUploadPartBodySchema = z.object({
  contentLength: z
    .number({ error: '分片大小必须是数字' })
    .int({ error: '分片大小必须是整数' })
    .min(1, { error: '分片大小必须大于 0' }),
});
export type SignUploadPartBody = z.infer<typeof signUploadPartBodySchema>;

export const promoteUploadToVersionBodySchema = z.object({
  note: versionNoteSchema.optional(),
});
export type PromoteUploadToVersionBody = z.infer<typeof promoteUploadToVersionBodySchema>;

// ---- DTO 类型 ----

export interface UploadConfigResponse {
  maxFileBytes: number;
  multipartThresholdBytes: number;
  partSizeBytes: number;
  concurrency: number;
  textPreviewMaxBytes: number;
}

export interface ListedUploadPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface UploadSessionInitResponse {
  sessionId: string;
  mode: UploadSessionMode;
  resumed: boolean;
  isMultipart: boolean;
  partSizeBytes: number | null;
  concurrency: number;
  maxFileBytes: number;
  mimeType: string;
  originalFilename: string;
  expiresAt: string;
  singlePutUrl?: string;
  uploadedParts?: ListedUploadPart[];
}

export interface UploadSessionDetail {
  sessionId: string;
  mode: UploadSessionMode;
  status: UploadSessionStatus;
  expired: boolean;
  isMultipart: boolean;
  partSizeBytes: number | null;
  sizeBytes: number;
  originalFilename: string;
  mimeType: string;
  fingerprintSha256: string | null;
  expiresAt: string;
  uploadedParts: ListedUploadPart[];
}

export interface SignUploadPartResponse {
  url: string;
  expiresAt: string;
  partNumber: number;
}

export interface ListUploadPartsResponse {
  parts: ListedUploadPart[];
}

export interface CompleteUploadResponse {
  artifact: ArtifactDetail;
  versionId: string;
  locationId: string;
  blobId: string;
}

export interface AbortUploadResponse {
  aborted: true;
}

export interface PreviewUrlResponse {
  previewKind: PreviewKind;
  url: string | null;
  expiresAt: string | null;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  tooLargeForPreview: boolean;
}
