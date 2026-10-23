import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { FreeCamera, MeshBuilder, NullEngine, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import ts from 'typescript';

const projectRoot = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@babylonjs/core/') && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(projectRoot.href)) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(url) && existsSync(new URL(url.href.replace(/\.js$/, '') + '.ts'))) return next(url.href.replace(/\.js$/, '') + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(projectRoot.href) && /\.(png|jpg|webp|bin)(\?.*)?$/.test(url)) return {
      format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(url) + ';',
    };
    if (url.startsWith(projectRoot.href) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
const { SceneRuntime } = await import('../../src/runtime/babylon/SceneRuntime.ts');
const { createEmptySceneDocument, createModelEntity } = await import('../../src/editor/model/SceneDocument.ts');
hooks.deregister();

const entityIds = ['conveyor-a', 'conveyor-b'];
const partNames = ['track', 'support', 'guard'];

async function fixture(t, conflict = true, enableBatching = true) {
  const engine = new NullEngine();
  engine.getCaps().instancedArrays = true;
  const scene = new Scene(engine);
  new FreeCamera('camera', new Vector3(0, 5, -10), scene);
  const logs = [];
  const runtime = new SceneRuntime(scene, message => logs.push(message));
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  const material = new StandardMaterial('fixture-fixed-material', scene);

  // 只替代资产加载输入，保留正式初始化、Driver、合批、照明和选择调用链。
  // 独立 Mesh 等价于独占 GLB 容器，避免共享加载策略把夹具变成 native instance。
  runtime.assets.loadModelRuntimeAssets = async () => {
    const trackRoot = new TransformNode('track-root', scene);
    const meshes = partNames.map((name, index) => {
      const mesh = MeshBuilder.CreateBox(name, { size: 1 }, scene);
      mesh.material = material;
      mesh.position.z = index * 3;
      if (name === 'track') mesh.parent = trackRoot;
      return mesh;
    });
    return {
      kind: 'owned-container', meshes, transformNodes: [trackRoot],
      handle: { kind: 'owned-container', animationGroups: [], dispose() { for (const mesh of meshes) mesh.dispose(); trackRoot.dispose(); } },
    };
  };

  const entities = Object.fromEntries(entityIds.map((id, index) => {
    const entity = createModelEntity('C:/fixture/conveyor.glb', 'editor-asset://fixture/conveyor.glb', id);
    entity.id = id;
    entity.components.transform.position.x = index * 6;
    entity.components.modelAsset.dataDrivenConfig = { device: { devType: 'conveyor' }, fixedNodes: ['track-root'] };
    entity.components.lighting = { mobility: 'static', castShadows: index === 0 || !conflict, receiveShadows: true, bakeIndirect: true };
    return [id, entity];
  }));
  let document = { ...createEmptySceneDocument(), id: 'motion-selection-proxy', selectedEntityId: null, entityIds, entities };
  document.sceneSettings.lighting.shadows.enabled = true;
  document.sceneSettings.lighting.bake.enabled = false;
  runtime.sync(document, []);
  for (let turn = 0; turn < 30; turn++) {
    if (runtime.assets.models.size === 2 && [...runtime.assets.models.values()].every(model => model.measurementReady && !model.externalScriptStarting)) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(runtime.assets.models.size, 2, logs.join('\n'));
  assert.ok([...runtime.assets.models.values()].every(model => model.measurementReady), logs.join('\n'));
  runtime.registerHostSceneObservers();
  // 既有功能回归明确启用实验合批，避免默认关闭后绕过被测路径。
  if (enableBatching) runtime.setMotionStaticBatchingEnabled(true);

  const motion = runtime.telemetry.motionStaticBatchRuntime;
  assert.equal(motion.getDiagnostics().groups, enableBatching ? partNames.length : 0, JSON.stringify(motion.getDiagnostics()));
  const batches = motion.getBatchesForEntity(entityIds[0]);
  const layer = runtime.selection.modelSelectionOutlineLayer;
  assert.ok(scene.effectLayers.includes(layer), '检查真实场景持有的 Babylon SelectionOutlineLayer');
  const select = ids => runtime.syncSelection({ ...document, selectedEntityId: ids[0] ?? null }, ids);
  const setConflict = enabled => {
    const entity = document.entities[entityIds[1]];
    document = { ...document, entities: { ...document.entities, [entity.id]: {
      ...entity, components: { ...entity.components, lighting: { ...entity.components.lighting, castShadows: !enabled } },
    } } };
    runtime.sync(document, [...runtime.selection.selectedEntityIds]);
    assert.deepEqual(motion.getBatchesForEntity(entityIds[0]), batches, '角色变化复用同一动静批次');
  };
  const records = () => runtime.environment.lightingRuntime.shadowInstances.records;
  const part = record => motion.getSourceMeshForEntity(record.source.instance.batch, record.source.entry.entityId).name;
  return { runtime, scene, motion, batches, layer, select, setConflict, records, part };
}

function assertRealConflict(f) {
  const records = f.records();
  assert.equal(records.length, entityIds.length * partNames.length, '真实 castShadows 冲突为每个逻辑实体生成全部部件代理');
  assert.ok(records.every(record => record.mesh.name.startsWith('__LightingShadowInstance_') && record.mesh.metadata.lightingShadowOnly));
  for (const batch of f.batches) {
    assert.ok(batch.meshes.every(mesh => mesh.thinInstanceCount === 0), '冲突代理绘制时全部原载体被照明隐藏');
  }
  assert.deepEqual(records.filter(record => record.source.entry.entityId === entityIds[0]).map(record => record.source.entry.castShadows), [true, true, true]);
  assert.deepEqual(records.filter(record => record.source.entry.entityId === entityIds[1]).map(record => record.source.entry.castShadows), [false, false, false]);
}

test('真实 Runtime 默认保留原绘制，显式开启合批生效，再关闭恢复原件身份及候选', async t => {
  const f = await fixture(t, false, false);
  const sources = [...f.runtime.assets.models.values()].flatMap(model => model.meshes);
  const parents = sources.map(mesh => mesh.parent);
  const materials = sources.map(mesh => mesh.material);
  const candidates = () => {
    const result = f.scene.getActiveMeshCandidates();
    return result.data.slice(0, result.length);
  };
  const assertOriginals = () => {
    assert.equal(f.motion.getDiagnostics().groups, 0);
    assert.equal(f.motion.getDiagnostics().batchMeshes, 0);
    assert.deepEqual(f.motion.getSuppressedMeshes(), []);
    const meshes = candidates();
    for (const [index, mesh] of sources.entries()) {
      assert.equal(mesh.isDisposed(), false);
      assert.equal(f.scene.getMeshByUniqueId(mesh.uniqueId), mesh);
      assert.equal(mesh.parent, parents[index]);
      assert.equal(mesh.material, materials[index]);
      assert.ok(meshes.includes(mesh), '原件由正式候选入口继续绘制');
      assert.equal(f.motion.isSuspended(mesh), false);
    }
  };
  assertOriginals();
  f.runtime.setMotionStaticBatchingEnabled(true);
  assert.equal(f.motion.getDiagnostics().groups, 3);
  const carriers = f.motion.getBatchesForEntity(entityIds[0]).flatMap(batch => batch.meshes);
  assert.equal(carriers.length, 3);
  const enabledCandidates = candidates();
  assert.ok(sources.every(mesh => !enabledCandidates.includes(mesh) && f.scene.meshes.includes(mesh)));
  assert.ok(carriers.every(mesh => enabledCandidates.includes(mesh)));
  f.runtime.setMotionStaticBatchingEnabled(false);
  assertOriginals();
  const restoredCandidates = candidates();
  assert.ok(carriers.every(mesh => !f.scene.meshes.includes(mesh) && !restoredCandidates.includes(mesh)), '关闭后不存在载体与原件双套');
});

test('真实动静批次的 castShadows 冲突代理进入真正 selection layer，单选不扩散到另一实体', async t => {
  const f = await fixture(t);
  assertRealConflict(f);
  f.select([entityIds[0]]);
  for (const record of f.records()) {
    assert.equal(f.layer.hasMesh(record.mesh), record.source.entry.entityId === entityIds[0], `${record.source.entry.entityId}/${f.part(record)}`);
  }
  for (const model of f.runtime.assets.models.values()) {
    for (const mesh of model.meshes) assert.equal(f.layer.hasMesh(mesh), false, '被抑制的原件不重复加入选区');
  }
  for (const batch of f.batches) assert.equal(f.runtime.selection.outlinedModelArrayBatches.has(batch), true, '即使载体全隐藏也跟踪权威 mask 生命周期');
});

test('代理全隐藏载体期间取消选择，代理回收后实际 instanceSelectionId 缓冲保持全零', async t => {
  const f = await fixture(t, false);
  f.select([entityIds[0]]);
  for (const batch of f.batches) {
    for (const mesh of batch.meshes) {
      const buffer = mesh.getVertexBuffer('instanceSelectionId').getData();
      assert.ok(buffer.some(value => value > 0), '先用真实可见载体建立非零选择缓冲');
    }
  }
  f.setConflict(true);
  assertRealConflict(f);
  f.select([]);
  assert.equal(f.layer.shouldRender(), false);
  assert.equal(f.runtime.selection.outlinedModelArrayBatches.size, 0);
  for (const batch of f.batches) {
    assert.deepEqual([...batch.selectedEntityIds], [], '隐藏状态仍清掉批次权威逻辑选区');
    assert.equal(batch.selectionId, 0);
  }
  f.setConflict(false);
  assert.equal(f.records().length, 0, '冲突解除后正式照明运行时回收代理');
  for (const batch of f.batches) {
    for (const mesh of batch.meshes) {
      assert.equal(mesh.thinInstanceCount, 2);
      assert.ok(mesh.getVertexBuffer('instanceSelectionId').getData().every(value => value === 0), '载体恢复不能复活旧高亮');
      assert.equal(f.layer.hasMesh(mesh), false);
    }
  }
});

test('固定轨道排除先于代理选择，只排除目标轨道，保留同设备其它固定结构且不误选邻机', async t => {
  const f = await fixture(t);
  assertRealConflict(f);
  f.runtime.setClickHighlightTrackExclusion([entityIds[0]]);
  f.select([entityIds[0]]);
  for (const record of f.records()) {
    const expected = record.source.entry.entityId === entityIds[0] && f.part(record) !== 'track';
    assert.equal(f.layer.hasMesh(record.mesh), expected, `${record.source.entry.entityId}/${f.part(record)}`);
  }
  const selectedParts = f.records().filter(record => f.layer.hasMesh(record.mesh)).map(f.part).sort();
  assert.deepEqual(selectedParts, ['guard', 'support']);
  f.runtime.setClickHighlightTrackExclusion([]);
  assert.deepEqual(f.records().filter(record => f.layer.hasMesh(record.mesh)).map(f.part).sort(), [...partNames].sort());
  f.select([entityIds[1]]);
  for (const record of f.records()) assert.equal(f.layer.hasMesh(record.mesh), record.source.entry.entityId === entityIds[1]);
});

for (const observableName of ['onBeforeAnimationsObservable', 'onAfterAnimationsObservable']) {
  test(`后注册未知 ${observableName} 当帧切换 custom renderer，实际 render 执行前归还原件且无双套`, async t => {
    const f = await fixture(t, false);
    const sources = [...f.runtime.assets.models.values()].flatMap(model => model.meshes);
    const carriers = f.batches.flatMap(batch => batch.meshes);
    let callbackCalls = 0;
    let renderCalls = 0;
    assert.equal(f.motion.getDiagnostics().groups, 3);
    f.scene[observableName].add(() => {
      callbackCalls++;
      f.scene.customRenderFunction = () => {
        renderCalls++;
        // 在 custom renderer 入口检查，不借候选查询触发额外回退来掩盖时序错误。
        assert.equal(f.motion.getDiagnostics().groups, 0);
        assert.ok(sources.every(mesh => !mesh.isDisposed() && f.scene.meshes.includes(mesh)), '原 source 仍可由自定义渲染器查询');
        assert.ok(carriers.every(mesh => !f.scene.meshes.includes(mesh)), '自定义渲染器不可同时看到 carrier 与 source 两套');
        assert.deepEqual(f.motion.getSuppressedMeshes(), []);
      };
    });
    f.scene.render();
    assert.equal(callbackCalls, 1, '实际 Scene.render 必须执行后注册的动画回调');
    assert.equal(renderCalls, 1, '同一帧必须进入回调设置的真实 custom renderer');
  });
}

test('后注册 LED 式 onBeforeRender 静态查询保留原 source，实际 render 继续维持合批', async t => {
  const f = await fixture(t, false);
  const sources = [...f.runtime.assets.models.values()].flatMap(model => model.meshes);
  const carriers = f.batches.flatMap(batch => batch.meshes);
  let callbackCalls = 0;
  f.scene.onBeforeRenderObservable.add(() => {
    callbackCalls++;
    assert.ok(sources.every(mesh => f.scene.meshes.includes(mesh) && f.scene.getMeshByUniqueId(mesh.uniqueId) === mesh), 'LED 式脚本仍能只读查到原件身份');
  });
  for (let frame = 0; frame < 2; frame++) {
    f.scene.render();
    assert.equal(f.motion.getDiagnostics().groups, 3, '未知早期只读查询不应使动静合批回退');
    const candidates = f.scene.getActiveMeshCandidates();
    const meshes = candidates.data.slice(0, candidates.length);
    assert.ok(sources.every(mesh => !meshes.includes(mesh)), '正式候选入口继续排除原件');
    assert.ok(carriers.every(mesh => meshes.includes(mesh)), '正式候选入口仍保留绘制载体');
  }
  assert.equal(callbackCalls, 2, '保留实际早期脚本回调的原执行频率');
});
