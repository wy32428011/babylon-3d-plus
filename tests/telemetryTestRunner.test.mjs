import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('遥测 runner 聚焦编译递归依赖并排除未选测试，全量入口仍报告未选测试中的类型错误', async t => {
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'telemetry-runner-fixture-'));
  t.after(async () => {
    if (path.dirname(fixtureRoot) !== os.tmpdir() || !path.basename(fixtureRoot).startsWith('telemetry-runner-fixture-')) throw new Error('测试清理目录超出临时工作区。');
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  for (const directory of ['scripts', 'tests/telemetry', 'src/runtime/helpers']) await mkdir(path.join(fixtureRoot, directory), { recursive: true });
  await copyFile(path.join(projectRoot, 'scripts/telemetry-test.mjs'), path.join(fixtureRoot, 'scripts/telemetry-test.mjs'));
  await symlink(path.join(projectRoot, 'node_modules'), path.join(fixtureRoot, 'node_modules'), 'junction');
  await writeFile(path.join(fixtureRoot, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(fixtureRoot, 'src/vite-env.d.ts'), '// 聚焦编译机制测试。\n');
  await writeFile(path.join(fixtureRoot, 'src/runtime/helpers/dependency.ts'), 'export const expected: number = 42;\n');
  await writeFile(path.join(fixtureRoot, 'tests/telemetry/selected.test.ts'), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { expected } from '../../src/runtime/helpers/dependency';",
    "test('被选测试及递归业务依赖确实执行', () => assert.equal(expected, 42));",
  ].join('\n'));
  await writeFile(path.join(fixtureRoot, 'tests/telemetry/unrelated.test.ts'), 'export const unrelated: number = "故意制造未选测试类型错误";\n');

  const run = args => spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts/telemetry-test.mjs'), ...args],
    { cwd: fixtureRoot, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const selected = run(['selected.test.ts']);
  assert.ifError(selected.error);
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  assert.match(selected.stdout, /被选测试及递归业务依赖确实执行/);
  assert.match(selected.stdout, /# pass 1/);
  assert.doesNotMatch(selected.stdout + selected.stderr, /TS2322/);

  const all = run([]);
  assert.ifError(all.error);
  assert.notEqual(all.status, 0, all.stdout + all.stderr);
  assert.match(all.stdout + all.stderr, /unrelated\.test\.ts/);
  assert.match(all.stdout + all.stderr, /TS2322/);
  assert.doesNotMatch(all.stdout, /# pass 1/);
});
