import { ArcRotateCamera, Color4, Engine, HemisphericLight, Matrix, Scene, Vector3 } from '@babylonjs/core';
import { SceneRuntime } from '../../src/runtime/babylon/SceneRuntime';
import { createEmptySceneDocument, createModelEntity } from '../../src/editor/model/SceneDocument';
import type { Entity } from '../../src/editor/model/Entity';
import { installDeploymentAssetManifest } from '../../src/runtime/assets/editorAssetUrl';
import { deviceTelemetryStore } from '../../src/runtime/mqtt/deviceTelemetry';
import { createClickEventBindingEvent, resolveClickEventBindingClick } from '../../src/editor/model/clickEventBinding';
import { createDefaultTelemetryBinding } from '../../src/editor/model/telemetryBinding';
import type { ModelArrayRuntimeController } from '../../src/runtime/babylon/scene-runtime/ModelArrayRuntimeController';
import type { ModelAssetRuntimeController } from '../../src/runtime/babylon/scene-runtime/ModelAssetRuntimeController';
import type { ParameterVariantHostPool } from '../../src/runtime/babylon/scene-runtime/ParameterVariantHostPool';
import type { ScenePoiAndEffectsController } from '../../src/runtime/babylon/scene-runtime/ScenePoiAndEffectsController';
import type { SceneTelemetryController } from '../../src/runtime/babylon/scene-runtime/SceneTelemetryController';
import { normalizeSceneModelEntranceSettings } from '../../src/editor/model/sceneModelEntrance';
import metadata from '../../Assets/Models/Model-2080102163768123393-LED/meta.json';

const canvas = document.createElement('canvas');
canvas.width = 1200;
canvas.height = 760;
canvas.style.cssText = 'display:block;width:1200px;height:760px';
document.body.append(canvas);
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.018, 0.028, 0.048, 1);
const camera = new ArcRotateCamera('led-camera', Math.PI / 2, Math.PI / 2.15, 3.8, new Vector3(0, 0.9, 0), scene);
new HemisphericLight('led-light', new Vector3(0.2, 1, -0.3), scene).intensity = 1.2;
const runtime = new SceneRuntime(scene, message => console.log('[SceneRuntime]', message));
const access = runtime as unknown as {
  assets: ModelAssetRuntimeController;
  arrays: ModelArrayRuntimeController;
  variants: ParameterVariantHostPool;
  effects: Pick<ScenePoiAndEffectsController, 'modelEntranceRuntime'>;
  telemetry: Pick<SceneTelemetryController, 'isModelEntranceHidden'>;
};
const sourcePath = 'C:/led-webgl/LED.glb';
const sourceUrl = 'editor-asset://local/' + encodeURIComponent(sourcePath);
const scriptUrl = 'editor-asset://local/' + encodeURIComponent('C:/led-webgl/led.model.ts');
installDeploymentAssetManifest({
  [sourceUrl]: location.origin + '/__led__/LED.glb',
  [scriptUrl]: location.origin + '/__led__/led.model.ts',
});

function createLed(id: string, assetCode: string, x: number, sourceEntityId?: string): Entity {
  const entity = createModelEntity(
    sourcePath,
    sourceUrl,
    assetCode,
    { lengthUnit: 'meter', unitScaleToMeters: 1 },
    { x, y: 0, z: 0 },
    metadata.modelParameters,
    [{ name: 'led.model.ts', path: 'led.model.ts', sourceUrl: scriptUrl }],
    metadata.parameterScripts,
    metadata.animationScripts,
    undefined,
    'led-webgl-v1',
    metadata.dataDriven ?? { device: { devType: 'led' }, fixedNodes: [] },
    undefined,
    undefined,
    undefined,
    'led',
  );
  entity.id = id;
  entity.components.modelAsset!.assetCode = assetCode;
  entity.components.telemetryBinding = createDefaultTelemetryBinding('led');
  entity.components.telemetryBinding.assetCode = assetCode;
  entity.components.telemetryBinding.staleAfterMs = 60_000;
  const clickEvent = createClickEventBindingEvent();
  clickEvent.id = `click-${id}`;
  entity.components.clickEventBinding = {
    deviceSlots: [{
      id: `slot-${id}`,
      deviceType: { id: 'led-type', assetId: 'led', displayName: 'LED', sourcePath, sourceUrl },
    }],
    events: [clickEvent],
  };
  if (sourceEntityId) entity.components.modelArrayInstance = { sourceEntityId };
  return entity;
}

let source = createLed('led-source', 'led01', -0.75);
let copy = createLed('led-copy', 'led02', 0.75, source.id);
copy.components.modelAsset!.parameterValues = {
  ...copy.components.modelAsset!.parameterValues,
  length: 1.35,
  height: 1.95,
};
const documentModel = createEmptySceneDocument('LED MQTT 真实 WebGL 验收');
documentModel.sceneSettings.lighting.shadows.enabled = false;
documentModel.sceneSettings.modelEntrance.enabled = false;
documentModel.entities[source.id] = source;
documentModel.entities[copy.id] = copy;
documentModel.entityIds.push(source.id, copy.id);
runtime.sync(documentModel);
engine.runRenderLoop(() => scene.render());

async function until<T>(read: () => T | null | false | undefined, description: string): Promise<T> {
  const deadline = performance.now() + 45_000;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('等待超时：' + description);
}

function snapshot(assetCode: string, sequence: number, text: string) {
  return {
    sourceId: 'default',
    topic: `dt/factory/logistics/led/${assetCode}/twindatadriven/joint`,
    deviceType: 'led',
    assetCode,
    payloadDeviceCode: assetCode,
    sourceTimestamp: null,
    sequence,
    receivedAt: Date.now(),
    fields: { deviceErrorMessage: '', wmsShowMessage: text },
    currentLocationKey: null,
    targetLocationKey: null,
    hasTargetLocation: false,
    faulted: false,
    message: '',
  } as const;
}

function state() {
  const activeMeshes = scene.getActiveMeshes();
  const active = new Set(activeMeshes.data.slice(0, activeMeshes.length));
  return [...access.arrays.modelArrayTelemetryProxies].map(([entityId, proxy]) => {
    const mesh = proxy.meshes[0];
    const stored = mesh?.metadata?.meshCanvasLabelEmissiveOverlay;
    const scriptState = proxy.externalScriptRuntime as unknown as {
      runtimeContext?: { mode?: string; telemetry?: unknown };
      instances?: Array<{ runtimeMode?: string; runtimeTelemetry?: unknown; lastScrollDisplayText?: string }>;
    };
    return {
      entityId,
      proxyId: proxy.root.uniqueId,
      hostRootId: proxy.telemetryProxySource?.root.uniqueId ?? null,
      assetCode: proxy.assetCode,
      readinessError: proxy.readinessError ?? null,
      starting: proxy.externalScriptStarting,
      initializationError: proxy.externalScriptRuntime?.getInitializationError() ?? null,
      meshClass: mesh?.getClassName() ?? null,
      materialId: mesh?.material?.uniqueId ?? null,
      geometryId: mesh?.geometry?.uniqueId ?? null,
      layerMask: mesh?.layerMask ?? null,
      enabled: proxy.root.isEnabled(),
      active: mesh ? active.has(mesh) : false,
      text: stored ? JSON.parse(stored.atlasSignature)[0] : null,
      runtimeContext: scriptState.runtimeContext ?? null,
      instances: scriptState.instances?.map(instance => ({
        runtimeMode: instance.runtimeMode,
        runtimeTelemetry: instance.runtimeTelemetry,
        lastScrollDisplayText: instance.lastScrollDisplayText,
      })) ?? [],
      world: mesh?.getWorldMatrix().m ?? null,
      sourceWorld: proxy.telemetryProxySource?.meshes.find(item => /^Box010/.test(item.name))?.getWorldMatrix().m ?? null,
      diagnostics: proxy.contentRoot.metadata?.parametricLedDisplayDiagnostics ?? null,
    };
  });
}

async function renderFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
  }
}

async function prepare() {
  await until(() => runtime.isModelReady(source.id), 'LED 源模型就绪');
  await until(() => access.arrays.modelArrayTelemetryProxies.size === 0 && access.assets.models.get(source.id)?.modelArrayBatch, '编辑态 LED 批次');
  await new Promise(resolve => setTimeout(resolve, 4500));
  await renderFrames(3);
  return { models: runtime.getPerformanceMetrics().models, state: state() };
}

async function editDisplayText(text: string, entityId = source.id) {
  const resolveHost = () => access.assets.models.get(entityId)
    ?? [...access.variants.modelArrayParameterVariants.values()].find(variant => (
      variant.entities.some(entity => entity.id === entityId)
    ))?.model;
  const host = resolveHost()!;
  const previousBatch = host.modelArrayBatch;
  const previousMaterial = host.meshes.find(mesh => /^Box010/.test(mesh.name))?.material;
  const current = documentModel.entities[entityId]!;
  const next = {
    ...current,
    components: {
      ...current.components,
      modelAsset: {
        ...current.components.modelAsset!,
        parameterValues: {
          ...current.components.modelAsset!.parameterValues,
          displayText: text,
        },
      },
    },
  };
  if (entityId === source.id) source = next;
  if (entityId === copy.id) copy = next;
  documentModel.entities[entityId] = next;
  runtime.syncModelParameters(documentModel, entityId);
  await until(() => {
    const currentHost = resolveHost();
    const screen = currentHost?.meshes.find(mesh => /^Box010/.test(mesh.name));
    const stored = screen?.metadata?.meshCanvasLabelEmissiveOverlay;
    return currentHost?.modelArrayBatch
      && currentHost.modelArrayBatch !== previousBatch
      && screen?.material !== previousMaterial
      && currentHost.modelArrayBatch.meshes.some(mesh => mesh.material === screen?.material)
      && stored && JSON.parse(stored.atlasSignature)[0] === text;
  }, `编辑态文字材质同步到 ${entityId} 批次`);
  await new Promise(resolve => setTimeout(resolve, 4500));
  await renderFrames(3);
  const currentHost = resolveHost()!;
  const screen = currentHost.meshes.find(mesh => /^Box010/.test(mesh.name));
  return {
    entityId,
    text,
    batchUsesScriptMaterial: currentHost.modelArrayBatch?.meshes.some(mesh => mesh.material === screen?.material) ?? false,
    diagnostics: currentHost.contentRoot.metadata?.parametricLedDisplayDiagnostics ?? null,
  };
}

async function start() {
  runtime.beginTelemetryPreview();
  await until(() => access.arrays.modelArrayTelemetryProxies.size === 2, '两个 LED 运行代理');
  await until(() => [...access.arrays.modelArrayTelemetryProxies.values()].every(proxy => (
    !proxy.externalScriptStarting && proxy.meshes[0]?.metadata?.meshCanvasLabelEmissiveOverlay
  )), '两个 LED 文字图集');
  deviceTelemetryStore.upsert(snapshot('led01', 1, 'MQTT-A 正常'));
  deviceTelemetryStore.upsert(snapshot('led02', 1, 'MQTT-B 故障'));
  await until(() => {
    const rows = state();
    return rows.length === 2 && rows.every(row => row.text?.startsWith(row.assetCode === 'led01' ? 'MQTT-A' : 'MQTT-B'));
  }, 'MQTT 文字写入各自屏幕');
  const immediate = state();
  await new Promise(resolve => setTimeout(resolve, 4500));
  await renderFrames(3);
  return { immediate, settled: state() };
}

function moveCamera() {
  camera.alpha += 0.12;
  camera.beta -= 0.04;
  scene.render();
  return state();
}

async function playEntrance() {
  const capture = () => ({
    snapshot: runtime.getModelEntranceSnapshot(),
    hidden: access.telemetry.isModelEntranceHidden,
    state: state(),
  });
  await runtime.prepareModelEntrance(normalizeSceneModelEntranceSettings({
    enabled: true,
    effect: 'fade',
    durationSeconds: 0.6,
  }));
  const immediate = capture();
  await renderFrames(2);
  const prepared = capture();
  runtime.startModelEntrance();
  await renderFrames(2);
  const playing = capture();
  access.effects.modelEntranceRuntime.tick(2, true);
  await until(() => scene.isReady(), '入场完成后恢复原材质');
  await new Promise(resolve => setTimeout(resolve, 500));
  await renderFrames(3);
  return { immediate, prepared, playing, completed: capture(), completedModels: modelState() };
}

function pickScreen(entityId: string) {
  const proxy = access.arrays.modelArrayTelemetryProxies.get(entityId);
  const mesh = proxy?.meshes[0];
  if (!mesh) throw new Error(`找不到 ${entityId} 的屏幕代理`);
  scene.render();
  mesh.computeWorldMatrix(true);
  const projected = Vector3.Project(
    mesh.getBoundingInfo().boundingBox.centerWorld,
    Matrix.Identity(),
    scene.getTransformMatrix(),
    camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()),
  );
  const hit = runtime.pickRuntimeModelHitAtCanvasPoint(projected.x, projected.y, canvas);
  const resolution = resolveClickEventBindingClick(documentModel, hit?.entityId ?? null, null);
  return { point: { x: projected.x, y: projected.y }, hit, resolution };
}

async function interruptLongText() {
  const longText = '断流后必须完整展示一遍的 MQTT 超长文案：ABCDEFGHIJKLMNOPQRSTUVWXYZ，一二三四五六七八九十。';
  deviceTelemetryStore.upsert(snapshot('led01', 2, longText));
  await until(() => state().find(row => row.entityId === source.id)?.text === longText, '长文案写入 LED');
  deviceTelemetryStore.upsert({ ...snapshot('led01', 3, longText), receivedAt: Date.now() - 61_000 });
  await until(() => {
    const row = state().find(item => item.entityId === source.id);
    return row && row.runtimeContext?.telemetry === null;
  }, 'MQTT 快照断流');
  const retained = state();
  const proxy = access.arrays.modelArrayTelemetryProxies.get(source.id)!;
  const mesh = proxy.meshes[0];
  const stored = mesh.metadata.meshCanvasLabelEmissiveOverlay;
  const instance = (proxy.externalScriptRuntime as unknown as {
    instances: Array<{
      scrollXPx: number;
      getInnerTexWidth(screen: unknown): number;
      scrollPeriod(innerWidth: number, contentWidth: number): number;
    }>;
  }).instances[0];
  instance.scrollXPx = Math.max(0, instance.scrollPeriod(
    instance.getInnerTexWidth(mesh),
    stored.metrics.contentWidth,
  ) - 1);
  await renderFrames(3);
  return { longText, retained, completed: state() };
}

async function stop() {
  runtime.endTelemetryPreview();
  await until(() => access.arrays.modelArrayTelemetryProxies.size === 0, '退出预览释放代理');
  await new Promise(resolve => setTimeout(resolve, 4500));
  await renderFrames(3);
  return state();
}

function modelState() {
  const copyVariant = [...access.variants.modelArrayParameterVariants.values()]
    .find(variant => variant.entities.some(entity => entity.id === copy.id));
  const activeMeshes = scene.getActiveMeshes();
  const active = new Set(activeMeshes.data.slice(0, activeMeshes.length));
  return [
    { entityId: source.id, model: access.assets.models.get(source.id) },
    { entityId: copy.id, model: copyVariant?.model },
  ].map(({ entityId, model }) => ({
    entityId,
    rootEnabled: model?.root.isEnabled() ?? null,
    hasBatch: Boolean(model?.modelArrayBatch),
    meshes: model?.modelArrayBatch?.meshes.map(mesh => ({
      name: mesh.name,
      layerMask: mesh.layerMask,
      enabled: mesh.isEnabled(),
      visible: mesh.isVisible && mesh.visibility > 0,
      thinInstanceCount: mesh.thinInstanceCount,
      entranceOverridden: Boolean(mesh.material?.pluginManager?.getPlugin('DigitalTwinModelEntrance')),
      active: active.has(mesh),
    })) ?? [],
  }));
}

Object.assign(window, {
  ledTelemetryHarness: {
    prepare,
    editDisplayText,
    start,
    moveCamera,
    playEntrance,
    pickScreen,
    interruptLongText,
    stop,
    state,
    modelState,
    renderer: () => ({ ...engine.getGlInfo(), webGLVersion: engine.webGLVersion }),
    dispose() {
      deviceTelemetryStore.clear();
      engine.stopRenderLoop();
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    },
  },
});
