import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitLightingTaskStep } from '../../src/runtime/babylon/lightingBakeTask.ts';

test('等待尚未完成的渲染/资源就绪时取消，会立即结束并忽略迟到完成', async () => {
  const controller = new AbortController();
  let finish!: (value: number) => void;
  const waiting = awaitLightingTaskStep(new Promise<number>(resolve => { finish = resolve; }), controller.signal);
  const reason = new Error('用户取消'); controller.abort(reason);
  await assert.rejects(waiting, error => error === reason);
  finish(1);
  await assert.rejects(waiting, error => error === reason);
});
test('就绪结果保留零值，底层错误不会被误报成功', async () => {
  const controller = new AbortController();
  assert.equal(await awaitLightingTaskStep(Promise.resolve(0), controller.signal), 0);
  const reason = new Error('shader failed');
  await assert.rejects(awaitLightingTaskStep(Promise.reject(reason), controller.signal), error => error === reason);
});

test('调用前已经取消也消费底层迟到错误，不能留下未处理拒绝', async () => {
  const controller = new AbortController(), reason = new Error('用户已取消');
  controller.abort(reason);
  await assert.rejects(awaitLightingTaskStep(Promise.reject(new Error('迟到的底层错误')), controller.signal), error => error === reason);
  await new Promise(resolve => setImmediate(resolve));
});
