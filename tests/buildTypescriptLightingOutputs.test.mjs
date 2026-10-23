import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTypeScript } from '../scripts/build-typescript.mjs';

const compiler = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
const prefix = 'babylon-ts-lighting-output-';
const quiet = { mode: 'electron', stdio: 'pipe' };

function fixture(t, extension = 'ts') {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith(prefix));
    rmSync(absolute, { recursive: true, force: true });
  });
  mkdirSync(path.join(root, 'electron', 'lighting-bake'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(path.join(root, 'tsconfig.node.json'), JSON.stringify({
    compilerOptions: {
      composite: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      outDir: 'dist-electron', rootDir: 'electron', types: [], skipLibCheck: true,
      rewriteRelativeImportExtensions: true, jsx: 'react-jsx',
    },
    include: ['electron/**/*'],
  }));
  const entryExtension = extension === 'cts' || extension === 'mts' ? extension : 'ts';
  const runtimeExtension = extension === 'cts' ? 'cjs' : extension === 'mts' ? 'mjs' : 'js';
  writeFileSync(path.join(root, `electron/main.${entryExtension}`), [
    `export { value } from './shared.${extension}';`,
    'export const example = "import { ignored } from \'./example.ts\';";',
    'export const template = `export { ignored } from "./template.ts";`;',
  ].join('\n'));
  writeFileSync(path.join(root, `electron/shared.${extension}`), 'export const value: number = 42;\n');
  writeFileSync(path.join(root, 'electron/lighting-bake/fixture.py'), 'print("controlled asset")\n');
  return { root, runtimeExtension, entry: path.join(root, `dist-electron/main.${runtimeExtension}`) };
}

function load(entry) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `const module = await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log(module.value);`,
  ], { encoding: 'utf8' });
}

test('增量缓存未变但产物残留TS导入时，仅本次强制修复并可由Node真实加载', async t => {
  for (const extension of ['ts', 'tsx', 'mts', 'cts']) {
    await t.test(extension, subtest => {
      const { root, runtimeExtension, entry } = fixture(subtest, extension);
      const first = runTypeScript({ root, ...quiet });
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const buildInfo = readFileSync(path.join(root, 'tsconfig.node.tsbuildinfo'), 'utf8');
      const original = readFileSync(entry, 'utf8');
      const broken = original.replace(`./shared.${runtimeExtension}`, `./shared.${extension}`);
      assert.notEqual(broken, original);
      writeFileSync(entry, broken);

      const incremental = spawnSync(process.execPath, [compiler, '-b', 'tsconfig.node.json'], { cwd: root, encoding: 'utf8' });
      assert.equal(incremental.status, 0, incremental.stdout + incremental.stderr);
      assert.equal(readFileSync(entry, 'utf8'), broken, '输入与buildinfo不变时，普通增量编译不会修复旧产物');
      assert.equal(readFileSync(path.join(root, 'tsconfig.node.tsbuildinfo'), 'utf8'), buildInfo);
      const failedLoad = load(entry);
      assert.notEqual(failedLoad.status, 0);
      assert.match(failedLoad.stderr, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/);

      const repaired = runTypeScript({ root, ...quiet });
      assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
      assert.equal(repaired.forced, true, '发现未交付TS引用时须强制重新生成现有产物');
      const loaded = load(entry);
      assert.equal(loaded.status, 0, loaded.stderr);
      assert.equal(loaded.stdout.trim(), '42');
      assert.equal(readFileSync(path.join(root, 'dist-electron/lighting-bake/fixture.py'), 'utf8'), 'print("controlled asset")\n');
      const warm = runTypeScript({ root, ...quiet });
      assert.equal(warm.status, 0, warm.stdout + warm.stderr);
      assert.equal(warm.forced, false, '完整且可加载的产物仍走增量，不误判示例字符串或模板');
    });
  }
});

test('实际已交付的TS目标不触发无谓强制编译', t => {
  const { root, entry } = fixture(t);
  assert.equal(runTypeScript({ root, ...quiet }).status, 0);
  const output = readFileSync(entry, 'utf8').replace('./shared.js', './shared.ts');
  writeFileSync(entry, output);
  writeFileSync(path.join(root, 'dist-electron/shared.ts'), 'export const value = 42;\n');
  const result = runTypeScript({ root, ...quiet });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.forced, false);
  assert.equal(readFileSync(entry, 'utf8'), output);
});

test('强制重建后仍有未交付TS引用时明确失败，不把编译退出0误报为成功', t => {
  const { root } = fixture(t, 'cts');
  assert.equal(runTypeScript({ root, ...quiet }).status, 0);
  writeFileSync(path.join(root, 'electron/main.cts'), [
    'declare function require(id: string): unknown;',
    "export const value = require('./not-delivered.ts');",
  ].join('\n'));
  const result = runTypeScript({ root, ...quiet });
  assert.equal(result.forced, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未交付|残留|导入/);
  assert.match(result.stderr, /not-delivered\.ts/);
  assert.deepEqual(result.missing, [], '该坏引用来自本次增量产物，不依赖首次缺失输出强制构建');
});
