import { getFileExtension, sanitizeFilename } from '@nw/shared';

export interface ListedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface HeadObjectResult {
  contentLength: number;
  contentType: string | null;
  etag: string | null;
}

export interface ListedStorageObject {
  key: string;
  size: number;
  lastModified: Date;
}

export class StorageNoSuchUploadError extends Error {
  readonly code = 'NoSuchUpload';
  constructor(message = 'Multipart upload does not exist') {
    super(message);
    this.name = 'StorageNoSuchUploadError';
  }
}

export interface StorageDriver {
  readonly kind: 'r2' | 'local';
  createMultipartUpload(params: {
    key: string;
    contentType: string;
  }): Promise<{ uploadId: string }>;
  signPutObject(params: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSec: number;
  }): Promise<string>;
  signUploadPart(params: {
    key: string;
    uploadId: string;
    partNumber: number;
    contentLength: number;
    expiresInSec: number;
  }): Promise<string>;
  listParts(params: { key: string; uploadId: string }): Promise<ListedPart[]>;
  completeMultipartUpload(params: {
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void>;
  abortMultipartUpload(params: { key: string; uploadId: string }): Promise<void>;
  headObject(key: string): Promise<HeadObjectResult | null>;
  signGetObject(params: {
    key: string;
    expiresInSec: number;
    responseContentDisposition?: string;
    responseContentType?: string;
  }): Promise<string>;
  deleteObject(key: string): Promise<void>;
  listObjectsByPrefix(prefix: string): Promise<ListedStorageObject[]>;
  close?(): Promise<void>;
}

/**
 * 生成不可复用的随机对象 key（绝不含原始文件名，杜绝路径与编码问题）。
 */
export function buildBlobObjectKey(projectId: string, objectId: string): string {
  return `projects/${projectId}/blobs/${objectId}`;
}

function encodeRfc5987ValueChars(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function makeAsciiFallback(cleanName: string): string {
  const ext = getFileExtension(cleanName);
  const asciiExt = ext.replace(/[^\x20-\x7e]/g, '').replace(/["\\;]/g, '');
  const rawBase = ext ? cleanName.slice(0, cleanName.length - ext.length) : cleanName;
  const asciiBase = rawBase
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\;/]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = asciiBase || 'download';
  const combined = `${base}${asciiExt}`.slice(0, 180);
  return combined || 'download';
}

/**
 * 构造 RFC 5987 `Content-Disposition: attachment` 响应头，精确还原中文/日文/空格原始文件名。
 */
export function buildContentDispositionAttachment(originalFilename: string): string {
  const clean = sanitizeFilename(originalFilename);
  const fallback = makeAsciiFallback(clean);
  const encoded = encodeRfc5987ValueChars(clean);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
