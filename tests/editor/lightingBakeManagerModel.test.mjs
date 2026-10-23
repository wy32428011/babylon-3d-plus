import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporary = await mkdtemp(path.resolve('node_modules/.lighting-manager-ui-test-'));
after(async () => {
  if (path.dirname(temporary) !== path.resolve('node_modules') || !path.basename(temporary).startsWith('.lighting-manager-ui-test-')) throw new Error('UI测试临时目录不在预期范围');
  await rm(temporary, { recursive: true, force: true });
});
const entry = path.join(temporary, 'entry.mjs');
await writeFile(entry, "export * from '../../src/editor/panels/lightingBakeManagerModel.ts';");
await build({ configFile: false, publicDir: false, logLevel: 'silent',
  build: { ssr: entry, outDir: path.join(temporary, 'ssr'), rolldownOptions: { output: { entryFileNames: 'ui.mjs' } } } });
const { createLightingManagerDraft, isLightingManagerDraftDirty, buildLightingManagerRows, getLightingManagerImpact,
  stageLightingManagerExceptions, applyLightingManagerPreset, getLightingManagerPolicy, EMPTY_LIGHTING_BULK_VALUES } = await import(pathToFileURL(path.join(temporary, 'ssr/ui.mjs')).href);

const lightingFixture = () => ({ version: 2, allowDayNightCycle: true, result: null,
  main: { source: 'managed', enabled: true, color: '#ffffff', azimuthDegrees: 225, elevationDegrees: 45, intensity: 1 },
  fill: { intensity: 0.3, color: '#ffffff', groundColor: '#404040' }, environmentIntensity: 1, disabledLightIds: [],
  shadows: { enabled: true, quality: 'balanced', darkness: 0, distanceMeters: 0, bias: 0.001, normalBias: 0 },
  bake: { enabled: true, quality: 'standard', atlasSize: 1024, texelsPerMeter: 16, probeSpacing: 4, maxTextureMiB: 64, cacheStaticShadows: true, dynamicShadows: true },
});
const appearanceFixture = () => ({ version: 1, backgroundColor: '#20262e', skyboxVisible: true, exposure: 1, contrast: 1, toneMappingEnabled: false,
  glowIntensity: 0.5, bloomEnabled: false, bloomWeight: 0.12, fogEnabled: false, fogColor: '#20262e', fogStart: 180, fogEnd: 700 });

function sceneFixture() {
  return { name: '集中管理器回归', entityIds: ['machine'], entities: { machine: { id: 'machine', name: '设备一', parentId: null, childrenIds: [],
    components: { meshRenderer: { meshKind: 'cube' } } } }, sceneSettings: {
    lighting: lightingFixture(), appearance: appearanceFixture(),
  } };
}
function entryFixture(scene, nodeKey = 'root/column', patch = {}) {
  return { key: `machine/${nodeKey}`, entityId: 'machine', nodeKey, name: nodeKey, mobility: 'static', reason: '实际驱动固定结构',
    castShadows: true, receiveShadows: true, bakeIndirect: true, parentDynamic: false, resourceIdentity: 'geometry-v1',
    policyContext: { entityId: 'machine', ownerEntityId: 'machine', entity: scene.entities.machine, entities: scene.entities,
      nodeKey, partKey: nodeKey, resourceIdentity: 'geometry-v1', motionRole: 'fixed',
      automatic: { mobility: 'static', reason: '实际驱动固定结构' }, entityLighting: scene.entities.machine.components.lighting },
    ...patch };
}

test('统一配置打开空规则草稿不变脏，恢复参数后仍无待应用更改', () => {
  const scene = sceneFixture(), draft = createLightingManagerDraft(scene, 'session');
  assert.equal(isLightingManagerDraftDirty(draft), false);
  draft.lighting.bake.quality = 'high';
  assert.equal(isLightingManagerDraftDirty(draft), true);
  draft.lighting.bake.quality = 'standard';
  draft.entityLighting.machine = null;
  assert.equal(isLightingManagerDraftDirty(draft), false);
  assert.equal(scene.sceneSettings.lighting.policy, undefined);
  draft.lighting.policy = { version: 1, defaults: {}, rules: [] };
  assert.equal(isLightingManagerDraftDirty(draft), false, '新增再移除规则后应恢复无更改状态');
});

test('统一光照和显示草稿深复制文档，编辑未应用值不会提前污染场景', () => {
  const scene = sceneFixture();
  scene.sceneSettings.lighting = lightingFixture();
  scene.sceneSettings.appearance = appearanceFixture();
  const draft = createLightingManagerDraft(scene, 'session');
  assert.deepEqual(draft.lighting, scene.sceneSettings.lighting);
  assert.deepEqual(draft.appearance, scene.sceneSettings.appearance);
  assert.equal(isLightingManagerDraftDirty(draft), false);
  draft.lighting.main.intensity = 1.8;
  draft.lighting.disabledLightIds.push('scene-light');
  draft.appearance.exposure = 1.4;
  assert.equal(scene.sceneSettings.lighting.main.intensity, 1);
  assert.deepEqual(scene.sceneSettings.lighting.disabledLightIds, []);
  assert.equal(scene.sceneSettings.appearance.exposure, 1);
  assert.equal(isLightingManagerDraftDirty(draft), true);
});

test('光照预设只修改光照草稿，保留显示、规则、资产结果和实体例外', () => {
  const scene = sceneFixture();
  scene.sceneSettings.lighting = lightingFixture();
  scene.sceneSettings.appearance = appearanceFixture();
  scene.sceneSettings.lighting.result = { version: 1, signature: 'lighting-v2:previous-input', createdAt: '2026-10-21T00:00:00.000Z', engineVersion: 'test',
    assets: ['geometry', 'lightmap', 'probes'].map(kind => ({ id: kind, kind, url: `editor-asset://local/${kind}`, byteLength: 4 })),
    surfaces: [{ key: 'machine/root', entityId: 'machine', nodeKey: 'root', geometryAssetId: 'geometry', lightmapAssetId: 'lightmap' }],
    probeAssetId: 'probes', statistics: { meshCount: 1, triangleCount: 12, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 1 } };
  const draft = createLightingManagerDraft(scene, 'session');
  draft.entityLighting.machine = { mobility: 'dynamic', castShadows: false, receiveShadows: true, bakeIndirect: true, nodeOverrides: {} };
  const next = applyLightingManagerPreset(draft, 'warm-gold-dusk', 'lighting');
  assert.equal(next.lighting.main.color, '#ffd6a0');
  assert.equal(next.lighting.main.azimuthDegrees, 270);
  assert.equal(next.lighting.main.elevationDegrees, 18);
  assert.equal(next.lighting.fill.intensity, 0.6);
  assert.equal(next.lighting.environmentIntensity, 0.4);
  assert.equal(next.lighting.shadows.darkness, 0.35);
  assert.deepEqual(next.appearance, draft.appearance);
  assert.equal(next.entityLighting, draft.entityLighting);
  assert.equal(next.lighting.bake, draft.lighting.bake);
  assert.equal(next.lighting.policy, draft.lighting.policy);
  assert.equal(next.lighting.result, draft.lighting.result);
  assert.equal(next.lighting.result.signature, 'lighting-v2:previous-input');
  assert.equal(scene.sceneSettings.lighting.main.color, '#ffffff');
});

test('显示预设仅修改显示草稿，曝光和雾不改变照明配置', () => {
  const scene = sceneFixture();
  scene.sceneSettings.lighting = lightingFixture();
  scene.sceneSettings.appearance = appearanceFixture();
  const draft = createLightingManagerDraft(scene, 'session');
  const next = applyLightingManagerPreset(draft, 'teal-night', 'appearance');
  assert.equal(next.lighting, draft.lighting);
  assert.equal(next.appearance.backgroundColor, '#071d22');
  assert.equal(next.appearance.fogEnabled, true);
  assert.equal(next.appearance.exposure, 1.1);
  assert.equal(next.appearance.skyboxVisible, false);
  assert.equal(next.baseScene, scene);
  assert.equal(scene.sceneSettings.appearance.backgroundColor, '#20262e');
  assert.equal(isLightingManagerDraftDirty(next), true);
});

test('预设与规则表单保留现有配置和规则中的扩展元数据', () => {
  const scene = sceneFixture();
  scene.sceneSettings.lighting.main.metadata = { source: 'import' };
  scene.sceneSettings.lighting.fill.metadata = { purpose: 'fixture' };
  scene.sceneSettings.appearance.metadata = { author: 'test' };
  scene.sceneSettings.lighting.policy = { version: 1, defaults: {}, rules: [
    { id: 'extension-rule', enabled: true, target: { kind: 'all' }, values: { mobility: 'static' }, metadata: { source: 'model-template' } },
  ], metadata: { source: 'saved-policy' } };
  const draft = createLightingManagerDraft(scene, 'session');
  const light = applyLightingManagerPreset(draft, 'industrial-daylight', 'lighting');
  const display = applyLightingManagerPreset(draft, 'industrial-daylight', 'appearance');
  assert.deepEqual(light.lighting.main.metadata, { source: 'import' });
  assert.deepEqual(light.lighting.fill.metadata, { purpose: 'fixture' });
  assert.deepEqual(display.appearance.metadata, { author: 'test' });
  const formPolicy = getLightingManagerPolicy(draft.lighting.policy);
  assert.deepEqual(formPolicy.metadata, { source: 'saved-policy' });
  assert.deepEqual(formPolicy.rules[0].metadata, { source: 'model-template' });
});

test('移除动态规则后草稿预览使用原始自动事实，不被旧有效分类污染', () => {
  const scene = sceneFixture();
  scene.sceneSettings.lighting.policy = { version: 1, defaults: {}, rules: [{ id: 'old', enabled: true, target: { kind: 'all' }, values: { mobility: 'dynamic' } }] };
  const draft = createLightingManagerDraft(scene, 'session');
  draft.lighting.policy = { version: 1, defaults: {}, rules: [] };
  const rows = buildLightingManagerRows(scene, [entryFixture(scene, 'root/column', { mobility: 'dynamic' })], draft);
  assert.equal(rows[0].previous.settings.mobility, 'dynamic');
  assert.equal(rows[0].effective.settings.mobility, 'static');
  assert.equal(rows[0].effective.fieldSources.mobility.kind, 'automatic');
  assert.equal(getLightingManagerImpact(rows).affectedEntityCount, 1);
});

test('完整节点清单先聚合，其他有效节点不会在草稿预览被误报缺失', () => {
  const scene = sceneFixture(), draft = createLightingManagerDraft(scene, 'session');
  draft.lighting.policy = { version: 1, defaults: {}, rules: [{ id: 'rule', enabled: true, target: { kind: 'all' }, values: {},
    nodeRules: [{ id: 'deck-rule', enabled: true, target: { kind: 'node', nodeKey: 'root/deck', resourceIdentity: 'geometry-v1' }, values: { castShadows: false } }] }] };
  const rows = buildLightingManagerRows(scene, [entryFixture(scene), entryFixture(scene, 'root/deck')], draft);
  assert.equal(getLightingManagerImpact(rows).mismatchCount, 0);
  assert.equal(rows[0].effective.settings.castShadows, true);
  assert.equal(rows[1].effective.settings.castShadows, false);
  assert.equal(rows[0].context.availableNodeKeys, rows[1].context.availableNodeKeys);
});

test('当前文档已移除的例外不会被迟到的运行时快照复活', () => {
  const scene = sceneFixture(), draft = createLightingManagerDraft(scene, 'session');
  const entry = entryFixture(scene);
  entry.policyContext.entityLighting = { mobility: 'dynamic', castShadows: false, receiveShadows: false, bakeIndirect: false, nodeOverrides: {} };
  const row = buildLightingManagerRows(scene, [entry], draft)[0];
  assert.equal(row.context.entityLighting, undefined);
  assert.equal(Object.hasOwn(row.context, 'entityLighting'), true);
  assert.equal(row.effective.settings.mobility, 'static');
  assert.equal(row.effective.settings.castShadows, true);
  assert.deepEqual(row.effective.preservedExceptionFields, []);
});

test('批量仅修改指定字段，保持其他旧实体例外及子部件覆盖', () => {
  const scene = sceneFixture();
  scene.entities.machine.components.lighting = { mobility: 'static', castShadows: true, receiveShadows: false, bakeIndirect: false,
    nodeOverrides: { rail: { mobility: 'dynamic', castShadows: true } } };
  const draft = createLightingManagerDraft(scene, 'session');
  const rows = buildLightingManagerRows(scene, [entryFixture(scene)], draft);
  const result = stageLightingManagerExceptions(draft, rows, [{ kind: 'entity', entityId: 'machine' }], { ...EMPTY_LIGHTING_BULK_VALUES, castShadows: 'false' });
  assert.equal(result.ok, true);
  const next = result.entityLighting.machine;
  assert.equal(next.castShadows, false);
  assert.equal(next.mobility, 'static');
  assert.equal(next.receiveShadows, false);
  assert.equal(next.bakeIndirect, false);
  assert.deepEqual(next.nodeOverrides, scene.entities.machine.components.lighting.nodeOverrides);
  assert.equal(scene.entities.machine.components.lighting.castShadows, true);
});

test('修改旧节点阴影不会把旧auto继承变成新显式自动，逐字段继承可恢复', () => {
  const scene = sceneFixture();
  scene.entities.machine.components.lighting = { mobility: 'dynamic', castShadows: true, receiveShadows: true, bakeIndirect: true,
    resourceIdentity: 'geometry-v1', nodeOverrides: { 'root/column': { mobility: 'auto', receiveShadows: false } } };
  const draft = createLightingManagerDraft(scene, 'session');
  const rows = buildLightingManagerRows(scene, [entryFixture(scene)], draft);
  const result = stageLightingManagerExceptions(draft, rows, [{ kind: 'node', key: rows[0].key }],
    { ...EMPTY_LIGHTING_BULK_VALUES, castShadows: 'false' });
  assert.equal(result.ok, true);
  const node = result.entityLighting.machine.nodeOverrides['root/column'];
  assert.equal(node.castShadows, false);
  assert.equal(node.receiveShadows, false);
  assert.ok(node.inheritPolicy.includes('mobility'));
  draft.entityLighting = result.entityLighting;
  assert.equal(buildLightingManagerRows(scene, [entryFixture(scene)], draft)[0].effective.settings.mobility, 'dynamic');
  const inherited = stageLightingManagerExceptions(draft, rows, [{ kind: 'node', key: rows[0].key }],
    { ...EMPTY_LIGHTING_BULK_VALUES, castShadows: 'inherit' });
  assert.ok(inherited.entityLighting.machine.nodeOverrides['root/column'].inheritPolicy.includes('castShadows'));
});

test('恢复所选节点只清除该节点，锁定父级和动态祖先约束仍生效', () => {
  const scene = sceneFixture();
  scene.entities.machine.components.lighting = { mobility: 'auto', castShadows: false, receiveShadows: true, bakeIndirect: true,
    nodeOverrides: { 'root/column': { mobility: 'static' }, 'root/deck': { mobility: 'dynamic' } } };
  const draft = createLightingManagerDraft(scene, 'session'), rows = buildLightingManagerRows(scene, [entryFixture(scene)], draft);
  const result = stageLightingManagerExceptions(draft, rows, [{ kind: 'node', key: rows[0].key }], EMPTY_LIGHTING_BULK_VALUES, true);
  assert.equal(result.ok, true);
  assert.equal(result.entityLighting.machine.nodeOverrides['root/column'], undefined);
  assert.deepEqual(result.entityLighting.machine.nodeOverrides['root/deck'], { mobility: 'dynamic' });
  assert.equal(result.entityLighting.machine.castShadows, false);
  rows[0].entry.parentDynamic = true;
  assert.equal(stageLightingManagerExceptions(draft, rows, [{ kind: 'node', key: rows[0].key }], { ...EMPTY_LIGHTING_BULK_VALUES, mobility: 'static' }).ok, false);
  scene.entities.parent = { id: 'parent', name: '锁定组', isFolder: true, locked: true, parentId: null, childrenIds: ['machine'], components: {} };
  scene.entities.machine.parentId = 'parent';
  assert.equal(stageLightingManagerExceptions(draft, rows, [{ kind: 'entity', entityId: 'machine' }], EMPTY_LIGHTING_BULK_VALUES, true).ok, false);
});

test('同宿主临时生成部件不能写宿主例外，稳定资源部件规则仍覆盖全部匹配实例', () => {
  const scene = sceneFixture(), draft = createLightingManagerDraft(scene, 'session');
  const sourceUrl = 'editor-asset://local/C%3A%2Fmodels%2Fcargo.glb';
  const generated = ['temporary-cargo-a', 'temporary-cargo-b'].map(entityId => {
    const entry = entryFixture(scene, 'root/deck');
    return { ...entry, key: `${entityId}/root/deck`, entityId, mobility: 'dynamic',
      policyContext: { ...entry.policyContext, entityId, ownerEntityId: 'machine', modelAsset: { sourceUrl },
        automatic: { mobility: 'dynamic', reason: '运行时生成的运动部件' }, motionRole: 'moving' } };
  });
  const rows = buildLightingManagerRows(scene, generated, draft);
  for (const reset of [false, true]) {
    const result = stageLightingManagerExceptions(draft, rows, [{ kind: 'node', key: rows[0].key }],
      { ...EMPTY_LIGHTING_BULK_VALUES, castShadows: 'false' }, reset);
    assert.equal(result.ok, false);
    assert.match(result.message, /生成部件请使用模型资源或类型规则/);
  }
  assert.deepEqual(draft.entityLighting, {});
  assert.equal(scene.entities.machine.components.lighting, undefined);
  draft.lighting.policy = { version: 1, defaults: {}, rules: [{ id: 'cargo-resource', enabled: true, target: { kind: 'resource', model: { sourceUrl } }, values: {},
    nodeRules: [{ id: 'cargo-part', enabled: true, target: { kind: 'node', nodeKey: 'root/deck', resourceIdentity: 'geometry-v1' }, values: { castShadows: false } }] }] };
  const resolved = buildLightingManagerRows(scene, generated, draft);
  assert.ok(resolved.every(row => row.effective.settings.castShadows === false));
  assert.ok(resolved.every(row => row.effective.fieldSources.castShadows.kind === 'node-rule'));
  // 宿主自身仍是普通持久化对象，可编辑整体配置。
  const host = stageLightingManagerExceptions(draft, resolved, [{ kind: 'entity', entityId: 'machine' }],
    { ...EMPTY_LIGHTING_BULK_VALUES, receiveShadows: 'false' });
  assert.equal(host.ok, true);
  assert.equal(host.entityLighting.machine.receiveShadows, false);
});

test('真实逻辑阵列实例仍写自己的例外，不误写源模型或显示宿主', () => {
  const scene = sceneFixture();
  scene.entities['array-item'] = { id: 'array-item', name: '设备一阵列实例', parentId: null, childrenIds: [],
    components: { meshRenderer: { meshKind: 'cube' }, modelArrayInstance: { sourceEntityId: 'machine' } } };
  scene.entityIds.push('array-item');
  const draft = createLightingManagerDraft(scene, 'session'), base = entryFixture(scene, 'root/deck');
  const entry = { ...base, key: 'array-item/root/deck', entityId: 'array-item',
    policyContext: { ...base.policyContext, entityId: 'array-item', ownerEntityId: 'machine' } };
  const rows = buildLightingManagerRows(scene, [entry], draft);
  assert.equal(rows[0].ownerEntityId, 'array-item');
  const result = stageLightingManagerExceptions(draft, rows, [{ kind: 'node', key: rows[0].key }],
    { ...EMPTY_LIGHTING_BULK_VALUES, castShadows: 'false' });
  assert.equal(result.ok, true);
  assert.equal(result.entityLighting['array-item'].nodeOverrides['root/deck'].castShadows, false);
  assert.equal(result.entityLighting.machine, undefined);
});
