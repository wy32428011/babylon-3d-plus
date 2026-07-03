import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const workspaceRoot = process.cwd();
const modelLibraryRoot = path.resolve(process.env.STACKER_MODEL_LIBRARY_ROOT ?? 'F:/3d-models');
const devAssetRoots = [workspaceRoot, modelLibraryRoot];

/** 判断请求文件是否位于允许的开发期本地资产根目录内。 */
function isAllowedDevAssetPath(filePath: string): boolean {
  const resolvedFilePath = path.resolve(filePath);

  return devAssetRoots.some((root) => {
    const relativePath = path.relative(root, resolvedFilePath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
  });
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
function editorLocalAssetDevServerPlugin(): Plugin {
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

        if (!isAllowedDevAssetPath(filePath) || !existsSync(filePath) || !statSync(filePath).isFile()) {
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

export default defineConfig({
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
  plugins: [react(), editorLocalAssetDevServerPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      allow: [workspaceRoot, modelLibraryRoot],
    },
  },
});
