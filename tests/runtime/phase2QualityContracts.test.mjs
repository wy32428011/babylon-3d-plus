import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MSFT_lod } from '@babylonjs/loaders/glTF/2.0/Extensions/MSFT_lod.js';
import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';
import { resolveSceneLightingPolicy } from '../../electron/shared/sceneLightingPolicy.ts';

test('R6合同反例：已遮挡结果在Mesh.render的onBeforeRender之前返回', () => {
  let occluded = false, notifications = 0, instanceQueries = 0;
  const engine = { currentRenderPassId: 0 };
  const scene = { getEngine: () => engine, activeCameras: [], activeCamera: null };
  const mesh = { getScene: () => scene, _internalAbstractMeshDataInfo: {},
    _occlusionDataStorage: { occlusionForRenderPassId: -1, forceRenderingWhenOccluded: false },
    _checkOcclusionQuery: () => occluded,
    _getInstancesRenderList() { instanceQueries++; return { mustReturn: false, hardwareInstancedRendering: {} }; },
    _geometry: { getVertexBuffers: () => ({}) }, _unIndexed: true,
    _internalMeshDataInfo: { _onBeforeRenderObservable: { notifyObservers() { notifications++; } } },
    _instanceDataStorage: {}, hasThinInstances: false, hasInstances: false, isAnInstance: false,
  };
  const subMesh = { _id: 0, getRenderingMesh: () => mesh, getMaterial: () => null };
  Mesh.prototype.render.call(mesh, subMesh, false);
  assert.equal(notifications, 1); assert.equal(instanceQueries, 1);
  occluded = true; Mesh.prototype.render.call(mesh, subMesh, false);
  assert.equal(notifications, 1, '遮挡优化改变公开render observer次数，不能称严格等价');
  assert.equal(instanceQueries, 1, '连后续实例提交路径也被跳过');
});

test('R7合同反例：MSFT_lod低级先就绪，高级替换并销毁旧节点而非按相机距离保留多级', async () => {
  const nodes = [{ index: 0, extensions: { MSFT_lod: { ids: [1, 2] } } }, { index: 1 }, { index: 2 }];
  const pending = new Map(), objects = new Map(), events = [];
  const babylonScene = { meshes: [], materials: [] };
  Object.defineProperty(babylonScene, 'activeCamera', { get() { throw new Error('渐进加载不能冒充距离LOD'); } });
  const loader = { parent: { extensionOptions: {} }, gltf: { nodes }, babylonScene,
    isExtensionUsed: () => true, logOpen() {}, logClose() {},
    loadNodeAsync(_context, node, assign) {
      const result = { name: 'lod-' + node.index, enabled: false, disposed: false,
        setEnabled(value) { this.enabled = value; events.push([this.name, 'enabled', value]); },
        getChildMeshes: () => [], dispose() { this.disposed = true; events.push([this.name, 'disposed']); } };
      objects.set(node.index, result); node._babylonTransformNode = result; assign(result);
      return new Promise(resolve => pending.set(node.index, () => resolve(result)));
    },
  };
  const extension = new MSFT_lod(loader);
  const first = extension.loadNodeAsync('/nodes/0', nodes[0], () => {});
  assert.deepEqual([...pending.keys()], [2, 1, 0]);
  pending.get(2)(); assert.equal(await first, objects.get(2));
  assert.equal(objects.get(2).enabled, true); assert.equal(objects.get(2).disposed, false);
  pending.get(1)(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(objects.get(2).disposed, true); assert.equal(objects.get(1).enabled, true);
  pending.get(0)(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(objects.get(1).disposed, true); assert.equal(objects.get(0).enabled, true);
  assert.notEqual(objects.get(0), objects.get(2), '升级会替换节点对象身份');
  assert.ok(events.some(row => row[1] === 'disposed')); extension.dispose();
});

test('S4现有共享配置和部件策略已支持阴影质量及精确castShadows例外', () => {
  for (const quality of ['performance', 'balanced', 'quality']) {
    assert.equal(normalizeSceneLightingConfig({ shadows: { quality } }).shadows.quality, quality);
  }
  const policy = { version: 1, defaults: {}, rules: [{ id: 'small-part', enabled: true, target: { kind: 'all' }, values: {},
    nodeRules: [{ id: 'rail', target: { kind: 'node', nodeKey: 'root/rail[0]', resourceIdentity: 'rev-1' }, values: { castShadows: false } }] }] };
  const context = { entityId: 'model', resourceIdentity: 'rev-1', automatic: { mobility: 'static', reason: '固定结构' } };
  assert.equal(resolveSceneLightingPolicy(policy, { ...context, nodeKey: 'root/rail[0]' }).settings.castShadows, false);
  assert.equal(resolveSceneLightingPolicy(policy, { ...context, nodeKey: 'root/body[0]' }).settings.castShadows, true);
  assert.equal(resolveSceneLightingPolicy(policy, { ...context, nodeKey: 'root/rail[0]', resourceIdentity: 'changed' }).settings.castShadows, true);
});

function encodeRgbm(rgb, range) {
  const multiplier = Math.max(1 / 255, Math.ceil(Math.max(...rgb) / range * 255) / 255);
  return [...rgb.map(value => value / (multiplier * range)), multiplier];
}
function decodeRgbm(rgba, range) { return rgba.slice(0, 3).map(value => value * rgba[3] * range); }

test('B9数值反例：直接平均RGBM编码RGBA并不等于平均线性辐照度', () => {
  const range = 8, a = [1, 0, 0], b = [0, 4, 0];
  const encodedA = encodeRgbm(a, range), encodedB = encodeRgbm(b, range);
  const genericMip = encodedA.map((value, index) => (value + encodedB[index]) / 2);
  const decodedMip = decodeRgbm(genericMip, range), expected = a.map((value, index) => (value + b[index]) / 2);
  assert.deepEqual(expected, [0.5, 2, 0]);
  assert.ok(Math.abs(decodedMip[0] - expected[0]) > 0.5);
  assert.ok(Math.abs(decodedMip[1] - expected[1]) > 0.5);
  const correctlyEncodedMip = encodeRgbm(expected, range);
  decodeRgbm(correctlyEncodedMip, range).forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-12));
});

test('B8数值反例：对旧线性RGBM只开启gamma解释会改变辐照度，不能恢复暗部精度', () => {
  const legacy = [0.25, 0.5, 1, 0.5], range = 8;
  const original = decodeRgbm(legacy, range);
  const shaderOnlyGamma = decodeRgbm([...legacy.slice(0, 3).map(value => value ** 2.2), legacy[3]], range);
  assert.deepEqual(original, [1, 2, 4]);
  assert.ok(Math.abs(original[0] - shaderOnlyGamma[0]) > 0.8);
  assert.ok(Math.abs(original[1] - shaderOnlyGamma[1]) > 1);
});
