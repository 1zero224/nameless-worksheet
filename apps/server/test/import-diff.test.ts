import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BoardResponse, MyTasksResponse } from '@nw/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { importWorkbook, resetProjectData } from '../src/importer/migrate-workbook.js';
import {
  formatExcelDuration,
  formatExcelSerialDate,
  normalizeCellText,
  parseCalendarDateString,
} from '../src/importer/normalize.js';
import { canonicalizePersonName, parseStageCellText } from '../src/importer/people.js';
import { exportProjectSnapshot, type ProjectSnapshot } from '../src/importer/snapshot.js';
import { readXlsxWorkbook } from '../src/importer/xlsx-reader.js';
import { buildSampleWorkbookBuffer } from './fixtures/import/build-sample-xlsx.js';
import { createTestEnv, createTwoProjects, type TestEnv } from './helpers.js';

function sortUsersForCompare(snap: ProjectSnapshot): ProjectSnapshot {
  return {
    ...snap,
    users: [...snap.users].sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
}

describe('阶段 5 T5–T7: OOXML 解析、脱敏小样差分测试 Oracle 与幂等零漂移', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('单元测试：归一化白名单、日期/时长换算、25 组人名合并与精确 na 词表', () => {
    expect(normalizeCellText('　第一行\r\n第二行　')).toBe('第一行\n第二行');
    expect(formatExcelSerialDate(45937)).toBe('2025-10-07');
    expect(formatExcelDuration(0.46875, false)).toBe('11:15');
    expect(parseCalendarDateString('2025.06..22')).toBe('2025-06-22');
    expect(parseCalendarDateString('2023.11.06-20')).toBeNull();

    expect(canonicalizePersonName('耗子')).toBe('山里的耗子');
    expect(canonicalizePersonName('tyb0v1')).toBe('tyb0v0');
    expect(canonicalizePersonName('狗圣帝君')).toBe('二狗');
    expect(canonicalizePersonName('帕鲁')).toBe('外协机械帕鲁');
    expect(canonicalizePersonName('ドリドリ')).toBe('Dori');

    const naParsed = parseStageCellText('官中');
    expect(naParsed.isNa).toBe(true);
    expect(naParsed.notes).toEqual(['官中']);

    const multiParsed = parseStageCellText('竹叶（歌轴）/养得累');
    expect(multiParsed.userDisplayNames).toEqual(['竹叶', '养得累']);
    expect(multiParsed.notes).toEqual(['歌轴']);

    const gptParsed = parseStageCellText('GPT');
    expect(gptParsed.userDisplayNames).toEqual([]);
    expect(gptParsed.textAssignees).toEqual(['GPT']);
  });

  it('OOXML 解析器严格通过 workbook.xml.rels 乱序配对工作表并准确解析颜色/合并/时长', () => {
    const sampleBuf = buildSampleWorkbookBuffer();
    const wb = readXlsxWorkbook(sampleBuf);
    const lv = wb.sheetByName.get('长视频全熟');
    expect(lv?.targetPath).toBe('xl/worksheets/sheet7.xml');
    const glossary = wb.sheetByName.get('⭐翻译对照表⭐');
    expect(glossary?.targetPath).toBe('xl/worksheets/sheet1.xml');
    const drama = wb.sheetByName.get('广播剧');
    expect(drama?.rowMap.get(3)?.cells.get(2)?.text).toBe('11:15');
  });

  it('脱敏小样差分测试 Oracle 逐项一致 + 连续 2 次导入零漂移 + 看板/我的任务隔离 + 原版备份留存', async () => {
    const { projectA } = await createTwoProjects(env.app.ctx.db);
    // 将管理员显示名改为 1zero 并清理掉多出来的测试普通用户（同时验证 resetProjectData）
    await env.app.ctx.db
      .update(schema.users)
      .set({ displayName: '1zero' })
      .where(eq(schema.users.id, projectA.admin.id));

    const resetRes = await resetProjectData({
      db: env.app.ctx.db,
      keepAdminLoginName: projectA.admin.loginName,
    });
    expect(resetRes.keptAdminDisplayName).toBe('1zero');

    const sampleBuf = buildSampleWorkbookBuffer();

    // 1. 首次正式导入（含原版备份至 StorageDriver 与 /docs）
    const first = await importWorkbook({
      db: env.app.ctx.db,
      storage: env.app.ctx.storage,
      projectId: projectA.id,
      fileBuffer: sampleBuf,
      sourceFilename: 'sample-workbook.xlsx',
      adminDisplayName: '1zero',
    });

    expect(first.report.dryRun).toBe(false);
    expect(first.report.batchId).toBeTruthy();
    expect(first.report.backupDocCreated).toBe(true);
    expect(first.report.backupR2Key).toContain(`projects/${projectA.id}/imports/`);

    // 确认只读源备份已真实写入 StorageDriver
    const head = await env.app.ctx.storage.headObject(first.report.backupR2Key!);
    expect(head).not.toBeNull();
    expect(head?.contentLength).toBe(sampleBuf.byteLength);

    // 2. 与人工核定的 workbook-oracle.json 逐项深度比对（排除含动态 sha256 的原版备份 doc 后完全等价）
    const snap1 = await exportProjectSnapshot(env.app.ctx.db, projectA.id);
    const backupArtifacts = snap1.artifacts.filter(
      (a) => a.scopeKind === 'doc' && a.name.includes('sample-workbook.xlsx'),
    );
    expect(backupArtifacts).toHaveLength(1);
    expect(backupArtifacts[0]?.locations[0]?.type).toBe('r2');

    const snapWithoutDynamicDoc: ProjectSnapshot = sortUsersForCompare({
      ...snap1,
      artifacts: snap1.artifacts.filter((a) => a.scopeKind !== 'doc'),
    });
    const oraclePath = path.resolve(
      process.cwd(),
      'apps/server/test/fixtures/import/workbook-oracle.json',
    );
    const oracle = sortUsersForCompare(
      JSON.parse(readFileSync(oraclePath, 'utf8')) as ProjectSnapshot,
    );
    expect(snapWithoutDynamicDoc).toEqual(oracle);

    // 3. 关键红线验证：看板与我的任务中绝无 shelved 与 free 工作表
    const boardRes = await env.app.inject({
      method: 'GET',
      url: '/api/board',
      headers: { cookie: projectA.admin.cookie },
    });
    expect(boardRes.statusCode).toBe(200);
    const board = boardRes.json() as BoardResponse;
    expect(board.worksheets.every((w) => w.kind === 'task')).toBe(true);
    expect(board.cards.some((c) => c.workName === '示例搁置联动表')).toBe(false);
    expect(board.cards.some((c) => c.worksheetName === '⭐翻译对照表⭐')).toBe(false);
    expect(board.cards.some((c) => c.worksheetName === '相关收益')).toBe(false);
    expect(board.cards.some((c) => c.worksheetName === '动漫工作表（留念用）')).toBe(false);

    const myTasksRes = await env.app.inject({
      method: 'GET',
      url: '/api/my-tasks',
      headers: { cookie: projectA.admin.cookie },
    });
    expect(myTasksRes.statusCode).toBe(200);
    const myTasks = myTasksRes.json() as MyTasksResponse;
    // 管理员 1zero 在「漫画」蓝底示例画集嵌字中为 in_progress
    expect(myTasks.inProgress.some((i) => i.taskTitle === '示例画集')).toBe(true);
    expect(
      [...myTasks.inProgress, ...myTasks.notStarted, ...myTasks.completed].every(
        (i) => i.publishStatus !== 'shelved',
      ),
    ).toBe(true);

    // 4. 连续第 2 次导入同一工作簿 -> 严格幂等零漂移
    const second = await importWorkbook({
      db: env.app.ctx.db,
      storage: env.app.ctx.storage,
      projectId: projectA.id,
      fileBuffer: sampleBuf,
      sourceFilename: 'sample-workbook.xlsx',
      adminDisplayName: '1zero',
    });

    expect(second.report.usersCreated).toHaveLength(0);
    expect(second.report.backupDocCreated).toBe(false);
    for (const s of second.report.sheets) {
      expect(s.rowsInserted).toBe(0);
      expect(s.rowsSkipped).toBe(s.rowsTotal);
      expect(s.workArtifactsInserted).toBe(0);
    }

    const snap2 = await exportProjectSnapshot(env.app.ctx.db, projectA.id);
    expect(JSON.stringify(snap2)).toBe(JSON.stringify(snap1));
  });
});
