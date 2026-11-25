// 验证层防篡改与测试健康守卫脚本（支持 off / observe / enforce 模式）
// 1. 扫描测试文件中的 flaky 反模式（waitForTimeout / .skip / .fixme）
// 2. 在 PR/分支对比场景下检测是否触及验证层文件，提醒人类重点复核并从 main 读取 REVIEW.md
// 3. 统计近期提交的 Verified: 验证戳覆盖情况（observe 信息提示）

import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROTECTED_VERIFICATION_FILES = new Set([
  'REVIEW.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/skills/verify/SKILL.md',
  '.github/workflows/ci.yml',
  'playwright.config.ts',
  'vitest.config.ts',
  'apps/server/test/core.test.ts',
  'scripts/check-verification-guard.mjs',
]);

const FLAKY_PATTERNS = [
  { name: 'waitForTimeout', re: /\bwaitForTimeout\s*\(/ },
  { name: 'skipped-test', re: /\b(?:test|it|describe)\s*\.\s*(?:skip|fixme)\s*\(/ },
];

function parseArgs(argv) {
  let mode = process.env.VERIFY_GUARD_MODE ?? 'observe';
  let baseRef = process.env.VERIFY_GUARD_BASE ?? '';
  let stampLimit = 10;

  for (const arg of argv) {
    if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
    } else if (arg.startsWith('--base=')) {
      baseRef = arg.slice('--base='.length);
    } else if (arg.startsWith('--check-stamps=')) {
      const parsed = Number.parseInt(arg.slice('--check-stamps='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) stampLimit = parsed;
    }
  }

  if (!baseRef && process.env.GITHUB_BASE_REF) {
    baseRef = `origin/${process.env.GITHUB_BASE_REF}`;
  }

  return { mode, baseRef, stampLimit };
}

function collectTestFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectTestFiles(full, out);
    } else if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

function scanFlakyPatterns() {
  const roots = [path.join(root, 'packages'), path.join(root, 'apps'), path.join(root, 'e2e')];
  const files = roots.flatMap((dir) => collectTestFiles(dir));
  const findings = [];

  for (const file of files) {
    const rel = path.relative(root, file).replaceAll('\\', '/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      const prevLine = i > 0 ? (lines[i - 1] ?? '') : '';
      if (line.includes('verify-allow:') || prevLine.includes('verify-allow:')) continue;

      for (const pat of FLAKY_PATTERNS) {
        if (pat.re.test(line)) {
          findings.push({
            file: rel,
            line: i + 1,
            rule: pat.name,
            snippet: trimmed.slice(0, 120),
          });
        }
      }
    }
  }

  return { scannedCount: files.length, findings };
}

function runGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function checkProtectedDiff(baseRef) {
  if (!baseRef) return { checked: false, touched: [] };
  const out = runGit(['diff', '--name-only', `${baseRef}...HEAD`]);
  if (out === null) return { checked: false, touched: [] };

  const changed = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const touched = changed.filter((f) => PROTECTED_VERIFICATION_FILES.has(f));
  return { checked: true, baseRef, totalChanged: changed.length, touched };
}

function checkVerificationStamps(baseRef, limit) {
  const rangeArgs = baseRef ? [`${baseRef}..HEAD`] : ['-n', String(limit)];
  const raw = runGit(['log', ...rangeArgs, '--format=%h%x1f%s%x1f%b%x1e']);
  if (!raw) return { total: 0, stamped: 0, unstamped: [] };

  const records = raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean);

  let stamped = 0;
  const unstamped = [];

  for (const rec of records) {
    const [hash = '', subject = '', body = ''] = rec.split('\x1f');
    const combined = `${subject}\n${body}`;
    if (/^\s*Verified:\s*\S+/im.test(combined)) {
      stamped += 1;
    } else {
      unstamped.push({ hash, subject });
    }
  }

  return { total: records.length, stamped, unstamped };
}

const { mode, baseRef, stampLimit } = parseArgs(process.argv.slice(2));

if (mode === 'off') {
  console.log('[verify-guard] mode=off，已跳过检查。');
  process.exit(0);
}

const flaky = scanFlakyPatterns();
const diffCheck = checkProtectedDiff(baseRef);
const stamps = checkVerificationStamps(baseRef, stampLimit);

const summaryLines = [
  '## Verification Layer Guard',
  `- 模式：\`${mode}\``,
  `- 测试健康扫描：共扫描 ${flaky.scannedCount} 个测试文件，发现 ${flaky.findings.length} 处 flaky 反模式`,
];

console.log(`[verify-guard] mode=${mode}`);
console.log(
  `[verify-guard] 已扫描 ${flaky.scannedCount} 个测试文件，flaky 反模式：${flaky.findings.length}`,
);

for (const item of flaky.findings) {
  const msg = `  - [WARN] ${item.file}:${item.line} (${item.rule}): ${item.snippet}`;
  console.log(msg);
  summaryLines.push(
    `  - ⚠️ \`${item.file}:${item.line}\`（\`${item.rule}\`）：\`${item.snippet.replaceAll('`', "'")}\``,
  );
}

if (diffCheck.checked) {
  console.log(
    `[verify-guard] 基准 ${diffCheck.baseRef} 对比共改动 ${diffCheck.totalChanged} 个文件，触及验证层：${diffCheck.touched.length}`,
  );
  if (diffCheck.touched.length > 0) {
    summaryLines.push(
      `- ⚠️ **防篡改提醒**：本次变更触及 ${diffCheck.touched.length} 个验证层文件，请人工重点复核，并务必以 \`main\` 分支的 \`REVIEW.md\` 为审查基准：`,
    );
    for (const file of diffCheck.touched) {
      console.log(`  - [GUARD] 验证层变更：${file}`);
      summaryLines.push(`  - \`${file}\``);
    }
  } else {
    summaryLines.push(`- 验证层防篡改（对比 \`${diffCheck.baseRef}\`）：未触及受保护验证文件`);
  }
}

if (stamps.total > 0) {
  console.log(
    `[verify-guard] 验证戳覆盖（Verified:）：${stamps.stamped}/${stamps.total} 个提交带验证戳`,
  );
  summaryLines.push(
    `- 提交验证戳覆盖（\`Verified:\`）：${stamps.stamped}/${stamps.total}（observe 统计，不阻断）`,
  );
}

const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
if (stepSummaryPath) {
  appendFileSync(stepSummaryPath, `${summaryLines.join('\n')}\n\n`, 'utf8');
}

if (mode === 'enforce' && flaky.findings.length > 0) {
  console.error(
    '[verify-guard] enforce 模式拦截：存在未豁免的 flaky 反模式（如需临时豁免请写 // verify-allow: <原因>）。',
  );
  process.exit(1);
}
