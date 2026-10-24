import {
  ArcRotateCamera, Color3, Color4, Engine, HemisphericLight, Matrix, Mesh, MeshBuilder,
  PBRMaterial, Scene, TransformNode, Vector3,
} from '@babylonjs/core';
import { SceneRuntime } from '../../src/runtime/babylon/SceneRuntime';
import { createEmptySceneDocument, createModelEntity, createModelGeneratorEntity } from '../../src/editor/model/SceneDocument';
import type { ModelAssetTemplate, ModelGeneratorComponent, ModelGeneratorModelTarget } from '../../src/editor/model/components';
import { resolveGeneratedUnitClick } from '../../src/editor/model/clickEventBinding';
import { installDeploymentAssetManifest } from '../../src/runtime/assets/editorAssetUrl';
import { deviceTelemetryStore, type DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import type { GeneratedCargoRuntimeEntry } from '../../src/runtime/babylon/telemetry/specialized/types';
import type { GeneratedModelOutputController } from '../../src/runtime/babylon/scene-runtime/GeneratedModelOutputController';
import type { ModelAssetRuntimeController } from '../../src/runtime/babylon/scene-runtime/ModelAssetRuntimeController';
import type { EnvironmentAndSkyboxController } from '../../src/runtime/babylon/scene-runtime/EnvironmentAndSkyboxController';
import type { SceneTelemetryController } from '../../src/runtime/babylon/scene-runtime/SceneTelemetryController';

declare global {
  interface Window {
    generatedCargoPool: ReturnType<typeof createHarness>;
    cargoPreloadScriptStarts?: number;
  }
}

const GENERATOR_ID = 'preload-generator';
const HOST_A = 'preload-conveyor-a';
const HOST_B = 'preload-conveyor-b';
const SOURCE_ID = 'preload-smoke';
const PRELOAD_ENABLED = true;
const POOL_ENABLED = new URLSearchParams(location.search).get('pool') !== 'off';
const canvas = document.createElement('canvas');
canvas.width = 1100; canvas.height = 720;
canvas.style.cssText = 'display:block;width:1100px;height:720px';
document.body.append(canvas);
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(.018, .028, .048, 1);
const camera = new ArcRotateCamera('preload-camera', -1.25, .93, 14, new Vector3(-1.8, .65, 0), scene);
new HemisphericLight('preload-light', new Vector3(.2, 1, -.1), scene).intensity = 1.1;
const ground = MeshBuilder.CreateGround('preload-ground', { width: 22, height: 9 }, scene);
ground.position.y = -.01;
const runtimeLogs: string[] = [];
const runtime = new SceneRuntime(scene, message => runtimeLogs.push(message));
// 只读验收需要访问领域状态；TypeScript private 字段在运行时仍为普通属性。
const access = runtime as unknown as {
  assets: ModelAssetRuntimeController;
  outputs: GeneratedModelOutputController & { generatorAssetPreloader: { getMetrics(): { pendingCount: number; readyAssetCount: number; failedCount: number } } };
  telemetry: SceneTelemetryController;
  environment: EnvironmentAndSkyboxController;
};
access.outputs.setGeneratedCargoPoolingEnabled(POOL_ENABLED);
if (!PRELOAD_ENABLED) {
  // 受控 A/B 仅关闭模板预取；后续生成、脚本、克隆、驱动和拾取均沿正式路径。
  Object.defineProperty(access.assets, 'preloadModelRuntimeAsset', {
    configurable: true, writable: true, value: async () => ({ dispose() {} }),
  });
}

const assetUrl = (name: string) => 'editor-asset://local/' + encodeURIComponent(`C:/preload-smoke/${name}`);
installDeploymentAssetManifest(Object.fromEntries(['conveyor.glb', 'cargo.glb', 'animated.glb', 'cargo.model.ts']
  .map(name => [assetUrl(name), location.origin + '/__cargo_preload__/' + name])));
const template = (name: string): ModelAssetTemplate => ({
  sourcePath: `C:/preload-smoke/${name}`, sourceUrl: assetUrl(name), assetRevision: 'preload-smoke-v1',
  lengthUnit: 'meter', unitScaleToMeters: 1,
});
const target = (name: string, modelAsset: ModelAssetTemplate): ModelGeneratorModelTarget => ({
  kind: 'model', assetId: name, displayName: name, modelAsset,
});
const staticTarget = target('static-cargo', template('cargo.glb'));
const scriptedTarget = (width: number) => target('scripted-' + width, {
  ...template('animated.glb'),
  parameterConfig: { schema: 'babylon-editor.model-parameters', version: 1,
    parameters: [{ key: 'width', label: '宽度', type: 'number', defaultValue: 1 }], bindings: [] },
  parameterValues: { width },
  scriptAssets: [{ name: 'cargo.model.ts', path: 'cargo.model.ts', sourceUrl: assetUrl('cargo.model.ts') }],
});
const component: ModelGeneratorComponent = {
  defaultTarget: staticTarget,
  rules: [
    { id: 'same-source-one', attributeName: 'variant', attributeValue: 'duplicate-one', target: staticTarget },
    { id: 'same-source-two', attributeName: 'variant', attributeValue: 'duplicate-two', target: staticTarget },
    { id: 'parameter-one', attributeName: 'variant', attributeValue: 'narrow', target: scriptedTarget(1) },
    { id: 'parameter-two', attributeName: 'variant', attributeValue: 'wide', target: scriptedTarget(2) },
  ],
};
const documentModel = createEmptySceneDocument('货物模板预取真实 WebGL 验收');
documentModel.sceneSettings.lighting.shadows.enabled = false;
documentModel.sceneSettings.modelEntrance.enabled = false;
const generator = createModelGeneratorEntity();
generator.id = GENERATOR_ID; generator.components.modelGenerator = component;
generator.components.transform.position = { x: 8, y: 0, z: -6 };
generator.components.clickEventBinding = { deviceSlots: [], events: [
  { id: 'preload-cargo-click', eventType: 'click', effects: ['highlight'] },
] };
documentModel.sceneSettings.defaultCargoGeneratorId = GENERATOR_ID;
for (const [id, code, x, origin] of [[HOST_A, 'CV1', -4, true], [HOST_B, 'CV2', 0, false]] as const) {
  const entity = createModelEntity('C:/preload-smoke/conveyor.glb', assetUrl('conveyor.glb'), code,
    { lengthUnit: 'meter', unitScaleToMeters: 1 }, { x, y: 0, z: 0 });
  entity.id = id;
  entity.components.modelAsset = { ...entity.components.modelAsset!, assetCode: code, assetRevision: 'host-v1' };
  entity.components.telemetryBinding = { enabled: true, sourceId: SOURCE_ID, deviceType: 'conveyor',
    expectedIntervalMs: 100, staleAfterMs: 60_000, trajectoryDirection: 'x',
    cargoOriginDevice: origin, cargoGeneratorId: GENERATOR_ID, cargoTravelSpeed: .3, cargoAutoDispose: true,
    surfaceArrows: { enabled: false } as never };
  documentModel.entities[id] = entity; documentModel.entityIds.push(id);
}
documentModel.entities[GENERATOR_ID] = generator; documentModel.entityIds.push(GENERATOR_ID);
runtime.sync(documentModel);
// 渲染持续进行；遥测只由下方显式固定步长驱动，避免 A/B 被墙钟帧数影响。
scene.onBeforeRenderObservable.remove(access.telemetry.telemetryObserver);
engine.runRenderLoop(() => scene.render());

function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function until<T>(get: () => T | null | false | undefined, description: string): Promise<T> {
  const started = performance.now();
  while (performance.now() - started < 30_000) {
    const value = get();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('等待超时：' + description);
}

const decodeCount = () => runtime.getPerformanceMetrics().loading.stages.assetReadDecode.count;
const cargoEntries = () => [...access.telemetry.specializedTelemetryRuntime.state.conveyorCargoMeshes.values()];
const state = () => ({
  logs: [...runtimeLogs], owners: [...access.outputs.generatedOutputOwners.values()].filter(owner => owner.metadata.generatedCargo).map(owner => ({ id: owner.entityId, error: owner.readinessError, output: owner.output?.kind, hasHandle: owner.output?.kind === 'model' && !!owner.output.model.assetHandle })),
  pool: POOL_ENABLED, poolMetrics: access.outputs.getGeneratedCargoPoolMetrics(), cacheMetrics: access.assets.sharedModelAssetCache.getMetrics(),
  preload: PRELOAD_ENABLED, decodeCount: decodeCount(), scriptStarts: window.cargoPreloadScriptStarts ?? 0,
  cargoCount: cargoEntries().length, preloadMetrics: access.outputs.generatorAssetPreloader.getMetrics(),
  cargoMeshes: scene.meshes.filter(mesh => mesh.metadata?.generatedCargo).length,
});
const modelOf = (cargo: GeneratedCargoRuntimeEntry) => {
  invariant(cargo.outputOwner?.output?.kind === 'model', '货物必须完成正式模型模板加载，不得使用 fallback');
  return cargo.outputOwner.output.model;
};
const waitCargo = async (cargo: GeneratedCargoRuntimeEntry) => {
  await until(() => cargo.outputOwner?.output?.kind === 'model' && cargo.outputOwner.output.model.measurementReady,
    '货物模板、参数脚本和材质');
  invariant(!cargo.fallback, '模板成功后不得残留 fallback');
  invariant(!modelOf(cargo).readinessError, '货物脚本不能以失败回退冒充成功');
  await runtime.waitForInitialRenderReady();
};

function snapshot(code: string, fields: Record<string, unknown>): DeviceTelemetrySnapshot {
  return { sourceId: SOURCE_ID, topic: 'smoke/preload', deviceType: 'conveyor', assetCode: code,
    payloadDeviceCode: null, sourceTimestamp: null, sequence: null, receivedAt: Date.now(), fields,
    currentLocationKey: null, targetLocationKey: null, hasTargetLocation: false, faulted: false, message: '' };
}

function push(code: string, fields: Record<string, unknown>): void {
  deviceTelemetryStore.upsert(snapshot(code, fields));
}

function tick(frames = 1): void {
  for (let index = 0; index < frames; index++) access.telemetry.specializedTelemetryRuntime.applyFrame(.05);
  scene.render();
}

function digestNumbers(values: ArrayLike<number> | null | undefined): string {
  let hash = 2166136261;
  for (const value of Array.from(values ?? [])) {
    const text = String(Math.round(value * 1e7) / 1e7);
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16);
}

function cargoSummary(cargo: GeneratedCargoRuntimeEntry) {
  const model = modelOf(cargo);
  return {
    cargoId: cargo.root.uniqueId, ownerId: cargo.outputOwner!.entityId, hostEntityId: cargo.hostEntityId,
    assetCode: cargo.assetCode, task: cargo.task, containerCode: cargo.containerCode, position: cargo.root.position.asArray(),
    meshes: model.meshes.filter(mesh => mesh.getTotalVertices() > 0).map(mesh => ({
      id: mesh.uniqueId, vertices: mesh.getTotalVertices(), indices: mesh.getTotalIndices(),
      positions: digestNumbers(mesh.getVerticesData('position')), normals: digestNumbers(mesh.getVerticesData('normal')),
      indicesDigest: digestNumbers(mesh.getIndices()), matrix: mesh.computeWorldMatrix(true).asArray().map(value => Math.round(value * 1e6) / 1e6),
      material: mesh.material instanceof PBRMaterial ? { type: mesh.material.getClassName(),
        color: mesh.material.albedoColor.asArray(), metallic: mesh.material.metallic, roughness: mesh.material.roughness,
        alpha: mesh.material.alpha } : { type: mesh.material?.getClassName() },
      hostEntityId: mesh.metadata?.hostEntityId, containerCode: mesh.metadata?.containerCode,
      visible: mesh.isVisible && mesh.isEnabled(),
    })),
  };
}

function pick(cargo: GeneratedCargoRuntimeEntry) {
  const mesh = modelOf(cargo).meshes.find(value => value.getTotalVertices() > 0 && value.isEnabled());
  invariant(mesh, '货物必须有可见真实几何');
  const center = mesh.getBoundingInfo().boundingBox.centerWorld;
  const projected = Vector3.Project(center, Matrix.Identity(), scene.getTransformMatrix(),
    camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()));
  const hit = runtime.pickGeneratedUnitClickTargetAtCanvasPoint(projected.x, projected.y, canvas);
  invariant(hit, '真实屏幕坐标必须能拾取货物');
  const resolution = resolveGeneratedUnitClick(documentModel, hit.hit);
  invariant(resolution?.generatedUnit?.kind === 'cargo', '拾取必须沿正式点击绑定解析为货物事件');
  invariant(resolution.generatedUnit.host?.assetCode === cargo.assetCode, '点击事件的承运设备编号必须匹配当前宿主');
  return { ...hit.hit, resolvedHost: resolution.generatedUnit.host };
}

function createManualCargo(id: string, variant: string, x: number) {
  const cargo: GeneratedCargoRuntimeEntry = { root: new TransformNode(id, scene), assetCode: 'CV2', containerCode: id,
    task: id, outputOwner: null, fallback: null, generatorEntityId: null, handoff: null,
    axialLengthCache: null, lockedWorldRotation: null };
  cargo.root.position.set(x, .6, -2);
  access.outputs.syncGeneratedCargoVisual(cargo, 'conveyor', snapshot('CV2', { variant }),
    access.outputs.modelGenerators.get(GENERATOR_ID)!, HOST_B);
  return cargo;
}

function createHarness() {
  let initialCargo: GeneratedCargoRuntimeEntry | null = null;
  const extraCargos: GeneratedCargoRuntimeEntry[] = [];
  let lastReplay: Record<string, unknown> | null = null;
  let disposed = false;
  return {
    state,
    replayProgress() { return lastReplay; },
    async prepare() {
      await until(() => runtime.isModelReady(HOST_A) && runtime.isModelReady(HOST_B), '两台真实输送机');
      await runtime.waitForInitialRenderReady();
      const prepared = state();
      invariant(prepared.cargoCount === 0 && prepared.cargoMeshes === 0, '预取阶段不能生成货物或调用生成器目标');
      invariant(prepared.scriptStarts === 0, '预取阶段不能提前执行参数脚本');
      invariant(prepared.preloadMetrics.pendingCount === 0, '首帧 ready 必须等待当前预取结算');
      invariant(prepared.preloadMetrics.failedCount === 0, '模板预取不得带失败通过验收');
      runtime.beginTelemetryPreview();
      scene.render();
      return prepared;
    },
    /** 正式遥测 store + conveyor driver 的固定50ms序列；每次销货后重新出生新逻辑cargo。 */
    async replay(cycles = 12, movingFrames = 12, classify = true) {
      const rows: unknown[] = [], births: unknown[] = [], logicalIds = new Set<string>();
      const checkpoints: unknown[] = [];
      const before = state(), started = performance.now();
      const sample = (cargo: GeneratedCargoRuntimeEntry, cycle: number, phase: string, frame: number) => {
        const owner = cargo.outputOwner!;
        const roles = classify ? access.environment.lightingRuntime.getClassification()
          .filter(row => row.entityId === owner.entityId).map(row => ({ nodeKey: row.nodeKey, mobility: row.mobility,
            reason: row.reason, castShadows: row.castShadows, receiveShadows: row.receiveShadows, bakeIndirect: row.bakeIndirect,
            motionRole: row.motionRole, resourceIdentity: row.resourceIdentity })) : [];
        rows.push({ cycle, phase, frame, summary: cargoSummary(cargo), roles });
      };
      const progress = () => ({ cycles, movingFrames, classify, elapsedMs: performance.now() - started, before, after: state(), rows, births, checkpoints });
      lastReplay = progress();
      try {
      for (let cycle = 0; cycle < cycles; cycle++) {
        const task = 100 + cycle, containerCode = 'pool-' + String(cycle).padStart(4, '0');
        push('CV2', { mode: 2, task: 0, movement_x: 0 });
        push('CV1', { mode: 1, task, movement_x: 1, containerCode }); tick();
        invariant(cargoEntries().length === 1, '每个输入出生沿必须恰好创建一件货物');
        const cargo = cargoEntries()[0]; await waitCargo(cargo); tick();
        const model = modelOf(cargo), owner = cargo.outputOwner!, imported = [...model.meshes];
        invariant(!logicalIds.has(owner.entityId), '新货物逻辑owner不能复用'); logicalIds.add(owner.entityId);
        const clickFirst = pick(cargo);
        const birth = { cycle, cargoId: cargo.root.uniqueId, ownerId: owner.entityId, modelRoot: model.root.name,
          contentRoot: model.contentRoot.name, meshIds: imported.map(mesh => mesh.uniqueId), clickFirst,
          modelCloneCount: access.assets.sharedModelAssetCache.getMetrics().instantiationCount };
        births.push(birth); checkpoints.push({ cycle, phase: 'birth', state: state() }); sample(cargo, cycle, 'birth', 0);
        for (let frame = 1; frame <= movingFrames; frame++) { tick(); sample(cargo, cycle, 'upstream', frame); }
        push('CV2', { mode: 1, task, movement_x: 1, containerCode }); tick();
        invariant(cargoEntries().length === 1 && cargoEntries()[0] === cargo, '交接不得增加或替换cargo');
        invariant(cargo.outputOwner === owner && modelOf(cargo) === model, '交接保持逻辑身份和model');
        invariant(imported.every((mesh, index) => model.meshes[index] === mesh), '交接不能触发出入池或换mesh');
        sample(cargo, cycle, 'handoff', 0);
        for (let frame = 1; frame <= 24; frame++) { tick(); sample(cargo, cycle, 'downstream', frame); }
        deviceTelemetryStore.upsert({ ...snapshot('CV2', { mode: 1, task, movement_x: 1, containerCode }), faulted: true, message: 'pool-fixture-fault' });
        for (let frame = 1; frame <= 4; frame++) { tick(); sample(cargo, cycle, 'fault', frame); }
        deviceTelemetryStore.upsert(snapshot('CV2', { mode: 1, task, movement_x: 1, containerCode })); tick();
        sample(cargo, cycle, 'recovered', 0);
        const clickEnd = pick(cargo);
        invariant(clickEnd.hostEntityId === HOST_B && clickEnd.containerCode === containerCode, '真实点击必须使用新宿主与箱号');
        push('CV1', { mode: 2, task: 0, movement_x: 0 }); push('CV2', { mode: 2, task: 0, movement_x: 0 }); tick();
        invariant(cargoEntries().length === 0 && cargo.root.isDisposed() && model.root.isDisposed() && model.contentRoot.isDisposed(),
          'mode2空光电必须经正式driver销货并释放逻辑wrapper');
        invariant(!access.outputs.generatedOutputOwners.has(owner.entityId), '退役旧逻辑owner必须注销');
        checkpoints.push({ cycle, phase: 'retire', state: state() });
        if (classify) invariant(!access.environment.lightingRuntime.getClassification().some(row => row.entityId === owner.entityId),
          '旧逻辑身份不得留在classification');
      }
      } finally {
        // 失败同样保留真实guard分布与已完成轨迹，由Node端先持久化再断言。
        lastReplay = progress();
      }
      return lastReplay;
    },
    async firstCargo() {
      const before = decodeCount();
      push('CV1', { task: 7, movement_x: 1, containerCode: '000317' }); tick();
      invariant(cargoEntries().length === 1, '起点设备必须只生成一件货物');
      initialCargo = cargoEntries()[0];
      await waitCargo(initialCargo);
      // 真实货物几何就绪后推进正常业务帧，再取跨设备交接的稳定起点。
      tick();
      const summary = cargoSummary(initialCargo);
      return { before, after: decodeCount(), summary, click: pick(initialCargo), state: state() };
    },
    async transfer() {
      invariant(initialCargo, '必须先经真实起点设备生成货物');
      const cargo = initialCargo;
      const originalRoot = cargo.root;
      const originalOwner = cargo.outputOwner;
      const originalMeshes = modelOf(cargo).meshes.map(mesh => mesh.uniqueId);
      const positions = [cargo.root.position.asArray()];
      push('CV2', { task: 7, movement_x: 1, containerCode: '000317' }); tick();
      positions.push(cargo.root.position.asArray());
      invariant(cargoEntries().length === 1 && cargoEntries()[0] === cargo, '交接必须保持同一件货物实例');
      invariant(cargo.assetCode === 'CV2' && cargo.hostEntityId === HOST_B, '交接必须更新承运设备');
      invariant(access.assets.models.get(HOST_A)!.conveyorTelemetry.cargoCode === null, '交接后上游必须释放货物引用');
      for (let index = 0; index < 24; index++) { tick(); positions.push(cargo.root.position.asArray()); }
      invariant(cargo.root === originalRoot && cargo.outputOwner === originalOwner, '交接不得重建 root 或生成物宿主');
      invariant(JSON.stringify(modelOf(cargo).meshes.map(mesh => mesh.uniqueId)) === JSON.stringify(originalMeshes), '交接不得替换模型网格');
      invariant(cargo.task === '7' && cargo.containerCode === '000317', '交接不得丢失 task 或箱号');
      const steps = positions.slice(1).map((position, index) => Vector3.Distance(Vector3.FromArray(position), Vector3.FromArray(positions[index])));
      invariant(steps.every(distance => distance < .35), '固定 50ms 步长的交接位置必须连续：' + JSON.stringify({ maxStep: Math.max(...steps), positions }));
      invariant(positions.at(-1)![0] > positions[0][0] + .1, '交接必须实际向下游移动');
      const summary = cargoSummary(cargo);
      invariant(summary.meshes.every(mesh => mesh.hostEntityId === HOST_B && mesh.containerCode === '000317'), '所有模型网格必须刷新点击宿主和箱号');
      return { summary, positions, maxStep: Math.max(...steps), click: pick(cargo), state: state() };
    },
    async isolation() {
      const before = decodeCount();
      const narrow = createManualCargo('parameter-one', 'narrow', 3);
      const wide = createManualCargo('parameter-two', 'wide', 5);
      extraCargos.push(narrow, wide);
      await Promise.all([waitCargo(narrow), waitCargo(wide)]);
      const one = modelOf(narrow); const two = modelOf(wide);
      const oneMesh = one.meshes.find(mesh => mesh.getTotalVertices() > 0) as Mesh;
      const twoMesh = two.meshes.find(mesh => mesh.getTotalVertices() > 0) as Mesh;
      invariant(oneMesh && twoMesh && oneMesh !== twoMesh, '两个脚本货物必须拥有独立网格');
      invariant(oneMesh.geometry !== twoMesh.geometry && oneMesh.material !== twoMesh.material, '脚本模型必须隔离 Geometry 与材质');
      invariant(Math.abs(oneMesh.scaling.x - 1) < 1e-6 && Math.abs(twoMesh.scaling.x - 2) < 1e-6, '参数脚本必须分别应用两个宽度');
      invariant(one.externalScriptRuntime !== two.externalScriptRuntime && (window.cargoPreloadScriptStarts ?? 0) === 2, '参数脚本实例必须独立且各执行一次');
      const oneAnimations = one.assetHandle?.animationGroups ?? [];
      const twoAnimations = two.assetHandle?.animationGroups ?? [];
      invariant(oneAnimations.length === 1 && twoAnimations.length === 1, '真实 GLB 动画组必须完整保留');
      invariant(oneAnimations[0] !== twoAnimations[0]
        && oneAnimations[0].targetedAnimations[0].target !== twoAnimations[0].targetedAnimations[0].target,
      '动画组与动画目标必须隔离');
      const unaffected = twoAnimations[0].targetedAnimations[0].target.position.clone();
      oneAnimations[0].start(false); oneAnimations[0].pause(); oneAnimations[0].goToFrame(15);
      invariant(twoAnimations[0].targetedAnimations[0].target.position.equals(unaffected), '第一件货物的动画不得移动第二件货物');
      const secondColor = (twoMesh.material as PBRMaterial).albedoColor.clone();
      (oneMesh.material as PBRMaterial).albedoColor = Color3.Red();
      invariant((twoMesh.material as PBRMaterial).albedoColor.equals(secondColor), '第一件货物的材质修改不得污染第二件');
      return { before, after: decodeCount(), scriptStarts: window.cargoPreloadScriptStarts,
        narrow: cargoSummary(narrow), wide: cargoSummary(wide), independentGeometry: true, independentMaterial: true, independentAnimation: true };
    },
    cleanup() {
      access.telemetry.specializedTelemetryRuntime.disposeAllCargo();
      for (const cargo of extraCargos.splice(0)) access.outputs.disposeGeneratedCargo(cargo);
      initialCargo = null;
      // preview原生命周期负责排空idle；不把禁用后才归零冒充正常清理。
      runtime.endTelemetryPreview();
      invariant(access.outputs.getGeneratedCargoPoolMetrics().idleEntries === 0, '退出preview必须排空idle');
      const remainingMeshes = scene.meshes.filter(mesh => mesh.metadata?.generatedCargo);
      const remainingOwners = [...access.outputs.generatedOutputOwners.values()].filter(owner => owner.metadata.generatedCargo);
      invariant(cargoEntries().length === 0 && remainingMeshes.length === 0 && remainingOwners.length === 0,
        '回收后不得残留货物、网格或输出宿主');
      return { cargoCount: cargoEntries().length, cargoMeshCount: remainingMeshes.length, ownerCount: remainingOwners.length,
        preloadMetrics: access.outputs.generatorAssetPreloader.getMetrics() };
    },
    renderer() { return { webGLVersion: engine.webGLVersion, ...engine.getGlInfo(), renderWidth: engine.getRenderWidth(), renderHeight: engine.getRenderHeight() }; },
    dispose() { if (disposed) return; disposed = true; runtime.dispose(); engine.stopRenderLoop(); scene.dispose(); engine.dispose(); deviceTelemetryStore.clear(); },
  };
}

window.generatedCargoPool = createHarness();
