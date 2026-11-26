import { z } from 'zod';
import type { PreviewKind } from './upload.js';
import type { Work } from './worksheet.js';
import { isValidCalendarDate, normalizeText } from './worksheet.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要匹配控制字符
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const WHITESPACE_RE = /\s/;
const charCount = (s: string) => [...s].length;

const httpUrlCheck = z.url({ protocol: /^https?$/ });

export function isValidArtifactUrl(s: string): boolean {
  if (charCount(s) === 0 || charCount(s) > 2000) return false;
  if (CONTROL_RE.test(s)) return false;
  return httpUrlCheck.safeParse(s).success;
}

// ---- 枚举与常量 ----

export const LOCATION_TYPES = ['cloud_link', 'r2'] as const;
export const locationTypeSchema = z.enum(LOCATION_TYPES, { error: '入口类型无效' });
export type LocationType = z.infer<typeof locationTypeSchema>;

export const CLOUD_PROVIDERS = [
  'baidu',
  'aliyun',
  'quark',
  'tianyi',
  '115',
  'gdrive',
  'mega',
  'onedrive',
  'other',
] as const;
export const cloudProviderSchema = z.enum(CLOUD_PROVIDERS, { error: '网盘服务商无效' });
export type CloudProvider = z.infer<typeof cloudProviderSchema>;

export const CLOUD_PROVIDER_LABELS: Record<CloudProvider, string> = {
  baidu: '百度网盘',
  aliyun: '阿里云盘',
  quark: '夸克网盘',
  tianyi: '天翼云盘',
  '115': '115网盘',
  gdrive: 'Google Drive',
  mega: 'MEGA',
  onedrive: 'OneDrive',
  other: '其他',
};

export const ARTIFACT_SCOPE_KINDS = ['doc', 'work', 'task', 'stage'] as const;
export type ArtifactScopeKind = (typeof ARTIFACT_SCOPE_KINDS)[number];

// ---- 字段校验 Schema ----

export const artifactNameSchema = z
  .string({ error: '请填写资源名' })
  .transform(normalizeText)
  .pipe(
    z
      .string()
      .refine((s) => charCount(s) >= 1, { error: '请填写资源名' })
      .refine((s) => charCount(s) <= 120, { error: '资源名最多 120 个字符' })
      .refine((s) => !CONTROL_RE.test(s), { error: '资源名不能包含控制字符' }),
  );

export const versionNoteSchema = z
  .string()
  .transform(normalizeText)
  .pipe(
    z
      .string()
      .refine((s) => charCount(s) <= 200, { error: '版本说明最多 200 个字符' })
      .refine((s) => !CONTROL_RE.test(s), { error: '版本说明不能包含控制字符' }),
  );

export const locationUrlSchema = z
  .string({ error: '请填写网盘链接' })
  .transform(normalizeText)
  .pipe(
    z
      .string()
      .refine((s) => charCount(s) >= 1, { error: '请填写网盘链接' })
      .refine((s) => !CONTROL_RE.test(s), { error: '链接不能包含控制字符' })
      .refine(isValidArtifactUrl, {
        error: '链接需为合法的 http:// 或 https:// 地址且不超过 2000 字符',
      }),
  );

export const extractCodeSchema = z
  .union([z.string(), z.null()])
  .transform((v) => {
    if (v === null) return null;
    const t = normalizeText(v);
    return t === '' ? null : t;
  })
  .pipe(
    z
      .string()
      .refine((s) => charCount(s) <= 32, { error: '提取码最多 32 个字符' })
      .refine((s) => !WHITESPACE_RE.test(s), { error: '提取码不能包含空白字符' })
      .refine((s) => !CONTROL_RE.test(s), { error: '提取码不能包含控制字符' })
      .nullable(),
  );

export const locationExpiresAtSchema = z
  .union([z.string(), z.null()])
  .transform((v) => {
    if (v === null) return null;
    const t = normalizeText(v);
    return t === '' ? null : t;
  })
  .pipe(
    z
      .string()
      .refine(isValidCalendarDate, { error: '有效期格式应为 YYYY-MM-DD 且为合法日期' })
      .nullable(),
  );

export const locationNoteSchema = z
  .string()
  .transform(normalizeText)
  .pipe(
    z
      .string()
      .refine((s) => charCount(s) <= 200, { error: '入口备注最多 200 个字符' })
      .refine((s) => !CONTROL_RE.test(s), { error: '入口备注不能包含控制字符' }),
  );

// ---- 归属与请求体 Schema ----

export const artifactScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('doc') }),
  z.object({ kind: z.literal('work'), workId: z.uuid({ error: '作品 ID 无效' }) }),
  z.object({ kind: z.literal('task'), taskId: z.uuid({ error: '任务 ID 无效' }) }),
  z.object({
    kind: z.literal('stage'),
    taskId: z.uuid({ error: '任务 ID 无效' }),
    stageColumnId: z.uuid({ error: '工序列 ID 无效' }),
  }),
]);
export type ArtifactScope = z.infer<typeof artifactScopeSchema>;

export const locationInputSchema = z.object({
  provider: cloudProviderSchema.optional(),
  url: locationUrlSchema,
  extractCode: extractCodeSchema.optional(),
  isFolder: z.boolean().default(false),
  expiresAt: locationExpiresAtSchema.optional(),
  note: locationNoteSchema.optional(),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

export const createArtifactBodySchema = z.object({
  scope: artifactScopeSchema,
  name: artifactNameSchema,
  versionNote: versionNoteSchema.optional(),
  location: locationInputSchema.optional(),
});
export type CreateArtifactBody = z.infer<typeof createArtifactBodySchema>;

export const updateArtifactBodySchema = z
  .object({
    name: artifactNameSchema.optional(),
    scope: artifactScopeSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.scope !== undefined, {
    error: '请至少提供要修改的名称或归属位置',
  });
export type UpdateArtifactBody = z.infer<typeof updateArtifactBodySchema>;

export const createArtifactVersionBodySchema = z.object({
  note: versionNoteSchema.optional(),
  location: locationInputSchema.optional(),
});
export type CreateArtifactVersionBody = z.infer<typeof createArtifactVersionBodySchema>;

export const createResourceLocationBodySchema = locationInputSchema;
export type CreateResourceLocationBody = z.infer<typeof createResourceLocationBodySchema>;

export const updateResourceLocationBodySchema = z
  .object({
    provider: cloudProviderSchema.optional(),
    url: locationUrlSchema.optional(),
    extractCode: extractCodeSchema.optional(),
    isFolder: z.boolean().optional(),
    expiresAt: locationExpiresAtSchema.optional(),
    note: locationNoteSchema.optional(),
  })
  .refine(
    (v) =>
      v.provider !== undefined ||
      v.url !== undefined ||
      v.extractCode !== undefined ||
      v.isFolder !== undefined ||
      v.expiresAt !== undefined ||
      v.note !== undefined,
    { error: '请至少修改一项入口信息' },
  );
export type UpdateResourceLocationBody = z.infer<typeof updateResourceLocationBodySchema>;

export const ungroupWorkBodySchema = z.object({
  deleteSharedArtifacts: z.boolean().optional().default(false),
});
export type UngroupWorkBody = z.infer<typeof ungroupWorkBodySchema>;

// ---- DTO 类型 ----

export interface ArtifactActor {
  id: string;
  displayName: string;
}

export interface ResourceLocation {
  id: string;
  artifactId: string;
  versionId: string;
  type: LocationType;
  provider: CloudProvider | null;
  url: string | null;
  extractCode: string | null;
  isFolder: boolean;
  expiresAt: string | null;
  note: string;
  blobId: string | null;
  originalFilename: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
  previewKind: PreviewKind | null;
  createdBy: ArtifactActor;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactVersionDetail {
  id: string;
  artifactId: string;
  versionNumber: number;
  note: string;
  originalFilename: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
  createdBy: ArtifactActor;
  createdAt: string;
  locations: ResourceLocation[];
}

export interface ArtifactDetail {
  id: string;
  scopeKind: ArtifactScopeKind;
  worksheetId: string | null;
  workId: string | null;
  taskId: string | null;
  stageColumnId: string | null;
  name: string;
  latestVersionId: string | null;
  latestVersion: ArtifactVersionDetail | null;
  versions: ArtifactVersionDetail[];
  createdBy: ArtifactActor;
  createdAt: string;
  updatedAt: string;
}

export interface WorkCapsuleSummary {
  artifactId: string;
  name: string;
  latestVersionNumber: number | null;
  locationCount: number;
  hasR2File: boolean;
  /** 仅当最新版恰好有 1 个无提取码的网盘入口且无 R2 文件时有值，用于胶囊点击一键直跳 */
  directUrl: string | null;
  directProvider: CloudProvider | null;
  directIsFolder: boolean;
  hasExtractCode: boolean;
  updatedAt: string;
}

export interface StageBadgeSummary {
  artifactCount: number;
  latestArtifactId: string;
  latestArtifactName: string;
  latestVersionNumber: number | null;
  kind: 'r2' | 'link';
  label: string;
}

export interface WorksheetArtifactSummary {
  /** key: workId */
  workCapsules: Record<string, WorkCapsuleSummary[]>;
  /** key: workId -> 作品共用资源总数 */
  workArtifactCounts: Record<string, number>;
  /** key: `${taskId}:${columnId}` */
  stageBadges: Record<string, StageBadgeSummary>;
  /** key: taskId -> 本任务级 + 全部工序格资源总数 */
  taskCounts: Record<string, number>;
}

export interface WorkArtifactsResponse {
  work: Work;
  artifacts: ArtifactDetail[];
}

export interface TaskArtifactsResponse {
  work: Work | null;
  workArtifacts: ArtifactDetail[];
  stageArtifacts: Record<string, ArtifactDetail[]>;
  taskArtifacts: ArtifactDetail[];
}

export interface DeleteArtifactVersionResponse {
  artifactId: string;
  latestVersionId: string | null;
}

export interface UngroupWorkResponse {
  ungroupedTaskCount: number;
  deletedArtifactCount: number;
}

export interface SearchDocItem {
  artifactId: string;
  name: string;
  latestVersionNumber: number | null;
  locationCount: number;
  updatedAt: string;
}
