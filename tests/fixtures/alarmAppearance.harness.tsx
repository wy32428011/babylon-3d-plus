import React from 'react';
import { createRoot } from 'react-dom/client';
import { ArcRotateCamera, EngineStore, Mesh, Vector3 } from '@babylonjs/core';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { InspectorPanel } from '../../src/editor/panels/InspectorPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { createEmptySceneDocument, createModelEntity } from '../../src/editor/model/SceneDocument';
import { createAlarmManagerEntity, resolveAlarmTargets } from '../../src/editor/model/alarmManager';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import { deviceTelemetryStore, parseDeviceTelemetryMessage } from '../../src/runtime/mqtt/deviceTelemetry';
import { installDeploymentAssetManifest } from '../../src/runtime/assets/editorAssetUrl';
import '../../src/styles/global.css';

const { sourcePath, libraryPath } = (window as unknown as { alarmFixturePaths: { sourcePath: string; libraryPath: string } }).alarmFixturePaths;
const modelIdentity = { sourceKey: 'a'.repeat(64), kind: 'model' as const, resourceId: '42', modelPath: 'device.gltf' };
installDeploymentAssetManifest(Object.fromEntries([sourcePath, libraryPath].map(assetPath =>
  ['editor-asset://local/' + encodeURIComponent(assetPath), location.origin + '/__editor_asset__/' + encodeURIComponent(assetPath)])));
// 普通模型库旧索引只有资源路径；来源键仅出现在列表返回值顶层。
const libraryAsset = { id: libraryPath, name: 'device.gltf', displayName: '报警测试设备', path: libraryPath,
  sourceUrl: 'editor-asset://local/' + encodeURIComponent(libraryPath), kind: 'model', libraryKind: 'model',
  packagePath: libraryPath.replace(/[\\/]device\.gltf$/, ''), lengthUnit: 'meter', unitScaleToMeters: 1 };
Object.assign(window, { editorApi: {
  listProjectAssets: async () => ({ projectRoot: 'C:/alarm-fixture', dataPlatformSourceKey: modelIdentity.sourceKey,
    assets: [libraryAsset], skyboxes: [], orphanedSkyboxes: [] }),
  listSyncedImages: async () => [],
} });
const doc = createEmptySceneDocument('报警外观特效验证');
doc.sceneSettings.shadows.enabled = false;
doc.mqttConfig.enabled = true;
doc.mqttConfig.simulatorEnabled = true;
const manager = createAlarmManagerEntity({ x: 0, y: 0, z: 5 });
const devices = ['A', 'B'].map((assetCode, index) => {
  const entity = createModelEntity(sourcePath, 'editor-asset://local/' + encodeURIComponent(sourcePath), '设备 ' + assetCode);
  entity.components.transform.position = { x: index ? 3 : -3, y: 1, z: 0 };
  entity.components.modelAsset!.assetCode = assetCode;
  entity.components.modelAsset!.dataPlatformModel = modelIdentity;
  entity.components.modelAsset!.sourceSnapshot = { contentSha256: 'b'.repeat(64) };
  entity.components.telemetryBinding = { enabled: true, sourceId: 'default', deviceType: 'device', expectedIntervalMs: 500, staleAfterMs: 100000 };
  return entity;
});
Object.assign(manager.components.alarmManager!, { runningState: 'alarm', warehouseAlarm: false, focusCamera: false, targetType: 'MODEL',
  targets: [] });
for (const entity of [manager, ...devices]) { doc.entityIds.push(entity.id); doc.entities[entity.id] = entity; }
doc.selectedEntityId = manager.id;
useEditorStore.getState().loadSceneFromContent(serializeScene(doc), 'alarm-effects.scene.json');
useEditorStore.setState({ sceneResourcePolicy: 'preserve-snapshot' });
if (!useEditorStore.getState().scene.entities[manager.id]) throw new Error('报警外观验证场景加载失败');
useEditorStore.getState().selectEntity(manager.id);
const root = createRoot(document.getElementById('root')!);
root.render(<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 440px', height: '100vh' }}>
  <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) 290px', minHeight: 0 }}><SceneViewPanel/><ProjectPanel/></div>
  <aside style={{ overflow: 'auto', padding: 12 }}><InspectorPanel/></aside>
</div>);
const scene = () => EngineStore.Instances.flatMap(engine => engine.scenes).find(scene => scene.meshes.some(mesh => mesh.metadata?.editorEntityId === manager.id));
const modelMeshes = (index: number) => scene()?.meshes.filter(mesh => mesh.metadata?.editorEntityId === devices[index].id && mesh.getTotalVertices() > 0) ?? [];
let sequence = 0;
Object.assign(window, { alarmAppearanceHarness: {
  store: useEditorStore, scene, devices, managerId: manager.id, modelMeshes,
  // 尚未配置报警目标时静态设备可以合批；加入报警目标后运行时会自动分离各设备。
  ready: () => devices.every((_, index) => modelMeshes(index).length > 0)
    || scene()?.meshes.some(mesh => mesh instanceof Mesh && mesh.name.startsWith('__modelArrayThinInstance_')
      && mesh.getTotalVertices() > 0 && mesh.thinInstanceCount === devices.length),
  config: () => useEditorStore.getState().scene.entities[manager.id].components.alarmManager,
  resolvedTargetCount: () => { const current = useEditorStore.getState().scene;
    return resolveAlarmTargets(current, current.entities[manager.id].components.alarmManager!).length; },
  diagnostic: () => ({ logs: useEditorStore.getState().logs,
    assets: devices.map(device => useEditorStore.getState().scene.entities[device.id]?.components.modelAsset),
    scenes: EngineStore.Instances.flatMap(engine => engine.scenes).map(scene => ({
      meshes: scene.meshes.map(mesh => ({ name: mesh.name, vertices: mesh.getTotalVertices(), entityId: mesh.metadata?.editorEntityId })) })) }),
  camera: () => { const camera = scene()!.activeCamera as ArcRotateCamera; camera.setTarget(new Vector3(0, 1, 0)); camera.alpha = -Math.PI / 2; camera.beta = 1.1; camera.radius = 19; },
  signal: (index: number, normal: boolean) => {
    const assetCode = devices[index].components.modelAsset!.assetCode;
    const snapshot = parseDeviceTelemetryMessage(`dt/factory/logistics/device/${assetCode}/twindatadriven/joint`, JSON.stringify({ seq: ++sequence, data: [{ e: assetCode, p: 'normal', v: normal }] }));
    if (!snapshot) throw new Error('报警外观验证的 MQTT 消息解析失败');
    return deviceTelemetryStore.upsert(snapshot);
  },
  effect: (index: number) => scene()?.getTransformNodeByName(manager.id + ':alarm:' + devices[index].id + '_poiEffectRoot'),
  save: () => serializeScene(useEditorStore.getState().scene),
  reopen: (content: string) => { useEditorStore.getState().loadSceneFromContent(content, 'reopened.scene.json');
    useEditorStore.setState({ sceneResourcePolicy: 'preserve-snapshot' }); useEditorStore.getState().selectEntity(manager.id); },
  dispose: () => { root.unmount(); deviceTelemetryStore.clear(); },
} });
