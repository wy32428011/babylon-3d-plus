import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';
const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'electron' ? { url: 'data:text/javascript,export const BrowserWindow = { getAllWindows: () => [] };', shortCircuit: true } : next(specifier, context);
} });
let cleanupModules: (() => void) | undefined;
after(() => { hooks.deregister(); cleanupModules?.(); });
const [{ executeDataPlatformSkyboxSync }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/dataPlatformSkyboxSync'),
]>(['electron/ipc/dataPlatformSkyboxSync.ts'], { deferCleanup: cleanup => { cleanupModules = cleanup; } });
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skybox-sync-queue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
const emptyPage = { success: true, data: { records: [], total: '0', pageNum: '1', pageSize: '100' } };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
test('同根执行入口串行，首个失败后仍允许下一次执行', async t => {
  const editorRoot = await fixture(t); const entered = deferred(), release = deferred(); let calls = 0;
  const dependencies = { requestJson: async () => { calls++; if (calls === 1) { entered.resolve(); await release.promise; throw new Error('first failed'); } return emptyPage; } };
  const first = executeDataPlatformSkyboxSync({ editorRoot, baseUrl: 'http://localhost', contextKey: null, dependencies });
  const failure = assert.rejects(first, /first failed/); await entered.promise;
  const second = executeDataPlatformSkyboxSync({ editorRoot: path.join(editorRoot, '.'), baseUrl: 'http://localhost', contextKey: null, dependencies });
  await new Promise(r => setImmediate(r));
  const callsBeforeRelease = calls;
  release.resolve(); await failure; await second;
  assert.equal(callsBeforeRelease, 1, '第二个调用在前次完成前不得查询或修改索引'); assert.equal(calls, 2);
});
test('排队取消立即返回且不会启动查询', async t => {
  const editorRoot = await fixture(t); const entered = deferred(), release = deferred(); let queuedCalls = 0;
  const first = executeDataPlatformSkyboxSync({ editorRoot, baseUrl: 'http://localhost', contextKey: null, dependencies: { requestJson: async () => { entered.resolve(); await release.promise; return emptyPage; } } });
  await entered.promise;
  const controller = new AbortController();
  const second = executeDataPlatformSkyboxSync({ editorRoot, baseUrl: 'http://localhost', contextKey: null, signal: controller.signal, dependencies: { requestJson: async () => { queuedCalls++; return emptyPage; } } });
  controller.abort();
  try { await assert.rejects(second, { name: 'AbortError' }); assert.equal(queuedCalls, 0); }
  finally { release.resolve(); await first; }
});
