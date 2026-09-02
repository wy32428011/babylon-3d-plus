import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
after(() => viteServer.close());

const { createCssProjectiveMatrix } = await viteServer.ssrLoadModule('/src/runtime/babylon/DataPlatformScreenOverlay.tsx') as typeof import('../../src/runtime/babylon/DataPlatformScreenOverlay');

test('大屏 Overlay 投影矩阵在正面视角下保持像素对齐', () => {
  assert.equal(createCssProjectiveMatrix(1000, 1000, [
    { x: 10, y: 20 },
    { x: 1010, y: 20 },
    { x: 1010, y: 1020 },
    { x: 10, y: 1020 },
  ]), 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,10,20,0,1)');
});

test('大屏 Overlay 投影矩阵拒绝退化四边形', () => {
  assert.equal(createCssProjectiveMatrix(1000, 1000, [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 200, y: 0 },
    { x: 300, y: 0 },
  ]), null);
});
