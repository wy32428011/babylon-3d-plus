import React from 'react';
import { createRoot } from 'react-dom/client';
import { ArcRotateCamera, EngineStore, Matrix, Vector3 } from '@babylonjs/core';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { EffectPathDrawingControls } from '../../src/editor/panels/EffectPathDrawingControls';
import { getEffectPathDrawing } from '../../src/editor/model/effectPathDrawing';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { createEmptySceneDocument } from '../../src/editor/model/SceneDocument';
import { createDefaultPoiEffectComponent } from '../../src/editor/model/poiEffect';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import type { PoiEffectKind } from '../../src/editor/model/components';
import '../../src/styles/global.css';

const documentModel = createEmptySceneDocument('特效路径绘制验收');
documentModel.mqttConfig.enabled = true; documentModel.mqttConfig.simulatorEnabled = true;
useEditorStore.getState().loadSceneFromContent(serializeScene(documentModel), 'effect-drawing.scene.json');
useEditorStore.getState().createPoiEffect('flow-path');
const entityId = useEditorStore.getState().scene.selectedEntityId!;
const before = useEditorStore.getState().scene.entities[entityId].components.transform;
useEditorStore.getState().commitEntityTransform(entityId, before, { position: { x: 3, y: 0, z: -2 }, rotation: { x: 0, y: .7, z: 0 }, scale: { x: 2, y: 1, z: .5 } });
function Controls() {
  const state = useEditorStore();
  const component = state.scene.entities[state.scene.selectedEntityId!]?.components.poiEffect;
  return <aside style={{ padding: 20, overflow: 'auto' }}><h2>绘制属性</h2>{component ? <EffectPathDrawingControls entityId={state.scene.selectedEntityId!} component={component} disabled={state.runtimeMode !== 'edit'} onChange={(next, label) => state.updateSelectedPoiEffect(next, label)} /> : <p>尚未选择特效</p>}</aside>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', height: '100vh' }}><SceneViewPanel performanceHudVisible={false} /><Controls /></div>);
const scene = () => EngineStore.Instances.flatMap(engine => engine.scenes).find(scene => scene.transformNodes.some(node => node.name === `${entityId}_poiEffectRoot`));
const effectRoot = () => scene()?.getTransformNodeByName(`${entityId}_poiEffectRoot`);
Object.assign(window, { effectDrawingHarness: {
  store: useEditorStore, drawing: getEffectPathDrawing, entityId, scene, effectRoot,
  current: () => useEditorStore.getState().scene.entities[entityId]?.components.poiEffect,
  setKind: (kind: PoiEffectKind) => useEditorStore.getState().updateSelectedPoiEffect(createDefaultPoiEffectComponent(kind), '切换验收特效'),
  camera: () => { const camera = scene()?.activeCamera as ArcRotateCamera; camera.setTarget(new Vector3(0, 0, 0)); camera.alpha = -Math.PI / 2; camera.beta = .45; camera.radius = 30; },
  project: (point: { x: number; y: number; z: number }) => {
    const s = scene()!, engine = s.getEngine(); const camera = s.activeCamera!;
    const p = Vector3.Project(new Vector3(point.x, point.y, point.z), Matrix.Identity(), s.getTransformMatrix(), camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()));
    const rect = engine.getRenderingCanvas()!.getBoundingClientRect();
    return { x: rect.left + p.x / engine.getRenderWidth() * rect.width, y: rect.top + p.y / engine.getRenderHeight() * rect.height };
  },
  local: (point: { x: number; y: number; z: number }) => Vector3.TransformCoordinates(new Vector3(point.x, point.y, point.z), effectRoot()!.computeWorldMatrix(true).clone().invert()).asArray(),
  previewCount: () => scene()?.meshes.filter(mesh => mesh.metadata?.effectPathDrawing).length ?? 0,
  reopen: () => useEditorStore.getState().loadSceneFromContent(serializeScene(useEditorStore.getState().scene), 'effect-drawing-reopened.scene.json'),
  dispose: () => root.unmount(),
} });
