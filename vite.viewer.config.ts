import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));

/** 构建可被部署导出器直接复制的独立 Web Viewer 模板。 */
export default defineConfig({
  root: path.join(workspaceRoot, 'src', 'player'),
  base: './',
  cacheDir: path.join(workspaceRoot, 'node_modules', '.vite-viewer'),
  plugins: [react()],
  build: {
    outDir: path.join(workspaceRoot, 'dist-viewer-template'),
    emptyOutDir: true,
  },
});
