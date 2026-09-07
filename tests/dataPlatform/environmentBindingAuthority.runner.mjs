import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = await mkdtemp(path.join(os.tmpdir(), 'environment-binding-authority-'));
const env = { ...process.env, ZENDING_ENV_AUTHORITY_TEST_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(require('electron'), [path.resolve('tests/dataPlatform/environmentBindingAuthority.integration.mjs')], { env, stdio: 'inherit', windowsHide: true });
  const timeout = setTimeout(() => child.kill(), 60000);
  let exitCode;
  try { exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
  finally { clearTimeout(timeout); }
  assert.equal(exitCode, 0, '真实Electron环境绑定权威性验收失败');
} finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
