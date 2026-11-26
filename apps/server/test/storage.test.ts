import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildBlobObjectKey,
  buildContentDispositionAttachment,
  StorageNoSuchUploadError,
} from '../src/storage/driver.js';
import { LocalStubStorageDriver } from '../src/storage/local-stub.js';
import { R2StorageDriver } from '../src/storage/r2.js';

describe('T3 存储适配层（RFC 5987、R2 签名构造、本地 S3 替身）', () => {
  it('RFC 5987 Content-Disposition 正确编码中文、日文、空格与特殊字符', () => {
    const header = buildContentDispositionAttachment('【无名字幕组】第01话 テスト (v2).ass');
    expect(header.startsWith('attachment; filename="')).toBe(true);
    expect(header).toContain(
      `filename*=UTF-8''${encodeURIComponent('【无名字幕组】第01话 テスト (v2).ass').replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    );
    expect(buildBlobObjectKey('proj-1', 'blob-1')).toBe('projects/proj-1/blobs/blob-1');
  });

  it('R2StorageDriver 签发 PUT/UploadPart/GET URL 不含冗余自动校验和头且包含预期参数', async () => {
    const r2 = new R2StorageDriver({
      endpoint: 'https://testaccount.r2.cloudflarestorage.com',
      bucket: 'test-bucket',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });

    try {
      const putUrl = await r2.signPutObject({
        key: 'projects/p1/blobs/b1',
        contentType: 'text/plain',
        contentLength: 128,
        expiresInSec: 600,
      });
      const parsedPut = new URL(putUrl);
      expect(parsedPut.hostname).toBe('test-bucket.testaccount.r2.cloudflarestorage.com');
      expect(parsedPut.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
      expect(parsedPut.searchParams.has('x-amz-checksum-crc32')).toBe(false);
      expect(parsedPut.searchParams.has('x-amz-sdk-checksum-algorithm')).toBe(false);

      const partUrl = await r2.signUploadPart({
        key: 'projects/p1/blobs/b1',
        uploadId: 'upload-123',
        partNumber: 2,
        contentLength: 1024,
        expiresInSec: 600,
      });
      const parsedPart = new URL(partUrl);
      expect(parsedPart.searchParams.get('uploadId')).toBe('upload-123');
      expect(parsedPart.searchParams.get('partNumber')).toBe('2');
      expect(parsedPart.searchParams.has('x-amz-checksum-crc32')).toBe(false);

      const disposition = buildContentDispositionAttachment('中文测试.ass');
      const getUrl = await r2.signGetObject({
        key: 'projects/p1/blobs/b1',
        expiresInSec: 600,
        responseContentDisposition: disposition,
        responseContentType: 'application/octet-stream',
      });
      const parsedGet = new URL(getUrl);
      expect(parsedGet.searchParams.get('response-content-disposition')).toBe(disposition);
      expect(parsedGet.searchParams.get('response-content-type')).toBe('application/octet-stream');
    } finally {
      await r2.close();
    }
  });

  describe('LocalStubStorageDriver 全功能闭环', () => {
    let stub: LocalStubStorageDriver;

    beforeAll(async () => {
      stub = new LocalStubStorageDriver();
      await stub.start();
    });

    afterAll(async () => {
      await stub.close();
    });

    it('支持单次 PUT、HeadObject、GET、Range 206、Content-Disposition 及过期/篡改 403', async () => {
      const key = 'projects/p1/blobs/single-1';
      const content = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
      const putUrl = await stub.signPutObject({
        key,
        contentType: 'text/plain',
        contentLength: content.length,
        expiresInSec: 60,
      });

      // CORS 预检
      const optRes = await fetch(putUrl, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(optRes.status).toBe(204);
      expect(optRes.headers.get('access-control-expose-headers')).toContain('ETag');

      // 篡改签名返 403
      const tampered = `${putUrl.slice(0, -4)}dead`;
      const badRes = await fetch(tampered, { method: 'PUT', body: content });
      expect(badRes.status).toBe(403);

      // 过期签名返 403
      const expiredUrl = await stub.signPutObject({
        key,
        contentType: 'text/plain',
        contentLength: content.length,
        expiresInSec: -5,
      });
      const expRes = await fetch(expiredUrl, { method: 'PUT', body: content });
      expect(expRes.status).toBe(403);

      // 正常 PUT
      const putRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: content,
      });
      expect(putRes.status).toBe(200);
      expect(putRes.headers.get('etag')).toBeTruthy();

      const head = await stub.headObject(key);
      expect(head?.contentLength).toBe(content.length);

      // GET 带中文文件名与 Range
      const disp = buildContentDispositionAttachment('中文字幕 01.ass');
      const getUrl = await stub.signGetObject({
        key,
        expiresInSec: 60,
        responseContentDisposition: disp,
      });

      const fullRes = await fetch(getUrl);
      expect(fullRes.status).toBe(200);
      expect(fullRes.headers.get('content-disposition')).toBe(disp);
      expect(Buffer.from(await fullRes.arrayBuffer()).equals(content)).toBe(true);

      const rangeRes = await fetch(getUrl, { headers: { Range: 'bytes=10-19' } });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toBe(`bytes 10-19/${content.length}`);
      expect(await rangeRes.text()).toBe('abcdefghij');
    });

    it('支持分片上传、ListParts、Complete 合并、Abort 后 NoSuchUpload 与 DeleteObject', async () => {
      const key = 'projects/p1/blobs/multi-1';
      const { uploadId } = await stub.createMultipartUpload({
        key,
        contentType: 'application/octet-stream',
      });
      const part1 = Buffer.alloc(64, 0x41);
      const part2 = Buffer.alloc(32, 0x42);

      const url1 = await stub.signUploadPart({
        key,
        uploadId,
        partNumber: 1,
        contentLength: part1.length,
        expiresInSec: 60,
      });
      const url2 = await stub.signUploadPart({
        key,
        uploadId,
        partNumber: 2,
        contentLength: part2.length,
        expiresInSec: 60,
      });

      const r1 = await fetch(url1, { method: 'PUT', body: part1 });
      const r2 = await fetch(url2, { method: 'PUT', body: part2 });
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      const listed = await stub.listParts({ key, uploadId });
      expect(listed).toHaveLength(2);
      expect(listed[0]?.size).toBe(64);
      expect(listed[1]?.size).toBe(32);

      await stub.completeMultipartUpload({
        key,
        uploadId,
        parts: listed.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      });

      const head = await stub.headObject(key);
      expect(head?.contentLength).toBe(96);

      const getUrl = await stub.signGetObject({ key, expiresInSec: 60 });
      const body = Buffer.from(await (await fetch(getUrl)).arrayBuffer());
      expect(body.equals(Buffer.concat([part1, part2]))).toBe(true);

      // Abort 流程
      const key2 = 'projects/p1/blobs/multi-abort';
      const mp2 = await stub.createMultipartUpload({
        key: key2,
        contentType: 'application/octet-stream',
      });
      await stub.abortMultipartUpload({ key: key2, uploadId: mp2.uploadId });
      await expect(stub.listParts({ key: key2, uploadId: mp2.uploadId })).rejects.toThrow(
        StorageNoSuchUploadError,
      );
      // 幂等重复 Abort 不报错
      await expect(
        stub.abortMultipartUpload({ key: key2, uploadId: mp2.uploadId }),
      ).resolves.toBeUndefined();

      // List & Delete
      const objects = await stub.listObjectsByPrefix('projects/p1/blobs/');
      expect(objects.some((o) => o.key === key)).toBe(true);
      await stub.deleteObject(key);
      expect(await stub.headObject(key)).toBeNull();
    });
  });
});
