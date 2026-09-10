import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { PlayerInitialLoadMonitor } from '../../src/player/playerInitialLoadMonitor.ts';
import { PlayerInitialLoadGate } from '../../src/player/playerInitialLoadState.ts';
import { computePlayerLoadingProgress } from '../../src/player/playerLoadingProgress.ts';

const source = await readFile(new URL('../../src/player/PlayerApp.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('PlayerApp.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function variable(name: string): ts.VariableDeclaration {
  let result: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) result = node;
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(result, `缺少实际组件变量 ${name}`); return result;
}
const gateInitializer = variable('initialLoadGate').initializer;
assert.ok(gateInitializer && ts.isNewExpression(gateInitializer));
const completeCallback = gateInitializer.arguments?.[0]?.getText(ast);
assert.ok(completeCallback);
const loadingMaskExpression = variable('loadingMask').initializer?.getText(ast);
assert.ok(loadingMaskExpression);

test('首帧验证成功主动发布完成状态，无 FPS、MQTT 或用户事件也立即关闭 Viewer 加载蒙版', async () => {
  const frames: ReturnType<typeof computePlayerLoadingProgress>[] = [];
  const initialLoadCompletedRef = { current: false };
  let initialLoadCompleted = false;
  let handshake = 0;
  const render = () => runInNewContext(loadingMaskExpression, {
    computePlayerLoadingProgress, initialLoadCompletedRef, initialLoadCompleted, phase: 'ready', startupPercent: 50,
    modelLoadProgress: { loading: false, percent: 1, completedCount: 98, totalCount: 98, currentFile: null }, message: '场景加载中',
  });
  const onComplete = runInNewContext(`(${completeCallback})`, {
    initialLoadCompletedRef,
    setInitialLoadCompleted: (value: boolean) => { initialLoadCompleted = value; frames.push(render()); },
    initialLoadMonitorRef: { current: null }, checkInitialLoad() {}, initialLoadCompletedForSession: false, setInitialLoadNotice() {},
    interactionController: { markInitialLoadComplete: () => { handshake += 1; } },
  });
  let nextFrame: (() => void) | undefined;
  let finishVerification!: () => void;
  const gate = new PlayerInitialLoadGate(onComplete, {
    schedule: callback => { nextFrame = callback; return 1; }, cancel: () => { nextFrame = undefined; },
    verifyReady: () => new Promise<void>(resolve => { finishVerification = resolve; }),
  });
  gate.update({ loading: false, totalCount: 98 }); gate.startTracking();
  assert.equal(render().visible, true);
  nextFrame!();
  assert.equal(frames.length, 0);
  finishVerification(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(handshake, 1);
  assert.equal(frames.length, 1, '必须由完成回调主动通知 React，不能等无关事件触发重绘');
  assert.equal(frames[0].visible, false);
  assert.equal(frames[0].percent, 100);
  gate.dispose();
});

test('已经销毁的场景首帧回调不能发布完成状态或发送新场景握手', async () => {
  let completed = 0; let scheduled: (() => void) | undefined; let finish!: () => void;
  const gate = new PlayerInitialLoadGate(() => { completed += 1; }, {
    schedule: callback => { scheduled = callback; return 1; }, cancel: () => { scheduled = undefined; },
    verifyReady: () => new Promise<void>(resolve => { finish = resolve; }),
  });
  gate.update({ loading: false, totalCount: 98 }); gate.startTracking(); scheduled!();
  gate.dispose(); finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, 0);
});

test('实际 Viewer 120秒缓慢提示保持gate有效，140秒资源与首帧完成只通知一次', async () => {
  const check = variable('checkInitialLoad').initializer?.getText(ast);
  assert.ok(check);
  let now = 0, notice = '', blocked = 0, complete = 0, settled = 0;
  let frame: (() => void) | undefined;
  const gate = new PlayerInitialLoadGate(() => complete++, { onSettled: () => settled++,
    schedule: callback => { frame = callback; return 1; }, cancel: () => { frame = undefined; },
    verifyReady: async () => undefined });
  const snapshot = { error: null, progress: { loading: true, totalCount: 164, completedCount: 163, percent: .9, currentFile: 'skybox.exr', filePercent: null },
    skybox: { stage: 'reading', receivedBytes: 0, totalBytes: 75_640_460 } };
  gate.update(snapshot.progress); gate.startTracking();
  const context = { disposed: false, initialLoadFailed: false, initialLoadCompletedForSession: false,
    runtime: { getInitialLoadSnapshot: () => snapshot }, loadMonitor: new PlayerInitialLoadMonitor(),
    performance: { now: () => now }, setInitialLoadNotice: (value: string) => { notice = value; },
    blockInitialLoad: () => { blocked++; gate.dispose(); } };
  const tick = runInNewContext('(' + check + ')', context);
  tick(); now = 120_000; snapshot.skybox.receivedBytes = 60_000_000; tick();
  assert.equal(blocked, 0); assert.match(notice, /缓慢|继续/); assert.equal(complete, 0);
  now = 140_000; snapshot.progress.loading = false; snapshot.progress.completedCount = 164;
  snapshot.skybox.stage = ''; tick(); gate.update(snapshot.progress); frame!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(complete, 1); assert.equal(settled, 1);
  context.initialLoadCompletedForSession = true; now = 999_999; tick();
  assert.equal(blocked, 0);
  gate.dispose();
});

test('实际 Viewer 真实失败或持续停滞仍阻断，不能被迟到成功恢复', () => {
  const check = variable('checkInitialLoad').initializer?.getText(ast);
  assert.ok(check);
  for (const explicitError of [null, '模型 device：HTTP 404']) {
    let now = 0, blocked = '', completed = 0;
    const gate = new PlayerInitialLoadGate(() => completed++);
    const snapshot = { error: explicitError, progress: { loading: true, totalCount: 1, completedCount: 0, percent: 0, currentFile: 'device', filePercent: null }, skybox: { stage: null, receivedBytes: 0, totalBytes: null } };
    const tick = runInNewContext('(' + check + ')', { disposed: false, initialLoadFailed: false, initialLoadCompletedForSession: false,
      runtime: { getInitialLoadSnapshot: () => snapshot }, loadMonitor: new PlayerInitialLoadMonitor(), performance: { now: () => now },
      setInitialLoadNotice() {}, blockInitialLoad: (detail: string) => { blocked = detail; gate.dispose(); } });
    tick(); now = 300_000; tick();
    assert.match(blocked, explicitError ? /HTTP 404/ : /进展|停滞/);
    gate.forceComplete(); assert.equal(completed, 0);
  }
});
