import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

test('真实 Electron IPC：中台打开使用当前远端元数据并防止配置变化污染', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'current-project-metadata-'));
  const env = { ...process.env, ZENDING_CURRENT_PROJECT_METADATA_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  let output = '';
  try {
    const child = spawn(require('electron'), [fileURLToPath(new URL('./currentProjectMetadata.integration.mjs', import.meta.url))], {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timeout = setTimeout(() => child.kill(), 50_000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0, output);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
