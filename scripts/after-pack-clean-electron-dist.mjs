import { rm } from 'node:fs/promises';
import path from 'node:path';

/** 清理自定义 electronDist 复制进生产目录、但应用运行不需要的 Electron 默认入口。 */
export default async function cleanElectronDistExtras(context) {
  if (context.electronPlatformName !== 'win32') return;

  await Promise.all([
    rm(path.join(context.appOutDir, 'resources', 'default_app.asar'), { force: true }),
    rm(path.join(context.appOutDir, 'version'), { force: true }),
  ]);
}
