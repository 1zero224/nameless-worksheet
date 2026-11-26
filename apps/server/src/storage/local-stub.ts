import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  type HeadObjectResult,
  type ListedPart,
  type ListedStorageObject,
  type StorageDriver,
  StorageNoSuchUploadError,
} from './driver.js';

interface StoredObjectMeta {
  key: string;
  filePath: string;
  contentType: string;
  contentLength: number;
  etag: string;
  lastModified: Date;
}

interface MultipartUploadState {
  uploadId: string;
  key: string;
  contentType: string;
  parts: Map<number, { filePath: string; size: number; etag: string }>;
}

/**
 * 本地开发、Vitest 与 Playwright E2E 使用的进程内 S3 兼容 HTTP 替身。
 * 完整实现预签名 HMAC 校验、CORS、ETag、单次 PUT、分片 PUT/ListParts/Complete/Abort、Range 206 与过期 403。
 */
export class LocalStubStorageDriver implements StorageDriver {
  readonly kind = 'local' as const;
  readonly #rootDir: string;
  readonly #secret: Buffer;
  readonly #objects = new Map<string, StoredObjectMeta>();
  readonly #uploads = new Map<string, MultipartUploadState>();
  #server: http.Server | null = null;
  #baseUrl = '';

  constructor(rootDir?: string) {
    this.#rootDir = rootDir ?? mkdtempSync(path.join(os.tmpdir(), 'nw-r2-stub-'));
    this.#secret = randomBytes(32);
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    await mkdir(path.join(this.#rootDir, 'objects'), { recursive: true });
    await mkdir(path.join(this.#rootDir, 'parts'), { recursive: true });

    const server = http.createServer((req, res) => {
      this.#handleHttp(req, res).catch((err) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(err instanceof Error ? err.message : 'Internal stub error');
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const addr = server.address() as AddressInfo;
    this.#server = server;
    this.#baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  #signParams(params: Record<string, string>): string {
    const entries = Object.entries(params)
      .filter(([, v]) => v !== '')
      .sort(([a], [b]) => a.localeCompare(b));
    const canonical = entries.map(([k, v]) => `${k}=${v}`).join('&');
    return createHmac('sha256', this.#secret).update(canonical).digest('hex');
  }

  #buildSignedUrl(params: Record<string, string>): string {
    if (!this.#baseUrl) {
      throw new Error('LocalStubStorageDriver not started');
    }
    const sig = this.#signParams(params);
    const url = new URL('/stub', this.#baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== '') url.searchParams.set(k, v);
    }
    url.searchParams.set('sig', sig);
    return url.toString();
  }

  #verifySignedUrl(url: URL): { ok: true; params: Record<string, string> } | { ok: false } {
    const sig = url.searchParams.get('sig');
    if (!sig) return { ok: false };
    const params: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) {
      if (k === 'sig') continue;
      params[k] = v;
    }
    const expected = this.#signParams(params);
    const sigBuf = Buffer.from(sig, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return { ok: false };
    }
    const expSec = Number(params.exp ?? '0');
    if (!Number.isFinite(expSec) || Date.now() / 1000 > expSec) {
      return { ok: false };
    }
    return { ok: true, params };
  }

  #applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'ETag, Content-Range, Accept-Ranges, Content-Length',
    );
    res.setHeader('Access-Control-Max-Age', '3600');
  }

  async #readBodyToFile(
    req: IncomingMessage,
    filePath: string,
  ): Promise<{ size: number; md5: string }> {
    const hash = createHash('md5');
    let size = 0;
    const out = createWriteStream(filePath);
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        hash.update(chunk);
        out.write(chunk);
      });
      req.on('end', () => {
        out.end(() => resolve());
      });
      req.on('error', (err) => {
        out.destroy();
        reject(err);
      });
      out.on('error', reject);
    });
    return { size, md5: hash.digest('hex') };
  }

  async #handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.#applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', this.#baseUrl);
    const verified = this.#verifySignedUrl(url);
    if (!verified.ok) {
      res.statusCode = 403;
      res.end('Forbidden: invalid or expired signature');
      return;
    }

    const { params } = verified;
    const op = params.op;
    const key = params.key;

    if (req.method === 'PUT' && op === 'put' && key) {
      const expectedLen = params.contentLength ? Number(params.contentLength) : null;
      const objFile = path.join(
        this.#rootDir,
        'objects',
        `${createHash('sha256').update(key).digest('hex')}-${randomBytes(4).toString('hex')}`,
      );
      const { size, md5 } = await this.#readBodyToFile(req, objFile);
      if (expectedLen !== null && size !== expectedLen) {
        await rm(objFile, { force: true });
        res.statusCode = 400;
        res.end('Content-Length mismatch');
        return;
      }
      const etag = `"${md5}"`;
      const prev = this.#objects.get(key);
      if (prev && prev.filePath !== objFile) {
        await rm(prev.filePath, { force: true });
      }
      this.#objects.set(key, {
        key,
        filePath: objFile,
        contentType:
          params.contentType ||
          (typeof req.headers['content-type'] === 'string'
            ? req.headers['content-type']
            : 'application/octet-stream'),
        contentLength: size,
        etag,
        lastModified: new Date(),
      });
      res.setHeader('ETag', etag);
      res.statusCode = 200;
      res.end();
      return;
    }

    if (req.method === 'PUT' && op === 'part' && key) {
      const uploadId = params.uploadId;
      const partNumber = Number(params.partNumber);
      const upload = uploadId ? this.#uploads.get(uploadId) : undefined;
      if (!upload || upload.key !== key || !Number.isInteger(partNumber) || partNumber < 1) {
        res.statusCode = 404;
        res.end('NoSuchUpload');
        return;
      }
      const expectedLen = params.contentLength ? Number(params.contentLength) : null;
      const partFile = path.join(this.#rootDir, 'parts', `${uploadId}-${partNumber}.part`);
      const { size, md5 } = await this.#readBodyToFile(req, partFile);
      if (expectedLen !== null && size !== expectedLen) {
        await rm(partFile, { force: true });
        res.statusCode = 400;
        res.end('Content-Length mismatch');
        return;
      }
      const etag = `"${md5}"`;
      upload.parts.set(partNumber, { filePath: partFile, size, etag });
      res.setHeader('ETag', etag);
      res.statusCode = 200;
      res.end();
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && op === 'get' && key) {
      const obj = this.#objects.get(key);
      if (!obj) {
        res.statusCode = 404;
        res.end('NoSuchKey');
        return;
      }
      const total = obj.contentLength;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', obj.etag);
      res.setHeader('Content-Type', params.respContentType || obj.contentType);
      if (params.disposition) {
        res.setHeader('Content-Disposition', params.disposition);
      }

      const rangeHeader = req.headers.range;
      if (typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
        const spec = rangeHeader.slice('bytes='.length).split(',')[0]?.trim() ?? '';
        const [startStr, endStr] = spec.split('-');
        let start = startStr === '' ? 0 : Number(startStr);
        let end = endStr === '' ? total - 1 : Number(endStr);
        if (startStr === '' && endStr !== '') {
          // suffix range: bytes=-500
          const suffix = Number(endStr);
          start = Math.max(0, total - suffix);
          end = total - 1;
        }
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 0 ||
          end >= total ||
          start > end
        ) {
          res.setHeader('Content-Range', `bytes */${total}`);
          res.statusCode = 416;
          res.end();
          return;
        }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', String(end - start + 1));
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(obj.filePath, { start, end });
          stream.on('error', reject);
          res.on('finish', resolve);
          stream.pipe(res);
        });
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Length', String(total));
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(obj.filePath);
        stream.on('error', reject);
        res.on('finish', resolve);
        stream.pipe(res);
      });
      return;
    }

    res.statusCode = 405;
    res.end('Method Not Allowed');
  }

  async createMultipartUpload(params: {
    key: string;
    contentType: string;
  }): Promise<{ uploadId: string }> {
    await this.start();
    const uploadId = `mp_${randomBytes(12).toString('hex')}`;
    this.#uploads.set(uploadId, {
      uploadId,
      key: params.key,
      contentType: params.contentType,
      parts: new Map(),
    });
    return { uploadId };
  }

  async signPutObject(params: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSec: number;
  }): Promise<string> {
    await this.start();
    const exp = String(Math.floor(Date.now() / 1000) + params.expiresInSec);
    return this.#buildSignedUrl({
      op: 'put',
      key: params.key,
      contentType: params.contentType,
      contentLength: String(params.contentLength),
      exp,
    });
  }

  async signUploadPart(params: {
    key: string;
    uploadId: string;
    partNumber: number;
    contentLength: number;
    expiresInSec: number;
  }): Promise<string> {
    await this.start();
    const exp = String(Math.floor(Date.now() / 1000) + params.expiresInSec);
    return this.#buildSignedUrl({
      op: 'part',
      key: params.key,
      uploadId: params.uploadId,
      partNumber: String(params.partNumber),
      contentLength: String(params.contentLength),
      exp,
    });
  }

  async listParts(params: { key: string; uploadId: string }): Promise<ListedPart[]> {
    const upload = this.#uploads.get(params.uploadId);
    if (!upload || upload.key !== params.key) {
      throw new StorageNoSuchUploadError();
    }
    const parts: ListedPart[] = [];
    for (const [partNumber, info] of upload.parts.entries()) {
      parts.push({ partNumber, etag: info.etag, size: info.size });
    }
    parts.sort((a, b) => a.partNumber - b.partNumber);
    return parts;
  }

  async completeMultipartUpload(params: {
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void> {
    const upload = this.#uploads.get(params.uploadId);
    if (!upload || upload.key !== params.key) {
      throw new StorageNoSuchUploadError();
    }
    const sorted = params.parts.slice().sort((a, b) => a.partNumber - b.partNumber);
    const objFile = path.join(
      this.#rootDir,
      'objects',
      `${createHash('sha256').update(params.key).digest('hex')}-${randomBytes(4).toString('hex')}`,
    );

    const buffers: Buffer[] = [];
    const md5List: Buffer[] = [];
    let totalSize = 0;

    for (const reqPart of sorted) {
      const stored = upload.parts.get(reqPart.partNumber);
      if (!stored || stored.etag !== reqPart.etag) {
        throw new Error(`Invalid part ${reqPart.partNumber}`);
      }
      const buf = await readFile(stored.filePath);
      buffers.push(buf);
      md5List.push(Buffer.from(stored.etag.replaceAll('"', ''), 'hex'));
      totalSize += buf.length;
    }

    await writeFile(objFile, Buffer.concat(buffers));
    const combinedMd5 = createHash('md5').update(Buffer.concat(md5List)).digest('hex');
    const etag = `"${combinedMd5}-${sorted.length}"`;

    const prev = this.#objects.get(params.key);
    if (prev && prev.filePath !== objFile) {
      await rm(prev.filePath, { force: true });
    }

    this.#objects.set(params.key, {
      key: params.key,
      filePath: objFile,
      contentType: upload.contentType,
      contentLength: totalSize,
      etag,
      lastModified: new Date(),
    });

    // 清理临时分片文件
    for (const info of upload.parts.values()) {
      await rm(info.filePath, { force: true });
    }
    this.#uploads.delete(params.uploadId);
  }

  async abortMultipartUpload(params: { key: string; uploadId: string }): Promise<void> {
    const upload = this.#uploads.get(params.uploadId);
    if (!upload || upload.key !== params.key) {
      return;
    }
    for (const info of upload.parts.values()) {
      await rm(info.filePath, { force: true });
    }
    this.#uploads.delete(params.uploadId);
  }

  async headObject(key: string): Promise<HeadObjectResult | null> {
    const obj = this.#objects.get(key);
    if (!obj) return null;
    try {
      const st = await stat(obj.filePath);
      return {
        contentLength: st.size,
        contentType: obj.contentType,
        etag: obj.etag,
      };
    } catch {
      return null;
    }
  }

  async signGetObject(params: {
    key: string;
    expiresInSec: number;
    responseContentDisposition?: string;
    responseContentType?: string;
  }): Promise<string> {
    await this.start();
    const exp = String(Math.floor(Date.now() / 1000) + params.expiresInSec);
    return this.#buildSignedUrl({
      op: 'get',
      key: params.key,
      exp,
      disposition: params.responseContentDisposition ?? '',
      respContentType: params.responseContentType ?? '',
    });
  }

  async deleteObject(key: string): Promise<void> {
    const obj = this.#objects.get(key);
    if (!obj) return;
    this.#objects.delete(key);
    await rm(obj.filePath, { force: true });
  }

  async listObjectsByPrefix(prefix: string): Promise<ListedStorageObject[]> {
    const list: ListedStorageObject[] = [];
    for (const obj of this.#objects.values()) {
      if (obj.key.startsWith(prefix)) {
        list.push({
          key: obj.key,
          size: obj.contentLength,
          lastModified: obj.lastModified,
        });
      }
    }
    return list;
  }

  /** 仅用于测试：调整某对象 lastModified 以模拟超宽限期孤立对象 */
  setObjectLastModifiedForTest(key: string, date: Date): void {
    const obj = this.#objects.get(key);
    if (obj) {
      obj.lastModified = date;
    }
  }

  async close(): Promise<void> {
    if (this.#server) {
      const srv = this.#server;
      this.#server = null;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    try {
      rmSync(this.#rootDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup failure
    }
  }
}
