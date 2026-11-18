import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(fixtureDirectory, '../../..');
const logicalModelUrl = `editor-asset://local/${encodeURIComponent('project/assets/assembly-animation.glb')}`;
const config = {
  version: 2,
  page: { title: '详情页隔离测试', loadingText: '加载', backgroundColor: '#111111' },
  paths: {
    scene: './project/scene.json',
    assetManifest: './project/asset-manifest.json',
    assetBase: './project/assets/',
  },
  viewer: { showGrid: false, allowCameraControl: true, showStatusOverlay: false },
  mqtt: {
    enabled: false, ip: '', address: '', topic: '', subscriptions: [],
    simulatorEnabled: false, simulatorAssetCode: '', simulatorScenario: 'cycle', simulatorIntervalMs: 500,
  },
  digitalTwin: { projectId: '9007199254740993', runtimeConfigEndpoint: './runtime-fixture' },
};

/** 只为测试提供隔离资源，详情页本身仍从正式入口加载。 */
function inspectionFixture() {
  return {
    name: 'inspection-page-fixture',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        const json = (value) => {
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify(value));
        };
        if (pathname === '/') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end('<!doctype html><a href="/host.html">打开详情页隔离测试</a>');
          return;
        }
        if (pathname === '/inspection.html') {
          const original = readFileSync(path.join(workspace, 'src/player/inspection.html'), 'utf8');
          const entry = `/@fs/${path.join(workspace, 'src/inspection/inspectionMain.tsx').replaceAll('\\', '/')}`;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(original.replace('../inspection/inspectionMain.tsx', entry));
          return;
        }
        if (pathname === '/runtime-config.json') return json(config);
        if (pathname === '/runtime-fixture') {
          if (request.method !== 'POST') {
            response.statusCode = 405;
            response.end();
            return;
          }
          return json({ success: true, data: { projectId: config.digitalTwin.projectId, runtimeEnabled: true, configJson: '{}' } });
        }
        if (pathname === '/project/asset-manifest.json') {
          return json({ version: 1, assets: [{ logicalUrl: logicalModelUrl, path: './assembly-animation.glb' }] });
        }
        if (pathname === '/api/v1/files/external.gltf') {
          return json({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'external.bin' }] });
        }
        if (pathname === '/project/assets/assembly-animation.glb' || pathname === '/api/v1/files/assembly-animation.glb') {
          response.setHeader('Content-Type', 'model/gltf-binary');
          response.setHeader('Cache-Control', 'no-store');
          response.end(readFileSync(path.join(fixtureDirectory, 'assembly-animation.glb')));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root: fixtureDirectory,
  cacheDir: path.join(workspace, '.claude', 'inspection-fixture-vite-cache'),
  plugins: [inspectionFixture()],
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
  server: { host: '127.0.0.1', port: 5247, strictPort: true, fs: { allow: [workspace] } },
});
