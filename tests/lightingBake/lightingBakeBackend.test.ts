import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateLightingBakeInput, safeLightingBakeChildPath, LightingBakeJobs, matchLightingBakeSurfaceSources } from '../../electron/ipc/lightingBakeValidation.ts';

const fixture = () => ({
  version: 1, jobId: 'test-bake-1', signature: 'scene-signature', sceneName: '测试场景',
  settings: { atlasSize: 256, quality: 'preview', texelsPerMeter: 8, probeSpacing: 4, maxTextureMiB: 256 },
  meshes: [{ key: 'ground', entityId: 'ground', nodeKey: 'root', name: '地面',
    positions: [-1, 0, -1, 1, 0, -1, 0, 0, 1], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0],
    indices: [0, 2, 1], worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    material: { baseColor: [1, 1, 1], alpha: 1, metallic: 0, roughness: 0.5, emissive: [0, 0, 0], doubleSided: true } }],
  lights: [], environment: { color: [0.25, 0.25, 0.25], intensity: 1 },
});

test('validates complete finite geometry and refuses unsafe job identifiers', () => {
  assert.equal(validateLightingBakeInput(fixture()).jobId, 'test-bake-1');
  assert.throws(() => validateLightingBakeInput({ ...fixture(), jobId: '../escape' }), /任务标识/);
  const invalid = fixture(); invalid.meshes[0].positions[0] = Number.NaN;
  assert.throws(() => validateLightingBakeInput(invalid), /有限数值/);
  const outOfRange = fixture(); outOfRange.meshes[0].indices[2] = 20;
  assert.throws(() => validateLightingBakeInput(outOfRange), /索引/);
});

test('refuses UV loss and unsupported source URLs before spawning Blender', () => {
  const missingUv = fixture();
  Object.assign(missingUv.meshes[0].material, { textures: { baseColor: { url: 'editor-asset://local/a.png', coordinatesIndex: 0, uScale: 1, vScale: 1, uOffset: 0, vOffset: 0, wAng: 0, level: 1 } } });
  assert.throws(() => validateLightingBakeInput(missingUv), /UV/);
  const remote = fixture();
  Object.assign(remote.environment, { textureUrl: 'https://example.com/sky.hdr' });
  assert.throws(() => validateLightingBakeInput(remote), /资产/);
});

test('output paths cannot escape their dedicated job directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-path-'));
  try {
    assert.equal(safeLightingBakeChildPath(root, 'geometry-0.json'), path.join(root, 'geometry-0.json'));
    for (const value of ['../evil.json', '/tmp/evil', 'nested/evil', 'C:\\evil.json', 'CON', 'manifest.json:secret']) {
      assert.throws(() => safeLightingBakeChildPath(root, value));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('job cancellation is owner scoped and release preserves replacement jobs', () => {
  const jobs = new LightingBakeJobs();
  const own = jobs.create(7, 'one');
  assert.equal(jobs.cancel(8, 'one'), false);
  assert.equal(own.signal.aborted, false);
  assert.equal(jobs.cancel(7, 'one'), true);
  assert.equal(own.signal.aborted, true);
  jobs.release(7, 'one', own);
  const next = jobs.create(7, 'one');
  jobs.release(7, 'one', own);
  assert.equal(jobs.cancel(7, 'one'), true);
  assert.equal(next.signal.aborted, true);
});

test('backend limits active jobs and cancels all owned jobs on shutdown', () => {
  const jobs = new LightingBakeJobs();
  const own = jobs.create(1, 'one');
  assert.throws(() => jobs.create(1, 'other'), /正在/);
  jobs.cancelAll();
  assert.equal(own.signal.aborted, true);
});

test('取消后立即重试等待原进程退出，等待中的重试也可以取消', async () => {
  const jobs = new LightingBakeJobs();
  const old = jobs.create(7, 'old');
  await assert.rejects(jobs.acquire(7, 'busy'), /正在/);
  jobs.cancel(7, 'old');
  let started = false;
  const pending = jobs.acquire(7, 'retry').then(controller => { started = true; return controller; });
  await Promise.resolve();
  assert.equal(started, false, '旧任务尚未释放时不能启动第二个引擎进程');
  assert.equal(jobs.cancel(8, 'retry'), false);
  assert.equal(jobs.cancel(7, 'retry'), true);
  await assert.rejects(pending, { name: 'AbortError', message: /取消/ });
  const next = jobs.acquire(7, 'next');
  jobs.release(7, 'old', old);
  const controller = await next;
  assert.equal(controller.signal.aborted, false);
  jobs.release(7, 'next', controller);
});

test('等待旧进程清理时窗口关闭会取消预约且不会残留锁', async () => {
  const jobs = new LightingBakeJobs();
  const old = jobs.create(7, 'old'); jobs.cancel(7, 'old');
  const windowLifetime = new AbortController();
  const pending = jobs.acquire(7, 'retry', windowLifetime.signal);
  windowLifetime.abort();
  await assert.rejects(pending, { name: 'AbortError', message: /取消/ });
  jobs.release(7, 'old', old);
  const next = jobs.create(7, 'after-close');
  assert.equal(next.signal.aborted, false);
});

test('单源跨页必须完整覆盖切分树，禁止缺片、重叠或源身份丢失', () => {
  const input = validateLightingBakeInput(fixture());
  const surface = (key: string) => ({ key, entityId: 'ground', nodeKey: 'root' });
  const valid = ['ground/tile:0', 'ground/tile:10', 'ground/tile:11'].map(surface);
  assert.deepEqual(matchLightingBakeSurfaceSources(input.meshes, valid), [input.meshes[0], input.meshes[0], input.meshes[0]]);
  assert.deepEqual(matchLightingBakeSurfaceSources(input.meshes, [surface('ground')]), [input.meshes[0]]);
  for (const keys of [['ground/tile:0'], ['ground/tile:0', 'ground/tile:00'],
    ['ground', 'ground/tile:0'], ['ground/tile:0', 'ground/tile:0'], ['missing/tile:0'], ['ground/tile:2']]) {
    assert.throws(() => matchLightingBakeSurfaceSources(input.meshes, keys.map(surface)), /烘焙表面/);
  }
  assert.throws(() => matchLightingBakeSurfaceSources(input.meshes, []), /烘焙表面/);
  assert.throws(() => matchLightingBakeSurfaceSources(input.meshes, [{ ...surface('ground'), entityId: 'other' }]), /烘焙表面/);
});
