import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groups, auditEntries } from './test-groups.mjs';
import { auditClassification, contractDomains } from './p4-test-classification.mjs';

// 清单只描述静态可达性，不执行测试，也不推断测试已经通过。
const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFileSync(path.join(root, file), 'utf8');
const scripts = JSON.parse(read('package.json')).scripts;
const entryAudit = auditEntries(scripts, JSON.parse(read('scripts/test-entry-manifest.json')));
const classification = JSON.parse(read('scripts/test-entry-classification.json'));
const classifications = new Map(classification.entries.map(entry => [entry.file, entry]));
const walk = dir => readdirSync(path.join(root, dir), { withFileTypes: true })
  // Python解释器缓存不是测试来源，不能因执行顺序使清单新增二进制候选。
  .flatMap(entry => entry.isDirectory() ? entry.name === '__pycache__' ? [] : walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
const files = [...walk('tests'), ...walk('scripts')].sort();
const sources = new Map(files.filter(file => /\.[cm]?[jt]sx?$/.test(file)).map(file => [file, read(file)]));
const candidate = file => file !== 'scripts/generate-test-inventory.mjs' &&
  (file.startsWith('tests/') || /(?:^|-)(?:smoke|test)(?:[-.]|$)/.test(path.posix.basename(file)) || /^scripts\/run-.*integration/.test(file));
const rows = files.filter(candidate).map(file => ({ file, entries: new Set(), ci: new Set(), conditions: new Set() }));
const byFile = new Map(rows.map(row => [row.file, row]));
const warnings = new Set();

function expand(pattern) {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  return files.filter(file => new RegExp(`^${expression}$`).test(file));
}

// 以下动态入口已逐一核对执行代码；证据片段失效时停止，避免静默扩大覆盖结论。
const adapters = {
  'scripts/telemetry-test.mjs': { targets: ['tests/telemetry/**/*.test.ts'], proof: ["run('node', ['--test', ...testFiles]", "tests/telemetry/**/*.test.js"], condition: 'runner 临时 tsc 编译；junction；清理临时输出' },
  'scripts/model-array-test.mjs': { targets: ['tests/editor/modelArray.test.ts'], proof: ["run('node', ['--test', join(outDir, 'tests/editor/modelArray.test.js')"], condition: 'runner 临时 tsc 编译；junction；清理临时输出' },
  'scripts/builtin-slot-test.mjs': { targets: ['tests/editor/builtInSlotAssetSync.test.ts'], proof: ["run('node', ['--test', join(outDir, 'tests/editor/builtInSlotAssetSync.test.js')"], condition: 'runner 临时 tsc 编译；junction；清理临时输出' },
  'scripts/model-asset-relink-test.mjs': { targets: ['tests/editor/modelAssetRelink.test.ts'], proof: ["run(['--test', join(outDir, 'tests/editor/modelAssetRelink.test.js')", 'rewriteRelativeImportExtensions: true', "normalizedProjectRoot + '/src/vite-env.d.ts'"], condition: 'runner 临时 tsc 编译；junction；清理临时输出' },
  'scripts/run-digital-twin-publish-integration.mjs': { targets: ['tests/digitalTwin/digitalTwinPublish.integration.mjs', 'tests/digitalTwin/publishBindingRecovery.integration.mjs'], proof: ["'digitalTwinPublish.integration.mjs'", "'publishBindingRecovery.integration.mjs'", 'spawn(electronPath, [testEntry]'], condition: 'Electron 二进制；共享 TEST_ROOT；runner 顺序执行' },
  'scripts/run-scene-model-update-integration.mjs': { targets: ['tests/dataPlatform/sceneModelUpdate.integration.mjs'], proof: ["['tests/dataPlatform/sceneModelUpdate.integration.mjs']"], condition: 'Electron 二进制；独立临时目录；240s 超时' },
  'scripts/run-publish-model-recovery-integration.mjs': { targets: ['tests/digitalTwin/publishModelRecovery.integration.mjs'], proof: ["['tests/digitalTwin/publishModelRecovery.integration.mjs']"], condition: 'Electron 二进制；独立临时 userData；退出后清理' },
};
for (const [file, adapter] of Object.entries(adapters)) {
  if (!adapter.proof.every(fragment => sources.get(file)?.includes(fragment))) throw new Error(`需要重新审查动态入口：${file}`);
}

function record(file, entry, conditions, ci, seen = new Set()) {
  if (seen.has(file)) return;
  seen.add(file);
  const row = byFile.get(file);
  if (row) {
    row.entries.add(entry);
    for (const condition of conditions) row.conditions.add(condition);
    if (ci) row.ci.add(ci);
  }
  const adapter = adapters[file];
  if (adapter) {
    for (const target of adapter.targets) {
      const matches = expand(target);
      if (!matches.length) throw new Error(`动态入口匹配为空：${file} -> ${target}`);
      for (const match of matches) record(match, entry, [...conditions, adapter.condition], ci, seen);
    }
  }
}

function visit(name, entry, conditions = [], ci = '', stack = []) {
  if (stack.includes(name)) throw new Error(`npm 入口循环：${[...stack, name].join(' -> ')}`);
  if (!(name in scripts)) throw new Error(`npm 入口不存在：${name}`);
  const state = [...conditions];
  for (const command of scripts[name].split(/\s*&&\s*/)) {
    const group = command.match(/^node scripts\/test-groups\.mjs (core|integration|smoke)$/)?.[1];
    if (group) { for (const child of groups[group]) visit(child, entry, state, ci, [...stack, name]); continue; }
    const domain = command.match(/^node scripts\/p4-test-domains\.mjs ([\w-]+)$/)?.[1];
    if (domain) {
      if (!contractDomains.includes(domain)) throw new Error(`未知领域入口：${domain}`);
      record('scripts/p4-test-domains.mjs', entry, state, ci);
      for (const item of classification.entries.filter(item => item.disposition === 'node-contract' && item.domain === domain)) record(item.file, entry, [...state, ...item.prerequisites], ci);
      continue;
    }
    if (command === 'npm test') { visit('test', entry, state, ci, [...stack, name]); continue; }
    if (/--test-concurrency=1\b/.test(command)) state.push('该 node 命令 --test-concurrency=1');
    if (/--experimental-strip-types\b/.test(command)) state.push('Node 原生 strip-types');
    if (/--experimental-transform-types\b/.test(command)) state.push('Node 原生 transform-types');
    if (/^electron\s/.test(command)) state.push('Electron 二进制');
    const nested = [...command.matchAll(/\bnpm\s+run\s+([\w:-]+)/g)];
    for (const match of nested) {
      if (/^(?:build|pack|dist)(?::|$)/.test(match[1])) state.push(`前置 npm run ${match[1]}`);
      else visit(match[1], entry, state, ci, [...stack, name]);
    }
    if (/^(?:node|electron)\s/.test(command)) {
      for (const match of command.matchAll(/(?:^|\s)["']?((?:tests|scripts)\/[^\s"']+\.(?:ts|mjs|js))["']?/g)) {
        const matches = expand(match[1]);
        if (!matches.length) throw new Error(`入口匹配为空：${name} -> ${match[1]}`);
        for (const file of matches) record(file, entry, state, ci);
      }
    } else if (!nested.length) warnings.add(`未解释的入口命令：${name}: ${command}`);
  }
}

const entryNames = Object.keys(scripts).filter(name => !['test:inventory', 'test:entries'].includes(name) && /(?:^|:)(test|smoke)(?::|$)/.test(name));
for (const name of entryNames) visit(name, name);
// 仅支持当前 workflow 的单行 run；块语法和动态命令必须人工复核。
for (const file of walk('.github/workflows').filter(file => /\.ya?ml$/.test(file))) {
  let platform = '平台未声明';
  for (const line of read(file).split(/\r?\n/)) {
    const runner = line.match(/^\s*runs-on:\s*(.+)$/);
    if (runner) platform = runner[1];
    const run = line.match(/^\s*(?:-\s*)?run:\s*(.+)$/);
    if (!run) continue;
    if (/^[|>]/.test(run[1])) warnings.add(`${file} 存在块状 run，CI 可达性需人工复核`);
    for (const match of run[1].matchAll(/npm\s+(?:run\s+([\w:-]+)|(test)\b)/g)) {
      if (!match[1]) match[1] = match[2];
      if (entryNames.includes(match[1])) visit(match[1], match[1], [], `${file}: ${platform}`);
    }
  }
}

function classify(file, source) {
  if (/(?:^|\/)fixtures\//.test(file)) return 'fixture / harness';
  if (file.startsWith('tests/helpers/')) return 'helper';
  if (['scripts/test-entry-manifest.json', 'scripts/test-entry-classification.json', 'scripts/p4-test-classification.mjs', 'scripts/test-groups.mjs', 'scripts/p4-test-domains.mjs'].includes(file)) return 'tooling / metadata';
  const kinds = [];
  if (adapters[file] || /\.runner\./.test(file)) kinds.push('runner');
  if (/\bNullEngine\b/.test(source)) kinds.push('NullEngine');
  if (/from ['"]electron['"]|require\(['"]electron['"]\)|\.integration\.mjs$/.test(source + file)) kinds.push('Electron 候选');
  if (/playwright|\.webgl\.|\.browser\./.test(source + file)) kinds.push('browser / WebGL 候选');
  if (/readFile(?:Sync)?\(|readFile\(/.test(source) && /assert/.test(source)) kinds.push('包含文件/源码断言候选');
  return kinds.length ? kinds.join('；') : /\.test\.|node:assert|node:test/.test(source + file) ? 'Node 测试候选' : '需人工判定';
}

for (const row of rows) {
  const source = sources.get(row.file) ?? '';
  row.kind = classify(row.file, source);
  row.support = /^(fixture|helper|tooling)/.test(row.kind);
  row.classification = classifications.get(row.file) ?? null;
  if (row.classification) for (const condition of row.classification.prerequisites) row.conditions.add(condition);
  row.platform = /taskkill|powershell|win-unpacked|\.exe\b/.test(source) ? '含 Windows 路径/命令，需 Windows 复核' : '未证明跨平台';
  if (/symlinkSync/.test(source) || row.conditions.has('runner 临时 tsc 编译；junction；清理临时输出')) row.platform += '；junction/symlink 权限';
  if (/registerHooks|register\(/.test(source)) row.conditions.add('模块加载 hook；保留进程隔离');
  if (/process\.env\.|globalThis\.|global\./.test(source)) row.conditions.add('含全局状态/环境变量；保留独立进程');
  if (/createServer|listen\(/.test(source)) row.conditions.add('含服务/端口；复核端口与关闭流程');
  if (/dist-electron/.test(source)) row.conditions.add('引用 dist-electron；核对 build:electron 前置');
  if (/dist-viewer-template/.test(source)) row.conditions.add('引用 dist-viewer-template；核对 build:viewer 前置');
  if (/tests[/'"]/.test(source) && /spawn|execFile|spawnSync/.test(source) && !adapters[row.file]) {
    warnings.add(`动态子进程需复核：${row.file}（其子测试不计为已覆盖）`);
  }
}

const classificationAudit = auditClassification(classification, rows, read);
const tests = rows.filter(row => !row.support);
const uncovered = tests.filter(row => !row.entries.size);
const ciCovered = tests.filter(row => row.ci.size);
const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = entries => ['| 文件 | 类型 / 已核对分类 | 当前 npm 入口 | 平台边界 | 构建前置与隔离要求 | CI 静态可达 |', '|---|---|---|---|---|---|', ...entries.map(row => `| ${escape(row.file)} | ${escape(row.kind + (row.classification ? '；' + row.classification.disposition + (row.classification.domain ? '/' + row.classification.domain : '') : ''))} | ${escape([...row.entries].sort().join('、') || (row.support ? '辅助/治理文件，不计执行覆盖' : row.classification ? row.classification.command + '（已分类，需定向执行并核对条件）' : '未发现；需补入口或人工复核'))} | ${escape(row.platform)} | ${escape([...row.conditions].sort().join('；') || '未静态确认；保留当前运行方式')} | ${escape([...row.ci].sort().join('；') || '否 / 未确认')} |`)].join('\n');
const output = `# 测试入口清单\n\n由 \`node scripts/generate-test-inventory.mjs\` 生成；\`--check\` 只检查漂移。\n\n## 统计与证据边界\n\n- 候选文件总数：${rows.length}；测试/runner/smoke 候选：${tests.length}；fixture/helper/治理工具：${rows.length - tests.length}。\n- npm 测试/smoke 入口：${entryNames.length}；有静态入口的候选：${tests.length - uncovered.length}；无静态 npm 入口：${uncovered.length}（已登记定向命令与条件）；未分类：${classificationAudit.unresolved}。\n- P4 逐文件复核原始 301 项，分类注册表保留源码摘要、用途、执行命令、前置与证据行；完整性/摘要/证据漂移即失败。登记表示已识别如何运行，不等于运行成功。新增无静态入口的候选必须补分类。\n- CI 静态可达候选：${ciCovered.length}。这些数字不是测试执行数、断言数或通过数，不能宣称全仓单测已覆盖。\n- 范围为 tests/ 的全部文件及 scripts/ 中 含 test/smoke 分隔词或 run-*integration 命名的文件（排除清单生成器）；其他目录/自定义命名测试不在自动发现范围。\n- 解析 package.json 名称含 test/smoke 的入口（排除 test:inventory 工具）、npm run 递归、node/electron 的显式文件与 * / ** glob。构建/打包只记录前置，不运行。动态编译与 Electron runner 使用已核对的限定适配；其他动态调用保守标记待复核。\n- CI 只读取 workflow 单行 run；可达表示配置选中，不代表远端执行成功。平台为源码线索，未标 Windows 的文件也未证明跨平台。\n- 文件/源码断言候选可能包含行为测试；NullEngine 不证明真实 GPU/FPS；browser/WebGL 候选不代表已获得真实渲染证据。\n- runner 条件按入口传播；各入口应单独运行，不合并测试进程。串行、Electron 编译和临时目录/junction 要求必须保留。\n\n## 已分类、无静态 npm 入口的定向候选\n\n${table(uncovered)}\n\n## 有静态入口的候选\n\n${table(tests.filter(row => row.entries.size))}\n\n## Fixture、helper 与治理工具（不计独立测试覆盖）\n\n${table(rows.filter(row => row.support))}\n\n## 必须人工复核的动态调用\n\n${[...warnings].sort().map(item => `- ${item}`).join('\n') || '无。'}\n`;
const target = 'docs/test-inventory.md';
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ entryAudit, classificationAudit: { reviewed: classificationAudit.reviewed, unresolved: classificationAudit.unresolved }, groups, files: rows.map(row => ({ file: row.file, entries: [...row.entries].sort(), kind: row.kind, support: row.support, classification: row.classification, reason: row.entries.size ? '静态入口已知；执行状态单独记录' : row.classification ? '已逐文件分类；执行前核对 command、prerequisites 与 evidence，实际执行结果单独记录' : '辅助/治理文件，不计独立执行覆盖' })) }, null, 2));
  process.exit(0);
}
if (process.argv.includes('--check')) {
  // Windows 检出可能使用 CRLF，换行风格不应被误判为清单内容漂移。
  if (read(target).replaceAll('\r\n', '\n') !== output) throw new Error('测试清单已漂移，请重新生成并审阅差异。');
} else writeFileSync(path.join(root, target), output, 'utf8');
console.log(JSON.stringify({ total: rows.length, candidates: tests.length, support: rows.length - tests.length, entries: entryNames.length, reachable: tests.length - uncovered.length, withoutStaticEntry: uncovered.length, unclassified: classificationAudit.unresolved, reviewed: classificationAudit.reviewed, ciReachable: ciCovered.length, reviewItems: warnings.size, check: process.argv.includes('--check') }));
