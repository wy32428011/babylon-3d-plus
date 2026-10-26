import assert from 'node:assert/strict';
import test from 'node:test';
import { PROJECT_OPEN_PHASES, PROJECT_OPEN_TRACE_LIMIT, type ProjectOpenTraceContext } from '../../electron/shared/projectOpenTrace.ts';
import { ProjectOpenTraceStore } from '../../electron/ipc/projectOpenTraceStore.ts';
import { RendererProjectOpenTraceStore } from '../../src/editor/loading/projectOpenTrace.ts';

const id = (n: number) => n.toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111';
const context = (n: number): ProjectOpenTraceContext => ({ version: 1, openId: id(n), detail: 'assets' });

test('main只读getter严格sender owner，不把openId变成权限；重复ID不能覆盖/借用', () => {
  const store = new ProjectOpenTraceStore({ now: () => 10 }), recorder = store.start(10, context(1)); assert.ok(recorder);
  recorder.beginPhase('projectResolve').end();
  assert.equal(store.read(11, id(1)), null); assert.equal(store.forOwner(11, id(1)), null); assert.equal(store.read(0, id(1)), null);
  assert.equal(store.read(10, id(2)), null); assert.equal(store.start(11, context(1)), null); assert.equal(store.start(10, context(1)), null);
  assert.equal(store.read(10, id(1))?.openId, id(1)); assert.equal(store.stats().retainedTraces, 1);
  const snapshot = store.read(10, id(1))!; snapshot.spans[0].status = 'error';
  assert.equal(store.read(10, id(1))?.spans[0].status, 'ok');
});

test('main 8次有界，优先淘汰本地已结算项，满在途时丢诊断而不关其它owner', () => {
  const store = new ProjectOpenTraceStore({ now: () => 10 }), pending = [];
  for (let n = 1; n <= PROJECT_OPEN_TRACE_LIMIT; n++) { const recorder = store.start(n, context(n)); assert.ok(recorder); pending.push(recorder.beginPhase('projectResolve')); }
  assert.equal(store.start(9, context(9)), null); assert.equal(store.stats().retainedTraces, 8);
  assert.equal(store.closeOwner(1), 1); assert.equal(store.read(2, id(2))?.status, 'active');
  assert.equal(store.start(9, context(9)), null, '取消后的真实在途收束仍不可被覆盖');
  pending[0].end(); assert.ok(store.start(9, context(9))); assert.equal(store.read(1, id(1)), null); assert.equal(store.stats().evictedTraces, 1);
});

test('main后续资源IPC复用显式上下文，project阶段已结算即可有限淘汰，读取不启动任务', () => {
  let reads = 0; const store = new ProjectOpenTraceStore({ now: () => ++reads });
  const first = store.start(1, context(1)); assert.ok(first);
  for (const phase of PROJECT_OPEN_PHASES.slice(0, 4)) first.beginPhase(phase).end();
  const later = store.forOwner(1, id(1)); assert.equal(later === first, true);
  const task = later!.beginTask('resourceDownload', 'sceneCommitResourceSync'); task.end();
  const snapshot = store.read(1, id(1))!; assert.equal(snapshot.spans.filter(span => span.stage === 'resourceDownload').length, 1);
  assert.equal(store.closeOwner(1), 0, '后续关闭不能改写本地已结算的历史main记录');
  assert.equal(store.read(1, id(1))?.status, 'active', 'main envelope仍可接受同open后续资源IPC，整体ready由renderer决定');
  const before = reads; assert.equal(store.read(2, id(1)), null); assert.equal(reads, before, '非owner读取不运行诊断时钟');
  for (let n = 2; n <= 8; n++) assert.ok(store.start(n, context(n)));
  assert.ok(store.start(9, context(9))); assert.equal(store.stats().retainedTraces, 8);
});

test('renderer仅在提交后绑定一次，两个scene/open不能互抢，旧token晚到不污染新上下文', async () => {
  let time = 0;
  const store = new RendererProjectOpenTraceStore({ now: () => time }), first = store.start(context(1)), second = store.start(context(2));
  assert.ok(first && second); assert.equal(store.bindScene(id(1), 'scene_session_A'), true);
  assert.equal(store.bindScene(id(1), 'scene_session_A'), true); assert.equal(store.bindScene(id(2), 'scene_session_A'), false);
  assert.equal(store.bindScene(id(1), 'scene_session_other'), false); assert.equal(store.bindScene(id(2), 'scene_session_B'), true);
  const old = first.beginTask('scriptInitialize', 'runtimeAcquireInitialize'); time = 5;
  assert.equal(store.retireScene('scene_session_A'), true); assert.equal(store.contextForScene('scene_session_A'), null);
  time = 20; old.end(); assert.equal(store.read(id(1))?.spans[0].status, 'stale');
  assert.equal(store.read(id(1))?.spans[0].lateCompletion, true); assert.equal(store.read(id(2))?.status, 'active');
  assert.equal(store.contextForScene('scene_session_B')?.openId, id(2)); assert.equal(store.forScene('scene_session_B') === second, true);
});

test('renderer同样8次有界且清除被淘汰的scene映射，无轮询/磁盘/网络资源', () => {
  const store = new RendererProjectOpenTraceStore({ now: () => 0 });
  for (let n = 1; n <= 8; n++) {
    const recorder = store.start(context(n)); assert.ok(recorder); assert.equal(store.bindScene(id(n), 'scene_' + n), true); recorder.finish('ready');
  }
  assert.ok(store.start(context(9))); assert.equal(store.read(id(1)), null); assert.equal(store.contextForScene('scene_1'), null);
  assert.equal(store.stats().retainedTraces, 8); assert.equal(store.stats().boundScenes, 7);
  assert.equal(store.start({ version: 1, openId: 'https://secret' }), null); assert.equal(store.bindScene(id(9), 'https://host/path'), false);
});

test('stores时钟异常不影响创建/归属/业务token，报告明确不完整而不编造时间', () => {
  const now = () => { throw new Error('clock diagnostic failure'); };
  const main = new ProjectOpenTraceStore({ now }), renderer = new RendererProjectOpenTraceStore({ now });
  const m = main.start(1, context(1)), r = renderer.start(context(1)); assert.ok(m && r);
  assert.equal(renderer.bindScene(id(1), 'scene_1'), true);
  const token = m.beginPhase('projectResolve'); assert.equal(token.end(), true);
  assert.equal(main.read(1, id(1))?.root.wallMs, null); assert.equal(main.read(1, id(1))?.recording.criticalPathComplete, false);
  assert.equal(renderer.read(id(1))?.root.wallMs, null);
});
