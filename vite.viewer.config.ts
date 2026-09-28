import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { createViewerTemplateCapabilities, VIEWER_TEMPLATE_CAPABILITIES_PATH } from './electron/ipc/viewerTemplateCapabilities';

const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));

function viewerCapabilitiesPlugin(): Plugin {
  return {
    name: 'viewer-template-capabilities',
    enforce: 'post',
    async writeBundle(options, bundle) {
      if (!options.dir) throw new Error('Viewer 能力清单需要有效的构建输出目录。');
      const outputRoot = options.dir;
      const outputs = Object.values(bundle);
      const readOutput = async (fileName: string) => ({
        path: fileName, content: await fs.readFile(path.resolve(outputRoot, fileName)),
      });
      // Vite 内置的后置处理仍会改变 generateBundle 中的入口；只对最终落盘字节签名。
      // 全部 JS chunk（含可见的 worker 输出）和 CSS 都属于当前 Viewer 的必要运行代码。
      const entryFiles = await Promise.all(outputs.filter(output => output.type === 'chunk'
        || output.fileName === 'index.html' || /\.(?:css|js)$/.test(output.fileName))
        .map(output => readOutput(output.fileName)));
      const openingAssets = await Promise.all(outputs.flatMap(output => {
        if (output.type !== 'asset') return [];
        const sourceName = output.names.find(name => /^asset-(?:10|[1-9])\.webp$/.test(name));
        return sourceName ? [readOutput(output.fileName).then(file => ({ id: sourceName.slice(0, -5), ...file }))] : [];
      }));
      const manifest = createViewerTemplateCapabilities(entryFiles, openingAssets);
      await fs.writeFile(path.join(outputRoot, VIEWER_TEMPLATE_CAPABILITIES_PATH),
        JSON.stringify(manifest, null, 2) + '\n');
    },
  };
}

/** 构建可被部署导出器直接复制的独立 Web Viewer 模板。 */
export default defineConfig({
  root: path.join(workspaceRoot, 'src', 'player'),
  base: './',
  cacheDir: path.join(workspaceRoot, 'node_modules', '.vite-viewer'),
  publicDir: path.join(workspaceRoot, 'public'),
  plugins: [react(), viewerCapabilitiesPlugin()],
  build: {
    outDir: path.join(workspaceRoot, 'dist-viewer-template'),
    emptyOutDir: true,
  },
});
