import { babylonCodeSplitting } from './scripts/babylon-build-chunks';
import { precompileModelScriptFile } from './electron/ipc/modelScriptCompiler';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import { buildAnalysisPlugins } from './scripts/build-analysis-plugin';
import { isAllowedDevAssetPath, resolveDevAssetRoots } from './scripts/dev-asset-paths';

const workspaceRoot = process.cwd();

/** 锚定工作区顶层的监听忽略目录：含运行期工程数据、构建验收产物及本机工具目录。 */
const IGNORED_WATCH_ROOT_DIRECTORIES = [
  'Conflicts',
  'Platforms',
  'SharedResources',
  'Projects',
  'Assets',
  'Scenes',
  'output',
  'release',
  'dist',
  'dist-electron',
  'dist-viewer-template',
  'artifacts',
  'test-artifacts',
  '_staging',
  '.idea',
  '.claude',
  '.omc',
  '.omx',
  '.superpowers',
  '.playwright-cli',
  '.playwright-mcp',
  '.remote-audit-temp',
  '.codex-remote-env',
] as const;

const IGNORED_WATCH_ROOT_PREFIXES = ['.tmp-', '.zending-write-probe-'] as const;
const BABYLON_EDITOR_METADATA_PATTERN = /(^|\/)\.babylon-editor(\/|$)/i;
const TRANSIENT_WATCHER_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT']);
const TRANSIENT_WATCHER_WARN_COOLDOWN_MS = 5_000;

function normalizeWatchPath(filePath: string): string {
  const resolved = path.resolve(filePath).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 构造锚定工作区顶层的监听过滤函数，免疫 Windows 盘符大小写及路径中的 glob 元字符，且不误伤 src/assets。 */
function createWorkspaceWatchIgnoredMatcher(rootDir: string): (targetPath: string) => boolean {
  const normalizedRoot = normalizeWatchPath(rootDir).replace(/\/+$/, '');
  const rootPrefix = `${normalizedRoot}/`;
  const ignoredDirectories = new Set(
    IGNORED_WATCH_ROOT_DIRECTORIES.map((directory) =>
      process.platform === 'win32' ? directory.toLowerCase() : directory,
    ),
  );
  const ignoredPrefixes = IGNORED_WATCH_ROOT_PREFIXES.map((prefix) =>
    process.platform === 'win32' ? prefix.toLowerCase() : prefix,
  );

  return (targetPath: string): boolean => {
    const normalized = normalizeWatchPath(targetPath);
    if (BABYLON_EDITOR_METADATA_PATTERN.test(normalized)) return true;
    if (!normalized.startsWith(rootPrefix)) return false;
    const relative = normalized.slice(rootPrefix.length);
    if (!relative) return false;
    const slashIndex = relative.indexOf('/');
    const topSegment = slashIndex === -1 ? relative : relative.slice(0, slashIndex);
    if (ignoredDirectories.has(topSegment)) return true;
    return ignoredPrefixes.some((prefix) => topSegment.startsWith(prefix));
  };
}

/** 兜底处理 Windows 杀毒或加密驱动引发的瞬态文件监听异常，避免未捕获的 watcher error 击穿开发服务器。 */
function devWatcherErrorGuardPlugin(): Plugin {
  return {
    name: 'dev-watcher-error-guard',
    apply: 'serve',
    configureServer(server) {
      const lastWarnAtByKey = new Map<string, number>();
      server.watcher.on('error', (error: unknown) => {
        const errno = error && typeof error === 'object' ? (error as NodeJS.ErrnoException) : null;
        const code = typeof errno?.code === 'string' ? errno.code : '';
        const targetPath = typeof errno?.path === 'string' ? errno.path : '';
        if (TRANSIENT_WATCHER_ERROR_CODES.has(code)) {
          const now = Date.now();
          const key = `${code}:${targetPath}`;
          const lastWarnAt = lastWarnAtByKey.get(key) ?? 0;
          if (now - lastWarnAt < TRANSIENT_WATCHER_WARN_COOLDOWN_MS) return;
          if (lastWarnAtByKey.size >= 256) lastWarnAtByKey.clear();
          lastWarnAtByKey.set(key, now);
          server.config.logger.warn(
            `[vite-watcher] 忽略瞬态文件监听异常 (${code})${targetPath ? `: ${targetPath}` : ''}`,
          );
          return;
        }
        server.config.logger.error(
          `[vite-watcher] 文件监听发生异常${code ? ` (${code})` : ''}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
  };
}

/** 根据扩展名返回最小 MIME，保证 GLB、脚本和贴图都按原文返回给运行时。 */
function getDevAssetContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.glb') return 'model/gltf-binary';
  if (extension === '.gltf') return 'model/gltf+json; charset=utf-8';
  if (extension === '.ts' || extension === '.js' || extension === '.json') return 'text/plain; charset=utf-8';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

/** 开发期只读地暴露 editor-asset 本地文件，避免 Vite 转译模型包脚本。 */
function editorLocalAssetDevServerPlugin(devAssetRoots: string[]): Plugin {
  return {
    name: 'editor-local-asset-dev-server',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__editor_asset__', (request, response, next) => {
        const encodedPath = request.url?.replace(/^\//, '').split('?')[0] ?? '';
        let filePath: string;

        try {
          filePath = decodeURIComponent(encodedPath);
        } catch {
          response.statusCode = 400;
          response.end('Invalid asset path.');
          return;
        }

        if (!isAllowedDevAssetPath(filePath, devAssetRoots) || !existsSync(filePath) || !statSync(filePath).isFile()) {
          response.statusCode = 404;
          response.end('Asset not found.');
          return;
        }

        if (new URL(request.url ?? '/', 'http://localhost').searchParams.get('modelScriptCompiled') === '1') {
          if (!/\.ts$/i.test(filePath)) { response.statusCode = 400; response.end('仅支持模型 TypeScript 脚本。'); return; }
          void precompileModelScriptFile(filePath).then(artifact => {
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.end(JSON.stringify(artifact));
          }).catch(next);
          return;
        }
        response.setHeader('Content-Type', getDevAssetContentType(filePath));
        createReadStream(filePath).on('error', next).pipe(response);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const devAssetRoots = resolveDevAssetRoots(workspaceRoot, mode);
  return {
    base: './',
    build: { rolldownOptions: { output: { strictExecutionOrder: true, codeSplitting: babylonCodeSplitting() } } },
    cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
    plugins: [react(), devWatcherErrorGuardPlugin(), editorLocalAssetDevServerPlugin(devAssetRoots), ...buildAnalysisPlugins('editor')],
    optimizeDeps: {
      // 只扫描产品入口；提前收集懒加载转换器，避免首次导入天空时预构建触发整页重载。
      entries: ['index.html', 'src/editor/assets/skyboxEnvironmentCompiler.ts', 'src/runtime/babylon/skyboxDecodedData.worker.ts'],
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      watch: {
        // 生成目录无需热更新，避免为历史缓存和安装包建立大量文件监听。
        // 数据中台工作区（Platforms）、冲突副本（Conflicts）、共享资源库和任何 .babylon-editor 暂存目录由编辑器主进程读写；
        // Windows 下 chokidar 持有的文件/目录监听句柄会导致原子替换报 EPERM，或在文件写入/加密驱动扫描瞬间触发未捕获 EBUSY 崩溃，
        // 因此改用锚定工作区顶层的函数过滤器统一排除。
        ignored: createWorkspaceWatchIgnoredMatcher(workspaceRoot),
      },
      fs: {
        allow: devAssetRoots,
      },
    },
  };
});
