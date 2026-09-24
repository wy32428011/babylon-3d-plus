import { ArcRotateCamera, Color3, Color4, Engine, HemisphericLight, Matrix, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { AlarmManagerRuntime } from '../../src/runtime/babylon/AlarmManagerRuntime';
import { createAlarmManagerEntity, normalizeAlarmManager } from '../../src/editor/model/alarmManager';
import { ALARM_APPEARANCE_PRESETS, createAlarmAppearancePreset } from '../../src/editor/model/alarmAppearancePresets';
import { createEmptySceneDocument, createModelEntity } from '../../src/editor/model/SceneDocument';
import { deviceTelemetryStore, parseDeviceTelemetryMessage } from '../../src/runtime/mqtt/deviceTelemetry';

document.body.style.cssText = 'margin:0;background:#07111e;color:#dceeff;font:16px system-ui';
document.body.innerHTML = '<main style="width:1100px;margin:auto"><header style="height:76px;display:flex;align-items:center;justify-content:space-between;padding:0 24px"><div><b id="preset-title" style="font-size:23px">报警外观验证</b><div style="font-size:13px;color:#81a5c5;margin-top:5px">实际 Babylon WebGL · CUSTOM PROPERTY / normal / true</div></div><span style="color:#86bdcf">左侧设备 A：报警　右侧设备 B：正常</span></header><canvas id="alarm-canvas" width="1100" height="660" style="display:block;width:1100px;height:660px"></canvas><footer style="padding:16px 24px;color:#81a5c5">本地回归场景：原始 MQTT p/v 解析、逐设备外观、移动跟随、解除恢复</footer></main>';
const canvas = document.querySelector<HTMLCanvasElement>('#alarm-canvas')!;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);
// GlowLayer 首次渲染会懒建场景默认材质；提前初始化，资源基线只比较各效果自身的增减。
void scene.defaultMaterial;
scene.clearColor = new Color4(.025, .045, .075, 1);
const camera = new ArcRotateCamera('reference-camera', -Math.PI / 2.35, 1.06, 19, new Vector3(-.4, 1.7, 0), scene);
camera.attachControl(canvas, true);
camera.minZ = .05;
const light = new HemisphericLight('reference-light', new Vector3(.4, 1, -.6), scene); light.intensity = .9;
const material = (name: string, color: string, emissive = 0) => {
  const result = new StandardMaterial(name, scene);
  result.diffuseColor = Color3.FromHexString(color); result.emissiveColor = result.diffuseColor.scale(emissive); result.specularColor = new Color3(.12, .12, .12);
  return result;
};
const ground = MeshBuilder.CreateGround('reference-ground', { width: 28, height: 22 }, scene);
ground.material = material('floor-material', '#152635'); ground.position.y = -.04;
for (let index = -12; index <= 12; index += 2) {
  const points = [new Vector3(index, -.025, -10), new Vector3(index, -.025, 10)];
  const line = MeshBuilder.CreateLines('floor-line-x-' + index, { points }, scene); line.color = new Color3(.08, .17, .23);
  const cross = MeshBuilder.CreateLines('floor-line-z-' + index, { points: [new Vector3(-14, -.025, index), new Vector3(14, -.025, index)] }, scene); cross.color = line.color;
}
const documentScene = createEmptySceneDocument('参考图报警外观验证');
const manager = createAlarmManagerEntity({ x: 0, y: 0, z: 8 });
const devices = ['A', 'B'].map((assetCode, index) => {
  const entity = createModelEntity('reference-device.glb', 'reference-device.glb', '注塑设备 ' + assetCode);
  entity.components.modelAsset!.assetCode = assetCode;
  entity.components.telemetryBinding = { enabled: true, sourceId: 'reference', deviceType: 'device', expectedIntervalMs: 500, staleAfterMs: 300 };
  const node = new TransformNode('device-' + assetCode, scene); node.position.x = index ? 4 : -3;
  const shared = material('device-original-' + assetCode, '#427581');
  const meshes: Mesh[] = [];
  const box = (name: string, width: number, height: number, depth: number, position: Vector3) => {
    const mesh = MeshBuilder.CreateBox(assetCode + '-' + name, { width, height, depth }, scene); mesh.parent = node; mesh.position.copyFrom(position); mesh.material = shared; meshes.push(mesh); return mesh;
  };
  box('body', 1.8, 2, 1.6, new Vector3(0, 1.25, 0));
  box('base', 2.3, .28, 2, new Vector3(0, .14, 0));
  box('panel', .5, 1.05, .16, new Vector3(.58, 1.5, -.9));
  box('roof', 2.05, .16, 1.85, new Vector3(0, 2.32, 0));
  const original = meshes.map(mesh => mesh.material);
  documentScene.entityIds.push(entity.id); documentScene.entities[entity.id] = entity;
  return { entity, node, meshes, original };
});
documentScene.entityIds.push(manager.id); documentScene.entities[manager.id] = manager;
Object.assign(manager.components.alarmManager!, { listenProperty: 'CUSTOM PROPERTY', customProperty: 'normal', customValue: 'true',
  warehouseAlarm: false, focusCamera: false, targetType: 'ENTITY', targets: devices.map(({ entity }, index) => ({ id: 'slot-' + index, entityId: entity.id, model: null })) });
let activations = 0, clockOffset = 0, sequence = 0;
const errors: string[] = [];
const runtime = new AlarmManagerRuntime(scene, {
  meshes: id => devices.find(device => device.entity.id === id)?.meshes ?? [],
  node: id => devices.find(device => device.entity.id === id)?.node ?? null,
  bounds: id => {
    const device = devices.find(value => value.entity.id === id); if (!device) return null;
    const bounds = device.node.getHierarchyBoundingVectors(true); return { minimum: bounds.min, maximum: bounds.max };
  },
  visible: () => true, activate: () => { activations++; }, report: message => errors.push(message),
});
const key = (index: number) => manager.id + ':alarm:' + devices[index].entity.id;
const effect = (index = 0) => scene.getTransformNodeByName(key(index) + '_poiEffectRoot');
const signal = (index: number, value: boolean, property = 'normal') => {
  const assetCode = devices[index].entity.components.modelAsset!.assetCode;
  const snapshot = parseDeviceTelemetryMessage(`dt/factory/logistics/device/${assetCode}/twindatadriven/joint`, JSON.stringify({ seq: ++sequence, data: [{ e: assetCode, p: property, v: value }] }), { kind: 'epv', sourceId: 'reference' });
  if (!snapshot) throw new Error('参考图验证消息解析失败');
  deviceTelemetryStore.upsert(snapshot);
};
const sample = () => ({
  active: devices.map(device => runtime.isActive(manager.id, device.entity.id)), activations, errors,
  restored: devices.map(device => device.meshes.every((mesh, index) => mesh.material === device.original[index])),
  roots: devices.map((_, index) => effect(index)?.position.asArray() ?? null),
  effectMeshes: scene.meshes.filter(mesh => mesh.name.includes(key(0)) && !mesh.name.includes('PickShell') && mesh.getTotalVertices() > 0).map(mesh => ({ name: mesh.name, vertices: mesh.getTotalVertices(), visible: mesh.isVisible && mesh.visibility > 0 && mesh.isEnabled(), position: mesh.position.asArray(), scale: mesh.scaling.asArray(), rotation: mesh.rotation.asArray(), alpha: mesh.material?.alpha })),
  effectMaterials: devices[0].meshes.map(mesh => ({ name: mesh.material?.name, diffuse: (mesh.material as StandardMaterial)?.diffuseColor?.asArray(), emissive: (mesh.material as StandardMaterial)?.emissiveColor?.asArray(), alpha: mesh.material?.alpha })),
  deviceRects: devices.map(device => {
    const corners = device.meshes.flatMap(mesh => { mesh.computeWorldMatrix(true); return mesh.getBoundingInfo().boundingBox.vectorsWorld; });
    const projected = corners.map(point => Vector3.Project(point, Matrix.Identity(), scene.getTransformMatrix(), camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())));
    return { left: Math.min(...projected.map(v => v.x)) - 5, right: Math.max(...projected.map(v => v.x)) + 5, top: Math.min(...projected.map(v => v.y)) - 5, bottom: Math.max(...projected.map(v => v.y)) + 5 };
  }),
  resources: { meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length, transformNodes: scene.transformNodes.length },
  materialNames: scene.materials.map(value => value.name),
});
engine.runRenderLoop(() => { runtime.update(Date.now() + clockOffset); scene.render(); });
Object.assign(window, { alarmReferenceHarness: {
  presets: ALARM_APPEARANCE_PRESETS, sample, signal, scene,
  setPreset: (id: string) => {
    runtime.reset(); deviceTelemetryStore.clear(); activations = 0; clockOffset = 0; devices[0].node.position.x = -3;
    const preset = ALARM_APPEARANCE_PRESETS.find(value => value.id === id)!;
    manager.components.alarmManager = normalizeAlarmManager({ ...manager.components.alarmManager, overrideColorEnabled: preset.tintModel, appearanceEffect: createAlarmAppearancePreset(id) });
    runtime.sync(documentScene);
    document.querySelector('#preset-title')!.textContent = preset.name;
    return sample();
  },
  advance: (milliseconds: number) => { clockOffset += milliseconds; },
  move: (delta: number) => { devices[0].node.position.x += delta; },
  dispose: () => { engine.stopRenderLoop(); runtime.dispose(); deviceTelemetryStore.clear(); scene.dispose(); engine.dispose(); },
} });
