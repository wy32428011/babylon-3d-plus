import React from 'react';
import { createRoot } from 'react-dom/client';
import { EngineStore } from '@babylonjs/core';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { InspectorPanel } from '../../src/editor/panels/InspectorPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { createEmptySceneDocument } from '../../src/editor/model/SceneDocument';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import { installDeploymentAssetManifest } from '../../src/runtime/assets/editorAssetUrl';
import '../../src/styles/global.css';

// Chrome 不注册 Electron 自定义协议，通过运行时真实资源映射读取同一 HDR 字节。
installDeploymentAssetManifest({ [(window as unknown as { builtinSourceUrl: string }).builtinSourceUrl]: '/__builtin_hdr__' });

const documentModel = createEmptySceneDocument('内置轻量天空盒验收');
documentModel.sceneSettings.shadows.enabled = false;
documentModel.mqttConfig = { ...documentModel.mqttConfig, enabled: true, simulatorEnabled: true };
useEditorStore.getState().loadSceneFromContent(serializeScene(documentModel), 'builtin-skybox.scene.json');
const root = createRoot(document.getElementById('root')!);
root.render(<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 430px', height: '100vh' }}>
  <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) 280px', minHeight: 0 }}><SceneViewPanel /><ProjectPanel /></div>
  <aside style={{ overflow: 'auto', padding: 12 }}><InspectorPanel /></aside>
</div>);
const scene = () => EngineStore.Instances.flatMap(engine => engine.scenes).find(value => !value.isDisposed);
Object.assign(window, { builtinSkyboxHarness: {
  store: useEditorStore,
  scene,
  skyboxes: () => useEditorStore.getState().scene.entityIds.map(id => useEditorStore.getState().scene.entities[id]).filter(entity => entity.components.skybox),
  ready: () => Boolean(scene()?.environmentTexture?.isReady() && scene()?.meshes.some(mesh => mesh.metadata?.editorSkyboxSphere && mesh.isEnabled())),
  settings: () => useEditorStore.getState().selectEntity(null),
  save: () => serializeScene(useEditorStore.getState().scene),
  reopen: (content: string) => useEditorStore.getState().loadSceneFromContent(content, 'builtin-skybox-reopened.scene.json'),
  dispose: () => root.unmount(),
} });
