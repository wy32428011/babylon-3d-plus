import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Matrix, MeshBuilder, NullEngine, Scene, TransformNode, VertexBuffer } from '@babylonjs/core';
import { appendGeneratedLightingSources, collectLightingRuntimeSources } from '../../src/runtime/babylon/lightingClassificationRuntime.ts';
import { EntityArrayThinInstanceBatch } from '../../src/runtime/babylon/EntityArrayThinInstanceBatch.ts';
import { getNativeLightingInstances } from '../../src/runtime/babylon/lightingNativeInstances.ts';

type Context = Parameters<typeof collectLightingRuntimeSources>[0];
const project = new URL('../../', import.meta.url);
const runtimeHooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href) && !context.parentURL.includes('/node_modules/')) {
      const target = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
      if (existsSync(target)) return next(target.href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (/\.(png|jpg|svg)$/.test(url)) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)}` };
    return next(url, context);
  },
});
const { SceneEnvironmentRuntime } = await import('../../src/runtime/babylon/SceneEnvironmentRuntime.ts');
runtimeHooks.deregister();
const sourceUrl = 'editor-asset://local/' + encodeURIComponent('C:/project/Assets/Models/lift/model.glb');
const otherUrl = 'editor-asset://local/' + encodeURIComponent('C:/project/Assets/Models/other/model.glb');
const transform = (x = 0) => ({ position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
const policy = (rules: unknown[], defaults = {}) => ({ version: 1, defaults, rules });
const resourceRule = (values: unknown, nodeRules?: unknown[]) => ({
  id: 'lift-resource', enabled: true, target: { kind: 'resource', model: { sourceUrl } }, values,
  ...(nodeRules ? { nodeRules } : {}),
});

function fixture() {
  const engine = new NullEngine(), scene = new Scene(engine);
  const entities: Record<string, any> = {
    folder: { id: 'folder', name: '设备组', isFolder: true, parentId: null, childrenIds: [], components: {} },
  };
  const document = { entities, sceneSettings: { lighting: { ...normalizeSceneLightingConfig(undefined), policy: undefined as unknown } } };
  const models: Array<[string, any]> = [];
  const batches: EntityArrayThinInstanceBatch[] = [];
  const context = { scene, document, models, primitiveMeshes: new Map(), environment: [], batches,
    getMotionTargets: () => ({ moving: [] as TransformNode[], fixed: [] as TransformNode[], known: false }),
    readEntityId: () => null };
  const add = (id: string, options: { sourceUrl?: string; size?: number; parentId?: string | null } = {}) => {
    const root = new TransformNode(id + '-root', scene);
    const fixed = MeshBuilder.CreateBox('fixed', { size: options.size ?? 1 }, scene); fixed.parent = root;
    const movingRoot = new TransformNode('carriage', scene); movingRoot.parent = root;
    const moving = MeshBuilder.CreateBox('deck', {}, scene); moving.parent = movingRoot;
    const actualUrl = options.sourceUrl ?? sourceUrl;
    const asset = { sourceUrl: actualUrl, sourcePath: decodeURIComponent(new URL(actualUrl).pathname.slice(1)) };
    const entity = { id, name: id, parentId: options.parentId === undefined ? 'folder' : options.parentId,
      childrenIds: [], components: { modelAsset: asset, transform: transform() } };
    entities[id] = entity;
    const model = { root, contentRoot: root, meshes: [fixed, moving], assetRevision: 'r1', parameterSignature: '',
      sourceUrl: asset.sourceUrl, resolvedModelAsset: asset, entitySnapshot: entity, assetHandle: null, externalScriptRuntime: null };
    models.push([id, model]);
    return { entity, model, root, fixed, movingRoot, moving };
  };
  const collect = () => collectLightingRuntimeSources(context as unknown as Context);
  return { engine, scene, entities, document, models, batches, context, add, collect,
    dispose() { scene.dispose(); engine.dispose(); } };
}

test('资源规则使用实际resolved模型来源，已存在和后续新增实例共同继承', () => {
  const f = fixture();
  try {
    const first = f.add('one');
    first.entity.components.modelAsset = { sourceUrl: otherUrl, sourcePath: 'C:/project/Assets/Models/other/model.glb' };
    f.document.sceneSettings.lighting.policy = policy([resourceRule({ castShadows: false, bakeIndirect: false })]);
    assert.ok(f.collect().every(source => !source.entry.castShadows && !source.entry.bakeIndirect));
    f.add('two');
    const sources = f.collect();
    assert.equal(new Set(sources.map(source => source.entry.entityId)).size, 2);
    assert.ok(sources.every(source => !source.entry.castShadows && !source.entry.bakeIndirect));
    assert.ok(sources.every(source => source.entry.matchedRuleIds?.includes('lift-resource')));
  } finally { f.dispose(); }
});

test('既有实体例外优先，逐字段恢复继承后才采用场景规则', () => {
  const f = fixture();
  try {
    const item = f.add('one');
    Object.assign(item.entity.components, { lighting: { mobility: 'static', castShadows: true, receiveShadows: true, bakeIndirect: true } });
    f.document.sceneSettings.lighting.policy = policy([resourceRule({ castShadows: false, receiveShadows: false, bakeIndirect: false })]);
    assert.ok(f.collect().every(source => source.entry.castShadows && source.entry.receiveShadows && source.entry.bakeIndirect));
    Object.assign(item.entity.components.lighting, { inheritPolicy: ['castShadows', 'bakeIndirect'] });
    assert.ok(f.collect().every(source => !source.entry.castShadows && source.entry.receiveShadows && !source.entry.bakeIndirect));
  } finally { f.dispose(); }
});

test('mobility恢复继承使用真实自动底值，场景dynamic默认不会把静止folder变成运动祖先', () => {
  const f = fixture();
  try {
    const item = f.add('one');
    const lighting = { mobility: 'dynamic', castShadows: true, receiveShadows: true, bakeIndirect: true, inheritPolicy: ['mobility'] };
    Object.assign(item.entity.components, { lighting });
    f.document.sceneSettings.lighting.policy = policy([]);
    assert.ok(f.collect().every(source => source.entry.mobility === 'static' && source.entry.automaticMobility === 'static'));
    Object.assign(lighting, { mobility: 'static', inheritPolicy: [] });
    f.document.sceneSettings.lighting.policy = policy([], { mobility: 'dynamic' });
    assert.ok(f.collect().every(source => source.entry.mobility === 'static' && !source.entry.parentDynamic));
    Object.assign(f.entities.folder.components, { lighting: { mobility: 'dynamic', inheritPolicy: ['mobility'] } });
    assert.ok(f.collect().every(source => source.entry.mobility === 'static' && !source.entry.parentDynamic),
      '祖先已恢复继承的旧manual字段不能继续制造动态祖先');
  } finally { f.dispose(); }
});

test('目录规则匹配实际实体祖先，真实运动父级不能被资源静态规则抵消', () => {
  const f = fixture();
  try {
    const first = f.add('one');
    f.add('outside', { sourceUrl: otherUrl, parentId: null });
    f.context.getMotionTargets = () => ({ moving: [first.movingRoot], fixed: [first.fixed], known: true });
    f.document.sceneSettings.lighting.policy = policy([
      { id: 'folder-rule', enabled: true, target: { kind: 'group', folderId: 'folder' }, values: { receiveShadows: false } },
      resourceRule({ mobility: 'static' }),
    ]);
    const sources = f.collect();
    assert.equal(sources.find(source => source.mesh === first.fixed)?.entry.receiveShadows, false);
    assert.equal(sources.find(source => source.entry.entityId === 'outside')?.entry.receiveShadows, true);
    assert.equal(sources.find(source => source.mesh === first.moving)?.entry.mobility, 'dynamic');
    assert.equal(sources.find(source => source.mesh === first.moving)?.entry.parentDynamic, true);
  } finally { f.dispose(); }
});

test('设备类型规则依据实际解析模型声明，不按名称或模板容器猜测', () => {
  const f = fixture();
  try {
    const lift = f.add('named-anything'), plain = f.add('name-contains-lift', { sourceUrl: otherUrl });
    Object.assign(lift.model.resolvedModelAsset, { dataDrivenConfig: { device: { devType: 'lift' }, fixedNodes: [] } });
    f.document.sceneSettings.lighting.policy = policy([
      { id: 'lift-type', enabled: true, target: { kind: 'type', deviceType: 'lift' }, values: { bakeIndirect: false } },
    ]);
    const sources = f.collect();
    assert.ok(sources.filter(source => source.entry.entityId === lift.entity.id).every(source => !source.entry.bakeIndirect));
    assert.ok(sources.filter(source => source.entry.entityId === plain.entity.id).every(source => source.entry.bakeIndirect));
  } finally { f.dispose(); }
});

test('同资源稳定部件规则跨实例匹配，参数拓扑变化明确失配且不误套', () => {
  const f = fixture();
  try {
    const first = f.add('one');
    const original = f.collect().find(source => source.mesh === first.fixed)!;
    f.add('two');
    const changed = f.add('changed', { size: 2 });
    const changedTopology = f.add('changed-topology');
    const extra = MeshBuilder.CreateBox('generated-extra', {}, f.scene); extra.parent = changedTopology.root;
    f.document.sceneSettings.lighting.policy = policy([resourceRule({}, [{
      id: 'fixed-part', enabled: true, target: { kind: 'node', nodeKey: original.entry.nodeKey,
        resourceIdentity: original.entry.resourceIdentity }, values: { receiveShadows: false },
    }])]);
    const sources = f.collect();
    assert.equal(sources.find(source => source.mesh === first.fixed)?.entry.receiveShadows, false);
    assert.equal(sources.find(source => source.entry.entityId === 'two' && source.mesh.name === 'fixed')?.entry.receiveShadows, false);
    const mismatch = sources.find(source => source.mesh === changed.fixed)!;
    assert.equal(mismatch.entry.receiveShadows, true);
    assert.ok(mismatch.entry.policyMismatches?.some(item => item.kind === 'resource-identity'));
    assert.ok(sources.find(source => source.mesh === changedTopology.fixed)?.entry.policyMismatches?.some(item => item.kind === 'resource-identity'),
      '脚本后来挂入的真实子几何也必须参与资源身份');
  } finally { f.dispose(); }
});

test('原生薄实例的稳定part规则覆盖全部实例，不使用可见前缀作为范围', () => {
  const f = fixture();
  try {
    const item = f.add('native');
    const before = f.collect().find(source => source.mesh === item.fixed)!;
    item.fixed.thinInstanceSetBuffer('matrix', new Float32Array([...Matrix.Identity().asArray(), ...Matrix.Translation(50, 0, 0).asArray()]), 16);
    f.document.sceneSettings.lighting.policy = policy([resourceRule({}, [{
      id: 'native-part', enabled: true, target: { kind: 'node', nodeKey: before.entry.nodeKey, resourceIdentity: before.entry.resourceIdentity },
      values: { castShadows: false },
    }])]);
    const sources = f.collect().filter(source => source.mesh === item.fixed);
    assert.equal(sources.length, 2);
    assert.ok(sources.every(source => !source.entry.castShadows));
  } finally { f.dispose(); }
});

test('真实逻辑实例批次按宿主资源匹配并保留各实例实体例外', () => {
  const f = fixture();
  let batch: EntityArrayThinInstanceBatch | null = null;
  try {
    const item = f.add('host');
    batch = EntityArrayThinInstanceBatch.create('host', [item.fixed], { interactive: true });
    assert.ok(batch);
    const second = { id: 'logical-two', name: 'logical-two', parentId: 'folder', childrenIds: [],
      components: { transform: transform(5), modelArrayInstance: { sourceEntityId: 'host' },
        lighting: { mobility: 'auto', castShadows: true, receiveShadows: true, bakeIndirect: true } } };
    f.entities[second.id] = second;
    assert.equal(batch.updateEntityTransforms(Matrix.Identity(), [
      { entityId: item.entity.id, transform: transform(), pickable: true },
      { entityId: second.id, transform: transform(5), pickable: true },
    ]), true);
    Object.assign(item.model, { modelArrayBatch: batch });
    f.batches.push(batch);
    f.document.sceneSettings.lighting.policy = policy([resourceRule({ castShadows: false })]);
    const sources = f.collect();
    assert.equal(sources.find(source => source.entry.entityId === 'host')?.entry.castShadows, false);
    assert.equal(sources.find(source => source.entry.entityId === second.id)?.entry.castShadows, true);
    Object.assign(item.entity.components, { lighting: { mobility: 'auto', castShadows: false, receiveShadows: true, bakeIndirect: true } });
    delete (second.components as any).lighting;
    f.document.sceneSettings.lighting.policy = policy([resourceRule({ castShadows: true })]);
    const reset = f.collect();
    assert.equal(reset.find(source => source.entry.entityId === 'host')?.entry.castShadows, false);
    assert.equal(reset.find(source => source.entry.entityId === second.id)?.entry.castShadows, true,
      '实例没有lighting组件时继承场景规则，不能暗中继承渲染宿主的例外');
  } finally { batch?.dispose(); f.dispose(); }
});

test('真实生成组合的非interactive批次可读取全部权威实例并通过原生整叶协议接管', () => {
  const f = fixture();
  let batch: EntityArrayThinInstanceBatch | null = null;
  try {
    const item = f.add('generated-source');
    batch = EntityArrayThinInstanceBatch.create('member', [item.fixed], { interactive: false });
    assert.ok(batch);
    assert.equal(batch.updateEntityTransforms(Matrix.Identity(), [
      { entityId: 'member', transform: transform(), pickable: false },
      { entityId: 'second-member', transform: transform(5000), pickable: false },
    ]), true);
    const sources = batch.getLightingInstances();
    assert.deepEqual(sources.map(source => source.entityId), ['member', 'second-member']);
    assert.equal(batch.getLightingInstanceWorldMatrix(sources[1].mesh, 1)?.getTranslation().x, 5000);
    assert.equal(batch.isLightingInstanceVisible(sources[1].mesh, 1), true);
    const mesh = sources[0].mesh, originalLayer = mesh.layerMask;
    const native = getNativeLightingInstances(mesh, 'generated-owner');
    native.setLightingHiddenInstances(new Map([[mesh.uniqueId, new Set([0, 1])]]));
    assert.equal(mesh.layerMask, 0);
    assert.equal(batch.getLightingInstances().length, 2);
    assert.equal(native.getLightingInstanceWorldMatrix(mesh, 1)?.getTranslation().x, 5000);
    native.setLightingHiddenInstances(new Map());
    assert.equal(mesh.layerMask, originalLayer);
  } finally { batch?.dispose(); f.dispose(); }
});

test('实际生成组合成员与阵列进入同一规则目录，多货物复用nodeId也不冲突且保留动态宿主约束', () => {
  const f = fixture();
  const batches: EntityArrayThinInstanceBatch[] = [];
  try {
    const first = f.add('host-a'), second = f.add('host-b');
    const identity = f.collect().find(source => source.mesh === first.fixed)!.entry.resourceIdentity;
    const members = [first, second].map((item, index) => {
      Object.assign(item.model, { entitySnapshot: null });
      const batch = EntityArrayThinInstanceBatch.create('member', item.model.meshes, { interactive: false })!;
      assert.ok(batch); batches.push(batch);
      assert.equal(batch.updateEntityTransforms(Matrix.Identity(), [
        { entityId: 'member', transform: transform(index * 20), pickable: false },
        { entityId: 'second-member', transform: transform(index * 20 + 5), pickable: false },
      ]), true);
      // 与真实生成组合一致：源网格退出scene，模型和批次仍持有完整实际几何。
      f.scene.removeMesh(item.fixed); f.scene.removeMesh(item.moving);
      return ['cargo-' + index, {
        entityId: 'cargo-' + index, editorEntityId: null, metadata: { generatedCargo: true, hostEntityId: item.entity.id },
        output: { kind: 'composition', members: [{ nodeId: 'member', model: item.model, mesh: null, arrayBatch: batch }] },
      }];
    });
    const target = { models: [] as Array<[string, any]>, primitiveMeshes: new Map(), batches: new Set<EntityArrayThinInstanceBatch>(),
      sourceOwners: new Map(), batchOwners: new Map() };
    appendGeneratedLightingSources(f.document as any, members as any, target);
    assert.equal(target.models.length, 2); assert.equal(target.batches.size, 2);
    f.document.sceneSettings.lighting.policy = policy([resourceRule({ mobility: 'static', receiveShadows: false }, [{
      id: 'fixed-part', enabled: true, target: { kind: 'node', nodeKey: 'fixed[0]', resourceIdentity: identity }, values: { castShadows: false },
    }])]);
    const sources = collectLightingRuntimeSources({ ...f.context, ...target } as unknown as Context);
    assert.equal(sources.length, 8);
    assert.equal(new Set(sources.map(source => source.entry.key)).size, 8);
    assert.ok(sources.every(source => source.entry.mobility === 'dynamic' && source.entry.parentDynamic));
    assert.ok(sources.every(source => !source.entry.receiveShadows));
    assert.equal(sources.filter(source => source.entry.policyContext?.partKey === 'fixed[0]' && !source.entry.castShadows).length, 4);
    assert.equal(sources.filter(source => source.entry.policyContext?.partKey === 'carriage[0]/deck[0]' && source.entry.castShadows).length, 4);
    assert.deepEqual(new Set(sources.map(source => source.entry.policyContext?.ownerEntityId)), new Set(['host-a', 'host-b']));
    assert.ok(sources.every(source => !source.entry.policyContext?.entities && !source.entry.policyContext?.entity
      && !source.entry.policyContext?.availableNodeKeys));
  } finally { for (const batch of batches) batch.dispose(); f.dispose(); }
});

test('生成器内置几何不会误匹配其设备宿主的模型资源与设备类型', () => {
  const f = fixture();
  try {
    const host = f.add('host');
    Object.assign(host.entity.components, { telemetryBinding: { deviceType: 'lift' } });
    const mesh = MeshBuilder.CreateBox('generated-box', {}, f.scene);
    const target = { models: [] as Array<[string, any]>, primitiveMeshes: new Map(), batches: new Set<EntityArrayThinInstanceBatch>(),
      sourceOwners: new Map(), batchOwners: new Map() };
    appendGeneratedLightingSources(f.document as any, [['cargo', {
      entityId: 'cargo', editorEntityId: null, metadata: { generatedCargo: true, hostEntityId: host.entity.id },
      output: { kind: 'mesh', mesh, target: { kind: 'mesh', meshKind: 'cube' } },
    }]] as any, target);
    f.document.sceneSettings.lighting.policy = policy([
      resourceRule({ castShadows: false }),
      { id: 'lift-type', enabled: true, target: { kind: 'type', deviceType: 'lift' }, values: { receiveShadows: false } },
    ]);
    const [source] = collectLightingRuntimeSources({ ...f.context, ...target } as unknown as Context);
    assert.equal(source.entry.castShadows, true);
    assert.equal(source.entry.receiveShadows, true);
    assert.equal(source.entry.deviceType, 'mesh:cube');
    assert.equal(source.entry.policyContext?.modelAsset?.sourceUrl, undefined);
  } finally { f.dispose(); }
});

test('环境规则读取实际运行变体和独立资源身份，无实体也可按类型和资源管理', () => {
  const f = fixture();
  try {
    const mesh = MeshBuilder.CreateBox('environment-wall', { updatable: true }, f.scene);
    const actualUrl = 'editor-asset://local/' + encodeURIComponent('C:/project/Assets/Environments/building/old.glb');
    const pendingUrl = 'editor-asset://local/' + encodeURIComponent('C:/project/Assets/Environments/building/new.glb');
    Object.assign(f.document.sceneSettings, { environment: { activeVariantUrl: pendingUrl, dataPlatformRevision: 'r1',
      variants: [{ sourceUrl: actualUrl, sourcePath: 'C:/project/Assets/Environments/building/old.glb' }] } });
    Object.assign(f.context, { environment: [{ key: 'building/wall[0]', mesh }],
      environmentSource: { sourceUrl: actualUrl, sourcePath: 'C:/project/Assets/Environments/building/old.glb', assetRevision: 'r1' } });
    const original = f.collect()[0].entry;
    assert.ok(original.resourceIdentity);
    f.document.sceneSettings.lighting.policy = policy([
      { id: 'environment-type', enabled: true, target: { kind: 'type', deviceType: 'environment' }, values: { castShadows: false } },
      { id: 'environment-resource', enabled: true, target: { kind: 'resource', model: { sourceUrl: actualUrl } }, values: {},
        nodeRules: [{ id: 'wall', enabled: true, target: { kind: 'node', nodeKey: original.nodeKey, resourceIdentity: original.resourceIdentity },
          values: { receiveShadows: false } }] },
    ]);
    const current = f.collect()[0].entry;
    assert.equal(current.entityId, '$environment'); assert.equal(current.deviceType, 'environment');
    assert.equal(current.policyContext?.modelAsset?.sourceUrl, actualUrl);
    assert.equal(current.policyContext?.entityLighting, undefined);
    assert.equal(current.castShadows, false); assert.equal(current.receiveShadows, false);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!.slice();
    positions[0] += 0.25; mesh.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    const changed = f.collect()[0].entry;
    assert.equal(changed.receiveShadows, true);
    assert.ok(changed.policyMismatches?.some(item => item.kind === 'resource-identity'));
  } finally { f.dispose(); }
});

test('环境候选加载时来源getter仍指向已提交几何，成功提交后才切到新来源和修订', () => {
  const f = fixture();
  const runtime = new SceneEnvironmentRuntime(f.scene, { onSnapshot: () => {} } as any);
  const internal = runtime as any;
  try {
    const oldUrl = sourceUrl, newUrl = otherUrl;
    internal.current = { sourceUrl: oldUrl, settings: { dataPlatformRevision: 'r1', variants: [{ sourceUrl: oldUrl, sourcePath: 'old.glb' }] } };
    internal.snapshot = { phase: 'loading', sourceUrl: newUrl };
    assert.deepEqual(runtime.getLightingSourceReference(), { sourceUrl: oldUrl, sourcePath: 'old.glb', assetRevision: 'r1' });
    internal.snapshot = { phase: 'error', sourceUrl: newUrl };
    assert.equal(runtime.getLightingSourceReference()?.sourceUrl, oldUrl);
    internal.current = { sourceUrl: newUrl, settings: { dataPlatformRevision: 'r2', variants: [{ sourceUrl: newUrl, sourcePath: 'new.glb' }] } };
    assert.deepEqual(runtime.getLightingSourceReference(), { sourceUrl: newUrl, sourcePath: 'new.glb', assetRevision: 'r2' });
    internal.current = null;
    assert.equal(runtime.getLightingSourceReference(), null);
  } finally { internal.current = null; runtime.dispose(); f.dispose(); }
});
