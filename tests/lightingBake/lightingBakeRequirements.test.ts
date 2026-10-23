import assert from 'node:assert/strict';
import test from 'node:test';
import { getSceneLightingBakeError } from '../../electron/shared/sceneLightingBakeContract.ts';

const scene = (entities: Record<string, unknown>, environment: unknown = null) => ({
  entities, sceneSettings: { shadows: { mode: 'hybrid' }, lightingBake: { enabled: true }, environment },
});
const model = (mobility: string, extra: Record<string, unknown> = {}) => ({
  components: { modelAsset: { sourceUrl: 'model.glb' }, lighting: { mobility, ...extra } },
});

test('全部显式动态且没有环境时混合模式无需静态GI，不要求伪造结果', () => {
  assert.equal(getSceneLightingBakeError(scene({ first: model('dynamic'), second: model('dynamic') })), null);
  assert.equal(getSceneLightingBakeError(scene({ first: model('dynamic') }, { visible: false })), null);
});
test('自动模型不能因遥测或运动声明被整体排除；静态部件覆盖仍要求烘焙', () => {
  const automatic = model('auto');
  (automatic.components as Record<string, unknown>).telemetryBinding = { enabled: true, deviceType: 'stacker' };
  (automatic.components.modelAsset as Record<string, unknown>).dataDrivenConfig = { motion: true };
  assert.match(getSceneLightingBakeError(scene({ automatic })) ?? '', /尚未完成/);
  assert.match(getSceneLightingBakeError(scene({ moving: model('dynamic', { nodeOverrides: { rail: { mobility: 'static' } } }) })) ?? '', /尚未完成/);
  assert.match(getSceneLightingBakeError(scene({ moving: model('dynamic') }, { visible: true })) ?? '', /尚未完成/);
});
test('隐藏的静态实体与编辑辅助对象不产生无意义的GI发布要求', () => {
  assert.equal(getSceneLightingBakeError(scene({ hidden: { ...model('static'), visible: false }, moving: model('dynamic'),
    cad: { components: { meshRenderer: {}, cadReference: {} } } })), null);
});
