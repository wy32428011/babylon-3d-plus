import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findMatchingEnvironmentResource,
  normalizeEnvironmentResourceReference,
} from '../../electron/shared/environmentResourceMatch.ts';

const describe = (resource: { id: string; name: string }) => ({
  resourceId: resource.id,
  displayName: resource.name,
});

test('稳定 ID 唯一匹配优先于名称和名称歧义', () => {
  const resources = [
    { id: '101', name: '已改名园区' },
    { id: '102', name: '旧园区' },
    { id: '103', name: '旧园区' },
  ];
  assert.equal(findMatchingEnvironmentResource(resources, { resourceId: '101', displayName: '旧园区' }, describe), resources[0]);
});

test('迁移到不同 ID 后按当前中台唯一显示名称匹配', () => {
  const resources = [{ id: '901', name: '园区' }];
  assert.equal(findMatchingEnvironmentResource(resources, { resourceId: '101', displayName: '园区' }, describe), resources[0]);
});

test('名称匹配忽略首尾空白、大小写和末尾 GLB 或 GLTF 文件后缀', () => {
  const resources = [{ id: '901', name: '  Campus.GLTF  ' }];
  for (const displayName of ['campus', ' CAMPUS.glb ', 'Campus.gltf']) {
    assert.equal(findMatchingEnvironmentResource(resources, { displayName }, describe), resources[0]);
  }
  assert.equal(findMatchingEnvironmentResource(resources, { displayName: 'campus.glb.backup' }, describe), null);
});

test('重复稳定 ID 报歧义，不能借名称选择其中一项', () => {
  const resources = [{ id: '101', name: '园区一' }, { id: '101', name: '园区二' }];
  assert.throws(() => findMatchingEnvironmentResource(resources, { resourceId: '101', displayName: '园区一' }, describe), /ID.*歧义/);
});

test('名称归一化后存在多个候选时报中文歧义', () => {
  const resources = [{ id: '901', name: 'Campus.glb' }, { id: '902', name: ' campus.GLTF ' }];
  assert.throws(() => findMatchingEnvironmentResource(resources, { resourceId: '101', displayName: 'CAMPUS' }, describe), /名称.*歧义/);
});

test('引用缺失、资源为空或没有匹配时返回 null', () => {
  const resources = [{ id: '101', name: '园区' }];
  for (const reference of [{}, { displayName: ' ' }, { resourceId: '102' }, { displayName: '其它园区' }, { displayName: '.glb' }]) {
    assert.equal(findMatchingEnvironmentResource(resources, reference, describe), null);
  }
  assert.equal(findMatchingEnvironmentResource([], { resourceId: '101' }, describe), null);
});

test('非法 ID 不参与稳定 ID 匹配，但仍允许名称匹配', () => {
  const resources = [{ id: '01', name: '错误候选' }, { id: '901', name: '园区' }];
  assert.equal(findMatchingEnvironmentResource(resources, { resourceId: '01', displayName: '园区' }, describe), resources[1]);
});

test('匹配返回原资源引用且不修改数组、资源或引用条件', () => {
  const resources = Object.freeze([
    Object.freeze({ id: '901', name: ' Campus.glb ', details: Object.freeze({ version: 2 }) }),
  ]);
  const reference = Object.freeze({ resourceId: '101', displayName: 'campus' });
  const before = JSON.stringify({ resources, reference });
  assert.equal(findMatchingEnvironmentResource(resources, reference, describe), resources[0]);
  assert.equal(JSON.stringify({ resources, reference }), before);
});

test('引用归一化接受单独合法 ID、单独名称和两者组合', () => {
  assert.deepEqual(normalizeEnvironmentResourceReference({ resourceId: '1' }), { resourceId: '1' });
  assert.deepEqual(normalizeEnvironmentResourceReference({ displayName: ' 园区.glb ' }), { displayName: '园区.glb' });
  assert.deepEqual(normalizeEnvironmentResourceReference({ resourceId: '901', displayName: ' 园区 ' }), { resourceId: '901', displayName: '园区' });
  assert.deepEqual(normalizeEnvironmentResourceReference({ resourceId: undefined, displayName: '园区' }), { displayName: '园区' });
});

test('引用归一化接受 ID 和名称边界长度', () => {
  const resourceId = '9'.repeat(64);
  const displayName = '园'.repeat(512);
  assert.deepEqual(normalizeEnvironmentResourceReference({ resourceId, displayName }), { resourceId, displayName });
});

test('拒绝非对象、数组和空引用', () => {
  for (const value of [null, undefined, false, 101, '园区', [], [{ resourceId: '1' }], {}, { resourceId: undefined, displayName: undefined }]) {
    assert.throws(() => normalizeEnvironmentResourceReference(value), /环境资源引用/);
  }
});

test('拒绝非法或恶意 ID，不以同时存在的合法名称掩盖错误', () => {
  for (const resourceId of ['', '0', '01', '-1', '1.0', '1e2', ' 1 ', '../1', '1/2', '1\n', '9'.repeat(65), 1, null, {}, ['1']]) {
    assert.throws(() => normalizeEnvironmentResourceReference({ resourceId, displayName: '园区' }), /环境资源.*ID/);
  }
});

test('拒绝空白、过长或非字符串名称，不以合法 ID 掩盖错误', () => {
  for (const displayName of ['', ' \t\n ', '园'.repeat(513), null, 101, {}, ['园区']]) {
    assert.throws(() => normalizeEnvironmentResourceReference({ resourceId: '1', displayName }), /环境资源.*名称/);
  }
});

test('引用归一化返回新对象，剔除无关字段且不修改输入', () => {
  const value = Object.freeze({ resourceId: '901', displayName: ' 园区 ', unexpected: 'value' });
  const normalized = normalizeEnvironmentResourceReference(value);
  assert.deepEqual(normalized, { resourceId: '901', displayName: '园区' });
  assert.notEqual(normalized, value);
  assert.equal(value.displayName, ' 园区 ');
});
