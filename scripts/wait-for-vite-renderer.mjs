import http from 'node:http';

const HOSTNAME = '127.0.0.1';
const PORT = 5173;
const configuredDevServerUrl = new URL(process.env.VITE_DEV_SERVER_URL ?? `http://${HOSTNAME}:${PORT}`);
const devServerHostname = configuredDevServerUrl.hostname;
const devServerPort = Number(configuredDevServerUrl.port || (configuredDevServerUrl.protocol === 'https:' ? 443 : 80));
const REQUEST_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 500;
const TOTAL_TIMEOUT_MS = 180000;
const MAX_WARMED_PATHS = 1500;
const DEV_SERVER_ORIGIN = configuredDevServerUrl.origin;

const RENDERER_WARMUP_PATHS = [
  '/',
  '/src/main.tsx',
];
const DISCOVERABLE_PATH_PREFIXES = ['/src/'];
const NON_APPLICATION_PATH_PREFIXES = [
  '/node_modules/',
  '/@id/',
  '/@vite/',
  '/@react-refresh',
  '/@fs/',
  '/@browser-external:',
];

class SkippableHttpError extends Error {
  /** 标记 404 这类非关键发现资源，预热器应跳过而不是无限等待。 */
  skippable = true;
}

/** 等待指定毫秒数，用于 Vite 首次依赖预构建期间的短间隔重试。 */
function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/** 将未知异常转换为可读消息，便于终端输出当前等待原因。 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 判断 URL 是否仍指向当前 Vite dev server，避免递归预热外部资源。 */
function isLocalDevServerUrl(url) {
  return url.origin === DEV_SERVER_ORIGIN;
}

/** 判断路径是否属于 Vite 运行时、optimizer 或第三方依赖，避免等待会变更 hash 的产物。 */
function isApplicationWarmupPath(pathname) {
  if (pathname === '/') return true;
  if (NON_APPLICATION_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  return DISCOVERABLE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** 将响应中发现的相对路径归一成当前 dev server 下的 path + query。 */
function normalizeDiscoveredPath(specifier, currentPathname) {
  if (!specifier || specifier.startsWith('data:') || specifier.startsWith('blob:')) return null;
  const isResolvableModulePath =
    specifier.startsWith('/') ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith(DEV_SERVER_ORIGIN);
  if (!isResolvableModulePath) return null;

  try {
    const url = new URL(specifier, `${DEV_SERVER_ORIGIN}${currentPathname}`);
    if (!isLocalDevServerUrl(url)) return null;
    if (!isApplicationWarmupPath(url.pathname)) return null;

    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** 从 HTML、CSS 或 Vite 转换后的 JS 中提取后续需要预热的本地资源路径。 */
function discoverLocalImports(pathname, body) {
  if (!shouldDiscoverImports(pathname)) return new Set();

  const discovered = new Set();
  const patterns = [
    /\b(?:src|href)=["']([^"']+)["']/g,
    /\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^'"]*?\s+from\s+["']([^"']+)["']/g,
    /@import\s+["']([^"']+)["']/g,
    /url\(\s*["']?([^"')]+)["']?\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      const normalizedPath = normalizeDiscoveredPath(match[1], pathname);
      if (normalizedPath) discovered.add(normalizedPath);
    }
  }

  return discovered;
}

/** 只递归扫描应用源码与入口 HTML，避免深入 Vite optimizer 的第三方依赖产物。 */
function shouldDiscoverImports(pathname) {
  return isApplicationWarmupPath(pathname);
}

/** 请求 Vite renderer 模块并完整读取响应体，确认服务不是只打开了 TCP 端口。 */
function requestRendererPath(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: devServerHostname,
        port: devServerPort,
        path: pathname,
        headers: {
          accept: 'text/html,text/javascript,*/*',
        },
      },
      (response) => {
        const chunks = [];

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          chunks.push(chunk);
        });
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) {
            resolve(chunks.join(''));
            return;
          }

          const errorMessage = `${pathname} 返回 HTTP ${statusCode}`;
          reject(statusCode === 404 ? new SkippableHttpError(errorMessage) : new Error(errorMessage));
        });
      },
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`${pathname} 请求超时 ${REQUEST_TIMEOUT_MS}ms`));
    });
    request.on('error', reject);
  });
}

/** 持续等待单个模块成功返回，覆盖 Vite optimizer 卡住首个请求的场景。 */
async function waitForRendererPath(pathname, deadlineMs) {
  let lastError = null;

  while (Date.now() < deadlineMs) {
    try {
      const body = await requestRendererPath(pathname);
      console.log(`[wait-renderer] ready ${pathname}`);
      return body;
    } catch (error) {
      if (error instanceof SkippableHttpError) {
        console.log(`[wait-renderer] skip ${pathname}: ${getErrorMessage(error)}`);
        return '';
      }

      lastError = error;
      console.log(`[wait-renderer] waiting ${pathname}: ${getErrorMessage(error)}`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  throw new Error(`等待 ${pathname} 超时：${lastError ? getErrorMessage(lastError) : '未知错误'}`);
}

/** 递归预热 Vite 模块图，避免 Electron 首次打开时被按需转换阻塞成空白窗口。 */
async function main() {
  const deadlineMs = Date.now() + TOTAL_TIMEOUT_MS;
  const queue = [...RENDERER_WARMUP_PATHS];
  const visited = new Set();

  while (queue.length > 0) {
    const pathname = queue.shift();
    if (!pathname || visited.has(pathname)) continue;
    if (visited.size >= MAX_WARMED_PATHS) {
      throw new Error(`预热模块数量超过上限 ${MAX_WARMED_PATHS}，请检查是否出现循环资源。`);
    }

    visited.add(pathname);
    const body = await waitForRendererPath(pathname, deadlineMs);

    for (const discoveredPath of discoverLocalImports(pathname, body)) {
      if (!visited.has(discoveredPath)) queue.push(discoveredPath);
    }
  }

  console.log(`[wait-renderer] Vite renderer is ready. warmed=${visited.size}`);
}

void main().catch((error) => {
  console.error(`[wait-renderer] Vite renderer 启动等待失败：${getErrorMessage(error)}`);
  process.exitCode = 1;
});
