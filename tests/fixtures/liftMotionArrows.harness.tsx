import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { EngineStore } from '@babylonjs/core/Engines/engineStore.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { InspectorPanel } from '../../src/editor/panels/InspectorPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';
import { createDefaultSceneSettings } from '../../src/editor/model/SceneDocument';
import { isScenePreparationActive } from '../../src/editor/loading/scenePreparationProgress';
import { liftMotionArrowSession } from '../../src/runtime/liftMotionArrowSession';
import '../../src/styles/global.css';

const source = (window as unknown as { liftArrowScene: string }).liftArrowScene;
// 旧版验收夹具省略设置；使用产品当前默认值补齐相机等必需字段，再走正式迁移与校验。
const sourceFile = JSON.parse(source);
sourceFile.scene.sceneSettings ??= createDefaultSceneSettings();
const initialScene = deserializeScene(JSON.stringify(sourceFile));
// 保留本验收原有禁用阴影的视觉设置，字段随统一光照 schema 迁移。
initialScene.sceneSettings.lighting.shadows.enabled = false;
// 本夹具验收实时设备箭头，不发起与该验收无关的光照烘焙任务。
initialScene.sceneSettings.lighting.bake.enabled = false;
useEditorStore.getState().loadSceneFromContent(serializeScene(initialScene), '提升机箭头验收.scene.json');
const root = createRoot(document.getElementById('root')!);
root.render(<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 440px', height: '100vh' }}>
  <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) 210px', minHeight: 0 }}><SceneViewPanel /><ProjectPanel /></div>
  <aside style={{ overflow: 'auto', padding: 12 }}><InspectorPanel /></aside>
</div>);
const scene = () => EngineStore.Instances.flatMap(engine => engine.scenes).find(value => value.activeCamera && value.meshes.some(mesh => mesh.name.includes('LiftColumn')));
const arrows = () => scene()?.meshes.filter(mesh => mesh.metadata?.liftMotionArrow === true) ?? [];
Object.assign(window, { liftArrowHarness: {
  store: useEditorStore, scene, arrows, session: liftMotionArrowSession,
  ready: () => !isScenePreparationActive() && !!scene(),
  camera: () => {
    const current = scene()!, camera = current.activeCamera as ArcRotateCamera;
    camera.setTarget(new Vector3(0, 2.7, 0));
    current.transformNodes.filter(node => node.name.startsWith('lift-arrow-locator')).forEach(node => node.getChildMeshes().forEach(mesh => { mesh.visibility = 0; }));
    camera.alpha = -.65; camera.beta = 1.15; camera.radius = 15;
  },
  save: () => serializeScene(useEditorStore.getState().scene),
  reopen: (content: string) => useEditorStore.getState().loadSceneFromContent(content, '提升机箭头重开.scene.json'),
  current: () => { const state = useEditorStore.getState().scene; return state.entities[state.selectedEntityId ?? state.entityIds[0]]; },
  visual: () => arrows().map(mesh => { mesh.computeWorldMatrix(true); return { id: mesh.uniqueId, name: mesh.name, channel: mesh.metadata.channel,
    enabled: mesh.isEnabled(), ready: mesh.isReady(true), uniforms: (mesh.material as unknown as { _floats: Record<string, number> })._floats,
    center: mesh.getBoundingInfo().boundingBox.centerWorld.asArray(),
    length: Vector3.TransformNormal(Vector3.Right(), mesh.getWorldMatrix()).length(),
    width: Vector3.TransformNormal(Vector3.Forward(), mesh.getWorldMatrix()).length() }; }),
  nodes: () => Object.fromEntries((scene()?.meshes ?? []).filter(mesh => /^(Lift|Hc)/.test(mesh.name)).map(mesh => {
    mesh.computeWorldMatrix(true); return [mesh.name, mesh.getBoundingInfo().boundingBox.centerWorld.asArray()];
  })),
  dispose: () => root.unmount(),
} });
