import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const viteUrl = pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href;
const configPath = path.join(root, 'vite.config.ts');

test('开发启动只扫描编辑器入口，排除生成产物与运行期工程目录并兜底监听异常', { timeout: 25000 }, async (t) => {
  // 故意在工作区路径中加入括号，验证锚定函数过滤器免疫 picomatch glob 元字符与 Windows 盘符大小写。
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'zending-vite-startup (paren)-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(path.join(fixture, 'src/assets/branding'), { recursive: true });
  await writeFile(path.join(fixture, 'index.html'), '<script type="module" src="/src/main.js"></script>');
  await writeFile(path.join(fixture, 'src/main.js'), 'export const ready = true;');
  const logo = Buffer.from('89504e470d0a1a0a', 'hex');
  await writeFile(path.join(fixture, 'src/assets/branding/zending-scene-loading-logo.png'), logo);
  for (const dir of ['output', 'release', 'dist-viewer-template', 'dist-electron']) {
    await mkdir(path.join(fixture, dir), { recursive: true });
    // 若历史产物误入依赖扫描，这个不存在的包会产生明确错误。
    await writeFile(path.join(fixture, dir, 'index.html'), '<script type="module">import "generated-artifact-must-not-be-scanned";</script>');
    await writeFile(path.join(fixture, dir, 'generated.js'), 'export const generated = true;');
  }
  await mkdir(path.join(fixture, 'Conflicts/2122853060450459649/preexisting/Assets/Cad'), { recursive: true });
  await writeFile(path.join(fixture, 'Conflicts/2122853060450459649/preexisting/Assets/Cad/pre.dxf'), '0\nEOF\n');
  await mkdir(path.join(fixture, 'Platforms/p1/Scenes'), { recursive: true });
  await writeFile(path.join(fixture, 'Platforms/p1/Scenes/main.scene.json'), '{}');
  await mkdir(path.join(fixture, 'SharedResources/Models/m1'), { recursive: true });
  await writeFile(path.join(fixture, 'SharedResources/Models/m1/model.glb'), 'glb');
  await mkdir(path.join(fixture, 'Projects/local'), { recursive: true });
  await writeFile(path.join(fixture, 'Projects/local/main.scene.json'), '{}');
  await mkdir(path.join(fixture, 'Assets/Cad'), { recursive: true });
  await writeFile(path.join(fixture, 'Assets/Cad/root.dxf'), '0\nEOF\n');

  const script = `
    import { createLogger, createServer } from ${JSON.stringify(viteUrl)};
    import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const errors = [];
    const warnings = [];
    const logger = createLogger('silent');
    logger.error = (message) => errors.push(message);
    logger.warn = (message) => warnings.push(message);
    const server = await createServer({
      configFile: ${JSON.stringify(configPath)},
      customLogger: logger,
      cacheDir: path.join(process.cwd(), 'node_modules/.vite'),
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    });
    try {
      await server.listen();
      const base = server.resolvedUrls.local[0];
      const response = await fetch(new URL('src/assets/branding/zending-scene-loading-logo.png', base), { signal: AbortSignal.timeout(5000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      const main = await fetch(new URL('src/main.js', base), { signal: AbortSignal.timeout(5000) });
      const mainBody = await main.text();
      const deadline = Date.now() + 3000;
      while (!Object.keys(server.watcher.getWatched()).some(dir => dir.endsWith('/src')) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      // 运行期动态写入冲突副本 CAD 文件、.babylon-editor 暂存文件及写探测文件，验证不进入监听且目录不锁句柄。
      const dynamicConflictDir = path.join(process.cwd(), 'Conflicts/2122853060450459649/2026-11-26T00-23-37-003Z-version-1/Assets/Cad/Import-cGyz0A');
      await mkdir(dynamicConflictDir, { recursive: true });
      await writeFile(path.join(dynamicConflictDir, 'CADmoban_Ndc8Objects(2)(1).dxf'), '0\\nEOF\\n');
      await mkdir(path.join(process.cwd(), 'src/.babylon-editor'), { recursive: true });
      await writeFile(path.join(process.cwd(), 'src/.babylon-editor/temp.json'), '{}');
      const probePath = path.join(process.cwd(), '.zending-write-probe-1234');
      await writeFile(probePath, 'ok');
      await rm(probePath, { force: true });
      await new Promise(resolve => setTimeout(resolve, 150));

      const conflictsDir = path.join(process.cwd(), 'Conflicts');
      const renamedConflictsDir = path.join(process.cwd(), 'Conflicts-renamed-check');
      await rename(conflictsDir, renamedConflictsDir);
      await rename(renamedConflictsDir, conflictsDir);

      const watched = Object.keys(server.watcher.getWatched()).map(dir => path.relative(process.cwd(), dir).replaceAll('\\\\', '/'));
      const sourceFile = path.join(process.cwd(), 'src/main.js');
      const sourceChanged = new Promise((resolve, reject) => {
        const onChange = file => {
          if (path.resolve(file) !== sourceFile) return;
          clearTimeout(timer);
          server.watcher.off('change', onChange);
          resolve(true);
        };
        const timer = setTimeout(() => {
          server.watcher.off('change', onChange);
          reject(new Error('源码修改未触发文件监听'));
        }, 3000);
        server.watcher.on('change', onChange);
      });
      await writeFile(sourceFile, 'export const ready = false;');
      await sourceChanged;
      await server.environments.client.depsOptimizer?.scanProcessing;

      const watcherErrorListenerCount = server.watcher.listenerCount('error');
      const ebusyError = Object.assign(new Error('EBUSY: resource busy or locked'), {
        code: 'EBUSY',
        path: path.join(dynamicConflictDir, 'CADmoban_Ndc8Objects(2)(1).dxf'),
      });
      server.watcher.emit('error', ebusyError);
      server.watcher.emit('error', ebusyError);
      const enospcError = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      server.watcher.emit('error', enospcError);

      console.log(JSON.stringify({
        errors,
        warnings,
        watched,
        watcherErrorListenerCount,
        status: response.status,
        logo: bytes.toString('hex'),
        mainBody,
      }));
    } finally {
      await server.close();
    }
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fixture,
    env: { ...process.env, VITE_CACHE_DIR: '' },
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout.trim());
  await t.test('历史 HTML 不进入依赖扫描，非瞬态监听错误记录为 error', () => {
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /\[vite-watcher\].*ENOSPC/);
  });
  await t.test('历史产物与运行期工程目录不建立文件监听，源码与 src/assets 保持监听', () => {
    assert.deepEqual(
      result.watched.filter(dir => /^(output|release|dist-viewer-template|dist-electron|Conflicts|Platforms|SharedResources|Projects|Assets|Scenes)(\/|$)/.test(dir)),
      [],
    );
    assert.deepEqual(
      result.watched.filter(dir => /(^|\/)\.babylon-editor(\/|$)/.test(dir)),
      [],
    );
    assert.ok(result.watched.includes('src'), '源码目录应保留监听');
    assert.ok(result.watched.some(dir => dir === 'src/assets' || dir.startsWith('src/assets/')), 'src/assets 应保留监听');
  });
  await t.test('watcher 已挂载错误兜底并对瞬态 EBUSY 节流告警', () => {
    assert.ok(result.watcherErrorListenerCount > 0, 'server.watcher 必须注册 error 监听器');
    const watcherWarnings = result.warnings.filter(message => message.includes('[vite-watcher]'));
    assert.equal(watcherWarnings.length, 1, '相同路径的连续 EBUSY 应被节流合并为一条告警');
    assert.match(watcherWarnings[0], /EBUSY/);
  });
  await t.test('品牌图片完整返回，入口源码正常转换', () => {
    assert.equal(result.status, 200);
    assert.equal(result.logo, logo.toString('hex'));
    assert.match(result.mainBody, /export const ready = true/);
  });
});

