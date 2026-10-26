import assert from 'node:assert/strict';
import test from 'node:test';
import { PROJECT_OPEN_PHASES, PROJECT_OPEN_SPAN_LIMIT, ProjectOpenTraceRecorder, readProjectOpenTraceContext,
  projectOpenIntervalUnion, projectOpenIpcResidual, joinProjectOpenTraces,
  type ProjectOpenTraceContext, type ProjectOpenPhase, type ProjectOpenSpanOptions } from '../../electron/shared/projectOpenTrace.ts';

const ID = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const context = (openId = ID, detail: 'phases' | 'assets' = 'assets'): ProjectOpenTraceContext => ({ version: 1, openId, detail });
function fixture(clockDomain: 'main' | 'renderer' = 'renderer', detail: 'phases' | 'assets' = 'assets') {
  let current = 0;
  const recorder = new ProjectOpenTraceRecorder(context(ID, detail), { clockDomain, now: () => current });
  return { recorder, set: (value: number) => { current = value; }, tick: () => { current++; } };
}
function closePhases(recorder: ProjectOpenTraceRecorder, phases: readonly ProjectOpenPhase[] = PROJECT_OPEN_PHASES) {
  for (const phase of phases) recorder.beginPhase(phase).end();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('上下文只接纳显式UUID和有限枚举，访问器/未知大对象/URL不被执行或保留', () => {
  const source = { version: 1, openId: ID, detail: 'assets' };
  const parsed = readProjectOpenTraceContext(source); assert.ok(parsed); assert.equal(parsed.openId, ID);
  source.openId = OTHER; assert.equal(parsed.openId, ID); assert.equal(Object.isFrozen(parsed), true);
  assert.equal(readProjectOpenTraceContext({ version: 1, openId: ID })?.detail, 'phases');
  let reads = 0;
  assert.equal(readProjectOpenTraceContext({ version: 1, get openId() { reads++; return ID; } }), null);
  assert.equal(readProjectOpenTraceContext({ version: 1, openId: ID, detail: { toString() { reads++; return 'assets'; } } }), null);
  assert.equal(reads, 0);
  for (const invalid of [{ version: 2, openId: ID }, { version: 1, openId: 'https://host/secret?token=credential' },
    { version: 1, openId: ID, scene: { arbitrary: new Array(50) } }, { version: 1, openId: ID, detail: 'all' }]) {
    assert.equal(readProjectOpenTraceContext(invalid), null);
  }
});

test('同域相交span明确区分phase wall union、task union和并发task sum', () => {
  const f = fixture(), phase = f.recorder.beginPhase('runtimeAcquireInitialize');
  f.set(5); const first = f.recorder.beginTask('assetReadDecode', 'runtimeAcquireInitialize', { parent: phase.ref! });
  f.set(10); const second = f.recorder.beginTask('templateWait', 'runtimeAcquireInitialize', { parent: phase.ref! });
  assert.equal(f.recorder.snapshot().phases.find(value => value.phase === 'runtimeAcquireInitialize')?.taskSumMs, null, '在途总量未知，不编成0');
  f.set(35); first.end(); f.set(55); second.end(); f.set(60); phase.end(); f.recorder.finish('ready');
  const snapshot = f.recorder.snapshot(), row = snapshot.phases.find(value => value.phase === 'runtimeAcquireInitialize')!;
  assert.equal(snapshot.root.wallMs, 60); assert.equal(row.phaseWallUnionMs, 60); assert.equal(row.taskUnionMs, 50); assert.equal(row.taskSumMs, 75);
  assert.equal(snapshot.recording.criticalPathComplete, false, '缺少其余必要阶段不冒充完整');
  assert.deepEqual(projectOpenIntervalUnion([{ startMs: 0, endMs: 20 }, { startMs: 10, endMs: 30 }]), { unionMs: 30, retainedUnionMs: 30, unknownCount: 0 });
  assert.equal(projectOpenIntervalUnion([{ startMs: null, endMs: 20 }]).unionMs, null);
});

test('IPC仅用两个单调时钟域的包络，给出residual/偏移范围，不伪造单轴时间', () => {
  const result = projectOpenIpcResidual({ rendererStartMs: 100, rendererEndMs: 180, mainStartMs: 5000, mainEndMs: 5060 });
  assert.equal(result.valid, true); assert.equal(result.rendererMs, 80); assert.equal(result.mainMs, 60); assert.equal(result.residualMs, 20);
  assert.deepEqual(result.mainToRendererOffsetBoundsMs, [-4900, -4880]);
  assert.equal(projectOpenIpcResidual({ rendererStartMs: 100, rendererEndMs: 150, mainStartMs: 5000, mainEndMs: 5060 }).residualMs, null);
  assert.equal(projectOpenIpcResidual({ rendererStartMs: null, rendererEndMs: 180, mainStartMs: 5000, mainEndMs: 5060 }).valid, false);
  assert.equal(projectOpenIpcResidual({ rendererStartMs: 180, rendererEndMs: 100, mainStartMs: 5000, mainEndMs: 5060 }).valid, false);
});

test('阶段跳过需明确原因，token end/finish均幂等，只有完整所需阶段才可声明complete', () => {
  const f = fixture('main');
  f.recorder.beginPhase('projectResolve').end(); f.recorder.beginPhase('sourceDownload').end('skipped', 'no-source-package');
  f.recorder.beginPhase('sourceExtractValidate').end('skipped', 'no-source-package');
  const token = f.recorder.beginPhase('projectMaterialize'); f.set(10);
  assert.equal(token.end(), true); assert.equal(token.end('error', 'operation-failed'), false);
  assert.equal(f.recorder.finish('ready'), true); assert.equal(f.recorder.finish('failed'), false);
  assert.equal(f.recorder.snapshot().recording.criticalPathComplete, true);
  const invalid = fixture('main'); closePhases(invalid.recorder, ['projectResolve']); invalid.recorder.beginPhase('sourceDownload').end('skipped');
  invalid.recorder.finish('ready'); assert.equal(invalid.recorder.snapshot().recording.criticalPathComplete, false);
  assert.equal(invalid.recorder.snapshot().recording.diagnosticErrors, 1);
});

test('异步成功、原错误与guard失败都保持业务语义，stale/cancelled始终结束原token', async () => {
  const f = fixture(), waiting = deferred<number>(); let current: 'current' | 'stale' = 'current';
  const task = f.recorder.measureTaskAsync('scriptInitialize', 'runtimeAcquireInitialize', token => {
    assert.equal(token.ref?.openId, ID); return waiting.promise;
  }, undefined, () => current);
  current = 'stale'; f.set(20); waiting.resolve(42); assert.equal(await task, 42);
  assert.equal(f.recorder.snapshot().spans[0].status, 'stale');
  const original = new Error('https://user:credential@host/private?token=secret');
  await assert.rejects(f.recorder.measureTaskAsync('assetReadDecode', 'runtimeAcquireInitialize', async () => { throw original; }, undefined,
    () => { throw new Error('guard diagnostic only'); }), (error: unknown) => error === original);
  assert.equal(f.recorder.measureTask('modelInitialize', 'runtimeAcquireInitialize', () => 7, undefined, () => { throw original; }), 7);
  assert.doesNotMatch(JSON.stringify(f.recorder.snapshot()), /credential|private|token=secret|guard diagnostic/);
  const pending = f.recorder.beginTask('modelAcquire', 'runtimeAcquireInitialize'); f.set(25); f.recorder.finish('cancelled');
  assert.equal(f.recorder.snapshot().recording.activeSpans, 1); f.set(35); pending.end();
  const cancelled = f.recorder.snapshot().spans.at(-1)!;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.lateCompletion, true); assert.equal(cancelled.durationMs, 15);
  assert.equal(f.recorder.snapshot().root.wallMs, 25, '取消后的收束不改根截止时刻');
});

test('诊断时钟抛错/回退/非有限值不替换业务结果，未知时长不编成0', async () => {
  const bad = new ProjectOpenTraceRecorder(context(), { clockDomain: 'renderer', now: () => { throw new Error('clock failure'); } });
  assert.equal(await bad.measureTaskAsync('modelAcquire', 'runtimeAcquireInitialize', async () => 'original-result'), 'original-result');
  bad.finish('ready'); const report = bad.snapshot();
  assert.equal(report.root.wallMs, null); assert.equal(report.spans[0].durationMs, null);
  assert.equal(report.phases.find(row => row.phase === 'runtimeAcquireInitialize')?.taskSumMs, null);
  assert.ok(report.recording.diagnosticErrors > 0); assert.equal(report.recording.criticalPathComplete, false);
  const f = fixture(); f.set(10); const task = f.recorder.beginTask('assetReadDecode', 'runtimeAcquireInitialize');
  f.set(5); task.end(); assert.equal(f.recorder.snapshot().spans[0].durationMs, null);
});

test('4096总记录上限保留七主阶段，drop保留task sum但union/complete不得伪装完整', () => {
  const f = fixture(), phase = f.recorder.beginPhase('runtimeAcquireInitialize');
  for (let index = 0; index < 5000; index++) { const task = f.recorder.beginTask('modelClone', 'runtimeAcquireInitialize', { resourceOrdinal: index }); f.tick(); task.end(); }
  phase.end(); closePhases(f.recorder, PROJECT_OPEN_PHASES.filter(value => value !== 'runtimeAcquireInitialize')); f.recorder.finish('ready');
  const snapshot = f.recorder.snapshot(), row = snapshot.phases.find(value => value.phase === 'runtimeAcquireInitialize')!;
  assert.equal(snapshot.recording.retainedSpans, PROJECT_OPEN_SPAN_LIMIT); assert.equal(snapshot.spans.filter(value => value.kind === 'phase').length, 7);
  assert.equal(snapshot.recording.droppedSpans, 912); assert.equal(snapshot.recording.criticalPathComplete, false);
  assert.equal(row.taskSumMs, 5000); assert.equal(row.taskCount, 5000); assert.equal(row.taskUnionMs, null); assert.equal(row.phaseWallUnionMs, null);
});

test('默认phase-only的beginTask只返回共享空token且不计资源时间，不冒充详细critical path', () => {
  let reads = 0;
  const recorder = new ProjectOpenTraceRecorder(context(ID, 'phases'), { clockDomain: 'renderer', now: () => ++reads });
  for (let index = 0; index < 5000; index++) assert.equal(recorder.beginTask('modelClone', 'runtimeAcquireInitialize').ref, null);
  assert.equal(reads, 1); closePhases(recorder, PROJECT_OPEN_PHASES.slice(4)); recorder.finish('ready'); const snapshot = recorder.snapshot();
  assert.equal(snapshot.spans.length, 3); assert.equal(snapshot.recording.suppressedTasks, 5000);
  assert.equal(snapshot.recording.phaseCoverageComplete, true); assert.equal(snapshot.recording.criticalPathComplete, false);
  assert.equal(snapshot.phases.find(row => row.phase === 'runtimeAcquireInitialize')?.taskSumMs, null);
  assert.equal(snapshot.phases.find(row => row.phase === 'sourceDownload')?.phaseWallUnionMs, null, '未到达阶段不当作耗时0');
});

test('两消费者只链接一个模板import，跨域同open父引用可用，snapshot与输入metadata互不别名', () => {
  const f = fixture(), phase = f.recorder.beginPhase('runtimeAcquireInitialize'), template = f.recorder.beginTask('assetReadDecode', 'runtimeAcquireInitialize', { parent: phase.ref! });
  const links = [template.ref!];
  const first = f.recorder.beginTask('templateWait', 'runtimeAcquireInitialize', { parent: phase.ref!, links });
  const second = f.recorder.beginTask('templateWait', 'runtimeAcquireInitialize', { parent: phase.ref!, links });
  links[0] = { openId: OTHER, clockDomain: 'main', spanId: 'main:1' }; template.end(); first.end(); second.end(); phase.end();
  const report = f.recorder.snapshot(); assert.equal(report.spans.filter(span => span.stage === 'assetReadDecode').length, 1);
  assert.ok(report.spans.filter(span => span.stage === 'templateWait').every(span => span.links?.[0].spanId === template.ref?.spanId));
  const mutable = report.spans.find(span => span.stage === 'templateWait')!; (mutable.links as unknown as { spanId: string }[])[0].spanId = 'renderer:999';
  assert.equal(f.recorder.snapshot().spans.find(span => span.stage === 'templateWait')?.links?.[0].spanId, template.ref?.spanId);
  const unsafe = { entityId: 'https://host/secret', scene: { arbitrary: true }, url: 'https://user:password@host/', resourceOrdinal: 5 } as unknown as ProjectOpenSpanOptions;
  f.recorder.beginTask('modelClone', 'runtimeAcquireInitialize', unsafe).end();
  assert.doesNotMatch(JSON.stringify(f.recorder.snapshot()), /https:|password|arbitrary/);
  f.recorder.beginTask('modelClone', 'runtimeAcquireInitialize', { parent: { openId: OTHER, clockDomain: 'main', spanId: 'main:1' } }).end();
  assert.equal(f.recorder.snapshot().spans.at(-1)?.parent, undefined, '跨open只可links，不能偷换父归属');
  f.recorder.beginTask('modelClone', 'runtimeAcquireInitialize', { parent: { openId: ID, clockDomain: 'renderer', spanId: 'renderer:999' } }).end();
  assert.equal(f.recorder.snapshot().spans.at(-1)?.parent, undefined, '同域未知/未来/循环父节点不能被接纳');
  const external = { openId: OTHER, clockDomain: 'main' as const, spanId: 'main:1' };
  f.recorder.beginTask('templateWait', 'runtimeAcquireInitialize', { links: [external] }).end();
  assert.equal(f.recorder.snapshot().spans.at(-1)?.links?.[0].openId, OTHER, '其它open的共享模板只作显式link');
});

test('joint报告仅合并同ID/正确clockDomain，全程wall取renderer并保留IPC residual', () => {
  const r = fixture(), m = fixture('main'); closePhases(r.recorder, PROJECT_OPEN_PHASES.slice(4)); closePhases(m.recorder, PROJECT_OPEN_PHASES.slice(0, 4));
  r.set(100); r.recorder.finish('ready');
  const combined = joinProjectOpenTraces(r.recorder.snapshot(), m.recorder.snapshot(), { openId: ID, rendererStartMs: 0, rendererEndMs: 60, mainStartMs: 5000, mainEndMs: 5050 });
  assert.equal(combined.criticalPathComplete, true); assert.equal(combined.rootWallMs, 100); assert.equal(combined.ipc.residualMs, 10);
  const different = new ProjectOpenTraceRecorder(context(OTHER), { clockDomain: 'main', now: () => 0 });
  const invalid = joinProjectOpenTraces(r.recorder.snapshot(), different.snapshot(), { openId: ID, rendererStartMs: 0, rendererEndMs: 60, mainStartMs: 5000, mainEndMs: 5050 });
  assert.equal(invalid.sameOpenId, false); assert.equal(invalid.domains.main, null); assert.equal(invalid.criticalPathComplete, false);
  assert.equal(joinProjectOpenTraces(r.recorder.snapshot(), m.recorder.snapshot(), { openId: OTHER, rendererStartMs: 0, rendererEndMs: 60, mainStartMs: 5000, mainEndMs: 5050 }).criticalPathComplete, false);
  m.recorder.finish('failed');
  assert.equal(joinProjectOpenTraces(r.recorder.snapshot(), m.recorder.snapshot(), { openId: ID, rendererStartMs: 0, rendererEndMs: 60, mainStartMs: 5000, mainEndMs: 5050 }).criticalPathComplete, false);
});

test('先报ready后才结束的子任务明确late，不能在晚到后升级成完整关键路径', () => {
  const f = fixture(); closePhases(f.recorder, PROJECT_OPEN_PHASES.slice(4));
  const child = f.recorder.beginTask('modelAcquire', 'runtimeAcquireInitialize'); f.set(10); f.recorder.finish('ready');
  assert.equal(f.recorder.snapshot().recording.criticalPathComplete, false); f.set(20); child.end();
  const report = f.recorder.snapshot(); assert.equal(report.root.wallMs, 10); assert.equal(report.recording.lateCompletions, 1);
  assert.equal(report.recording.phaseCoverageComplete, false); assert.equal(report.recording.criticalPathComplete, false);
});

test('IPC bridge保留宿主真实M1/M2与采样时刻，phase-only也记录且不叠phase/task统计', () => {
  let now = 30, reads = 0;
  const recorder = new ProjectOpenTraceRecorder(context(ID, 'phases'), { clockDomain: 'main', now: () => { reads++; return now; } });
  const before = reads, bridge = recorder.beginIpcBridge('openProject', 10);
  assert.equal(reads, before, 'M1是handler已捕获值，不另读时钟');
  now = 40; const resolving = recorder.beginPhase('projectResolve', { parent: bridge.ref! }); now = 50; resolving.end();
  const sampled = recorder.snapshot(); assert.equal(sampled.sampledAtMs, 50); assert.equal(sampled.spans.find(row => row.kind === 'bridge')?.endMs, null);
  now = 60; const beforeEnd = reads; bridge.end('ok', undefined, 60); assert.equal(reads, beforeEnd, 'M2是返回边界已捕获值');
  now = 10000; const later = recorder.snapshot(), span = later.spans.find(row => row.kind === 'bridge')!;
  assert.equal(span.startMs, 10); assert.equal(span.endMs, 60); assert.equal(span.durationMs, 50); assert.equal(later.sampledAtMs, 10000);
  const phase = later.phases.find(row => row.phase === 'projectResolve')!;
  assert.equal(phase.phaseWallUnionMs, 10); assert.equal(phase.taskCount, 0); assert.equal(phase.taskSumMs, null);
  assert.equal(recorder.getStatus(), 'active'); assert.equal(reads, beforeEnd + 1);
});
