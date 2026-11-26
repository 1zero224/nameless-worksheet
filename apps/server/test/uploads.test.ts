import { createHash, randomUUID } from 'node:crypto';
import type {
  ArtifactDetail,
  CompleteUploadResponse,
  PreviewUrlResponse,
  SearchResponse,
  UploadConfigResponse,
  UploadSessionDetail,
  UploadSessionInitResponse,
  WorksheetFullResponse,
} from '@nw/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { schema } from '../src/db/index.js';
import { cleanupExpiredUploads } from '../src/jobs/cleanup-uploads.js';
import { StorageNoSuchUploadError } from '../src/storage/driver.js';
import type { LocalStubStorageDriver } from '../src/storage/local-stub.js';
import { createTestEnv, createTwoProjects, TEST_ORIGIN, type TestEnv } from './helpers.js';

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('阶段 4：R2 直传、分片续传、并发冲突、授权下载、在线预览、检索与清理', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv({
      r2MultipartThresholdBytes: 128,
      r2PartSizeBytes: 64,
      uploadCleanupGraceHours: 2,
      uploadSessionTtlHours: 24,
    });
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('T2/T11 配置校验：生产环境缺少 R2 凭据或误设 local 时明确报缺失变量名', () => {
    try {
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        APP_ORIGIN: 'https://example.test',
      });
      expect.unreachable('should throw ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const vars = (err as ConfigError).variables;
      expect(vars).toContain('R2_ACCOUNT_ID');
      expect(vars).toContain('R2_ACCESS_KEY_ID');
      expect(vars).toContain('R2_SECRET_ACCESS_KEY');
      expect(vars).toContain('R2_BUCKET');
    }

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        APP_ORIGIN: 'https://example.test',
        STORAGE_DRIVER: 'local',
      }),
    ).toThrow(ConfigError);

    const validProd = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      APP_ORIGIN: 'https://example.test',
      R2_ACCOUNT_ID: 'acct123',
      R2_ACCESS_KEY_ID: 'key123',
      R2_SECRET_ACCESS_KEY: 'secret123',
      R2_BUCKET: 'my-bucket',
    });
    expect(validProd.storageDriver).toBe('r2');
    expect(validProd.r2Endpoint).toBe('https://acct123.r2.cloudflarestorage.com');
  });

  it('T2 数据库约束：同版本最多 1 条未删 R2 入口，且 type=r2 禁止填写 url/extract_code', async () => {
    const { projectA } = await createTwoProjects(env.app.ctx.db);
    const db = env.app.ctx.db;

    const createArt = await env.app.inject({
      method: 'POST',
      url: '/api/artifacts',
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: { scope: { kind: 'doc' }, name: '约束测试资源' },
    });
    expect(createArt.statusCode).toBe(201);
    const art = createArt.json<ArtifactDetail>();
    const verId = art.latestVersionId!;

    const [blob1] = await db
      .insert(schema.blobs)
      .values({
        projectId: projectA.id,
        r2Key: `projects/${projectA.id}/blobs/${randomUUID()}`,
        sizeBytes: 10,
        mimeType: 'text/plain',
        createdBy: projectA.admin.id,
      })
      .returning();
    const [blob2] = await db
      .insert(schema.blobs)
      .values({
        projectId: projectA.id,
        r2Key: `projects/${projectA.id}/blobs/${randomUUID()}`,
        sizeBytes: 20,
        mimeType: 'text/plain',
        createdBy: projectA.admin.id,
      })
      .returning();

    // type=r2 带 url 被 CHECK 拒绝
    await expect(
      db.insert(schema.resourceLocations).values({
        projectId: projectA.id,
        artifactId: art.id,
        versionId: verId,
        type: 'r2',
        blobId: blob1!.id,
        url: 'https://pan.baidu.com/s/should-fail',
        createdBy: projectA.admin.id,
      }),
    ).rejects.toThrow();

    // 正常插入 1 条 r2
    await db.insert(schema.resourceLocations).values({
      projectId: projectA.id,
      artifactId: art.id,
      versionId: verId,
      type: 'r2',
      blobId: blob1!.id,
      createdBy: projectA.admin.id,
    });

    // 同版本再插第 2 条未删 r2 被部分唯一索引拒绝
    await expect(
      db.insert(schema.resourceLocations).values({
        projectId: projectA.id,
        artifactId: art.id,
        versionId: verId,
        type: 'r2',
        blobId: blob2!.id,
        createdBy: projectA.admin.id,
      }),
    ).rejects.toThrow();
  });

  it('T4/T5 小文件单次 PUT、同名两版保留旧字节、四级摘要、中文名下载、Range 206 与预览白名单', async () => {
    const { projectA, projectB } = await createTwoProjects(env.app.ctx.db);

    // 1. 获取上传配置
    const cfgRes = await env.app.inject({
      method: 'GET',
      url: '/api/uploads/config',
      headers: { cookie: projectA.admin.cookie },
    });
    expect(cfgRes.statusCode).toBe(200);
    const cfg = cfgRes.json<UploadConfigResponse>();
    expect(cfg.multipartThresholdBytes).toBe(128);
    expect(cfg.partSizeBytes).toBe(64);

    // 建工作表、作品、任务与工序列
    const wsRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: { name: '番剧总表', template: 'standard_video' },
    });
    expect(wsRes.statusCode).toBe(201);
    const wsJson = wsRes.json() as { id?: string; worksheet?: { id: string } };
    const wsId = wsJson.worksheet?.id ?? wsJson.id!;

    const fullWs0 = await env.app.inject({
      method: 'GET',
      url: `/api/worksheets/${wsId}`,
      headers: { cookie: projectA.admin.cookie },
    });
    expect(fullWs0.statusCode).toBe(200);
    const stageColId = fullWs0.json<WorksheetFullResponse>().columns[0]!.id;

    const taskRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${wsId}/tasks`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: { title: '第01话', workName: '测试作品' },
    });
    expect(taskRes.statusCode).toBe(201);
    const taskJson = taskRes.json() as {
      task?: { id: string; workId: string };
      id?: string;
      workId?: string;
    };
    const taskId = taskJson.task?.id ?? taskJson.id!;
    const workId = taskJson.task?.workId ?? taskJson.workId!;

    // 2. 作品共用资源上传小文件（含中文、日文、空格）
    const v1Content = Buffer.from('[Script Info]\nTitle: 第01话 初稿\n', 'utf8');
    const filename = '【无名字幕组】第01话 テスト (初稿).ass';
    const initV1 = await env.app.inject({
      method: 'POST',
      url: '/api/uploads/sessions',
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {
        mode: 'create_artifact',
        scope: { kind: 'work', workId },
        name: '第01话字幕',
        filename,
        sizeBytes: v1Content.length,
        mimeType: 'text/plain',
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    expect(initV1.statusCode).toBe(201);
    const s1 = initV1.json<UploadSessionInitResponse>();
    expect(s1.isMultipart).toBe(false);
    expect(s1.singlePutUrl).toBeTruthy();

    // 未上传直接 complete 必须被拒绝（A11）
    const premature = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${s1.sessionId}/complete`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: { r2Key: 'fake/key', sizeBytes: 1 },
    });
    expect(premature.statusCode).toBe(400);

    // 真实 PUT 到 local stub
    const put1 = await fetch(s1.singlePutUrl!, {
      method: 'PUT',
      headers: { 'Content-Type': s1.mimeType },
      body: v1Content,
    });
    expect(put1.status).toBe(200);

    // complete 成功并幂等
    const comp1a = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${s1.sessionId}/complete`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {},
    });
    expect(comp1a.statusCode).toBe(200);
    const res1a = comp1a.json<CompleteUploadResponse>();
    expect(res1a.artifact.latestVersion?.versionNumber).toBe(1);
    expect(res1a.artifact.latestVersion?.originalFilename).toBe(filename);
    expect(res1a.artifact.latestVersion?.locations[0]?.type).toBe('r2');
    expect(res1a.artifact.latestVersion?.locations[0]?.previewKind).toBe('text');

    // 重复 complete 严格幂等
    const comp1b = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${s1.sessionId}/complete`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {},
    });
    expect(comp1b.statusCode).toBe(200);
    const res1b = comp1b.json<CompleteUploadResponse>();
    expect(res1b.versionId).toBe(res1a.versionId);
    expect(res1b.locationId).toBe(res1a.locationId);
    expect(res1b.blobId).toBe(res1a.blobId);

    // 3. 上传同名文件作为 v2，确认两个独立 blob 且旧版内容完整
    const v2Content = Buffer.from('[Script Info]\nTitle: 第01话 终稿更新\n', 'utf8');
    const initV2 = await env.app.inject({
      method: 'POST',
      url: '/api/uploads/sessions',
      headers: { cookie: projectA.user.cookie, origin: TEST_ORIGIN },
      payload: {
        mode: 'create_version',
        artifactId: res1a.artifact.id,
        versionNote: '校对终稿',
        filename,
        sizeBytes: v2Content.length,
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    expect(initV2.statusCode).toBe(201);
    const s2 = initV2.json<UploadSessionInitResponse>();
    expect((await fetch(s2.singlePutUrl!, { method: 'PUT', body: v2Content })).status).toBe(200);

    const comp2 = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${s2.sessionId}/complete`,
      headers: { cookie: projectA.user.cookie, origin: TEST_ORIGIN },
      payload: {},
    });
    expect(comp2.statusCode).toBe(200);
    const res2 = comp2.json<CompleteUploadResponse>();
    expect(res2.artifact.latestVersion?.versionNumber).toBe(2);
    expect(res2.blobId).not.toBe(res1a.blobId);

    // 4. 在工序格上传一个 .svg（验证 StageBadgeSummary.kind === 'r2' 与禁用 SVG 内联预览）
    const svgBytes = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const initSvg = await env.app.inject({
      method: 'POST',
      url: '/api/uploads/sessions',
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {
        mode: 'create_artifact',
        scope: { kind: 'stage', taskId, stageColumnId: stageColId },
        name: '图标矢量',
        filename: 'icon.svg',
        sizeBytes: svgBytes.length,
        mimeType: 'image/svg+xml',
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    const sSvg = initSvg.json<UploadSessionInitResponse>();
    expect((await fetch(sSvg.singlePutUrl!, { method: 'PUT', body: svgBytes })).status).toBe(200);
    const compSvg = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${sSvg.sessionId}/complete`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {},
    });
    const svgLocId = compSvg.json<CompleteUploadResponse>().locationId;

    // 核对工作表摘要：作品胶囊 hasR2File=true 且 directUrl=null；工序格角标 kind='r2'
    const fullWs1 = await env.app.inject({
      method: 'GET',
      url: `/api/worksheets/${wsId}`,
      headers: { cookie: projectA.admin.cookie },
    });
    const wsData = fullWs1.json<WorksheetFullResponse>();
    const capsule = wsData.artifactSummary.workCapsules[workId]?.[0];
    expect(capsule?.hasR2File).toBe(true);
    expect(capsule?.directUrl).toBeNull();
    const badge = wsData.artifactSummary.stageBadges[`${taskId}:${stageColId}`];
    expect(badge?.kind).toBe('r2');

    // 5. 授权下载（302 + 中文名 RFC 5987 + Range 206 + 旧版 v1 可下载）
    const dlV1 = await env.app.inject({
      method: 'GET',
      url: `/api/resource-locations/${res1a.locationId}/download`,
      headers: { cookie: projectA.user.cookie },
    });
    expect(dlV1.statusCode).toBe(302);
    expect(dlV1.headers['cache-control']).toBe('no-store');
    expect(dlV1.headers['referrer-policy']).toBe('no-referrer');
    const dlUrlV1 = String(dlV1.headers.location);

    const fetchedV1 = await fetch(dlUrlV1);
    expect(fetchedV1.status).toBe(200);
    expect(fetchedV1.headers.get('content-disposition')).toContain('attachment;');
    expect(fetchedV1.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(Buffer.from(await fetchedV1.arrayBuffer()).equals(v1Content)).toBe(true);

    const rangeV1 = await fetch(dlUrlV1, { headers: { Range: 'bytes=0-12' } });
    expect(rangeV1.status).toBe(206);
    expect(await rangeV1.text()).toBe('[Script Info]');

    // 下载 v2 内容与 v1 不同
    const dlV2 = await env.app.inject({
      method: 'GET',
      url: `/api/resource-locations/${res2.locationId}/download`,
      headers: { cookie: projectA.user.cookie },
    });
    const fetchedV2 = await fetch(String(dlV2.headers.location));
    expect(Buffer.from(await fetchedV2.arrayBuffer()).equals(v2Content)).toBe(true);

    // 6. 预览白名单校验（文本可预览、SVG 拒绝内联）
    const prevAss = await env.app.inject({
      method: 'GET',
      url: `/api/resource-locations/${res2.locationId}/preview-url`,
      headers: { cookie: projectA.user.cookie },
    });
    expect(prevAss.statusCode).toBe(200);
    const prevAssBody = prevAss.json<PreviewUrlResponse>();
    expect(prevAssBody.previewKind).toBe('text');
    expect(prevAssBody.url).toBeTruthy();
    expect(prevAssBody.tooLargeForPreview).toBe(false);

    const prevSvg = await env.app.inject({
      method: 'GET',
      url: `/api/resource-locations/${svgLocId}/preview-url`,
      headers: { cookie: projectA.user.cookie },
    });
    expect(prevSvg.statusCode).toBe(200);
    const prevSvgBody = prevSvg.json<PreviewUrlResponse>();
    expect(prevSvgBody.previewKind).toBe('unsupported');
    expect(prevSvgBody.url).toBeNull();

    // 7. 融合检索匹配未删版本原文件名，且不泄漏 r2Key / 签名
    const searchRes = await env.app.inject({
      method: 'GET',
      url: `/api/search?q=${encodeURIComponent('テスト')}`,
      headers: { cookie: projectA.user.cookie },
    });
    expect(searchRes.statusCode).toBe(200);
    const searchJson = searchRes.json<SearchResponse>();
    expect(searchJson.items.some((i) => i.taskId === taskId)).toBe(true);
    const rawSearch = JSON.stringify(searchJson);
    expect(rawSearch).not.toContain('projects/');
    expect(rawSearch).not.toContain('sig=');

    // 8. 跨项目隔离（Project B 访问所有下载/预览/会话接口一律 404）
    for (const [method, url] of [
      ['GET', `/api/resource-locations/${res1a.locationId}/download`],
      ['GET', `/api/resource-locations/${res1a.locationId}/preview-url`],
      ['GET', `/api/uploads/sessions/${s1.sessionId}`],
      ['GET', `/api/uploads/sessions/${s1.sessionId}/parts`],
      ['POST', `/api/uploads/sessions/${s1.sessionId}/parts/1/sign`],
      ['POST', `/api/uploads/sessions/${s1.sessionId}/complete`],
      ['POST', `/api/uploads/sessions/${s1.sessionId}/promote-to-version`],
      ['POST', `/api/uploads/sessions/${s1.sessionId}/abort`],
    ] as const) {
      const cross = await env.app.inject({
        method,
        url,
        headers: {
          cookie: projectB.admin.cookie,
          ...(method === 'POST' ? { origin: TEST_ORIGIN } : {}),
        },
        payload: method === 'POST' ? { contentLength: 64 } : undefined,
      });
      expect(cross.statusCode, `cross-project ${method} ${url}`).toBe(404);
    }

    // 非会话创建者（同项目另一用户）访问会话亦返 404
    const otherUserSess = await env.app.inject({
      method: 'GET',
      url: `/api/uploads/sessions/${s1.sessionId}`,
      headers: { cookie: projectA.user.cookie },
    });
    expect(otherUserSess.statusCode).toBe(404);
  });

  it('T4 分片上传、指纹续传复用、同大小不同内容绝不误恢复、取消 Abort 无残留分片', async () => {
    const { projectA } = await createTwoProjects(env.app.ctx.db);

    // 160 bytes (> 128 阈值, 64/片 -> 3 片: 64, 64, 32)
    const fileA = Buffer.concat([
      Buffer.alloc(64, 0x61),
      Buffer.alloc(64, 0x62),
      Buffer.alloc(32, 0x63),
    ]);
    const fileB = Buffer.concat([
      Buffer.alloc(64, 0x78),
      Buffer.alloc(64, 0x79),
      Buffer.alloc(32, 0x7a),
    ]);
    const fpA = sha256Hex(fileA);
    const fpB = sha256Hex(fileB);

    const init1 = await env.app.inject({
      method: 'POST',
      url: '/api/uploads/sessions',
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {
        mode: 'create_artifact',
        scope: { kind: 'doc' },
        name: '分片视频样本',
        filename: 'sample.mp4',
        sizeBytes: fileA.length,
        fingerprintSha256: fpA,
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    expect(init1.statusCode).toBe(201);
    const sess1 = init1.json<UploadSessionInitResponse>();
    expect(sess1.isMultipart).toBe(true);
    expect(sess1.partSizeBytes).toBe(64);
    expect(sess1.resumed).toBe(false);

    // 上传第 1 片
    const sign1 = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${sess1.sessionId}/parts/1/sign`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: { contentLength: 64 },
    });
    expect(sign1.statusCode).toBe(200);
    expect(
      (await fetch(sign1.json().url, { method: 'PUT', body: fileA.subarray(0, 64) })).status,
    ).toBe(200);

    // 缺片时 complete 必须拒绝
    const incomplete = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${sess1.sessionId}/complete`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {},
    });
    expect(incomplete.statusCode).toBe(400);

    // 大小相同、指纹不同的文件绝不误恢复
    const initDiff = await env.app.inject({
      method: 'POST',
      url: '/api/uploads/sessions',
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {
        mode: 'create_artifact',
        scope: { kind: 'doc' },
        name: '分片视频样本',
        filename: 'sample.mp4',
        sizeBytes: fileB.length,
        fingerprintSha256: fpB,
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    expect(initDiff.statusCode).toBe(201);
    const sessDiff = initDiff.json<UploadSessionInitResponse>();
    expect(sessDiff.resumed).toBe(false);
    expect(sessDiff.sessionId).not.toBe(sess1.sessionId);

    // 取消 sessDiff，校验 R2 侧已 Abort 无残留分片
    const [diffRow] = await env.app.ctx.db
      .select()
      .from(schema.uploadSessions)
      .where(eq(schema.uploadSessions.id, sessDiff.sessionId));
    const abortRes = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${sessDiff.sessionId}/abort`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {},
    });
    expect(abortRes.statusCode).toBe(200);
    await expect(
      env.app.ctx.storage.listParts({
        key: diffRow!.r2Key,
        uploadId: diffRow!.r2UploadId!,
      }),
    ).rejects.toThrow(StorageNoSuchUploadError);

    // 同一文件（同指纹）再次发起会话 -> 自动续传复用 sess1 并返回已完成分片 1
    const initResume = await env.app.inject({
      method: 'POST',
      url: '/api/uploads/sessions',
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {
        mode: 'create_artifact',
        scope: { kind: 'doc' },
        name: '分片视频样本',
        filename: 'sample.mp4',
        sizeBytes: fileA.length,
        fingerprintSha256: fpA,
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    expect(initResume.statusCode).toBe(200);
    const resumed = initResume.json<UploadSessionInitResponse>();
    expect(resumed.resumed).toBe(true);
    expect(resumed.sessionId).toBe(sess1.sessionId);
    expect(resumed.uploadedParts).toHaveLength(1);
    expect(resumed.uploadedParts?.[0]?.partNumber).toBe(1);

    // GET /sessions/:id 详情同样含 uploadedParts
    const detailRes = await env.app.inject({
      method: 'GET',
      url: `/api/uploads/sessions/${sess1.sessionId}`,
      headers: { cookie: projectA.admin.cookie },
    });
    expect(detailRes.json<UploadSessionDetail>().uploadedParts).toHaveLength(1);

    // 补传第 2 片和第 3 片并完成
    const sign2 = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${sess1.sessionId}/parts/2/sign`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: { contentLength: 64 },
    });
    const sign3 = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${sess1.sessionId}/parts/3/sign`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: { contentLength: 32 },
    });
    expect(
      (await fetch(sign2.json().url, { method: 'PUT', body: fileA.subarray(64, 128) })).status,
    ).toBe(200);
    expect(
      (await fetch(sign3.json().url, { method: 'PUT', body: fileA.subarray(128, 160) })).status,
    ).toBe(200);

    const comp = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${sess1.sessionId}/complete`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {},
    });
    expect(comp.statusCode).toBe(200);
    const compData = comp.json<CompleteUploadResponse>();

    // 下载核验合并后的完整字节
    const dl = await env.app.inject({
      method: 'GET',
      url: `/api/resource-locations/${compData.locationId}/download`,
      headers: { cookie: projectA.admin.cookie },
    });
    const downloaded = Buffer.from(await (await fetch(String(dl.headers.location))).arrayBuffer());
    expect(downloaded.equals(fileA)).toBe(true);
  });

  it('T4 并发上传新版本严格递增，并发补传冲突返 409 后一键 promote-to-version 零重传生成 v2', async () => {
    const { projectA } = await createTwoProjects(env.app.ctx.db);

    // 先建一个仅有网盘链接的 v1 资源
    const createArt = await env.app.inject({
      method: 'POST',
      url: '/api/artifacts',
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {
        scope: { kind: 'doc' },
        name: '并发补传资源',
        location: { url: 'https://pan.baidu.com/s/1concurrentTest', extractCode: 'ab12' },
      },
    });
    const art = createArt.json<ArtifactDetail>();
    const v1Id = art.latestVersionId!;

    // 两人同时向 v1 发起 attach_version 会话并完成 PUT
    const bufA = Buffer.from('file-from-admin-v1');
    const bufB = Buffer.from('file-from-user-conflict');

    const [initA, initB] = await Promise.all([
      env.app.inject({
        method: 'POST',
        url: '/api/uploads/sessions',
        headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
        payload: {
          mode: 'attach_version',
          versionId: v1Id,
          filename: 'admin.srt',
          sizeBytes: bufA.length,
          idempotencyKey: `idem-${randomUUID()}`,
        },
      }),
      env.app.inject({
        method: 'POST',
        url: '/api/uploads/sessions',
        headers: { cookie: projectA.user.cookie, origin: TEST_ORIGIN },
        payload: {
          mode: 'attach_version',
          versionId: v1Id,
          filename: 'user.srt',
          sizeBytes: bufB.length,
          idempotencyKey: `idem-${randomUUID()}`,
        },
      }),
    ]);
    expect(initA.statusCode).toBe(201);
    expect(initB.statusCode).toBe(201);

    const sA = initA.json<UploadSessionInitResponse>();
    const sB = initB.json<UploadSessionInitResponse>();
    expect((await fetch(sA.singlePutUrl!, { method: 'PUT', body: bufA })).status).toBe(200);
    expect((await fetch(sB.singlePutUrl!, { method: 'PUT', body: bufB })).status).toBe(200);

    // A 先完成 -> 成功挂载到 v1（不升版本），与网盘链接共存
    const compA = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${sA.sessionId}/complete`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {},
    });
    expect(compA.statusCode).toBe(200);
    const resA = compA.json<CompleteUploadResponse>();
    expect(resA.versionId).toBe(v1Id);
    expect(resA.artifact.latestVersion?.versionNumber).toBe(1);
    expect(resA.artifact.latestVersion?.locations).toHaveLength(2); // 1 cloud_link + 1 r2

    // B 后完成 -> 收到 409 VERSION_ALREADY_HAS_FILE
    const compB = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${sB.sessionId}/complete`,
      headers: { cookie: projectA.user.cookie, origin: TEST_ORIGIN },
      payload: {},
    });
    expect(compB.statusCode).toBe(409);
    expect(compB.json().error.code).toBe('VERSION_ALREADY_HAS_FILE');

    // B 一键 promote-to-version -> 201 零重传创建 v2
    const promoB = await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${sB.sessionId}/promote-to-version`,
      headers: { cookie: projectA.user.cookie, origin: TEST_ORIGIN },
      payload: { note: '并发冲突自动转存' },
    });
    expect(promoB.statusCode).toBe(201);
    const resB = promoB.json<CompleteUploadResponse>();
    expect(resB.artifact.latestVersion?.versionNumber).toBe(2);

    // 验证转存后的 v2 字节完整可读
    const dlB = await env.app.inject({
      method: 'GET',
      url: `/api/resource-locations/${resB.locationId}/download`,
      headers: { cookie: projectA.user.cookie },
    });
    expect(
      Buffer.from(await (await fetch(String(dlB.headers.location))).arrayBuffer()).equals(bufB),
    ).toBe(true);

    // 并发 create_version 严格生成 v3 与 v4
    const [iv3, iv4] = await Promise.all([
      env.app.inject({
        method: 'POST',
        url: '/api/uploads/sessions',
        headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
        payload: {
          mode: 'create_version',
          artifactId: art.id,
          filename: 'c1.txt',
          sizeBytes: 5,
          idempotencyKey: `idem-${randomUUID()}`,
        },
      }),
      env.app.inject({
        method: 'POST',
        url: '/api/uploads/sessions',
        headers: { cookie: projectA.user.cookie, origin: TEST_ORIGIN },
        payload: {
          mode: 'create_version',
          artifactId: art.id,
          filename: 'c2.txt',
          sizeBytes: 5,
          idempotencyKey: `idem-${randomUUID()}`,
        },
      }),
    ]);
    const sv3 = iv3.json<UploadSessionInitResponse>();
    const sv4 = iv4.json<UploadSessionInitResponse>();
    await Promise.all([
      fetch(sv3.singlePutUrl!, { method: 'PUT', body: Buffer.from('11111') }),
      fetch(sv4.singlePutUrl!, { method: 'PUT', body: Buffer.from('22222') }),
    ]);
    const [cv3, cv4] = await Promise.all([
      env.app.inject({
        method: 'POST',
        url: `/api/uploads/sessions/${sv3.sessionId}/complete`,
        headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
        payload: {},
      }),
      env.app.inject({
        method: 'POST',
        url: `/api/uploads/sessions/${sv4.sessionId}/complete`,
        headers: { cookie: projectA.user.cookie, origin: TEST_ORIGIN },
        payload: {},
      }),
    ]);
    expect(cv3.statusCode).toBe(200);
    expect(cv4.statusCode).toBe(200);
    const nums = [
      cv3
        .json<CompleteUploadResponse>()
        .artifact.versions.find((v) => v.id === cv3.json<CompleteUploadResponse>().versionId)
        ?.versionNumber,
      cv4
        .json<CompleteUploadResponse>()
        .artifact.versions.find((v) => v.id === cv4.json<CompleteUploadResponse>().versionId)
        ?.versionNumber,
    ].sort();
    expect(nums).toEqual([3, 4]);
  });

  it('T5 软删 R2 入口与恢复冲突保护 + cleanupExpiredUploads 仅删过期分片与孤儿对象、绝不删软删版本 blobs', async () => {
    const { projectA } = await createTwoProjects(env.app.ctx.db);
    const db = env.app.ctx.db;
    const stub = env.app.ctx.storage as LocalStubStorageDriver;

    // 1. 上传一个正常文件并软删其 R2 入口
    const content = Buffer.from('keep-my-soft-deleted-bytes');
    const init = await env.app.inject({
      method: 'POST',
      url: '/api/uploads/sessions',
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {
        mode: 'create_artifact',
        scope: { kind: 'doc' },
        name: '软删恢复测试',
        filename: 'keep.txt',
        sizeBytes: content.length,
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    const s = init.json<UploadSessionInitResponse>();
    await fetch(s.singlePutUrl!, { method: 'PUT', body: content });
    const comp = (
      await env.app.inject({
        method: 'POST',
        url: `/api/uploads/sessions/${s.sessionId}/complete`,
        headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
        payload: {},
      })
    ).json<CompleteUploadResponse>();

    const [blobRow] = await db.select().from(schema.blobs).where(eq(schema.blobs.id, comp.blobId));
    expect(blobRow).toBeTruthy();

    // 软删 R2 入口 -> 下载返 404，但存储字节仍在
    const delRes = await env.app.inject({
      method: 'DELETE',
      url: `/api/resource-locations/${comp.locationId}`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
    });
    expect(delRes.statusCode).toBe(204);

    const dlDeleted = await env.app.inject({
      method: 'GET',
      url: `/api/resource-locations/${comp.locationId}/download`,
      headers: { cookie: projectA.admin.cookie },
    });
    expect(dlDeleted.statusCode).toBe(404);
    expect(await stub.headObject(blobRow!.r2Key)).not.toBeNull();

    // 将其 lastModified 伪造为 10 天前，并创建一个真正的孤立对象和一个过期的分片会话
    const oldDate = new Date(Date.now() - 10 * 24 * 3600_000);
    stub.setObjectLastModifiedForTest(blobRow!.r2Key, oldDate);

    const orphanKey = `projects/${projectA.id}/blobs/orphan-${randomUUID()}`;
    const orphanPut = await stub.signPutObject({
      key: orphanKey,
      contentType: 'application/octet-stream',
      contentLength: 4,
      expiresInSec: 60,
    });
    await fetch(orphanPut, { method: 'PUT', body: Buffer.from('junk') });
    stub.setObjectLastModifiedForTest(orphanKey, oldDate);

    // 过期超过宽限期的分片会话
    const expInit = await env.app.inject({
      method: 'POST',
      url: '/api/uploads/sessions',
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {
        mode: 'create_artifact',
        scope: { kind: 'doc' },
        name: '过期分片',
        filename: 'expired.bin',
        sizeBytes: 200,
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    const expSess = expInit.json<UploadSessionInitResponse>();
    await db
      .update(schema.uploadSessions)
      .set({ expiresAt: new Date(Date.now() - 5 * 3600_000) })
      .where(eq(schema.uploadSessions.id, expSess.sessionId));
    const [expRow] = await db
      .select()
      .from(schema.uploadSessions)
      .where(eq(schema.uploadSessions.id, expSess.sessionId));

    // 执行后台清理作业
    const report = await cleanupExpiredUploads(db, stub, env.config);
    expect(report.markedExpired).toBeGreaterThanOrEqual(1);
    expect(report.cleanedSessions).toBeGreaterThanOrEqual(1);
    expect(report.deletedOrphans).toBeGreaterThanOrEqual(1);

    // 孤立对象已删，过期分片已 Abort
    expect(await stub.headObject(orphanKey)).toBeNull();
    await expect(
      stub.listParts({ key: expRow!.r2Key, uploadId: expRow!.r2UploadId! }),
    ).rejects.toThrow(StorageNoSuchUploadError);

    // 软删版本的 blob 字节完好无损，恢复后可正常下载！
    expect(await stub.headObject(blobRow!.r2Key)).not.toBeNull();
    const restoreRes = await env.app.inject({
      method: 'POST',
      url: `/api/resource-locations/${comp.locationId}/restore`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {},
    });
    expect(restoreRes.statusCode).toBe(200);

    const dlRestored = await env.app.inject({
      method: 'GET',
      url: `/api/resource-locations/${comp.locationId}/download`,
      headers: { cookie: projectA.admin.cookie },
    });
    expect(dlRestored.statusCode).toBe(302);
    expect(
      Buffer.from(await (await fetch(String(dlRestored.headers.location))).arrayBuffer()).equals(
        content,
      ),
    ).toBe(true);

    // 再次软删 -> 原地补传一份新文件 -> 再尝试恢复旧 R2 入口必须返 409 CONFLICT
    await env.app.inject({
      method: 'DELETE',
      url: `/api/resource-locations/${comp.locationId}`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
    });
    const reInit = await env.app.inject({
      method: 'POST',
      url: '/api/uploads/sessions',
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {
        mode: 'attach_version',
        versionId: comp.versionId,
        filename: 'replacement.txt',
        sizeBytes: 3,
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    const reSess = reInit.json<UploadSessionInitResponse>();
    await fetch(reSess.singlePutUrl!, { method: 'PUT', body: Buffer.from('new') });
    await env.app.inject({
      method: 'POST',
      url: `/api/uploads/sessions/${reSess.sessionId}/complete`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {},
    });

    const conflictRestore = await env.app.inject({
      method: 'POST',
      url: `/api/resource-locations/${comp.locationId}/restore`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
      payload: {},
    });
    expect(conflictRestore.statusCode).toBe(409);

    // 核对修改记录绝不含 r2Key 或签名 URL
    const logsRes = await env.app.inject({
      method: 'GET',
      url: '/api/docs/change-logs',
      headers: { cookie: projectA.admin.cookie },
    });
    const logsText = logsRes.body;
    expect(logsText).not.toContain('projects/');
    expect(logsText).not.toContain('sig=');
  });
});
