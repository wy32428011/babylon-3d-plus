import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findSourceJavaScriptArtifacts, runTypeScript } from '../scripts/build-typescript.mjs';

test('源码守卫检测 ts/tsx 同名 JS，保留独立参考 JS，并在编译前拒绝', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-js-guard-'));
  try {
    for (const name of ['src/shared/ids.ts', 'src/shared/ids.js', 'src/view/Panel.tsx', 'src/view/Panel.js',
      'src/runtime/opening/reference/source.js', 'outside/example.ts', 'outside/example.js']) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'export {};\n');
    }
    assert.deepEqual(findSourceJavaScriptArtifacts(root), ['src/shared/ids.js', 'src/view/Panel.js']);
    assert.throws(() => runTypeScript({ root, stdio: 'pipe' }), /同名 TypeScript 衍生 JavaScript/);
    await rm(path.join(root, 'src/shared/ids.js'));
    await rm(path.join(root, 'src/view/Panel.js'));
    assert.deepEqual(findSourceJavaScriptArtifacts(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('当前仓库不存在会遮蔽 TypeScript 源码的 JavaScript 产物', () => {
  assert.deepEqual(findSourceJavaScriptArtifacts(), []);
});
