import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForSkyboxPrefilter } from '../../src/runtime/babylon/skyboxPrefilter.ts';

function fixture() {
  let handler: ((event: any) => void) | undefined;
  let removed = 0, disposed = 0;
  const engine = { onEffectErrorObservable: {
    add(callback: typeof handler) { handler = callback; return callback; },
    remove() { removed++; handler = undefined; },
  } } as unknown as Parameters<typeof waitForSkyboxPrefilter>[0];
  return { engine, removed: () => removed, disposed: () => disposed,
    fail(shader = 'hdrFiltering') { handler?.({ effect: { name: { vertex: shader, fragment: shader },
      dispose() { disposed++; } }, errors: 'compile failed' }); } };
}

test('预过滤编译失败即使原Promise不结算也及时拒绝，并移除监听', async () => {
  const f = fixture();
  const result = waitForSkyboxPrefilter(f.engine, () => new Promise<void>(() => {}));
  const rejected = assert.rejects(result, /预过滤着色器编译失败.*compile failed/);
  f.fail(); await rejected;
  assert.equal(f.disposed(), 1); assert.equal(f.removed(), 1);
});

test('其他材质错误不会误伤天空盒，正常成功后移除监听', async () => {
  const f = fixture(); let ready!: () => void;
  const result = waitForSkyboxPrefilter(f.engine, () => new Promise<void>(resolve => { ready = resolve; }));
  f.fail('pbr'); ready(); await result;
  assert.equal(f.disposed(), 0); assert.equal(f.removed(), 1);
});

test('预过滤同步异常也释放公开错误监听', async () => {
  const f = fixture();
  await assert.rejects(waitForSkyboxPrefilter(f.engine, () => { throw new Error('filter failed'); }), /filter failed/);
  assert.equal(f.removed(), 1);
});
