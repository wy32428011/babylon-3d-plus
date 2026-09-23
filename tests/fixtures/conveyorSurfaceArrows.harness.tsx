import React from 'react';
import { createRoot } from 'react-dom/client';
import { ArcRotateCamera, Color3, EngineStore, Mesh, MeshBuilder, StandardMaterial, Vector3 } from '@babylonjs/core';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { InspectorPanel } from '../../src/editor/panels/InspectorPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';
import { isScenePreparationActive } from '../../src/editor/loading/scenePreparationProgress';
import { conveyorSurfaceArrowSession } from '../../src/runtime/conveyorSurfaceArrowSession';
import '../../src/styles/global.css';

const source = (window as unknown as { conveyorArrowScene: string }).conveyorArrowScene;
const initialScene = deserializeScene(source);
initialScene.sceneSettings.shadows.enabled = false;
useEditorStore.getState().loadSceneFromContent(serializeScene(initialScene), '表面箭头验收.scene.json');
const root = createRoot(document.getElementById('root')!);
root.render(<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 440px', height: '100vh' }}>
  <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) 210px', minHeight: 0 }}>
    <SceneViewPanel /><ProjectPanel />
  </div>
  <aside style={{ overflow: 'auto', padding: 12 }}><InspectorPanel /></aside>
</div>);
const scene = () => EngineStore.Instances.flatMap(engine => engine.scenes).find(value => value.activeCamera && value.meshes.some(mesh => mesh.getTotalVertices() > 0));
const arrows = () => scene()?.meshes.filter(mesh => mesh.metadata?.conveyorSurfaceArrow === true) ?? [];
let occluder: Mesh | null = null;
Object.assign(window, { conveyorArrowHarness: {
  store: useEditorStore, scene, arrows, session: conveyorSurfaceArrowSession,
  ready: () => !isScenePreparationActive() && !!scene() && useEditorStore.getState().scene.entityIds.length > 0,
  camera: () => {
    const camera = scene()!.activeCamera as ArcRotateCamera;
    camera.setTarget(new Vector3(0, .3, 0)); camera.alpha = -1.15; camera.beta = .62; camera.radius = 11;
  },
  save: () => serializeScene(useEditorStore.getState().scene),
  reopen: (content: string) => useEditorStore.getState().loadSceneFromContent(content, '表面箭头重开.scene.json'),
  current: () => { const state = useEditorStore.getState().scene; return state.entities[state.selectedEntityId ?? state.entityIds[0]]; },
  visual: () => arrows().map(mesh => ({ name: mesh.name, enabled: mesh.isEnabled(), ready: mesh.isReady(true),
    vertices: mesh.getTotalVertices(), material: mesh.material?.getClassName(),
    uniforms: (mesh.material as unknown as { _floats: Record<string, number> })._floats,
    bounds: { min: mesh.getBoundingInfo().boundingBox.minimumWorld.asArray(), max: mesh.getBoundingInfo().boundingBox.maximumWorld.asArray() } })),
  setOccluder: (enabled: boolean) => {
    if (enabled && (!occluder || occluder.isDisposed())) {
      occluder = MeshBuilder.CreateBox('surface-arrow-occlusion-fixture', { width: 2, height: .8, depth: 1.3 }, scene()!);
      occluder.position.y = .45;
      const material = new StandardMaterial('occlusion-fixture-material', scene()!);
      material.disableLighting = true; material.emissiveColor = Color3.FromHexString('#c88b4c');
      occluder.material = material;
    }
    occluder?.setEnabled(enabled);
  },
  dispose: () => root.unmount(),
} });
