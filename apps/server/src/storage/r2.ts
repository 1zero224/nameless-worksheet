import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  type HeadObjectResult,
  type ListedPart,
  type ListedStorageObject,
  type StorageDriver,
  StorageNoSuchUploadError,
} from './driver.js';

export interface R2StorageDriverOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function getS3ErrorCode(err: unknown): { code: string; status: number | undefined } {
  const e = err as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return {
    code: e?.Code ?? e?.name ?? e?.code ?? '',
    status: e?.$metadata?.httpStatusCode,
  };
}

function isNoSuchUpload(err: unknown): boolean {
  const { code, status } = getS3ErrorCode(err);
  return code === 'NoSuchUpload' || (status === 404 && code !== 'NoSuchBucket');
}

function isNotFoundError(err: unknown): boolean {
  const { code, status } = getS3ErrorCode(err);
  return code === 'NotFound' || code === 'NoSuchKey' || status === 404;
}

export class R2StorageDriver implements StorageDriver {
  readonly kind = 'r2' as const;
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(opts: R2StorageDriverOptions) {
    this.#bucket = opts.bucket;
    this.#client = new S3Client({
      region: 'auto',
      endpoint: opts.endpoint,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
      forcePathStyle: false,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async createMultipartUpload(params: {
    key: string;
    contentType: string;
  }): Promise<{ uploadId: string }> {
    const out = await this.#client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: params.key,
        ContentType: params.contentType,
      }),
    );
    if (!out.UploadId) {
      throw new Error('R2 CreateMultipartUpload did not return UploadId');
    }
    return { uploadId: out.UploadId };
  }

  async signPutObject(params: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSec: number;
  }): Promise<string> {
    return getSignedUrl(
      this.#client,
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: params.key,
        ContentType: params.contentType,
        ContentLength: params.contentLength,
      }),
      { expiresIn: params.expiresInSec },
    );
  }

  async signUploadPart(params: {
    key: string;
    uploadId: string;
    partNumber: number;
    contentLength: number;
    expiresInSec: number;
  }): Promise<string> {
    return getSignedUrl(
      this.#client,
      new UploadPartCommand({
        Bucket: this.#bucket,
        Key: params.key,
        UploadId: params.uploadId,
        PartNumber: params.partNumber,
        ContentLength: params.contentLength,
      }),
      { expiresIn: params.expiresInSec },
    );
  }

  async listParts(params: { key: string; uploadId: string }): Promise<ListedPart[]> {
    const all: ListedPart[] = [];
    let partNumberMarker: string | undefined;

    try {
      while (true) {
        const out = await this.#client.send(
          new ListPartsCommand({
            Bucket: this.#bucket,
            Key: params.key,
            UploadId: params.uploadId,
            PartNumberMarker: partNumberMarker,
          }),
        );
        for (const p of out.Parts ?? []) {
          if (p.PartNumber !== undefined && p.ETag && p.Size !== undefined) {
            all.push({
              partNumber: p.PartNumber,
              etag: p.ETag,
              size: p.Size,
            });
          }
        }
        if (!out.IsTruncated || !out.NextPartNumberMarker) {
          break;
        }
        partNumberMarker = out.NextPartNumberMarker;
      }
    } catch (err) {
      if (isNoSuchUpload(err)) {
        throw new StorageNoSuchUploadError();
      }
      throw err;
    }

    all.sort((a, b) => a.partNumber - b.partNumber);
    return all;
  }

  async completeMultipartUpload(params: {
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void> {
    try {
      await this.#client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: params.key,
          UploadId: params.uploadId,
          MultipartUpload: {
            Parts: params.parts
              .slice()
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
    } catch (err) {
      if (isNoSuchUpload(err)) {
        throw new StorageNoSuchUploadError();
      }
      throw err;
    }
  }

  async abortMultipartUpload(params: { key: string; uploadId: string }): Promise<void> {
    try {
      await this.#client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: params.key,
          UploadId: params.uploadId,
        }),
      );
    } catch (err) {
      if (isNoSuchUpload(err)) {
        return;
      }
      throw err;
    }
  }

  async headObject(key: string): Promise<HeadObjectResult | null> {
    try {
      const out = await this.#client.send(
        new HeadObjectCommand({
          Bucket: this.#bucket,
          Key: key,
        }),
      );
      return {
        contentLength: out.ContentLength ?? 0,
        contentType: out.ContentType ?? null,
        etag: out.ETag ?? null,
      };
    } catch (err) {
      if (isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  async signGetObject(params: {
    key: string;
    expiresInSec: number;
    responseContentDisposition?: string;
    responseContentType?: string;
  }): Promise<string> {
    return getSignedUrl(
      this.#client,
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: params.key,
        ...(params.responseContentDisposition
          ? { ResponseContentDisposition: params.responseContentDisposition }
          : {}),
        ...(params.responseContentType ? { ResponseContentType: params.responseContentType } : {}),
      }),
      { expiresIn: params.expiresInSec },
    );
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.#client.send(
        new DeleteObjectCommand({
          Bucket: this.#bucket,
          Key: key,
        }),
      );
    } catch (err) {
      if (isNotFoundError(err)) {
        return;
      }
      throw err;
    }
  }

  async listObjectsByPrefix(prefix: string): Promise<ListedStorageObject[]> {
    const out: ListedStorageObject[] = [];
    let continuationToken: string | undefined;

    while (true) {
      const res = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of res.Contents ?? []) {
        if (item.Key && item.Size !== undefined && item.LastModified) {
          out.push({
            key: item.Key,
            size: item.Size,
            lastModified: item.LastModified,
          });
        }
      }
      if (!res.IsTruncated || !res.NextContinuationToken) {
        break;
      }
      continuationToken = res.NextContinuationToken;
    }

    return out;
  }

  async close(): Promise<void> {
    this.#client.destroy();
  }
}
