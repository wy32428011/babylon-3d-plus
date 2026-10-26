import assert from 'node:assert/strict';
import test from 'node:test';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import { HybridShadowCache } from '../../src/runtime/babylon/HybridShadowCache.ts';

function fixture() {
  let generation = 1, lost = false, sequence = 0;
  const deleted = [], invalidDeletes = [];
  const remove = (kind, handle) => { if (lost || handle.generation !== generation) invalidDeletes.push({ kind, generation, handle }); else deleted.push({ kind, handle }); };
  const gl = { blitFramebuffer() {}, isContextLost: () => lost, deleteFramebuffer: handle => remove('framebuffer', handle), deleteRenderbuffer: handle => remove('renderbuffer', handle) };
  const engine = { webGLVersion: 2, _gl: gl, onContextLostObservable: new Observable(), onContextRestoredObservable: new Observable() };
  const scene = { getEngine: () => engine, getFrameId: () => 4 }, originalRender = () => {};
  const map = { customRenderFunction: originalRender, onBeforeRenderObservable: new Observable(), onBeforeBindObservable: new Observable() };
  const generator = { getLight: () => ({ getScene: () => scene }), getShadowMap: () => map }, state = { refreshForFrame() {} };
  const cache = new HybridShadowCache(generator, state);
  const populate = () => { const handle = () => ({ generation, id: ++sequence });
    const face = { framebuffer: handle(), color: handle(), depth: handle(), signature: 'stable', bytes: 100 }; cache.faces.set(0, face); return face; };
  const lose = (notify = true) => { lost = true; if (notify) engine.onContextLostObservable.notifyObservers(engine); };
  const restore = () => { generation++; lost = false; engine.onContextRestoredObservable.notifyObservers(engine); };
  return { cache, engine, map, originalRender, deleted, invalidDeletes, populate, lose, restore };
}

test('真实lost→新世代restore遗忘旧FBO/RBO，不向新context delete旧句柄；恢复后新资源正常释放', () => {
  const f = fixture(); f.populate(); const revision = f.cache.revision;
  try { f.lose(); const afterLost = f.cache.cachedFaces; assert.deepEqual(f.deleted, []);
    f.restore(); assert.deepEqual(f.invalidDeletes, [], '新context不能删除旧世代资源'); assert.equal(afterLost, 0, 'lost事件立即遗忘浏览器已释放的faces');
    assert.deepEqual(f.deleted, []); assert.equal(f.cache.revision, revision + 1, '保留原restore invalidate频率');
    const fresh = f.populate(); f.cache.setEnabled(false);
    assert.deepEqual(f.deleted.map(value => value.handle), [fresh.framebuffer, fresh.color, fresh.depth]); assert.deepEqual(f.invalidDeletes, []);
  } finally { f.cache.dispose(); }
});

test('lost期间disable/dispose（包括lost通知尚未派发）都不能delete失效资源', async t => {
  for (const notify of [true, false]) for (const action of ['disable', 'dispose']) await t.test(JSON.stringify({ notify, action }), () => {
    const f = fixture(); f.populate(); f.lose(notify);
    if (action === 'disable') f.cache.setEnabled(false); else f.cache.dispose();
    assert.equal(f.cache.cachedFaces, 0); assert.deepEqual(f.deleted, []); assert.deepEqual(f.invalidDeletes, []);
    f.restore(); assert.deepEqual(f.invalidDeletes, []); f.cache.dispose();
  });
});

test('正常disable/dispose和无lost手动restored通知仍精确删除有效资源，原observer/render身份保留', async () => {
  const f = fixture(), externalLost = f.engine.onContextLostObservable.add(() => {}), externalRestore = f.engine.onContextRestoredObservable.add(() => {});
  const first = f.populate(); f.engine.onContextRestoredObservable.notifyObservers(f.engine);
  assert.deepEqual(f.deleted.map(value => value.handle), [first.framebuffer, first.color, first.depth]);
  const second = f.populate(); f.cache.dispose(); f.cache.dispose();
  assert.deepEqual(f.deleted.map(value => value.handle), [first.framebuffer, first.color, first.depth, second.framebuffer, second.color, second.depth]);
  assert.deepEqual(f.invalidDeletes, []); assert.equal(f.map.customRenderFunction, f.originalRender);
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(f.engine.onContextLostObservable.observers, [externalLost]); assert.deepEqual(f.engine.onContextRestoredObservable.observers, [externalRestore]);
  assert.equal(f.map.onBeforeRenderObservable.observers.length, 0); assert.equal(f.map.onBeforeBindObservable.observers.length, 0);
  const revision = f.cache.revision; f.engine.onContextLostObservable.notifyObservers(f.engine); f.engine.onContextRestoredObservable.notifyObservers(f.engine);
  assert.equal(f.cache.revision, revision, 'dispose后不能收到重复生命周期callback');
});
