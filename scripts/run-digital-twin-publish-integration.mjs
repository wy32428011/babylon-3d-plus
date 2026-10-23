import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const __filename = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(__filename), '..');
const testRoot = await fs.mkdtemp(path.join(tmpdir(), 'zending-digital-twin-publish-integration-'));
const testEntries = [
  path.join(workspaceRoot, 'tests', 'digitalTwin', 'digitalTwinPublish.integration.mjs'),
  path.join(workspaceRoot, 'tests', 'digitalTwin', 'publishBindingRecovery.integration.mjs'),
];
let exitCode = 1;

try {
  // 原生编译工作留在普通 Node 进程；Electron 只执行真实 renderer 产物，避免强制退出时竞逐编译线程关闭。
  await prepareRendererFixture();
  for (const testEntry of testEntries) {
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
    if (exitCode !== 0) break;
  }
} finally {
  await removeWithRetry(testRoot);
}

process.exitCode = exitCode;

async function prepareRendererFixture() {
  const entries = [
    ['publishWithResourceRetry', 'src/editor/deployment/publishOrchestration.ts'],
    ['createEmptySceneDocument, createSkyboxEntity', 'src/editor/model/SceneDocument.ts'],
    ['serializeScene', 'src/editor/project/SceneSerializer.ts'],
    ['repairPublishSceneSkyboxes', 'src/editor/deployment/repairPublishSceneSkyboxes.ts'],
  ];
  const inputPath = path.join(testRoot, 'renderer-entry.mjs');
  await fs.writeFile(inputPath, entries.map(([names, source]) => {
    const modulePath = path.resolve(workspaceRoot, source).replace(/\\/g, '/');
    return `export { ${names} } from ${JSON.stringify(modulePath)};`;
  }).join('\n') + '\n', 'utf8');
  await build({
    configFile: false,
    root: workspaceRoot,
    logLevel: 'error',
    ssr: { noExternal: true },
    build: {
      ssr: true,
      outDir: path.join(testRoot, 'renderer'),
      emptyOutDir: false,
      rollupOptions: { input: inputPath, output: { entryFileNames: 'publish-renderer.mjs' } },
    },
  });
}

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
