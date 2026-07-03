import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTNAME = '127.0.0.1';
const DEFAULT_PORT = 5173;
const MAX_PORT_ATTEMPTS = 300;
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const viteCliPath = path.join(ROOT_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
const electronCommand = process.platform === 'win32'
  ? path.join(ROOT_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(ROOT_DIR, 'node_modules', '.bin', 'electron');

const childProcesses = new Set();
let isShuttingDown = false;

/** 检查指定端口是否可绑定，用于避开已有 Vite 或其他本地服务。 */
function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve({ available: false, reason: error.code ?? error.message }));
    server.once('listening', () => {
      server.close(() => resolve({ available: true }));
    });
    server.listen(port, HOSTNAME);
  });
}

/** 从首选端口开始向后查找可用端口，避免 npm run dev:electron 因端口占用失败。 */
async function findAvailablePort(preferredPort) {
  const blockedReasons = new Map();

  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = preferredPort + offset;
    const result = await canListen(port);
    if (result.available) return port;

    const reason = result.reason ?? 'UNKNOWN';
    blockedReasons.set(reason, (blockedReasons.get(reason) ?? 0) + 1);
  }

  const reasonSummary = [...blockedReasons.entries()]
    .map(([reason, count]) => `${reason}:${count}`)
    .join(', ');
  throw new Error(`无法在 ${preferredPort}-${preferredPort + MAX_PORT_ATTEMPTS - 1} 中找到可用端口（${reasonSummary || '无错误详情'}）。`);
}

/** 启动子进程并继承当前终端输出，便于直接查看 Vite/Electron 日志。 */
function spawnChild(command, args, env, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT_DIR,
    env,
    stdio: 'inherit',
    shell: options.shell ?? false,
  });

  childProcesses.add(child);
  child.once('error', () => {
    childProcesses.delete(child);
  });
  child.once('exit', () => {
    childProcesses.delete(child);
  });

  return child;
}

/** 运行一个必须正常退出的命令，失败时让主流程中止。 */
function runChecked(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(command, args, env, { shell: process.platform === 'win32' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} 退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    });
  });
}

/** 终止本脚本启动的子进程，避免 Electron 或 Vite 残留。 */
function shutdown(exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  for (const child of childProcesses) {
    if (!child.killed) child.kill();
  }

  process.exitCode = exitCode;
}

async function main() {
  const preferredPort = Number(process.env.VITE_DEV_SERVER_PORT ?? DEFAULT_PORT);
  const port = await findAvailablePort(Number.isFinite(preferredPort) ? preferredPort : DEFAULT_PORT);
  const devServerUrl = `http://${HOSTNAME}:${port}`;
  const viteCacheDir = path.join(ROOT_DIR, 'node_modules', `.vite-electron-${port}`);
  const env = {
    ...process.env,
    VITE_DEV_SERVER_URL: devServerUrl,
    VITE_DEV_SERVER_PORT: String(port),
    VITE_CACHE_DIR: viteCacheDir,
  };

  console.log(`[dev-electron] renderer dev server: ${devServerUrl}`);
  console.log(`[dev-electron] vite cache dir: ${viteCacheDir}`);
  const vite = spawnChild(process.execPath, [viteCliPath, '--host', HOSTNAME, '--port', String(port), '--strictPort'], env);

  try {
    await runChecked(npmCommand, ['run', 'wait:renderer'], env);
    await runChecked(npmCommand, ['run', 'build:electron'], env);
  } catch (error) {
    console.error(`[dev-electron] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    shutdown(1);
    return;
  }

  const electron = spawnChild(electronCommand, ['.'], env);
  electron.once('exit', (code) => {
    shutdown(code ?? 0);
  });

  vite.once('exit', (code) => {
    if (!isShuttingDown && code !== 0) shutdown(code ?? 1);
  });
}

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));

void main().catch((error) => {
  console.error(`[dev-electron] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
});
