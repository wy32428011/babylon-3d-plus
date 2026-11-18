import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'zending-roam-avatar-'));
const env = { ...process.env, MANUAL_ROAM_AVATAR_TEST_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
let report;
try {
  const child = spawn(createRequire(import.meta.url)('electron'), ['tests/roam/manualRoamAvatar.integration.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 240_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(timedOut, false, '漫游人物上传集成测试超时');
    assert.equal(code, 0, 'Electron 人物上传测试异常退出');
    report = await readFile(path.join(root, 'result.txt'), 'utf8');
    assert.match(report, /^PASS: /, 'Electron 未确认完成全部上传断言');
  } finally {
    clearTimeout(timeout);
  }
} finally {
  // Windows 会一直持有 userData 中的数据库，直到 Electron 子进程退出。
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(report);
