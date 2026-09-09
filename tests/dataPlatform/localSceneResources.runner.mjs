import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = await mkdtemp(path.join(os.tmpdir(), 'local-scene-resources-'));
const env = { ...process.env, ZENDING_LOCAL_SCENE_RESOURCES_TEST_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const integrationPath = fileURLToPath(new URL('./localSceneResources.integration.mjs', import.meta.url));
  const child = spawn(require('electron'), [integrationPath], { env, stdio: 'inherit', windowsHide: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(timedOut, false, '真实 Electron 本地场景资源同步验收超时');
  assert.equal(exitCode, 0, '真实 Electron 本地场景资源同步验收失败');
} finally {
  const resolvedRoot = await realpath(root);
  const resolvedTemp = await realpath(os.tmpdir());
  assert.equal(path.dirname(resolvedRoot), resolvedTemp, '测试清理目录必须位于系统临时目录中');
  assert.ok(path.basename(resolvedRoot).startsWith('local-scene-resources-'), '测试清理目录前缀不符');
  await rm(resolvedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
