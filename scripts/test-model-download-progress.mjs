import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = await mkdtemp(path.join(os.tmpdir(), 'model-byte-integration-'));
try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.resolve('tests/dataPlatform/modelDownloadProgress.integration.mjs')], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, ZENDING_DOWNLOAD_PROGRESS_TEST_ROOT: root },
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = Number(exitCode);
} finally {
  // Electron退出后再清理其数据库，避免Windows尚持有文件句柄。
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('model-byte-integration-'));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
