import { ArcRotateCamera, Color4, Engine, HemisphericLight, MeshBuilder, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { SceneRuntime } from '../../src/runtime/babylon/SceneRuntime';
import { createEmptySceneDocument, createPoiEffectEntity, createModelGeneratorEntity, createLocatorEntity } from '../../src/editor/model/SceneDocument';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import { createDefaultEffectConfiguration } from '../../src/editor/model/effectConfigurationValidation';
import { installDeploymentAssetManifest } from '../../src/runtime/assets/editorAssetUrl';
import { getEffectDiagnostic } from '../../src/runtime/effects/effectDiagnostics';
import type { GeneratedCargoRuntimeEntry } from '../../src/runtime/babylon/telemetry/specialized/types';
import type { EffectRuntimeTarget } from '../../src/editor/model/effectConfiguration';
import type { ModelGeneratorComponent } from '../../src/editor/model/components';
import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';

const canvas = document.createElement('canvas'); canvas.width = 1100; canvas.height = 720; canvas.style.cssText = 'width:1100px;height:720px'; document.body.append(canvas);
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
const scene = new Scene(engine); scene.clearColor = new Color4(.015, .025, .045, 1);
const camera = new ArcRotateCamera('camera', -1.1, 1.1, 18, new Vector3(0, 1, 0), scene);
new HemisphericLight('light', new Vector3(0, 1, 0), scene); MeshBuilder.CreateGround('ground', { width: 60, height: 30 }, scene);
const runtime = new SceneRuntime(scene);
const methods = runtime as unknown as {
  getRuntimeEffectTargets(): readonly EffectRuntimeTarget[];
  syncGeneratedCargoVisual(cargo: GeneratedCargoRuntimeEntry, kind: string, snapshot: DeviceTelemetrySnapshot, generator: unknown): void;
  disposeGeneratedCargo(cargo: GeneratedCargoRuntimeEntry): void;
};
const path = 'C:/generated-follow/cargo.gltf', sourceUrl = 'editor-asset://local/' + encodeURIComponent(path);
installDeploymentAssetManifest({ [sourceUrl]: location.origin + '/__generated_cargo__.gltf' });
const template = { sourcePath: path, sourceUrl, lengthUnit: 'meter' as const, unitScaleToMeters: 1, dataDrivenConfig: { device: { devType: 'cargo' }, motion: false, fixedNodes: [] } };
const generator = { defaultTarget: { kind: 'model', assetId: 'cargo', displayName: 'Cargo Type', modelAsset: template }, rules: [] } as unknown as ModelGeneratorComponent;
const documentModel = createEmptySceneDocument('运行时类型跟随'); documentModel.sceneSettings.shadows.enabled = false;
const fetchMode = new URLSearchParams(location.search).get('mode') === 'fetch';
const effect = createPoiEffectEntity('target-follow'); const config = createDefaultEffectConfiguration(effect.components.poiEffect!);
Object.assign(config.target, { mode: 'model', model: { name: 'Cargo Type', sourcePath: path, sourceUrl, deviceType: 'cargo' }, instanceSource: 'generated', instanceKey: 'containerCode', generatorId: 'cargo-generator', sourceId: 'factory-a', deviceType: 'cargo', assetCode: '000317', anchor: 'origin' });
config.parameters = { smoothTime: 0, manualTakeover: false, distance: 12, height: 5 };
effect.components.poiEffect!.configuration = config;
documentModel.entities[effect.id] = effect; documentModel.entityIds.push(effect.id);
if (fetchMode) {
  const gen = createModelGeneratorEntity(); gen.id = 'cargo-generator'; gen.components.modelGenerator!.defaultTarget = generator.defaultTarget;
  const locator = createLocatorEntity({ x: 6, y: 0, z: 0 }); Object.assign(locator.components.locator!, { columns: 3, length: 2, width: 2, height: 2, fetchDrive: { enabled: true, cargoGeneratorId: gen.id } });
  for (const entity of [gen, locator]) { documentModel.entities[entity.id] = entity; documentModel.entityIds.push(entity.id); }
  documentModel.sceneSettings.defaultCargoGeneratorId = gen.id;
  documentModel.fetchConfig = { url: location.origin + '/__inventory__', apiKey: '', syncIntervalSeconds: 0 };
  config.target.sourceId = '';
}
runtime.sync(documentModel); runtime.beginTelemetryPreview();
let cargo: GeneratedCargoRuntimeEntry | null = null;
const snapshot = { sourceId: 'factory-a', deviceType: 'conveyor', assetCode: 'carrier-001', fields: {}, receivedAt: Date.now() } as DeviceTelemetrySnapshot;
const addButton = (text: string, action: () => void) => { const button = document.createElement('button'); button.textContent = text; button.onclick = action; document.body.append(button); };
const remove = () => { if (cargo) methods.disposeGeneratedCargo(cargo); cargo = null; };
addButton('生成 000317', () => {
  remove(); cargo = { root: new TransformNode('generated-cargo', scene), assetCode: 'carrier-001', containerCode: '000317', task: 'task-1', outputOwner: null, fallback: null, generatorEntityId: null, handoff: null, axialLengthCache: null, lockedWorldRotation: null };
  cargo.root.position.x = 6;
  methods.syncGeneratedCargoVisual(cargo, 'conveyor', snapshot, { entityId: 'cargo-generator', component: generator });
});
addButton('移动到 12', () => { if (cargo) cargo.root.position.x = 12; });
addButton('销毁', remove);
addButton('停止预览', () => { remove(); runtime.endTelemetryPreview(); });
if (fetchMode) addButton('同步库存', () => { void runtime.handleFetchDriveEvent(documentModel.fetchConfig); });
const status = document.createElement('pre'); document.body.append(status);
engine.runRenderLoop(() => { scene.render(); status.textContent = JSON.stringify(getEffectDiagnostic(effect.id), null, 2); });
Object.assign(window, { generatedFollow: {
  state: () => ({ targets: methods.getRuntimeEffectTargets(), diagnostic: getEffectDiagnostic(effect.id), camera: camera.target.asArray(), visibleMeshes: scene.meshes.filter(m => m.isVisible && m.isEnabled() && m.getTotalVertices() > 0).map(m => m.name) }),
  save: () => serializeScene(documentModel),
  dispose: () => { remove(); engine.stopRenderLoop(); runtime.dispose(); scene.dispose(); engine.dispose(); },
} });
