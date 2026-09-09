import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'scene-model-update-'));
const env = { ...process.env, SCENE_MODEL_UPDATE_TEST_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(createRequire(import.meta.url)('electron'), ['tests/dataPlatform/sceneModelUpdate.integration.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'), env, stdio: 'inherit', windowsHide: true,
  });
  let timeout = false;
  const timer = setTimeout(() => { timeout = true; child.kill(); }, 240000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }); }
  finally { clearTimeout(timer); }
  assert.equal(timeout, false, '场景模型同步集成测试超时');
  assert.equal(code, 0, '场景模型同步集成测试失败');
} finally {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('scene-model-update-'));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
