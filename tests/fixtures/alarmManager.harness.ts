import { Engine, Scene, MeshBuilder, StandardMaterial, Color3, ArcRotateCamera, HemisphericLight, Vector3 } from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AlarmManagerRuntime } from '/src/runtime/babylon/AlarmManagerRuntime';
import { createAlarmManagerEntity } from '/src/editor/model/alarmManager';
import { createEmptySceneDocument } from '/src/editor/model/SceneDocument';
import { deviceTelemetryStore } from '/src/runtime/mqtt/deviceTelemetry';
import { DataPlatformScreenOverlay } from '/src/runtime/babylon/DataPlatformScreenOverlay';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const engine = new Engine(canvas, true, { alpha: true, preserveDrawingBuffer: true });
const scene = new Scene(engine);
const camera = new ArcRotateCamera('camera', -Math.PI / 2, 1.1, 13, new Vector3(0, 1, 0), scene);
camera.attachControl(canvas, true);
new HemisphericLight('light', new Vector3(0, 1, -1), scene);
const left = MeshBuilder.CreateBox('受监控设备', { size: 2 }, scene); left.position.set(-2, 1, 0);
const right = MeshBuilder.CreateBox('正常设备', { size: 2 }, scene); right.position.set(2, 1, 0);
const original = new StandardMaterial('shared', scene); original.diffuseColor = Color3.FromHexString('#00a59a');
left.material = right.material = original;
const manager = createAlarmManagerEntity({ x: 0, y: 0, z: 0 });
const c = manager.components.alarmManager!;
c.runningState = 'alarm'; c.showMarker = true; c.focusCamera = false; c.associationType = 'builtin'; c.marker.text = '设备报警';
const target = { id: 'device', name: '设备 A', visible: true, parentId: null, childrenIds: [], locked: false, components: {
  transform: { position: { x: -2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  modelAsset: { sourceUrl: 'editor-asset://local/test.glb', sourcePath: 'test.glb', assetCode: 'A', lengthUnit: 'm', unitScaleToMeters: 1 },
  telemetryBinding: { enabled: true, sourceId: 'default', deviceType: 'device', staleAfterMs: 100000 },
} };
c.targets = [{ id: 'slot', model: null, entityId: 'device' }];
const sceneDocument = { ...createEmptySceneDocument('报警可视验证'), entityIds: [manager.id, target.id], entities: { [manager.id]: manager, [target.id]: target } };
const events: unknown[] = [], errors: string[] = [];
const runtime = new AlarmManagerRuntime(scene, { meshes: () => [left], visible: () => true,
  bounds: () => { left.computeWorldMatrix(true); const b = left.getBoundingInfo().boundingBox; return { minimum: b.minimumWorld, maximum: b.maximumWorld }; },
  activate: event => events.push(event), report: message => errors.push(message),
});
runtime.sync(sceneDocument as never);
scene.onBeforeRenderObservable.add(() => runtime.update());
const reactRoot = createRoot(window.document.getElementById('overlay')!);
reactRoot.render(React.createElement(DataPlatformScreenOverlay, { scene, canvas, runtime: { getDataPlatformScreenOverlayItems: () => runtime.getOverlayItems() } as never }));
let sequence = 0;
function signal(faulted: boolean) { deviceTelemetryStore.upsert({ sourceId: 'default', topic: 'test', deviceType: 'device', assetCode: 'A', receivedAt: Date.now(), sourceTimestamp: null, sequence: ++sequence, fields: {}, faulted } as never); }
Object.assign(window, { alarmHarness: {
  signal,
  inspect: () => ({ overridden: left.material !== original, normalUnchanged: right.material === original, particles: scene.particleSystems.length, activeParticles: scene.particleSystems.reduce((sum, p) => sum + p.getActiveCount(), 0), overlays: runtime.getOverlayItems().length, events: events.length, errors, appearance: scene.transformNodes.some(n => n.name.endsWith('_appearance')) }),
  appearance: () => { c.appearanceModel = { kind: 'model', assetId: 'appearance', displayName: '实际 GLB 外观', modelAsset: { sourcePath: 'manual-roam/EQ_People.glb', sourceUrl: '/manual-roam/EQ_People.glb', lengthUnit: 'm', unitScaleToMeters: 1 } }; runtime.sync(sceneDocument as never); signal(true); },
  dispose: () => { runtime.dispose(); reactRoot.unmount(); engine.stopRenderLoop(); scene.dispose(); engine.dispose(); },
} });
engine.runRenderLoop(() => scene.render());
