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

test('开发启动只扫描编辑器入口，排除生成产物并保留源码监听', { timeout: 20000 }, async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'zending-vite-startup-'));
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

  const script = `
    import { createLogger, createServer } from ${JSON.stringify(viteUrl)};
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const errors = [];
    const logger = createLogger('silent');
    logger.error = (message) => errors.push(message);
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
      console.log(JSON.stringify({ errors, watched, status: response.status, logo: bytes.toString('hex'), mainBody }));
    } finally {
      await server.close();
    }
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fixture,
    env: { ...process.env, VITE_CACHE_DIR: '' },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout.trim());
  await t.test('历史 HTML 不进入依赖扫描', () => {
    assert.deepEqual(result.errors, []);
  });
  await t.test('历史产物目录不建立文件监听', () => {
    assert.deepEqual(result.watched.filter(dir => /^(output|release|dist-viewer-template|dist-electron)(\/|$)/.test(dir)), []);
    assert.ok(result.watched.includes('src'), '源码目录应保留监听');
  });
  await t.test('品牌图片完整返回，入口源码正常转换', () => {
    assert.equal(result.status, 200);
    assert.equal(result.logo, logo.toString('hex'));
    assert.match(result.mainBody, /export const ready = true/);
  });
});
