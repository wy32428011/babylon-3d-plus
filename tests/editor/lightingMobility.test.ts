import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEntityMobility, resolveLightingNodeSettings } from '../../src/editor/model/lightingMobility.ts';

const entity = (components: Record<string, unknown>) => ({ id: 'device', components });
test('普通模型与仅状态遥测保持静态，运动配置不依赖当前连接状态', () => {
  assert.equal(classifyEntityMobility(entity({ meshRenderer: { kind: 'cube' } })).mobility, 'static');
  assert.equal(classifyEntityMobility(entity({ telemetryBinding: { enabled: true, deviceType: 'generic' } })).mobility, 'static');
  assert.equal(classifyEntityMobility(entity({ modelAsset: { dataDrivenConfig: { motion: true } }, telemetryBinding: { enabled: false } })).mobility, 'dynamic');
});
test('任意脚本保守动态，运行时明确确认的参数化固定几何才按静态处理', () => {
  const model = entity({ modelAsset: { scriptAssets: [{ name: 'shelf.ts' }], parameterScriptMetadata: [{}] } });
  assert.equal(classifyEntityMobility(model).mobility, 'dynamic');
  assert.equal(classifyEntityMobility(model, { parameterGeometryOnly: true }).mobility, 'static');
  assert.equal(classifyEntityMobility(model, { parameterGeometryOnly: true, hasUnknownScriptMotion: true }).mobility, 'dynamic');
  assert.equal(classifyEntityMobility(model, { parameterGeometryOnly: true, hasGeometryAnimation: true }).mobility, 'dynamic');
});
test('使用驱动提供的节点判定，手动修正优先但不能抵消动态祖先', () => {
  const settings = { mobility: 'auto', castShadows: true, receiveShadows: true, bakeIndirect: true, nodeOverrides: { 'root/rail': { mobility: 'static' }, 'root/fork': { mobility: 'dynamic', castShadows: false } } } as const;
  assert.equal(resolveLightingNodeSettings(settings, 'root/rail', { mobility: 'dynamic', reason: '驱动判定' }, false).mobility, 'static');
  const fork = resolveLightingNodeSettings(settings, 'root/fork', { mobility: 'static', reason: '固定几何' }, false);
  assert.equal(fork.mobility, 'dynamic');
  assert.equal(fork.castShadows, false);
  const parent = resolveLightingNodeSettings(settings, 'root/rail', { mobility: 'static', reason: '固定几何' }, true);
  assert.equal(parent.mobility, 'dynamic');
  assert.match(parent.reason, /祖先/);
});
test('模型资源身份改变时不把旧节点覆盖静默应用到同名节点', () => {
  const settings = { mobility: 'auto', resourceIdentity: 'old', nodeOverrides: { 'root/rail': { mobility: 'static' } } } as const;
  const result = resolveLightingNodeSettings(settings, 'root/rail', { mobility: 'dynamic', reason: '未知脚本' }, false, 'new');
  assert.equal(result.mobility, 'dynamic');
  assert.equal(result.unmatchedOverride, true);
  assert.match(result.reason, /资源|失配/);
});
test('实体手动覆盖、动态生成器及实际动画使用同一分类入口', () => {
  assert.equal(classifyEntityMobility(entity({ lighting: { mobility: 'static' }, modelAsset: { scriptAssets: [{}] } })).mobility, 'static');
  assert.equal(classifyEntityMobility(entity({ lighting: { mobility: 'static' } }), { parentDynamic: true }).mobility, 'dynamic');
  for (const components of [{ deviceSpawner: {} }, { manualRoamSpawn: {} }, { autoPatrol: {} }]) assert.equal(classifyEntityMobility(entity(components)).mobility, 'dynamic');
  assert.equal(classifyEntityMobility(entity({}), { hasGeometryAnimation: true }).mobility, 'dynamic');
});
