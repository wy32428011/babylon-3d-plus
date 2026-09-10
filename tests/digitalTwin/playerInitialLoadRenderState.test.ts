import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
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
    initialLoadTimeoutRef: { current: null }, blockInitialLoad() {},
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

test('实际 Viewer 超时处理阻断场景并取消首帧等待，不能发送成功握手或启动巡检', () => {
  const timeoutHandler = variable(source.includes('const blockInitialLoad =') ? 'blockInitialLoad' : 'forceCompleteInitialLoad').initializer?.getText(ast);
  assert.ok(timeoutHandler);
  let complete = 0; let settled = 0; let phase = 'ready'; let message = '';
  const gate = new PlayerInitialLoadGate(() => { complete += 1; }, { onSettled: () => { settled += 1; } });
  gate.update({ loading: true, totalCount: 98 }); gate.startTracking();
  const timeout = runInNewContext(`(${timeoutHandler})`, {
    disposed: false, initialLoadGate: gate, autoPatrolStartGate: { dispose() {} },
    setPhase: (value: string) => { phase = value; }, setMessage: (value: string) => { message = value; },
  });
  timeout();
  assert.equal(complete, 0, '超时不能以成功握手放行宿主');
  assert.equal(settled, 0, '超时不能放行巡检');
  assert.equal(phase, 'blocked');
  assert.match(message, /120|超时/);
  gate.update({ loading: false, totalCount: 98 });
  gate.forceComplete();
  assert.equal(complete, 0, '已阻断的初始gate不能被迟到事件恢复为成功');
});
