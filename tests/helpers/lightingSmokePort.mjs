import { createServer } from 'node:net';

/** Vite 的 port:0 会回退项目默认端口；先由系统挑选非零端口，不占用或终止用户服务。 */
export async function findLightingSmokePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const address = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string' || !address.port) throw new Error('无法分配本次光照验收的 loopback 端口');
  return address.port;
}
