import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSceneLightingBakeSettings } from '../../electron/shared/sceneLightingBakeData.ts';
import { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';

const region = { id: 'floor-1', name: '一楼运动区', enabled: true, min: [0, 0, 0], max: [8, 4, 8] };
const scene = (bake: unknown) => ({ entities: {}, sceneSettings: { lighting: { version: 2, bake } } });
test('新执行设备和区域能归一化，旧默认不附加字段', () => {
  const before = normalizeSceneLightingBakeSettings({});
  assert.equal(Object.hasOwn(before, 'device'), false);
  assert.equal(Object.hasOwn(before, 'probeVolumes'), false);
  const next = normalizeSceneLightingBakeSettings({ device: 'gpu', probeVolumes: [region] });
  assert.equal(next.device, 'gpu');
  assert.deepEqual(next.probeVolumes, [region]);
  assert.notEqual(next.probeVolumes?.[0], region);
});
test('物理覆盖范围进签名，设备和区域名称不改变有效 GI', () => {
  assert.equal(getSceneLightingBakeSignature(scene({})), getSceneLightingBakeSignature(scene({ device: 'gpu' })));
  const signature = getSceneLightingBakeSignature(scene({ probeVolumes: [region] }));
  assert.notEqual(signature, getSceneLightingBakeSignature(scene({})));
  assert.equal(signature, getSceneLightingBakeSignature(scene({ probeVolumes: [{ ...region, name: '改名', id: 'renamed' }] })));
  assert.notEqual(signature, getSceneLightingBakeSignature(scene({ probeVolumes: [{ ...region, max: [12, 4, 8] }] })));
  assert.equal(getSceneLightingBakeSignature(scene({ probeVolumes: [{ ...region, enabled: false }] })), getSceneLightingBakeSignature(scene({})));
});
test('无效区域不能在保存时静默丢失', () => {
  assert.throws(() => normalizeSceneLightingBakeSettings({ probeVolumes: [{ ...region, max: [0, 1, 1] }] }), /区域/);
});
