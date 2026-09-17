import { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

/** 预构建共用模块，绕过动态 SSR 加载停滞；保持单个遥测 Store 实例。 */
export async function buildAlarmTestModules(includeRuntime = false) {
  const output = await mkdtemp(path.resolve('node_modules/.alarm-test-'));
  const cleanup = async () => {
    if (path.dirname(output) !== path.resolve('node_modules') || !path.basename(output).startsWith('.alarm-test-')) throw new Error('报警测试临时目录范围无效');
    await rm(output, { recursive: true, force: true });
  };
  after(cleanup);
  const input = {
    alarmManager: 'src/editor/model/alarmManager.ts', deviceTelemetry: 'src/runtime/mqtt/deviceTelemetry.ts',
    ...(includeRuntime ? {
      SceneDocument: 'src/editor/model/SceneDocument.ts', SceneSerializer: 'src/editor/project/SceneSerializer.ts',
      editModeModelThinInstances: 'src/editor/model/editModeModelThinInstances.ts',
      editorStore: 'src/editor/store/editorStore.ts', AlarmManagerRuntime: 'src/runtime/babylon/AlarmManagerRuntime.ts',
    } : {}),
  };
  try {
    await build({ configFile: false, publicDir: false, logLevel: 'silent', ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
      build: { ssr: true, outDir: output, rollupOptions: { input, output: { entryFileNames: '[name].mjs' } } } });
    return { ssrLoadModule: async source => {
      const name = path.basename(source, '.ts');
      if (!Object.hasOwn(input, name)) throw new Error('未知报警测试模块：' + source);
      return import(pathToFileURL(path.join(output, name + '.mjs')).href);
    } };
  } catch (error) { await cleanup(); throw error; }
}
