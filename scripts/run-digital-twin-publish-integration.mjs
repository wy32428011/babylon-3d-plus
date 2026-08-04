import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const __filename = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(__filename), '..');
const testRoot = await fs.mkdtemp(path.join(tmpdir(), 'zending-digital-twin-publish-integration-'));
const testEntry = path.join(workspaceRoot, 'tests', 'digitalTwin', 'digitalTwinPublish.integration.mjs');
let exitCode = 1;

try {
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [testEntry], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        ZENDING_DIGITAL_TWIN_PUBLISH_TEST_ROOT: testRoot,
      },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`数字孪生发布集成测试被信号终止：${signal}`));
      else resolve(code ?? 1);
    });
  });
} finally {
  await removeWithRetry(testRoot);
}

process.exitCode = exitCode;

async function removeWithRetry(targetPath) {
  const tempBase = path.resolve(tmpdir());
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(tempBase, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝清理临时目录之外的路径：${resolvedTarget}`);
  }
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(resolvedTarget, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!error || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}
