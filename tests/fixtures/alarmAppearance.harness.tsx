import React from 'react';
import { createRoot } from 'react-dom/client';
import { ArcRotateCamera, EngineStore, Vector3 } from '@babylonjs/core';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { InspectorPanel } from '../../src/editor/panels/InspectorPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { createEmptySceneDocument, createModelEntity } from '../../src/editor/model/SceneDocument';
import { createAlarmManagerEntity } from '../../src/editor/model/alarmManager';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import { deviceTelemetryStore } from '../../src/runtime/mqtt/deviceTelemetry';
import '../../src/styles/global.css';

const sourcePath = (window as unknown as { alarmFixturePath: string }).alarmFixturePath;
const doc = createEmptySceneDocument('报警外观特效验证');
doc.sceneSettings.shadows.enabled = false;
doc.mqttConfig.enabled = true;
doc.mqttConfig.simulatorEnabled = true;
const manager = createAlarmManagerEntity({ x: 0, y: 0, z: 5 });
const devices = ['A', 'B'].map((assetCode, index) => {
  const entity = createModelEntity(sourcePath, 'editor-asset://local/' + encodeURIComponent(sourcePath), '设备 ' + assetCode);
  entity.components.transform.position = { x: index ? 3 : -3, y: 1, z: 0 };
  entity.components.modelAsset!.assetCode = assetCode;
  entity.components.telemetryBinding = { enabled: true, sourceId: 'default', deviceType: 'device', expectedIntervalMs: 500, staleAfterMs: 100000 };
  return entity;
});
Object.assign(manager.components.alarmManager!, { runningState: 'alarm', warehouseAlarm: false, focusCamera: false,
  targets: devices.map(entity => ({ id: entity.id, model: null, entityId: entity.id })) });
for (const entity of [manager, ...devices]) { doc.entityIds.push(entity.id); doc.entities[entity.id] = entity; }
doc.selectedEntityId = manager.id;
useEditorStore.getState().loadSceneFromContent(serializeScene(doc), 'alarm-effects.scene.json');
useEditorStore.getState().selectEntity(manager.id);
const root = createRoot(document.getElementById('root')!);
root.render(<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 440px', height: '100vh' }}>
  <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) 290px', minHeight: 0 }}><SceneViewPanel/><ProjectPanel/></div>
  <aside style={{ overflow: 'auto', padding: 12 }}><InspectorPanel/></aside>
</div>);
const scene = () => EngineStore.Instances.flatMap(engine => engine.scenes).find(scene => scene.meshes.some(mesh => mesh.metadata?.editorEntityId === devices[0].id));
const modelMeshes = (index: number) => scene()?.meshes.filter(mesh => mesh.metadata?.editorEntityId === devices[index].id && mesh.getTotalVertices() > 0) ?? [];
let sequence = 0;
Object.assign(window, { alarmAppearanceHarness: {
  store: useEditorStore, scene, devices, managerId: manager.id, modelMeshes,
  ready: () => devices.every((_, index) => modelMeshes(index).length > 0),
  config: () => useEditorStore.getState().scene.entities[manager.id].components.alarmManager,
  camera: () => { const camera = scene()!.activeCamera as ArcRotateCamera; camera.setTarget(new Vector3(0, 1, 0)); camera.alpha = -Math.PI / 2; camera.beta = 1.1; camera.radius = 19; },
  signal: (index: number, faulted: boolean) => deviceTelemetryStore.upsert({ sourceId: 'default', topic: 'fixture', deviceType: 'device', assetCode: index ? 'B' : 'A', receivedAt: Date.now(), sourceTimestamp: null, sequence: ++sequence, fields: {}, faulted } as never),
  effect: (index: number) => scene()?.getTransformNodeByName(manager.id + ':alarm:' + devices[index].id + '_poiEffectRoot'),
  save: () => serializeScene(useEditorStore.getState().scene),
  reopen: (content: string) => { useEditorStore.getState().loadSceneFromContent(content, 'reopened.scene.json'); useEditorStore.getState().selectEntity(manager.id); },
  dispose: () => { root.unmount(); deviceTelemetryStore.clear(); },
} });
