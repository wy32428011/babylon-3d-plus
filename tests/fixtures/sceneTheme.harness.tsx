import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArcRotateCamera, EngineStore, Vector3 } from '@babylonjs/core';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { InspectorPanel } from '../../src/editor/panels/InspectorPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { createEmptySceneDocument, createLightEntity, createMeshEntity, sanitizeSceneEnvironment } from '../../src/editor/model/SceneDocument';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import { isScenePreparationActive } from '../../src/editor/loading/scenePreparationProgress';
import '../../src/styles/global.css';

const sourcePath = (window as unknown as { sceneThemeFixturePath: string }).sceneThemeFixturePath;
const sourceUrl = 'editor-asset://local/' + encodeURIComponent(sourcePath);
const documentModel = createEmptySceneDocument('科技蓝夜景主题验收');
documentModel.sceneSettings.shadows.enabled = false;
documentModel.sceneSettings.environment = sanitizeSceneEnvironment({
  packagePath: sourcePath, lengthUnit: 'meter', unitScaleToMeters: 1,
  displayName: '夜景示例厂房', placementMode: 'scene-base', visible: true, opacity: 1,
  activeVariantUrl: sourceUrl, variants: [{ name: '默认环境', sourcePath, sourceUrl }],
});
const pointLight = createLightEntity('point', { x: -4, y: 5, z: -4 });
pointLight.name = '暖白装卸灯';
Object.assign(pointLight.components.light!, { color: '#ffd6a0', intensity: 2, range: 25 });
const equipment = createMeshEntity('cube', { x: 0, y: 1, z: -6 });
equipment.name = '待观察设备';
equipment.components.transform.scale = { x: 2, y: 2, z: 2 };
equipment.components.meshRenderer!.materialColor = '#87939f';
for (const entity of [pointLight, equipment]) {
  documentModel.entities[entity.id] = entity;
  documentModel.entityIds.push(entity.id);
}
documentModel.selectedEntityId = equipment.id;
useEditorStore.getState().loadSceneFromContent(serializeScene(documentModel), 'scene-theme.scene.json');

let setReadOnly: (readOnly: boolean) => void = () => undefined;
function Harness() {
  const [readOnly, updateReadOnly] = useState(false);
  setReadOnly = updateReadOnly;
  return <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 440px', height: '100vh' }}>
    <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) 260px', minHeight: 0 }}>
      <SceneViewPanel /><ProjectPanel readOnly={readOnly} />
    </div>
    <aside style={{ overflow: 'auto', padding: 12 }}><InspectorPanel readOnly={readOnly} /></aside>
  </div>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<Harness />);
const scene = () => EngineStore.Instances.flatMap(engine => engine.scenes)
  .find(value => value.transformNodes.some(node => node.name.startsWith('EnvironmentRoot_')));
const environmentRoot = () => scene()?.transformNodes.find(node => node.name.startsWith('EnvironmentRoot_'));
let primaryCamera: ArcRotateCamera | null = null;
let alternateCamera: ArcRotateCamera | null = null;
function switchCamera(alternate: boolean): number {
  const currentScene = scene()!;
  primaryCamera ??= currentScene.activeCamera as ArcRotateCamera;
  if (alternate && !alternateCamera) {
    alternateCamera = new ArcRotateCamera('SceneThemeSmokeAlternateCamera', -0.6, 1.05, 30, new Vector3(0, 2, 0), currentScene);
  }
  currentScene.activeCamera = alternate ? alternateCamera : primaryCamera;
  return currentScene.activeCamera!.uniqueId;
}
function disposeAlternateCamera() {
  if (!alternateCamera) return;
  if (scene()?.activeCamera === alternateCamera) scene()!.activeCamera = primaryCamera;
  alternateCamera.dispose(); alternateCamera = null; primaryCamera = null;
}
Object.assign(window, { sceneThemeHarness: {
  store: useEditorStore,
  scene,
  environmentRoot,
  meshes: () => environmentRoot()?.getChildMeshes().filter(mesh => mesh.getTotalVertices() > 0) ?? [],
  ready: () => useEditorStore.getState().environmentRuntimeSnapshot.phase === 'ready' && !isScenePreparationActive(),
  camera: () => {
    const camera = scene()?.activeCamera as ArcRotateCamera;
    camera.setTarget(new Vector3(0, 2, 0));
    camera.alpha = -1.2; camera.beta = 1.15; camera.radius = 30;
  },
  switchCamera,
  disposeAlternateCamera,
  setReadOnly: (value: boolean) => setReadOnly(value),
  save: () => serializeScene(useEditorStore.getState().scene),
  reopen: (content: string) => useEditorStore.getState().loadSceneFromContent(content, 'reopened-theme.scene.json'),
  dispose: () => { disposeAlternateCamera(); root.unmount(); },
} });
