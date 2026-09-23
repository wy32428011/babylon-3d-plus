import React from 'react';
import { createRoot } from 'react-dom/client';
import { ArcRotateCamera, EngineStore, Vector3 } from '@babylonjs/core';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { InspectorPanel } from '../../src/editor/panels/InspectorPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';
import { isScenePreparationActive } from '../../src/editor/loading/scenePreparationProgress';
import { stackerMotionArrowSession } from '../../src/runtime/stackerMotionArrowSession';
import '../../src/styles/global.css';

const source = (window as unknown as { stackerArrowScene: string }).stackerArrowScene;
const initialScene = deserializeScene(source);
initialScene.sceneSettings.shadows.enabled = false;
useEditorStore.getState().loadSceneFromContent(serializeScene(initialScene), '堆垛机箭头验收.scene.json');
const root = createRoot(document.getElementById('root')!);
root.render(<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 440px', height: '100vh' }}>
  <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) 210px', minHeight: 0 }}><SceneViewPanel /><ProjectPanel /></div>
  <aside style={{ overflow: 'auto', padding: 12 }}><InspectorPanel /></aside>
</div>);
const scene = () => EngineStore.Instances.flatMap(engine => engine.scenes).find(value => value.activeCamera && value.meshes.some(mesh => mesh.name.includes('ArrowMast')));
const arrows = () => scene()?.meshes.filter(mesh => mesh.metadata?.stackerMotionArrow === true) ?? [];
Object.assign(window, { stackerArrowHarness: {
  store: useEditorStore, scene, arrows, session: stackerMotionArrowSession,
  ready: () => !isScenePreparationActive() && !!scene(),
  camera: (mode: 'overview' | 'lift' = 'overview') => {
    const current = scene()!, camera = current.activeCamera as ArcRotateCamera;
    const mast = current.meshes.find(mesh => mesh.name === 'ArrowMast');
    mast?.computeWorldMatrix(true);
    camera.setTarget(mode === 'lift' ? mast?.getBoundingInfo().boundingBox.centerWorld.clone() ?? new Vector3(0, 3.5, 0) : new Vector3(0, 2.5, 0));
    camera.alpha = mode === 'lift' ? -Math.PI : -2.3; camera.beta = mode === 'lift' ? Math.PI / 2 : 1.03; camera.radius = mode === 'lift' ? 10 : 23;
    // 货格保留定位数据，只隐藏调试线框，防止其青色像素混入箭头可视断言。
    current.transformNodes.filter(node => node.name.startsWith('arrow-locator_')).forEach(node => node.getChildMeshes().forEach(mesh => { mesh.visibility = 0; }));
  },
  save: () => serializeScene(useEditorStore.getState().scene),
  reopen: (content: string) => useEditorStore.getState().loadSceneFromContent(content, '堆垛机箭头重开.scene.json'),
  current: () => { const state = useEditorStore.getState().scene; return state.entities[state.selectedEntityId ?? state.entityIds[0]]; },
  visual: () => arrows().map(mesh => { mesh.computeWorldMatrix(true); return { id: mesh.uniqueId, name: mesh.name, channel: mesh.metadata.channel,
    enabled: mesh.isEnabled(), ready: mesh.isReady(true), uniforms: (mesh.material as unknown as { _floats: Record<string, number> })._floats,
    center: mesh.getBoundingInfo().boundingBox.centerWorld.asArray(),
    length: Vector3.TransformNormal(Vector3.Right(), mesh.getWorldMatrix()).length(),
    width: Vector3.TransformNormal(Vector3.Forward(), mesh.getWorldMatrix()).length() }; }),
  nodes: () => Object.fromEntries((scene()?.meshes ?? []).filter(mesh => /^Arrow/.test(mesh.name)).map(mesh => {
    mesh.computeWorldMatrix(true); return [mesh.name, mesh.getBoundingInfo().boundingBox.centerWorld.asArray()];
  })),
  dispose: () => root.unmount(),
} });
