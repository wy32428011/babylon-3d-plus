import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../../src/runtime/babylon/SceneSkyboxRuntime.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('SceneSkyboxRuntime.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const runtimeClass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SceneSkyboxRuntime');
assert.ok(runtimeClass && ts.isClassDeclaration(runtimeClass));
const methodNames = ['sync', 'getReadiness', 'retry', 'startLoad', 'commitLoadedSkybox', 'handleLoadError', 'cancelPending', 'dispose'];
const methods = methodNames.map(name => {
  const method = runtimeClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
  assert.ok(method, `missing runtime method ${name}`);
  return method.getText(ast);
});
const helpers = ['createSceneSkyboxSignature', 'createVersionedRuntimeUrl', 'getEntityKey'].map(name => {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `missing runtime helper ${name}`);
  return declaration.getText(ast).replace(/^export /, '');
});
const fields = runtimeClass.members.filter(node => ts.isPropertyDeclaration(node) && node.initializer).map(node => node.getText(ast));
// 直接运行产品方法，只替换 GPU 对象和网络传输；不复制状态机实现。
const executable = ts.transpileModule(`${helpers.join('\n')}
class RuntimeState {
  ${fields.join('\n')}
  ${methods.join('\n')}
}
RuntimeState;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

type Texture = { id: string; disposed: number; dispose(): void };
type Request = { url: string; signal: AbortSignal; resolve(texture: Texture): void; reject(error: Error): void };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function texture(id: string): Texture {
  return { id, disposed: 0, dispose() { this.disposed += 1; } };
}
function target(url: string, revision = 'weak-v1', resolution = 256, entityId = 'skybox') {
  return { entityId, skybox: { format: 'exr', sourceUrl: url, assetRevision: revision, resolution }, visible: true };
}
function fixture() {
  const requests: Request[] = [];
  const changes: Array<{ phase: string; sourceUrl: string | null; message: string | null }> = [];
  const Runtime = runInNewContext(executable, {
    AbortController, Error, LEGACY_SKYBOX_ENTITY_KEY: 'legacy', resolveRuntimeAssetUrl: (url: string) => url,
    loadSkyboxTexture: (url: string, signal: AbortSignal) => new Promise((resolve, reject) => {
      requests.push({ url, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(Object.assign(new Error('取消'), { name: 'AbortError' })), { once: true });
    }),
  });
  const runtime = new Runtime();
  runtime.scene = { getEngine: () => ({ _features: { allowTexturePrefiltering: false } }) };
  runtime.pushLog = () => undefined;
  runtime.onReadinessChanged = (state: any) => changes.push(state);
  runtime.selectionHighlightLayer = { dispose() {} };
  runtime.createActiveSkybox = (entityKey: string) => ({ entityKey, signature: null, texture: null });
  runtime.disposeActive = () => { runtime.active?.texture?.dispose(); runtime.active = null; };
  runtime.applyTarget = () => undefined;
  runtime.installReflectionTexture = () => undefined;
  return { runtime, requests, changes };
}

test('有效 A 切到失败 B 后切回 A，立即清除旧错误并复用已加载纹理', async () => {
  const f = fixture(); const original = texture('A');
  f.runtime.sync(target('A.exr')); f.requests[0].resolve(original); await tick();
  assert.equal(f.runtime.getReadiness().phase, 'ready');
  f.runtime.sync(target('B.exr')); f.requests[1].reject(new Error('B 损坏')); await tick();
  assert.equal(f.runtime.getReadiness().phase, 'error');
  assert.equal(f.runtime.active.texture, original, '失败 B 必须保留 A 的有效效果');
  f.runtime.sync(target('A.exr'));
  assert.equal(f.runtime.getReadiness().phase, 'ready');
  assert.equal(f.runtime.getReadiness().message, null);
  assert.equal(f.runtime.getReadiness().sourceUrl, 'A.exr');
  assert.equal(f.changes.at(-1)?.phase, 'ready');
  assert.equal(f.requests.length, 2);
  assert.equal(original.disposed, 0);
});

test('同失败签名的普通同步不自动重试，显式 retry 只启动一个在途请求且成功后恢复', async () => {
  const f = fixture();
  f.runtime.sync(target('broken.exr')); f.requests[0].reject(new Error('解码失败')); await tick();
  for (let index = 0; index < 6; index++) f.runtime.sync({ ...target('broken.exr'), selected: index % 2 === 0 });
  assert.equal(f.requests.length, 1);
  assert.equal(f.runtime.getReadiness().phase, 'error');
  f.runtime.retry(); f.runtime.retry();
  assert.equal(f.requests.length, 2);
  assert.equal(f.runtime.getReadiness().phase, 'loading');
  f.requests[1].resolve(texture('repaired')); await tick();
  assert.equal(f.runtime.getReadiness().phase, 'ready');
  f.runtime.retry();
  assert.equal(f.requests.length, 2, 'ready 状态不能被显式 retry 重建');
});

test('失败目标的资源修订变化允许正常启动，旧失败回调不能污染新一轮', async () => {
  const f = fixture();
  f.runtime.sync(target('same.exr', 'v1'));
  const old = { ...f.runtime.pending };
  f.requests[0].reject(new Error('v1 失败')); await tick();
  f.runtime.sync(target('same.exr', 'v2'));
  assert.equal(f.requests.length, 2);
  f.runtime.handleLoadError(old.token, old.entityKey, old.signature, new Error('迟到的 v1 错误'));
  assert.equal(f.runtime.getReadiness().phase, 'loading');
  f.requests[1].resolve(texture('v2')); await tick();
  assert.equal(f.runtime.getReadiness().phase, 'ready');
});

test('完整 SHA-256 的 SOURCE 与共享缓存复用进行中的读取，最终状态采用当前引用', async () => {
  const f = fixture(); const hash = 'ab'.repeat(32);
  f.runtime.sync(target('source/skybox.exr', hash));
  f.runtime.sync(target('shared/skybox.exr', hash.toUpperCase()));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].signal.aborted, false);
  f.requests[0].resolve(texture('shared-content')); await tick();
  assert.equal(f.runtime.getReadiness().phase, 'ready');
  assert.equal(f.runtime.getReadiness().sourceUrl, 'shared/skybox.exr');
  f.runtime.sync(target('third/skybox.exr', hash));
  assert.equal(f.requests.length, 1, '已经成功的内容同样跨路径复用');
});

test('弱修订保留 URL 隔离，相同内容更换分辨率也必须重新准备', async () => {
  for (const revision of ['weak-v1', '', 'a'.repeat(63), 'g'.repeat(64)]) {
    const f = fixture();
    f.runtime.sync(target('source.exr', revision));
    f.runtime.sync(target('shared.exr', revision));
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].signal.aborted, true);
    f.runtime.dispose(); await tick();
  }
  const f = fixture(); const hash = 'aa'.repeat(32);
  f.runtime.sync(target('source.exr', hash, 256)); f.requests[0].resolve(texture('small')); await tick();
  f.runtime.sync(target('shared.exr', hash, 512));
  assert.equal(f.requests.length, 2);
  assert.equal(f.runtime.getReadiness().phase, 'loading');
  f.runtime.dispose(); await tick();
});

test('新目标加载中切回有效 A 会取消 B，迟到成功结果必须释放且不能覆盖 A', async () => {
  const f = fixture(); const a = texture('A');
  f.runtime.sync(target('A.exr')); f.requests[0].resolve(a); await tick();
  f.runtime.sync(target('B.exr')); const old = { ...f.runtime.pending };
  f.runtime.sync(target('A.exr'));
  assert.equal(f.requests[1].signal.aborted, true);
  const late = texture('late-B');
  f.runtime.commitLoadedSkybox(old.token, old.entityKey, old.signature, late); await tick();
  assert.equal(late.disposed, 1);
  assert.equal(f.runtime.active.texture, a);
  assert.equal(f.runtime.getReadiness().phase, 'ready');
});

test('清除或释放场景会取消在途加载，旧错误和显式 retry 不能重启已退出的资源', async () => {
  for (const operation of ['clear', 'dispose']) {
    const f = fixture();
    f.runtime.sync(target('pending.exr')); const old = { ...f.runtime.pending };
    if (operation === 'clear') f.runtime.sync(null); else f.runtime.dispose();
    assert.equal(f.requests[0].signal.aborted, true);
    f.runtime.handleLoadError(old.token, old.entityKey, old.signature, new Error('迟到失败'));
    f.runtime.retry(); await tick();
    assert.equal(f.runtime.getReadiness().phase, 'idle');
    assert.equal(f.runtime.getReadiness().message, null);
    assert.equal(f.requests.length, 1);
  }
});
