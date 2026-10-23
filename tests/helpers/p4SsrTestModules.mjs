import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

/** 一次构建真实测试模块图，避免动态 SSR 逐模块请求停滞，并保留共享模块单例。 */
export async function createP4SsrTestModules(entries) {
  const root = process.cwd();
  const dependencyRoot = path.resolve(root, 'node_modules');
  const output = await mkdtemp(path.join(dependencyRoot, '.p4-ssr-test-'));
  const inputs = Object.fromEntries(entries.map((entry, index) => [`entry${index}`, path.resolve(root, entry.replace(/^\//, ''))]));
  const moduleNames = new Map(entries.map((entry, index) => [entry, `entry${index}.mjs`]));
  const close = async () => {
    // 只清理本次创建且仍位于依赖目录下的测试产物。
    if (path.dirname(output) !== dependencyRoot || !path.basename(output).startsWith('.p4-ssr-test-')) {
      throw new Error('P4 SSR 测试临时目录范围无效');
    }
    await rm(output, { recursive: true, force: true });
  };
  try {
    await build({
      configFile: false,
      root,
      publicDir: false,
      logLevel: 'error',
      ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
      build: {
        ssr: true,
        outDir: output,
        rollupOptions: { input: inputs, output: { entryFileNames: '[name].mjs' } },
      },
    });
    return {
      async ssrLoadModule(entry) {
        const name = moduleNames.get(entry);
        if (!name) throw new Error(`未知 P4 SSR 测试入口：${entry}`);
        return import(pathToFileURL(path.join(output, name)).href);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
