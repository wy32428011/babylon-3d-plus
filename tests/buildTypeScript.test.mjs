import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTypeScript } from '../scripts/build-typescript.mjs';

const compiler = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'babylon-ts-build-'));
  mkdirSync(path.join(root, 'electron')); mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'tsconfig.node.json'), JSON.stringify({ compilerOptions: { composite: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', outDir: 'dist-electron', rootDir: 'electron', types: [], skipLibCheck: true }, include: ['electron/**/*.ts', 'electron/**/*.cts'] }));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [], skipLibCheck: true }, include: ['src'], references: [{ path: './tsconfig.node.json' }] }));
  writeFileSync(path.join(root, 'electron/main.ts'), "export { value } from './shared.js';\n");
  writeFileSync(path.join(root, 'electron/preload.cts'), 'export const ready = true;\n');
  writeFileSync(path.join(root, 'electron/shared.ts'), 'export const value: number = 1;\n');
  writeFileSync(path.join(root, 'src/index.ts'), "import { value } from '../electron/shared.js'; export const doubled = value * 2;\n");
  return root;
}
const compile = (root, args) => spawnSync(process.execPath, [compiler, ...args], { cwd: root, encoding: 'utf8' });
const quiet = { stdio: 'pipe' };

test('missing intermediate declaration and entire output recover despite retained cache', () => {
  const root = fixture();
  try {
    assert.equal(compile(root, ['-b']).status, 0);
    const declaration = path.join(root, 'dist-electron/shared.d.ts');
    rmSync(declaration);
    assert.equal(compile(root, ['-p', 'tsconfig.node.json']).status, 0);
    assert.equal(existsSync(declaration), false, '旧编译路径会跳过缺失输出，必须暴露该复现');
    const repaired = runTypeScript({ root, ...quiet });
    assert.equal(repaired.status, 0); assert.equal(repaired.forced, true); assert.ok(existsSync(declaration));
    rmSync(path.join(root, 'dist-electron'), { recursive: true });
    assert.ok(existsSync(path.join(root, 'tsconfig.node.tsbuildinfo')));
    const standalone = runTypeScript({ root, mode: 'electron', ...quiet });
    assert.equal(standalone.status, 0); assert.equal(standalone.forced, true);
    for (const name of ['main.js', 'main.d.ts', 'preload.cjs', 'preload.d.cts', 'shared.js', 'shared.d.ts']) assert.ok(existsSync(path.join(root, 'dist-electron', name)), name);
  } finally { rmSync(root, { recursive: true }); }
});

test('complete outputs preserve incremental mode; changed input rebuilds and type errors remain failures', () => {
  const root = fixture();
  try {
    assert.equal(runTypeScript({ root, ...quiet }).status, 0);
    const warm = runTypeScript({ root, ...quiet }); assert.equal(warm.status, 0); assert.equal(warm.forced, false);
    writeFileSync(path.join(root, 'electron/shared.ts'), 'export const value: number = 99;\n');
    const changed = runTypeScript({ root, ...quiet }); assert.equal(changed.status, 0); assert.equal(changed.forced, false);
    assert.match(readFileSync(path.join(root, 'dist-electron/shared.js'), 'utf8'), /99/);
    writeFileSync(path.join(root, 'src/index.ts'), 'const invalid: number = "wrong";\n');
    assert.notEqual(runTypeScript({ root, ...quiet }).status, 0);
  } finally { rmSync(root, { recursive: true }); }
});

test('invalid config and unknown CLI option fail visibly', () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, 'tsconfig.node.json'), '{broken');
    assert.throws(() => runTypeScript({ root, ...quiet }), /tsconfig.node.json/);
    const result = spawnSync(process.execPath, [path.resolve('scripts/build-typescript.mjs'), '--unknown'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /未知参数/);
  } finally { rmSync(root, { recursive: true }); }
});
