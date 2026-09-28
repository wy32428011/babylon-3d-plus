import { createServer } from 'vite';
import path from 'node:path';
import react from '@vitejs/plugin-react';

// 限定演示入口，避免扫描已导出的离线 HTML 与多个 DIST 包，缩短视觉验收冷启动。
const server = await createServer({
  configFile: false, root: process.cwd(),
  plugins: [react()],
  cacheDir: path.resolve('node_modules/.vite-geographic-opening-demo'),
  optimizeDeps: { noDiscovery: false, include: ['react','react-dom/client','react/jsx-runtime','zustand','mqtt','typescript','@linkiez/dxf-renew','lodash/cloneDeep'],
    entries: ['tests/fixtures/geographicOpeningDemo.html','tests/fixtures/geographicOpeningEditor.html'] },
  server: { host: '127.0.0.1', port: Number(process.env.OPENING_PORT || 5198), strictPort: true, hmr: false,
    watch: { ignored: ['**/output/**'] } },
});
await server.listen();
console.log(server.resolvedUrls.local[0]);
const close = async () => { await server.close(); process.exit(0); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
