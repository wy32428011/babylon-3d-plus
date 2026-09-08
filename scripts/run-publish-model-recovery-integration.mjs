import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = await mkdtemp(path.join(tmpdir(), 'zending-model-recovery-'));
let exitCode = 1;
try {
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), ['tests/digitalTwin/publishModelRecovery.integration.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'), stdio: 'inherit', windowsHide: true,
      env: { ...process.env, MODEL_RECOVERY_TEST_ROOT: root },
    });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('zending-model-recovery-')) throw new Error('临时目录范围无效');
  // Electron 退出后再清理 userData，避免 Windows 字典或缓存文件仍被占用。
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exitCode = exitCode;
