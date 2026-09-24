import { Camera, CascadedShadowGenerator, Color4, Engine, FreeCamera, Matrix, Scene, Vector3 } from '@babylonjs/core';
import { SceneRuntime } from '../../src/runtime/babylon/SceneRuntime';
import { createEmptySceneDocument, createLightEntity, createMeshEntity, type SceneDocument } from '../../src/editor/model/SceneDocument';
import type { LightComponent, LightKind } from '../../src/editor/model/components';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.015, 0.025, 0.04, 1);
const camera = new FreeCamera('lighting-smoke-camera', new Vector3(0, 15, -0.001), scene);
camera.setTarget(Vector3.Zero());
camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = -10;
camera.orthoRight = 10;
camera.orthoTop = 7.5;
camera.orthoBottom = -7.5;
camera.minZ = 0.1;
camera.maxZ = 100;
const runtime = new SceneRuntime(scene);
let currentDocument = createEmptySceneDocument('五种光源 WebGL 验收');
let lightId = '';
let groundId = '';
let unsubscribe: (() => void) | null = null;
let unmountUI: (() => void) | null = null;
let baselinePixels: Uint8Array | null = null;
engine.runRenderLoop(() => scene.render());

async function settle() {
  // Shader 编译及阴影贴图热切换需要真实帧，不使用仅看字段的替代断言。
  const targetFrame = scene.getFrameId() + 16;
  const deadline = performance.now() + 15_000;
  while (scene.getFrameId() < targetFrame || !scene.isReady()) {
    if (performance.now() > deadline) throw new Error('光源验收场景等待渲染就绪超时');
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
}

function applyDocument(value: SceneDocument) {
  currentDocument = value;
  runtime.sync(currentDocument);
}

async function createCase(kind: LightKind, shadows = false) {
  runtime.endTelemetryPreview();
  applyDocument(createEmptySceneDocument());
  camera.mode = kind === 'directional' ? Camera.PERSPECTIVE_CAMERA : Camera.ORTHOGRAPHIC_CAMERA;
  const next = createEmptySceneDocument(`${kind} 光源验收`);
  Object.assign(next.sceneSettings.shadows, {
    // 既有方向光均衡档仅环境/专用地面接收，高质量档允许普通实体互投影。
    enabled: shadows, mode: 'realtime', quality: kind === 'directional' ? 'quality' : 'balanced', catcherEnabled: false,
    sunIntensity: 0, fillIntensity: 0, darkness: 0.15,
    bias: kind === 'directional' ? 0.002 : 0.0001, normalBias: kind === 'directional' ? 0.03 : 0.01,
  });
  const ground = createMeshEntity('plane');
  ground.components.transform.scale = { x: 10, y: 1, z: 7.5 };
  ground.components.meshRenderer!.materialColor = '#888888';
  groundId = ground.id;
  const light = createLightEntity(kind, { x: 0, y: 7, z: 0 });
  lightId = light.id;
  Object.assign(light.components.light!, {
    intensity: kind === 'rectArea' ? 8 : 0.8, color: '#ffffff', range: 30, groundColor: '#000000',
    angle: Math.PI / 3, exponent: 2, width: 3, height: 2,
  });
  const blockers = [-2, 2].map(x => {
    const entity = createMeshEntity('cube', { x, y: 0.75, z: 0 });
    entity.components.transform.scale = { x: 1, y: 1.5, z: 1 };
    entity.components.meshRenderer!.materialColor = '#4f718c';
    return entity;
  });
  for (const entity of [ground, ...blockers, light]) {
    next.entityIds.push(entity.id);
    next.entities[entity.id] = entity;
  }
  applyDocument(next);
  runtime.beginTelemetryPreview();
  await settle();
  return snapshot();
}

function snapshot() {
  const light = scene.lights.find(value => value.name === lightId);
  const markerMeshes = scene.meshes.filter(mesh => mesh.metadata?.editorLightMarker === true);
  const shadow = light?.getShadowGenerator(scene.activeCamera) ?? light?.getShadowGenerator();
  return {
    component: currentDocument.entities[lightId]?.components.light,
    transform: currentDocument.entities[lightId]?.components.transform,
    className: light?.getClassName(), lightCount: scene.lights.filter(value => !value.name.startsWith('__')).length,
    enabled: light?.isEnabled(), intensity: light?.intensity, color: light?.diffuse.toHexString(), range: light?.range,
    shadows: Boolean(shadow), cubeShadow: shadow?.getShadowMap()?.isCube ?? false,
    shadowClass: shadow?.getClassName(),
    cascadeDepthBounds: shadow instanceof CascadedShadowGenerator ? { auto: shadow.autoCalcDepthBounds, min: shadow.minDistance, max: shadow.maxDistance, far: shadow.shadowMaxZ } : null,
    casterCount: shadow?.getShadowMap()?.renderList?.length ?? 0,
    markerCasterCount: shadow?.getShadowMap()?.renderList?.filter(mesh => mesh.metadata?.editorLightMarker === true).length ?? 0,
    markerCount: markerMeshes.length,
    visibleMarkerCount: markerMeshes.filter(mesh => mesh.isVisible && mesh.isEnabled()).length,
    groundReceivesShadows: scene.getMeshByName(groundId)?.receiveShadows,
  };
}

async function sample(x: number, z: number) {
  await settle();
  const projected = Vector3.Project(new Vector3(x, 0.001, z), Matrix.Identity(), scene.getTransformMatrix(),
    camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()));
  const pixels = await engine.readPixels(Math.round(projected.x) - 2,
    engine.getRenderHeight() - Math.round(projected.y) - 2, 5, 5);
  const rgb = [0, 0, 0];
  for (let index = 0; index < pixels.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) rgb[channel] += Number(pixels[index + channel]) / 25;
  }
  return { rgb, luminance: (rgb[0] + rgb[1] + rgb[2]) / 3 };
}

async function compareFrame(saveBaseline = false) {
  await settle();
  const pixels = await engine.readPixels(0, 0, engine.getRenderWidth(), engine.getRenderHeight());
  if (saveBaseline) { baselinePixels = new Uint8Array(pixels.buffer.slice(0)); return null; }
  let darker = 0, brighter = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const change = Number(pixels[index]) - baselinePixels![index];
    if (change < -15) darker++;
    if (change > 15) brighter++;
  }
  return { darker, brighter, snapshot: snapshot() };
}

async function patchLight(patch: Partial<LightComponent>, rotation?: { x: number; y: number; z: number }) {
  const entity = currentDocument.entities[lightId];
  const updated = { ...entity, components: { ...entity.components,
    light: { ...entity.components.light!, ...patch },
    transform: rotation ? { ...entity.components.transform, rotation } : entity.components.transform,
  } };
  applyDocument({ ...currentDocument, entities: { ...currentDocument.entities, [lightId]: updated } });
  await settle();
  return snapshot();
}

async function setShadows(enabled: boolean) {
  applyDocument({ ...currentDocument, sceneSettings: { ...currentDocument.sceneSettings,
    shadows: { ...currentDocument.sceneSettings.shadows, enabled },
  } });
  await settle();
  return snapshot();
}

async function lifecycle() {
  runtime.endTelemetryPreview();
  await settle();
  const edit = snapshot();
  runtime.beginTelemetryPreview();
  await settle();
  const preview = snapshot();
  applyDocument({ ...currentDocument, entities: { ...currentDocument.entities,
    [lightId]: { ...currentDocument.entities[lightId], visible: false },
  } });
  await settle();
  const hidden = snapshot();
  const hiddenPixel = await sample(0, -2);
  const light = scene.lights.find(value => value.name === lightId)!;
  const serialized = serializeScene(currentDocument);
  const reopened = deserializeScene(serialized);
  applyDocument(reopened);
  const persisted = snapshot();
  const entities = { ...currentDocument.entities };
  delete entities[lightId];
  applyDocument({ ...currentDocument, entities, entityIds: currentDocument.entityIds.filter(id => id !== lightId) });
  await settle();
  return { edit, preview, hidden, hiddenPixel, persisted, deleted: snapshot(), disposed: light.isDisposed() };
}

async function roundtrip() {
  const before = snapshot();
  const content = serializeScene(currentDocument);
  applyDocument(createEmptySceneDocument());
  applyDocument(deserializeScene(content));
  await settle();
  return { before, after: snapshot(), content };
}

async function mountUI() {
  const [{ default: React }, { createRoot }, { ProjectPanel }, { InspectorPanel }, { useEditorStore }] = await Promise.all([
    import('react'), import('react-dom/client'), import('../../src/editor/panels/ProjectPanel'),
    import('../../src/editor/panels/InspectorPanel'), import('../../src/editor/store/editorStore'),
  ]);
  await import('../../src/styles/global.css');
  canvas.style.display = 'none';
  document.getElementById('panels')!.style.height = '100vh';
  runtime.endTelemetryPreview();
  useEditorStore.getState().loadSceneFromContent(serializeScene(currentDocument), 'lighting-types.scene.json');
  unsubscribe = useEditorStore.subscribe(state => applyDocument(state.scene));
  const root = createRoot(document.getElementById('panels')!);
  root.render(React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 440px', height: '100%' } },
    React.createElement(ProjectPanel),
    React.createElement('aside', { style: { overflow: 'auto', padding: 10 } }, React.createElement(InspectorPanel))));
  unmountUI = () => root.unmount();
  Object.assign(window, { lightingUIStore: useEditorStore });
}

function closeUI() {
  unsubscribe?.(); unsubscribe = null;
  unmountUI?.(); unmountUI = null;
  canvas.style.display = 'block';
  document.getElementById('panels')!.style.height = '0';
}

Object.assign(window, { lightingTypesHarness: {
  createCase, snapshot, sample, patchLight, setShadows, lifecycle, roundtrip, settle, mountUI, closeUI, compareFrame,
  dispose: () => { unsubscribe?.(); unmountUI?.(); engine.stopRenderLoop(); runtime.dispose(); scene.dispose(); engine.dispose(); },
} });
