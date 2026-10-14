import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import { buildAnalysisPlugins } from './scripts/build-analysis-plugin';
import { isAllowedDevAssetPath, resolveDevAssetRoots } from './scripts/dev-asset-paths';

const workspaceRoot = process.cwd();

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
    cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
    plugins: [react(), editorLocalAssetDevServerPlugin(devAssetRoots), ...buildAnalysisPlugins('editor')],
    optimizeDeps: {
      // 历史验收与打包目录中也有 HTML，只从实际编辑器入口扫描依赖。
      entries: ['index.html'],
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      watch: {
        // 生成目录无需热更新，避免为历史缓存和安装包建立大量文件监听。
        ignored: ['output', 'release', 'dist-electron', 'dist-viewer-template'].map(
          (directory) => `${path.resolve(workspaceRoot, directory).replaceAll('\\', '/')}/**`,
        ),
      },
      fs: {
        allow: devAssetRoots,
      },
    },
  };
});
