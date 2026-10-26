import net from 'node:net';
import { createServer } from 'vite';

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

/**
 * 天空盒真实 GPU/Electron 验证自带的 Vite 服务：端口由本次验证独占，调用方只关闭自己创建的服务。
 * 关闭文件监视，避免扫描体积巨大的 output/ 目录拖慢模块加载。
 */
export async function startSkyboxViteServer() {
  const server = await createServer({ server: { host: '127.0.0.1', port: await freePort(), strictPort: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', '@babylonjs/core', '@babylonjs/loaders', '@linkiez/dxf-renew', 'typescript', 'mqtt', 'zustand', 'fflate'] } });
  await server.listen();
  await server.watcher.close();
  return { server, origin: server.resolvedUrls.local[0].replace(/\/$/, ''), close: () => server.close() };
}
