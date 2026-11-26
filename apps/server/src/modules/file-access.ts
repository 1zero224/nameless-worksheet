import {
  detectPreviewKind,
  getSafePreviewContentType,
  type PreviewUrlResponse,
  sanitizeFilename,
  TEXT_PREVIEW_MAX_BYTES,
} from '@nw/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { type Db, schema } from '../db/index.js';
import { notFound } from '../errors.js';
import { buildContentDispositionAttachment, type StorageDriver } from '../storage/driver.js';
import { ensureArtifactParentActive } from './artifacts.js';
import { parseUuidParam } from './helpers.js';

async function loadActiveR2Location(db: Db, projectId: string, locationId: string) {
  const [row] = await db
    .select({
      loc: schema.resourceLocations,
      blob: schema.blobs,
      ver: schema.artifactVersions,
      art: schema.artifacts,
    })
    .from(schema.resourceLocations)
    .innerJoin(schema.blobs, eq(schema.resourceLocations.blobId, schema.blobs.id))
    .innerJoin(
      schema.artifactVersions,
      eq(schema.resourceLocations.versionId, schema.artifactVersions.id),
    )
    .innerJoin(schema.artifacts, eq(schema.resourceLocations.artifactId, schema.artifacts.id))
    .where(
      and(
        eq(schema.resourceLocations.projectId, projectId),
        eq(schema.resourceLocations.id, locationId),
        eq(schema.resourceLocations.type, 'r2'),
        isNull(schema.resourceLocations.deletedAt),
        eq(schema.blobs.projectId, projectId),
        eq(schema.artifactVersions.projectId, projectId),
        isNull(schema.artifactVersions.deletedAt),
        eq(schema.artifacts.projectId, projectId),
        isNull(schema.artifacts.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw notFound();
  await ensureArtifactParentActive(db, projectId, row.art);
  return row;
}

export function registerFileAccessRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: Config; storage: StorageDriver },
): void {
  const { db, config, storage } = deps;

  // GET /api/resource-locations/:id/download
  app.get<{ Params: { id: string } }>(
    '/api/resource-locations/:id/download',
    { config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = request.auth!;
      const locationId = parseUuidParam(request.params.id);
      const { blob, ver, art } = await loadActiveR2Location(db, auth.projectId, locationId);

      const filename = sanitizeFilename(ver.originalFilename ?? art.name);
      const disposition = buildContentDispositionAttachment(filename);
      const signedUrl = await storage.signGetObject({
        key: blob.r2Key,
        expiresInSec: config.r2DownloadSignTtlSec,
        responseContentDisposition: disposition,
      });

      return reply
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .redirect(signedUrl, 302);
    },
  );

  // GET /api/resource-locations/:id/preview-url
  app.get<{ Params: { id: string } }>(
    '/api/resource-locations/:id/preview-url',
    { config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = request.auth!;
      const locationId = parseUuidParam(request.params.id);
      const { blob, ver, art } = await loadActiveR2Location(db, auth.projectId, locationId);

      const filename = sanitizeFilename(ver.originalFilename ?? art.name);
      const sizeBytes = blob.sizeBytes;
      const mimeType = blob.mimeType;
      const previewKind = detectPreviewKind(filename, mimeType);
      const tooLargeForPreview = previewKind === 'text' && sizeBytes > TEXT_PREVIEW_MAX_BYTES;

      if (previewKind === 'unsupported' || tooLargeForPreview) {
        const res: PreviewUrlResponse = {
          previewKind,
          url: null,
          expiresAt: null,
          filename,
          sizeBytes,
          mimeType,
          tooLargeForPreview,
        };
        return reply.header('Cache-Control', 'no-store').send(res);
      }

      const safeContentType = getSafePreviewContentType(filename, previewKind, mimeType);
      const signedUrl = await storage.signGetObject({
        key: blob.r2Key,
        expiresInSec: config.r2DownloadSignTtlSec,
        responseContentType: safeContentType,
      });

      const res: PreviewUrlResponse = {
        previewKind,
        url: signedUrl,
        expiresAt: new Date(Date.now() + config.r2DownloadSignTtlSec * 1000).toISOString(),
        filename,
        sizeBytes,
        mimeType,
        tooLargeForPreview: false,
      };
      return reply.header('Cache-Control', 'no-store').send(res);
    },
  );
}
