import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePrefix = 'zending-dev-electron-startup-';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** 使用操作系统分配的测试端口，避免触碰用户正在使用的 5173 服务。 */
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function events(root) {
  try {
    return (await readFile(path.join(root, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function portReleased(port) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const available = await new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return true;
    await delay(30);
  }
  return false;
}

/** 复制实际启动器；仅替换隔离目录中的依赖及三个构建阶段，不使用真实 Electron 或网络安装。 */
async function fixture(t, mode) {
  const root = await mkdtemp(path.join(os.tmpdir(), fixturePrefix));
  const stopFile = path.join(root, 'stop');
  let child;
  t.after(async () => {
    await writeFile(stopFile, 'stop');
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    // 假 Vite 主动观察本夹具的停止文件；旧启动器遗留子进程时也只回收本测试的资源。
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const recorded = await events(root);
      const vite = recorded.find(event => event.kind === 'vite-started');
      if (!vite || await portReleased(vite.port)) break;
      await delay(30);
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith(fixturePrefix));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'node_modules/electron'), { recursive: true });
  await mkdir(path.join(root, 'node_modules/vite/bin'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/electron/package.json'), JSON.stringify({ type: 'commonjs', main: 'index.js' }));
  await copyFile(path.join(projectRoot, 'scripts/dev-electron.mjs'), path.join(root, 'scripts/dev-electron.mjs'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    type: 'module', main: 'scripts/fake-electron.cjs',
    scripts: Object.fromEntries(['wait:renderer', 'build:viewer', 'build:electron'].map(stage => [stage, `node scripts/stage.mjs ${stage}`])),
  }));
  const record = "const record = event => fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ ...event, pid: process.pid }) + '\\n');";
  await writeFile(path.join(root, 'node_modules/electron/index.js'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.resolve(__dirname, '../..');
    ${record}
    record({ kind: 'runtime-resolving' });
    ${mode === 'install-error' ? "throw new Error('fixture-electron-runtime-install-failed');" : `
      fs.writeFileSync(path.join(root, 'runtime-ready'), 'prepared on package resolution');
      record({ kind: 'runtime-prepared' });
      module.exports = ${mode === 'missing-executable' ? "path.join(__dirname, 'dist/missing-electron-runtime.exe')" : 'process.execPath'};
    `}
  `);
  await writeFile(path.join(root, 'node_modules/vite/bin/vite.js'), `
    import fs from 'node:fs';
    import http from 'node:http';
    import path from 'node:path';
    const root = process.cwd();
    ${record}
    const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
    const server = http.createServer((request, response) => response.end('fixture renderer ready'));
    server.listen(port, '127.0.0.1', () => record({ kind: 'vite-started', port, runtimeReady: fs.existsSync(path.join(root, 'runtime-ready')) }));
    const watchdog = setInterval(() => {
      if (fs.existsSync(path.join(root, 'stop'))) {
        clearInterval(watchdog);
        server.close();
      }
    }, 25);
    setTimeout(() => { clearInterval(watchdog); server.close(); }, 18000).unref();
  `);
  await writeFile(path.join(root, 'scripts/stage.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    const root = process.cwd();
    ${record}
    const stage = process.argv[2];
    if (stage === 'wait:renderer') {
      let ready = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const response = await fetch(process.env.VITE_DEV_SERVER_URL, { signal: AbortSignal.timeout(500) });
          if (response.ok && await response.text() === 'fixture renderer ready') { ready = true; break; }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!ready) throw new Error('fixture renderer did not become ready');
    }
    record({ kind: 'stage', stage });
  `);
  await writeFile(path.join(root, 'scripts/fake-electron.cjs'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const root = process.cwd();
    ${record}
    if (!fs.existsSync(path.join(root, 'runtime-ready'))) throw new Error('runtime was not prepared');
    record({ kind: 'electron-started', url: process.env.VITE_DEV_SERVER_URL });
    console.log('fixture Electron entry reached');
  `);
  const port = await unusedPort();
  const run = async () => {
    child = spawn(process.execPath, ['scripts/dev-electron.mjs'], {
      cwd: root,
      env: { ...process.env, VITE_DEV_SERVER_PORT: String(port), npm_config_update_notifier: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let timedOut = false;
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      void writeFile(stopFile, 'stop');
      child.kill();
    }, 12000);
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timer));
    return { ...result, timedOut, output, events: await events(root), port };
  };
  return { run };
}

test('Electron 包先准备首次运行产物，再完整执行开发启动入口', { timeout: 25000 }, async t => {
  const { run } = await fixture(t, 'success');
  const result = await run();
  assert.equal(result.timedOut, false, result.output);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.events.filter(event => event.kind === 'stage').map(event => event.stage), ['wait:renderer', 'build:viewer', 'build:electron']);
  const vite = result.events.find(event => event.kind === 'vite-started');
  assert.ok(vite, result.output);
  assert.equal(vite.runtimeReady, true, '运行时解析和首次准备必须发生在启动 Vite 之前');
  assert.ok(result.events.findIndex(event => event.kind === 'runtime-prepared') < result.events.findIndex(event => event.kind === 'vite-started'));
  assert.ok(result.events.some(event => event.kind === 'electron-started'), result.output);
  assert.match(result.output, /fixture Electron entry reached/);
  assert.equal(await portReleased(vite.port), true, '正常退出后释放本夹具的 Vite 端口');
});

test('Electron 包解析或安装失败时明确退出，且不启动 renderer 服务', { timeout: 25000 }, async t => {
  const { run } = await fixture(t, 'install-error');
  const result = await run();
  assert.equal(result.timedOut, false, result.output);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /fixture-electron-runtime-install-failed/);
  assert.match(result.output, /启动失败/);
  assert.deepEqual(result.events.map(event => event.kind), ['runtime-resolving']);
  assert.equal(await portReleased(result.port), true);
});

test('Electron 可执行文件启动失败时保留错误并回收已启动的 Vite', { timeout: 25000 }, async t => {
  const { run } = await fixture(t, 'missing-executable');
  const result = await run();
  assert.equal(result.timedOut, false, result.output);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /missing-electron-runtime\.exe/);
  assert.match(result.output, /ENOENT/);
  const vite = result.events.find(event => event.kind === 'vite-started');
  assert.ok(vite, '必须实际启动过服务才能验证失败回收');
  assert.equal(result.events.some(event => event.kind === 'electron-started'), false);
  assert.equal(await portReleased(vite.port), true, 'spawn error 后必须释放本夹具的 Vite 端口');
});
