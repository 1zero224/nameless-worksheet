import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ArtifactDetail,
  ArtifactVersionDetail,
  BoardResponse,
  ChangeLogsResponse,
  RealtimeEventMessage,
  ResourceLocation,
  SearchResponse,
  TaskArtifactsResponse,
  WorkArtifactsResponse,
  WorksheetFullResponse,
} from '@nw/shared';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, schema } from '../src/db/index.js';
import {
  connectWs,
  createIsolatedDatabase,
  createTestEnv,
  createTwoProjects,
  TEST_ORIGIN,
  type TestEnv,
} from './helpers.js';

function authHeaders(cookie: string, extra: Record<string, string> = {}) {
  return {
    cookie,
    origin: TEST_ORIGIN,
    'content-type': 'application/json',
    ...extra,
  };
}

describe('阶段 3：四级资源、版本历史、网盘入口、生命周期、实时与安全', () => {
  let env: TestEnv;
  let port = 0;

  beforeAll(async () => {
    env = await createTestEnv();
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = env.app.server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('T2: 0002 迁移可在阶段 2 旧库上平滑执行且重复执行幂等，CHECK 约束拒绝非法归属组合', async () => {
    const isolated = await createIsolatedDatabase();
    try {
      const client = new pg.Client({ connectionString: isolated.databaseUrl });
      await client.connect();
      try {
        await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE;');
        for (const file of [
          '0000_init.sql',
          '0001_phase2_worksheets.sql',
          '0002_phase3_artifacts.sql',
        ]) {
          const sqlText = readFileSync(
            path.resolve(process.cwd(), 'apps/server/drizzle', file),
            'utf8',
          );
          for (const stmt of sqlText.split('--> statement-breakpoint')) {
            if (stmt.trim()) await client.query(stmt);
          }
        }
        const { rows: projRows } = await client.query<{ id: string }>(
          `INSERT INTO "projects" ("name") VALUES ('迁移测试项目') RETURNING id`,
        );
        const { rows: userRows } = await client.query<{ id: string }>(
          `INSERT INTO "users" ("login_name", "display_name") VALUES ('m_u1', '迁移测试人') RETURNING id`,
        );
        const projectId = projRows[0]!.id;
        const userId = userRows[0]!.id;
        const { rows: wsRows } = await client.query<{ id: string }>(
          `INSERT INTO "worksheets" ("project_id", "name", "sort_order") VALUES ($1, '测试表', 'a0') RETURNING id`,
          [projectId],
        );
        const wsId = wsRows[0]!.id;
        const { rows: workRows } = await client.query<{ id: string }>(
          `INSERT INTO "works" ("project_id", "worksheet_id", "name") VALUES ($1, $2, '测试作品') RETURNING id`,
          [projectId, wsId],
        );
        const workId = workRows[0]!.id;
        const { rows: taskRows } = await client.query<{ id: string }>(
          `INSERT INTO "tasks" ("project_id", "worksheet_id", "title", "sort_order") VALUES ($1, $2, '测试任务', 'a0') RETURNING id`,
          [projectId, wsId],
        );
        const taskId = taskRows[0]!.id;

        // 非法归属：work_id 和 task_id 同时非空 -> 被 CHECK 约束拒绝
        await expect(
          client.query(
            `INSERT INTO "artifacts" ("project_id", "worksheet_id", "work_id", "task_id", "name", "created_by")
             VALUES ($1, $2, $3, $4, '非法组合', $5)`,
            [projectId, wsId, workId, taskId, userId],
          ),
        ).rejects.toThrow(/artifacts_scope_check/);

        // 非法归属：worksheet_id 为空但 work_id 非空 -> 被 CHECK 约束拒绝
        await expect(
          client.query(
            `INSERT INTO "artifacts" ("project_id", "worksheet_id", "work_id", "name", "created_by")
             VALUES ($1, NULL, $2, '非法组合2', $3)`,
            [projectId, workId, userId],
          ),
        ).rejects.toThrow(/artifacts_scope_check/);
      } finally {
        await client.end();
      }

      // 再次在完整库上运行 runMigrations 幂等
      await expect(runMigrations(env.databaseUrl)).resolves.toBeUndefined();
    } finally {
      await isolated.drop();
    }
  });

  it('T3: 四级资源创建、同版本多入口不升版本、0 入口、并发新版本递增、删除回退与恢复、改名与跨级移动', async () => {
    const { projectA } = await createTwoProjects(env.app.ctx.db);
    const cookie = projectA.user.cookie;

    // 建工作表、作品、任务
    const wsRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: authHeaders(cookie),
      payload: { name: '资源测试表', template: 'standard_video' },
    });
    expect(wsRes.statusCode).toBe(201);
    const { worksheet, columns } = wsRes.json() as {
      worksheet: { id: string };
      columns: Array<{ id: string; name: string; type: string }>;
    };
    const stageCol = columns.find((c) => c.type === 'stage')!;

    const workRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${worksheet.id}/works`,
      headers: authHeaders(cookie),
      payload: { name: '5th-BD' },
    });
    expect(workRes.statusCode).toBe(201);
    const work = workRes.json() as { id: string; name: string };

    const taskRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${worksheet.id}/tasks`,
      headers: authHeaders(cookie),
      payload: { title: 'Disc 1 正片', workId: work.id },
    });
    expect(taskRes.statusCode).toBe(201);
    const task = taskRes.json() as { id: string };

    // 1) 通用文档（带百度链接，不传 provider 自动识别）
    const docRes = await env.app.inject({
      method: 'POST',
      url: '/api/artifacts',
      headers: authHeaders(cookie),
      payload: {
        scope: { kind: 'doc' },
        name: '通用术语对照表',
        versionNote: '2026 初版',
        location: {
          url: 'https://pan.baidu.com/s/1docSecretUrl99',
          extractCode: 'd0c1',
          isFolder: false,
          expiresAt: '2027-12-31',
        },
      },
    });
    expect(docRes.statusCode).toBe(201);
    const docArt = docRes.json() as ArtifactDetail;
    expect(docArt.scopeKind).toBe('doc');
    expect(docArt.latestVersion?.versionNumber).toBe(1);
    expect(docArt.latestVersion?.locations).toHaveLength(1);
    expect(docArt.latestVersion?.locations[0]?.provider).toBe('baidu');
    expect(docArt.latestVersion?.locations[0]?.extractCode).toBe('d0c1');

    // 2) 作品共用资源（无提取码单入口 -> directUrl 应非空）
    const workArtRes = await env.app.inject({
      method: 'POST',
      url: '/api/artifacts',
      headers: authHeaders(cookie),
      payload: {
        scope: { kind: 'work', workId: work.id },
        name: '全篇原片',
        location: {
          url: 'https://mega.nz/file/workRaw01',
          isFolder: false,
        },
      },
    });
    expect(workArtRes.statusCode).toBe(201);
    const workArt = workArtRes.json() as ArtifactDetail;
    expect(workArt.scopeKind).toBe('work');
    expect(workArt.worksheetId).toBe(worksheet.id);

    // 3) 任务级资源（0 入口待补充）
    const taskArtRes = await env.app.inject({
      method: 'POST',
      url: '/api/artifacts',
      headers: authHeaders(cookie),
      payload: {
        scope: { kind: 'task', taskId: task.id },
        name: '待补特效素材',
      },
    });
    expect(taskArtRes.statusCode).toBe(201);
    const taskArt = taskArtRes.json() as ArtifactDetail;
    expect(taskArt.latestVersion?.locations).toEqual([]);

    // 4) 工序格资源
    const stageArtRes = await env.app.inject({
      method: 'POST',
      url: '/api/artifacts',
      headers: authHeaders(cookie),
      payload: {
        scope: { kind: 'stage', taskId: task.id, stageColumnId: stageCol.id },
        name: stageCol.name,
        location: {
          url: 'https://pan.quark.cn/s/stageFile1',
          extractCode: 'qk11',
          isFolder: false,
        },
      },
    });
    expect(stageArtRes.statusCode).toBe(201);
    const stageArt = stageArtRes.json() as ArtifactDetail;
    expect(stageArt.scopeKind).toBe('stage');

    // 校验非 http/https 链接被拒绝
    const badUrlRes = await env.app.inject({
      method: 'POST',
      url: '/api/artifacts',
      headers: authHeaders(cookie),
      payload: {
        scope: { kind: 'doc' },
        name: '恶意链接',
        location: { url: 'javascript:alert(1)', isFolder: false },
      },
    });
    expect(badUrlRes.statusCode).toBe(400);

    // 同版本补充第二个网盘入口（不升版本号）
    const loc2Res = await env.app.inject({
      method: 'POST',
      url: `/api/artifact-versions/${stageArt.latestVersion!.id}/locations`,
      headers: authHeaders(cookie),
      payload: {
        url: 'https://www.alipan.com/s/mirror2',
        extractCode: 'al22',
        isFolder: true,
        note: '阿里镜像',
      },
    });
    expect(loc2Res.statusCode).toBe(201);
    const loc2 = loc2Res.json() as ResourceLocation;
    expect(loc2.provider).toBe('aliyun');

    // 编辑入口 & 删除后恢复
    const patchLocRes = await env.app.inject({
      method: 'PATCH',
      url: `/api/resource-locations/${loc2.id}`,
      headers: authHeaders(cookie),
      payload: { note: '阿里镜像(更新)' },
    });
    expect(patchLocRes.statusCode).toBe(200);
    expect((patchLocRes.json() as ResourceLocation).note).toBe('阿里镜像(更新)');

    const delLocRes = await env.app.inject({
      method: 'DELETE',
      url: `/api/resource-locations/${loc2.id}`,
      headers: authHeaders(cookie),
    });
    expect(delLocRes.statusCode).toBe(204);

    // 删掉一个入口不影响另一个入口
    const taskArtsAfterDelLoc = (
      await env.app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/artifacts`,
        headers: { cookie },
      })
    ).json() as TaskArtifactsResponse;
    expect(taskArtsAfterDelLoc.stageArtifacts[stageCol.id]?.[0]?.latestVersion?.versionNumber).toBe(
      1,
    );
    expect(
      taskArtsAfterDelLoc.stageArtifacts[stageCol.id]?.[0]?.latestVersion?.locations,
    ).toHaveLength(1);

    const restoreLocRes = await env.app.inject({
      method: 'POST',
      url: `/api/resource-locations/${loc2.id}/restore`,
      headers: authHeaders(cookie),
    });
    expect(restoreLocRes.statusCode).toBe(200);

    // 校验工作表摘要与看板资源数
    const fullWs = (
      await env.app.inject({
        method: 'GET',
        url: `/api/worksheets/${worksheet.id}`,
        headers: { cookie },
      })
    ).json() as WorksheetFullResponse;
    expect(fullWs.artifactSummary.workCapsules[work.id]?.[0]?.directUrl).toBe(
      'https://mega.nz/file/workRaw01',
    );
    expect(fullWs.artifactSummary.stageBadges[`${task.id}:${stageCol.id}`]?.label).toBe('v1');
    expect(fullWs.artifactSummary.taskCounts[task.id]).toBe(2);

    const boardRes = (
      await env.app.inject({ method: 'GET', url: '/api/board', headers: { cookie } })
    ).json() as BoardResponse;
    const card = boardRes.cards.find((c) => c.taskId === task.id);
    expect(card?.resourceCount).toBe(3); // 1 work shared + 1 task + 1 stage

    // 并发登记 4 个新版本 -> 严格得到 v2, v3, v4, v5，互不覆盖
    const concurrentVers = await Promise.all(
      [1, 2, 3, 4].map((idx) =>
        env.app.inject({
          method: 'POST',
          url: `/api/artifacts/${stageArt.id}/versions`,
          headers: authHeaders(cookie),
          payload: { note: `并发修订 ${idx}` },
        }),
      ),
    );
    for (const r of concurrentVers) expect(r.statusCode).toBe(201);
    const createdNums = concurrentVers
      .map((r) => (r.json() as ArtifactVersionDetail).versionNumber)
      .sort((a, b) => a - b);
    expect(createdNums).toEqual([2, 3, 4, 5]);

    const v5 = concurrentVers
      .map((r) => r.json() as ArtifactVersionDetail)
      .find((v) => v.versionNumber === 5)!;
    const v2 = concurrentVers
      .map((r) => r.json() as ArtifactVersionDetail)
      .find((v) => v.versionNumber === 2)!;

    // 删除最新版 v5 -> 自动回退 latestVersionId 至 v4
    const delV5Res = await env.app.inject({
      method: 'DELETE',
      url: `/api/artifact-versions/${v5.id}`,
      headers: authHeaders(cookie),
    });
    expect(delV5Res.statusCode).toBe(200);
    const afterDelV5 = (
      await env.app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/artifacts`,
        headers: { cookie },
      })
    ).json() as TaskArtifactsResponse;
    expect(afterDelV5.stageArtifacts[stageCol.id]?.[0]?.latestVersion?.versionNumber).toBe(4);

    // 删除旧版 v2 再恢复 v2 -> 不覆盖当前最新 v4
    await env.app.inject({
      method: 'DELETE',
      url: `/api/artifact-versions/${v2.id}`,
      headers: authHeaders(cookie),
    });
    await env.app.inject({
      method: 'POST',
      url: `/api/artifact-versions/${v2.id}/restore`,
      headers: authHeaders(cookie),
    });
    const afterRestoreV2 = (
      await env.app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/artifacts`,
        headers: { cookie },
      })
    ).json() as TaskArtifactsResponse;
    expect(afterRestoreV2.stageArtifacts[stageCol.id]?.[0]?.latestVersion?.versionNumber).toBe(4);

    // 恢复 v5 -> 重新成为最新版 v5
    await env.app.inject({
      method: 'POST',
      url: `/api/artifact-versions/${v5.id}/restore`,
      headers: authHeaders(cookie),
    });
    const afterRestoreV5 = (
      await env.app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/artifacts`,
        headers: { cookie },
      })
    ).json() as TaskArtifactsResponse;
    expect(afterRestoreV5.stageArtifacts[stageCol.id]?.[0]?.latestVersion?.versionNumber).toBe(5);

    // 改名与跨挂载点移动（任务级 -> 作品共用 -> 通用文档），不升版本号
    const moveRes = await env.app.inject({
      method: 'PATCH',
      url: `/api/artifacts/${taskArt.id}`,
      headers: authHeaders(cookie),
      payload: {
        name: '通用特效模板',
        scope: { kind: 'doc' },
      },
    });
    expect(moveRes.statusCode).toBe(200);
    const moved = moveRes.json() as ArtifactDetail;
    expect(moved.scopeKind).toBe('doc');
    expect(moved.worksheetId).toBeNull();
    expect(moved.latestVersion?.versionNumber).toBe(1);

    const docsList = (
      await env.app.inject({ method: 'GET', url: '/api/docs?q=特效', headers: { cookie } })
    ).json() as ArtifactDetail[];
    expect(docsList.map((d) => d.id)).toContain(taskArt.id);
  });

  it('T4: 删工序列降级、空作品含共用资源可见、解散分组保护、删/恢复任务精确还原与搜索零提取码泄漏', async () => {
    const { projectA } = await createTwoProjects(env.app.ctx.db);
    const cookie = projectA.user.cookie;

    const wsRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: authHeaders(cookie),
      payload: { name: '联动测试表', template: 'standard_video' },
    });
    const { worksheet, columns } = wsRes.json() as {
      worksheet: { id: string };
      columns: Array<{ id: string; name: string; type: string }>;
    };
    const stageCol1 = columns[0]!;

    // 建空作品并挂共用资源（0 任务）
    const work = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${worksheet.id}/works`,
        headers: authHeaders(cookie),
        payload: { name: '空作品但有原片' },
      })
    ).json() as { id: string };

    const sharedArt = (
      await env.app.inject({
        method: 'POST',
        url: '/api/artifacts',
        headers: authHeaders(cookie),
        payload: {
          scope: { kind: 'work', workId: work.id },
          name: '独占蓝光原片',
          location: {
            url: 'https://pan.baidu.com/s/1secretWorkUrl',
            extractCode: 'x9y8z7',
            isFolder: false,
          },
        },
      })
    ).json() as ArtifactDetail;

    // 0 任务但有共用资源 -> GET /worksheets/:id 仍返回该作品
    const wsBeforeTask = (
      await env.app.inject({
        method: 'GET',
        url: `/api/worksheets/${worksheet.id}`,
        headers: { cookie },
      })
    ).json() as WorksheetFullResponse;
    expect(wsBeforeTask.works.some((w) => w.id === work.id)).toBe(true);

    // 挂 1 条任务到该作品，并添加 2 个资源（1 个工序资源、1 个稍后单独删除的任务资源）
    const task = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${worksheet.id}/tasks`,
        headers: authHeaders(cookie),
        payload: { title: 'Part 1', workId: work.id },
      })
    ).json() as { id: string };

    const stageArt = (
      await env.app.inject({
        method: 'POST',
        url: '/api/artifacts',
        headers: authHeaders(cookie),
        payload: {
          scope: { kind: 'stage', taskId: task.id, stageColumnId: stageCol1.id },
          name: '精校时轴稿',
          location: {
            url: 'https://pan.quark.cn/s/secretStageUrl',
            extractCode: 's3cr3t',
            isFolder: false,
          },
        },
      })
    ).json() as ArtifactDetail;

    const deletedBeforeTaskArt = (
      await env.app.inject({
        method: 'POST',
        url: '/api/artifacts',
        headers: authHeaders(cookie),
        payload: {
          scope: { kind: 'task', taskId: task.id },
          name: '已被单删的旧草稿',
        },
      })
    ).json() as ArtifactDetail;
    await env.app.inject({
      method: 'DELETE',
      url: `/api/artifacts/${deletedBeforeTaskArt.id}`,
      headers: authHeaders(cookie),
    });

    // 搜索命中资源名 & 通用文档，但绝不命中提取码或 URL
    const docSecret = (
      await env.app.inject({
        method: 'POST',
        url: '/api/artifacts',
        headers: authHeaders(cookie),
        payload: {
          scope: { kind: 'doc' },
          name: '字幕压制规范手册',
          location: {
            url: 'https://pan.baidu.com/s/1docSecretOnlyUrl',
            extractCode: 'p4ss99',
            isFolder: false,
          },
        },
      })
    ).json() as ArtifactDetail;
    expect(docSecret.id).toBeTruthy();

    const searchByName = (
      await env.app.inject({
        method: 'GET',
        url: `/api/search?q=${encodeURIComponent('精校时轴稿')}`,
        headers: { cookie },
      })
    ).json() as SearchResponse;
    expect(searchByName.items.some((i) => i.taskId === task.id)).toBe(true);
    expect(searchByName.items[0]?.matchedArtifactNames).toContain('精校时轴稿');

    const searchByDoc = (
      await env.app.inject({
        method: 'GET',
        url: `/api/search?q=${encodeURIComponent('压制规范')}`,
        headers: { cookie },
      })
    ).json() as SearchResponse;
    expect(searchByDoc.docs.some((d) => d.artifactId === docSecret.id)).toBe(true);

    // 严禁命中提取码或 URL
    for (const forbidden of ['x9y8z7', 's3cr3t', 'p4ss99', 'secretWorkUrl', 'docSecretOnlyUrl']) {
      const sRes = (
        await env.app.inject({
          method: 'GET',
          url: `/api/search?q=${encodeURIComponent(forbidden)}`,
          headers: { cookie },
        })
      ).json() as SearchResponse;
      expect(sRes.items).toHaveLength(0);
      expect(sRes.docs).toHaveLength(0);
    }

    // 删除任务 -> 资源隐藏，尝试恢复该任务下被删资源返回 409；恢复任务 -> 未单删的精确回来、已单删的不复活
    await env.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${task.id}`,
      headers: authHeaders(cookie),
    });
    const restoreArtWhileTaskDeleted = await env.app.inject({
      method: 'POST',
      url: `/api/artifacts/${deletedBeforeTaskArt.id}/restore`,
      headers: authHeaders(cookie),
    });
    expect(restoreArtWhileTaskDeleted.statusCode).toBe(409);

    await env.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/restore`,
      headers: authHeaders(cookie),
    });
    const restoredTaskArts = (
      await env.app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/artifacts`,
        headers: { cookie },
      })
    ).json() as TaskArtifactsResponse;
    expect(restoredTaskArts.stageArtifacts[stageCol1.id]?.map((a) => a.id)).toEqual([stageArt.id]);
    expect(restoredTaskArts.taskArtifacts.map((a) => a.id)).not.toContain(deletedBeforeTaskArt.id);

    // 删除工序列 -> 工序资源自动降级为任务级并保留原名，修改记录注明数量
    const delColRes = await env.app.inject({
      method: 'DELETE',
      url: `/api/worksheets/${worksheet.id}/columns/${stageCol1.id}`,
      headers: authHeaders(cookie),
    });
    expect(delColRes.statusCode).toBe(204);

    const afterDelColArts = (
      await env.app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/artifacts`,
        headers: { cookie },
      })
    ).json() as TaskArtifactsResponse;
    expect(afterDelColArts.stageArtifacts[stageCol1.id]).toBeUndefined();
    expect(afterDelColArts.taskArtifacts.find((a) => a.id === stageArt.id)?.name).toBe(
      '精校时轴稿',
    );

    const logsAfterDelCol = (
      await env.app.inject({
        method: 'GET',
        url: `/api/worksheets/${worksheet.id}/change-logs`,
        headers: { cookie },
      })
    ).json() as ChangeLogsResponse;
    expect(
      logsAfterDelCol.items.some(
        (l) => l.action === 'column.deleted' && l.summary.includes('1 个工序资源'),
      ),
    ).toBe(true);

    // 解散分组（默认 deleteSharedArtifacts=false -> 保留作品横幅与共用资源）
    const ungroupKeep = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${worksheet.id}/works/${work.id}/ungroup`,
      headers: authHeaders(cookie),
      payload: {},
    });
    expect(ungroupKeep.statusCode).toBe(200);
    expect(ungroupKeep.json()).toEqual({ ungroupedTaskCount: 1, deletedArtifactCount: 0 });
    const wsAfterKeep = (
      await env.app.inject({
        method: 'GET',
        url: `/api/worksheets/${worksheet.id}`,
        headers: { cookie },
      })
    ).json() as WorksheetFullResponse;
    expect(wsAfterKeep.works.some((w) => w.id === work.id)).toBe(true);

    // 解散分组（deleteSharedArtifacts=true -> 软删共用资源且可在修改记录中恢复）
    const ungroupDel = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${worksheet.id}/works/${work.id}/ungroup`,
      headers: authHeaders(cookie),
      payload: { deleteSharedArtifacts: true },
    });
    expect(ungroupDel.statusCode).toBe(200);
    expect(ungroupDel.json()).toEqual({ ungroupedTaskCount: 0, deletedArtifactCount: 1 });

    const wsAfterDel = (
      await env.app.inject({
        method: 'GET',
        url: `/api/worksheets/${worksheet.id}`,
        headers: { cookie },
      })
    ).json() as WorksheetFullResponse;
    expect(wsAfterDel.works.some((w) => w.id === work.id)).toBe(false);

    const wsLogs = (
      await env.app.inject({
        method: 'GET',
        url: `/api/worksheets/${worksheet.id}/change-logs`,
        headers: { cookie },
      })
    ).json() as ChangeLogsResponse;
    const artDelLog = wsLogs.items.find(
      (l) => l.action === 'artifact.deleted' && l.artifactId === sharedArt.id,
    );
    expect(artDelLog?.canRestore).toBe(true);

    // 恢复共用资源 -> 作品重新可见
    const restoreShared = await env.app.inject({
      method: 'POST',
      url: `/api/artifacts/${sharedArt.id}/restore`,
      headers: authHeaders(cookie),
    });
    expect(restoreShared.statusCode).toBe(200);
    const workArtsAfterRestore = (
      await env.app.inject({
        method: 'GET',
        url: `/api/works/${work.id}/artifacts`,
        headers: { cookie },
      })
    ).json() as WorkArtifactsResponse;
    expect(workArtsAfterRestore.artifacts.map((a) => a.id)).toContain(sharedArt.id);

    // 通用文档修改记录与零提取码检查
    await env.app.inject({
      method: 'DELETE',
      url: `/api/artifacts/${docSecret.id}`,
      headers: authHeaders(cookie),
    });
    const docLogs = (
      await env.app.inject({ method: 'GET', url: '/api/docs/change-logs', headers: { cookie } })
    ).json() as ChangeLogsResponse;
    const delDocLog = docLogs.items.find((l) => l.action === 'artifact.deleted');
    expect(delDocLog?.canRestore).toBe(true);

    // 审计数据库 change_logs 和 realtime_events 绝不含任何提取码或敏感网盘 URL
    const allLogs = await env.app.ctx.db
      .select()
      .from(schema.changeLogs)
      .where(eq(schema.changeLogs.projectId, projectA.id));
    const logsBlob = JSON.stringify(allLogs);
    for (const secret of [
      'x9y8z7',
      's3cr3t',
      'p4ss99',
      'secretWorkUrl',
      'secretStageUrl',
      'docSecretOnlyUrl',
    ]) {
      expect(logsBlob).not.toContain(secret);
    }

    const allEvents = await env.app.ctx.db
      .select()
      .from(schema.realtimeEvents)
      .where(eq(schema.realtimeEvents.projectId, projectA.id));
    const eventsBlob = JSON.stringify(allEvents, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    for (const secret of [
      'x9y8z7',
      's3cr3t',
      'p4ss99',
      'secretWorkUrl',
      'secretStageUrl',
      'docSecretOnlyUrl',
    ]) {
      expect(eventsBlob).not.toContain(secret);
    }
  });

  it('T5: 双端实时同步收到 artifact.changed（零提取码/零 URL）且带 X-Connection-Id 去重', async () => {
    const { projectA } = await createTwoProjects(env.app.ctx.db);
    const wsRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: authHeaders(projectA.admin.cookie),
      payload: { name: '实时资源表', template: 'standard_video' },
    });
    const { worksheet } = wsRes.json() as { worksheet: { id: string } };
    const task = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${worksheet.id}/tasks`,
        headers: authHeaders(projectA.admin.cookie),
        payload: { title: '实时测试任务' },
      })
    ).json() as { id: string };

    const clientA = await connectWs(port, { cookie: projectA.admin.cookie, origin: TEST_ORIGIN });
    const clientB = await connectWs(port, { cookie: projectA.user.cookie, origin: TEST_ORIGIN });
    try {
      const helloA = (await clientA.nextMessage((m) => m.t === 'hello')) as {
        t: 'hello';
        connId: string;
      };
      await clientB.nextMessage((m) => m.t === 'hello');

      clientA.send({ t: 'subscribe', scope: { type: 'worksheet', id: worksheet.id } });
      clientB.send({ t: 'subscribe', scope: { type: 'worksheet', id: worksheet.id } });
      clientB.send({ t: 'subscribe', scope: { type: 'project', id: projectA.id } });
      await clientA.nextMessage((m) => m.t === 'subscribed');
      await clientB.nextMessage((m) => m.t === 'subscribed' && m.scope.type === 'worksheet');
      await clientB.nextMessage((m) => m.t === 'subscribed' && m.scope.type === 'project');

      // A 带 X-Connection-Id 创建任务资源（含提取码）
      const secretCode = 'ws9988';
      const secretUrl = 'https://pan.baidu.com/s/1wsNoLeakUrl';
      const createRes = await env.app.inject({
        method: 'POST',
        url: '/api/artifacts',
        headers: authHeaders(projectA.admin.cookie, { 'x-connection-id': helloA.connId }),
        payload: {
          scope: { kind: 'task', taskId: task.id },
          name: '实时附件',
          location: { url: secretUrl, extractCode: secretCode, isFolder: false },
        },
      });
      expect(createRes.statusCode).toBe(201);

      const evWs = (await clientB.nextMessage(
        (m) => m.t === 'event' && m.type === 'artifact.changed',
      )) as RealtimeEventMessage;
      const evStr = JSON.stringify(evWs);
      expect(evStr).not.toContain(secretCode);
      expect(evStr).not.toContain(secretUrl);

      // A 建通用文档 -> B 在 project 范围收到 artifact.changed (scopeKind: 'doc')
      const docRes = await env.app.inject({
        method: 'POST',
        url: '/api/artifacts',
        headers: authHeaders(projectA.admin.cookie, { 'x-connection-id': helloA.connId }),
        payload: {
          scope: { kind: 'doc' },
          name: '实时通用文档',
          location: {
            url: 'https://pan.quark.cn/s/docNoLeak',
            extractCode: 'doc77',
            isFolder: false,
          },
        },
      });
      expect(docRes.statusCode).toBe(201);

      const evDoc = (await clientB.nextMessage(
        (m) => m.t === 'event' && m.type === 'artifact.changed' && m.scope.type === 'project',
      )) as RealtimeEventMessage;
      expect(JSON.stringify(evDoc)).not.toContain('doc77');
      expect(JSON.stringify(evDoc)).not.toContain('docNoLeak');
    } finally {
      clientA.close();
      clientB.close();
    }
  });

  it('R01 / V11: 跨项目隔离——项目 B 访问项目 A 全部新增带 ID 接口均返回 404 且不修改项目 A 数据', async () => {
    const { projectA, projectB } = await createTwoProjects(env.app.ctx.db);

    const wsA = (
      await env.app.inject({
        method: 'POST',
        url: '/api/worksheets',
        headers: authHeaders(projectA.admin.cookie),
        payload: { name: 'A表', template: 'standard_video' },
      })
    ).json() as {
      worksheet: { id: string };
      columns: Array<{ id: string; type: string }>;
    };
    const stageColA = wsA.columns.find((c) => c.type === 'stage')!;
    const workA = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${wsA.worksheet.id}/works`,
        headers: authHeaders(projectA.admin.cookie),
        payload: { name: 'A作品' },
      })
    ).json() as { id: string };
    const taskA = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${wsA.worksheet.id}/tasks`,
        headers: authHeaders(projectA.admin.cookie),
        payload: { title: 'A任务', workId: workA.id },
      })
    ).json() as { id: string };
    const artA = (
      await env.app.inject({
        method: 'POST',
        url: '/api/artifacts',
        headers: authHeaders(projectA.admin.cookie),
        payload: {
          scope: { kind: 'stage', taskId: taskA.id, stageColumnId: stageColA.id },
          name: 'A机密资源',
          location: { url: 'https://mega.nz/file/secretA', extractCode: 'aaaa', isFolder: false },
        },
      })
    ).json() as ArtifactDetail;
    const verA = artA.latestVersion!;
    const locA = verA.locations[0]!;

    const cookieB = projectB.admin.cookie;
    const checks: Array<{
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: 'GET', url: `/api/works/${workA.id}/artifacts` },
      { method: 'GET', url: `/api/tasks/${taskA.id}/artifacts` },
      {
        method: 'POST',
        url: '/api/artifacts',
        payload: { scope: { kind: 'work', workId: workA.id }, name: '越权挂作品' },
      },
      {
        method: 'POST',
        url: '/api/artifacts',
        payload: { scope: { kind: 'task', taskId: taskA.id }, name: '越权挂任务' },
      },
      {
        method: 'POST',
        url: '/api/artifacts',
        payload: {
          scope: { kind: 'stage', taskId: taskA.id, stageColumnId: stageColA.id },
          name: '越权挂工序',
        },
      },
      { method: 'PATCH', url: `/api/artifacts/${artA.id}`, payload: { name: '篡改' } },
      { method: 'DELETE', url: `/api/artifacts/${artA.id}` },
      { method: 'POST', url: `/api/artifacts/${artA.id}/restore` },
      { method: 'POST', url: `/api/artifacts/${artA.id}/versions`, payload: { note: '越权v2' } },
      { method: 'DELETE', url: `/api/artifact-versions/${verA.id}` },
      { method: 'POST', url: `/api/artifact-versions/${verA.id}/restore` },
      {
        method: 'POST',
        url: `/api/artifact-versions/${verA.id}/locations`,
        payload: { url: 'https://mega.nz/file/evil', isFolder: false },
      },
      {
        method: 'PATCH',
        url: `/api/resource-locations/${locA.id}`,
        payload: { note: '篡改' },
      },
      { method: 'DELETE', url: `/api/resource-locations/${locA.id}` },
      { method: 'POST', url: `/api/resource-locations/${locA.id}/restore` },
      {
        method: 'POST',
        url: `/api/worksheets/${wsA.worksheet.id}/works/${workA.id}/ungroup`,
        payload: { deleteSharedArtifacts: true },
      },
    ];

    for (const c of checks) {
      const res = await env.app.inject({
        method: c.method,
        url: c.url,
        headers: c.method === 'GET' ? { cookie: cookieB } : authHeaders(cookieB),
        payload: c.payload,
      });
      expect(res.statusCode, `${c.method} ${c.url} should be 404`).toBe(404);
    }

    // 确认项目 A 数据完好无损
    const checkA = (
      await env.app.inject({
        method: 'GET',
        url: `/api/tasks/${taskA.id}/artifacts`,
        headers: { cookie: projectA.admin.cookie },
      })
    ).json() as TaskArtifactsResponse;
    expect(checkA.stageArtifacts[stageColA.id]?.[0]?.name).toBe('A机密资源');
    expect(checkA.stageArtifacts[stageColA.id]?.[0]?.latestVersion?.locations[0]?.id).toBe(locA.id);
  });
});
