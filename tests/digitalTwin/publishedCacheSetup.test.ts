import assert from 'node:assert/strict';
import test from 'node:test';
import { withPublishedCacheSetupBudget } from '../../src/player/publishedCacheSetup.ts';

test('可选缓存初始化超时不取消场景主流程，忽略不支持取消的迟到结果', async () => {
  const parent = new AbortController();
  let child: AbortSignal | undefined;
  await assert.rejects(withPublishedCacheSetupBudget(parent.signal, signal => {
    child = signal;
    return new Promise(() => {});
  }, 10), /初始化超时/);
  assert.equal(parent.signal.aborted, false);
  assert.equal(child?.aborted, true);
});

test('成功初始化撤销超时，页面销毁仍能取消缓存生命周期', async () => {
  const parent = new AbortController();
  const child = await withPublishedCacheSetupBudget(parent.signal, async signal => signal, 10);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(child.aborted, false);
  parent.abort();
  assert.equal(child.aborted, true);
});

test('已取消的页面不开始初始化', async () => {
  const parent = new AbortController(); parent.abort();
  await assert.rejects(withPublishedCacheSetupBudget(parent.signal, async () => assert.fail('不应开始')), { name: 'AbortError' });
});
