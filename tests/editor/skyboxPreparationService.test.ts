import assert from 'node:assert/strict';
import test from 'node:test';
import { SKYBOX_ENVIRONMENT_RECIPE, type SkyboxEnvironmentResource } from '../../electron/shared/sceneSkyboxContract.ts';
import { prepareSceneSkyboxEnvironments, prepareSkyboxEnvironment } from '../../src/editor/assets/skyboxPreparationService.ts';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const sha = (seed: string) => seed.repeat(64).slice(0, 64);
function environmentFor(sourceSha256: string, faceSize: 256 | 512 | 1024 = 256): SkyboxEnvironmentResource {
  return { version: 1, format: 'env', sourceSha256, sourceRevision: sourceSha256, recipeKey: SKYBOX_ENVIRONMENT_RECIPE,
    sha256: sha('e'), byteLength: 1024, faceSize, sourceUrl: `editor-asset://local/env-${sourceSha256.slice(0, 4)}.env` };
}
const source = (name: string, extra: Record<string, unknown> = {}) => ({ sourcePath: `C:/sky/${name}.hdr`, sourceUrl: `editor-asset://local/${name}.hdr`,
  format: 'hdr' as const, assetRevision: sha(name[0]), resolution: 256 as const, ...extra });

type Api = {
  prepareSkyboxEnvironment: (request: { sourceUrl: string }) => Promise<unknown>;
  commitSkyboxEnvironment: (request: { token: string }) => Promise<unknown>;
  cancelSkyboxEnvironment: (token: string) => Promise<void>;
};
function install(api: Partial<Api>) {
  const calls = { prepare: [] as string[], commit: [] as string[], cancel: [] as string[] };
  (globalThis as { window?: unknown }).window = { editorApi: {
    prepareSkyboxEnvironment: async (request: { sourceUrl: string }) => { calls.prepare.push(request.sourceUrl); return api.prepareSkyboxEnvironment!(request); },
    commitSkyboxEnvironment: async (request: { token: string }) => { calls.commit.push(request.token); return api.commitSkyboxEnvironment!(request); },
    cancelSkyboxEnvironment: async (token: string) => { calls.cancel.push(token); },
  } };
  return calls;
}
const ticket = (name: string, environment: SkyboxEnvironmentResource | null = null) => ({ token: environment ? null : `token-${name}`,
  sourceUrl: `editor-asset://local/${name}.hdr`, sourceSha256: sha(name[0]), sourceRevision: sha(name[0]), faceSize: 256, recipeKey: SKYBOX_ENVIRONMENT_RECIPE, environment });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

test('同一来源的多个消费者共享一次准备任务，各自独立取消而不影响其他消费者', async () => {
  const gate = deferred<unknown>();
  const calls = install({ prepareSkyboxEnvironment: () => gate.promise });
  const first = new AbortController(), second = new AbortController();
  const a = prepareSkyboxEnvironment(source('alpha'), first.signal);
  const b = prepareSkyboxEnvironment(source('alpha'), second.signal);
  await tick();
  assert.equal(calls.prepare.length, 1, '同一键只能向主进程发起一次准备');
  first.abort();
  await assert.rejects(a, { name: 'AbortError' });
  gate.resolve(ticket('alpha', environmentFor(sha('a'))));
  assert.equal((await b).sourceSha256, sha('a'), '剩余消费者仍应得到结果');
  assert.equal(calls.cancel.length, 0);
});

test('最后一个消费者取消后任务终止，已发放的生成令牌被取消且不提交', async () => {
  const gate = deferred<unknown>();
  const calls = install({ prepareSkyboxEnvironment: () => gate.promise });
  const controller = new AbortController();
  const pending = prepareSkyboxEnvironment(source('bravo'), controller.signal);
  await tick();
  controller.abort(new DOMException('用户取消', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  gate.resolve(ticket('bravo'));
  await tick(); await tick();
  assert.deepEqual(calls.cancel, ['token-bravo'], '无人等待时必须取消主进程令牌');
  assert.deepEqual(calls.commit, [], '取消后的任务不得提交 ENV');
});

test('全局只有一个运行中的准备任务，其余按顺序等待，队列满后明确拒绝', async () => {
  const gates = new Map<string, Deferred<unknown>>();
  const calls = install({ prepareSkyboxEnvironment: request => {
    const gate = deferred<unknown>(); gates.set(request.sourceUrl, gate); return gate.promise;
  } });
  // 首字母取十六进制字符，使 assetRevision 与 ENV 的 sourceSha256 构成合法 SHA。
  const names = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
  const signals = names.map(() => new AbortController());
  const results = names.map((name, index) => prepareSkyboxEnvironment(source(name), signals[index].signal));
  await tick();
  assert.deepEqual(calls.prepare, ['editor-asset://local/a0.hdr'], '只允许一个任务占用 GPU/IPC');
  await assert.rejects(prepareSkyboxEnvironment(source('aoverflow'), new AbortController().signal), /队列已满/);
  gates.get('editor-asset://local/a0.hdr')!.resolve(ticket('a0', environmentFor(sha('a'))));
  await tick();
  assert.deepEqual(calls.prepare, ['editor-asset://local/a0.hdr', 'editor-asset://local/a1.hdr'], '前一个结束后才启动下一个');
  for (const controller of signals.slice(1)) controller.abort();
  // 已启动的任务仍在等待主进程返回；结束它们并确认全部令牌被取消，避免队列状态泄漏到后续用例。
  for (const [url, gate] of gates) if (url !== 'editor-asset://local/a0.hdr') gate.resolve(ticket(url.split('/').pop()!.replace('.hdr', '')));
  await Promise.allSettled(results.slice(1));
  await results[0];
  await tick(); await tick();
  assert.deepEqual(calls.prepare.length <= 2, true, '被取消的排队任务不得再占用主进程');
});

test('普通 Web 无桌面桥接时复用匹配 ENV，不匹配或缺失时给出明确错误', async () => {
  const calls = install({ prepareSkyboxEnvironment: async () => { throw new Error('不应调用'); } });
  (globalThis as { window?: unknown }).window = {};
  const environment = environmentFor(sha('c'));
  assert.equal((await prepareSkyboxEnvironment(source('charlie', { sourceAvailable: false, environment }), new AbortController().signal)).sha256, environment.sha256);
  await assert.rejects(prepareSkyboxEnvironment(source('charlie', { sourceAvailable: false }), new AbortController().signal), /尚未生成 ENV/);
  await assert.rejects(prepareSkyboxEnvironment(source('charlie', { sourceAvailable: false, environment, resolution: 512 }), new AbortController().signal), /尚未生成 ENV/);
  assert.deepEqual(calls.prepare, []);
});

test('场景批量准备只丰富副本；已取消的信号不修改任何内容', async () => {
  install({ prepareSkyboxEnvironment: async () => ticket('delta', environmentFor(sha('d'))) });
  const skybox = { ...source('delta') };
  const scene = { entityIds: ['sky'], entities: { sky: { id: 'sky', components: { skybox } } }, sceneSettings: {} };
  const snapshot = structuredClone(scene);
  const prepared = await prepareSceneSkyboxEnvironments(scene as never, new AbortController().signal);
  assert.notEqual(prepared, scene);
  assert.equal(prepared.entities.sky.components.skybox?.environment?.sha256, sha('e'));
  assert.deepEqual(scene, snapshot, '原场景对象不得被修改');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(prepareSceneSkyboxEnvironments(scene as never, aborted.signal), { name: 'AbortError' });
  assert.deepEqual(scene, snapshot);
});

test('连续取消的排队任务立即释放容量，最新请求仍可执行', async () => {
  const gate = deferred<unknown>();
  const calls = install({ prepareSkyboxEnvironment: request => request.sourceUrl.includes('block')
    ? gate.promise : Promise.resolve(ticket('alpha', environmentFor(sha('a')))) });
  const blocker = prepareSkyboxEnvironment(source('block'), new AbortController().signal);
  for (let index = 0; index < 16; index++) {
    const controller = new AbortController();
    const pending = prepareSkyboxEnvironment(source(`a${index}`), controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  }
  const latest = prepareSkyboxEnvironment(source('alpha'), new AbortController().signal);
  gate.resolve(ticket('block', environmentFor(sha('b'))));
  await blocker;
  assert.equal((await latest).sourceSha256, sha('a'));
  assert.equal(calls.prepare.length, 2, '已取消的等待任务不访问主进程');
});

test('同源不同场景会话不复用旧任务；已取消token在IPC返回时被回收', async () => {
  const gate = deferred<unknown>();
  const calls = install({ prepareSkyboxEnvironment: () => calls.prepare.length === 1
    ? gate.promise : Promise.resolve(ticket('alpha', environmentFor(sha('a')))) });
  const first = new AbortController();
  const old = prepareSkyboxEnvironment(source('alpha'), first.signal, undefined, 'session-A');
  const next = prepareSkyboxEnvironment(source('alpha'), new AbortController().signal, undefined, 'session-B');
  first.abort(); await assert.rejects(old, { name: 'AbortError' });
  gate.resolve(ticket('alpha'));
  assert.equal((await next).sourceSha256, sha('a'));
  assert.equal(calls.prepare.length, 2);
  assert.deepEqual(calls.cancel, ['token-alpha']);
});

test('桌面运行包仍由主进程验证ENV，不因无原图而绕过授权', async () => {
  const calls = install({ prepareSkyboxEnvironment: async () => { throw new Error('天空 ENV 文件未获得当前工程授权。'); } });
  await assert.rejects(prepareSkyboxEnvironment(source('alpha', { sourceAvailable: false, environment: environmentFor(sha('a')) }),
    new AbortController().signal), /授权/);
  assert.equal(calls.prepare.length, 1);
});
