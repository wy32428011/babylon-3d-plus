import React from 'react';
import { createRoot } from 'react-dom/client';
import { ArcRotateCamera, EngineStore, Vector3 } from '@babylonjs/core';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { InspectorPanel } from '../../src/editor/panels/InspectorPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { getScenePreparationSnapshot } from '../../src/editor/loading/scenePreparationProgress';
import { createAutoPatrolEntity, createEmptySceneDocument, createMeshEntity } from '../../src/editor/model/SceneDocument';
import { getAutoPatrolWaypointWorldPose, getSceneCameraPosition } from '../../src/editor/model/autoPatrolInspection';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import '../../src/styles/global.css';

const fixture = createEmptySceneDocument('自动巡检当前视角验收');
fixture.sceneSettings.shadows.enabled = false;
const route = createAutoPatrolEntity({ x: 10, y: 3, z: -5 });
route.components.transform.rotation = { x: 0.12, y: 0.7, z: -0.08 };
const building = createMeshEntity('cube', { x: 0, y: 3, z: 0 });
building.components.transform.scale = { x: 6, y: 6, z: 4 };
const marker = createMeshEntity('cube', { x: 8, y: 5, z: -5 });
marker.components.transform.scale = { x: 3, y: 10, z: 3 };
marker.components.meshRenderer!.materialColor = '#e88c39';
for (const entity of [building, marker, route]) {
  fixture.entities[entity.id] = entity;
  fixture.entityIds.push(entity.id);
}
useEditorStore.getState().loadSceneFromContent(serializeScene(fixture), '巡检取景.scene.json');
useEditorStore.getState().selectEntity(route.id);

const root = createRoot(document.getElementById('root')!);
root.render(<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 420px', height: '100vh' }}>
  <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) 230px', minHeight: 0 }}>
    <SceneViewPanel /><ProjectPanel />
  </div>
  <aside style={{ overflow: 'auto', padding: 12 }}><InspectorPanel /></aside>
</div>);

function camera(): ArcRotateCamera | undefined {
  return EngineStore.Instances.flatMap(engine => engine.scenes)
    .find(scene => scene.activeCamera?.name === 'EditorCamera')?.activeCamera as ArcRotateCamera | undefined;
}

function snapshot() {
  const current = camera()!;
  const matrix = Array.from(current.getViewMatrix(true).m);
  return {
    position: { x: current.position.x, y: current.position.y, z: current.position.z },
    target: { x: current.target.x, y: current.target.y, z: current.target.z },
    alpha: current.alpha, beta: current.beta, radius: current.radius,
    matrix, projection: Array.from(current.getProjectionMatrix(true).m),
  };
}

Object.assign(window, { autoPatrolCaptureHarness: {
  store: useEditorStore,
  camera,
  snapshot,
  preparation: getScenePreparationSnapshot,
  routeId: route.id,
  waypoints: () => {
    const entity = useEditorStore.getState().scene.entities[route.id];
    return entity.components.autoPatrol!.waypoints.map(waypoint => {
      const pose = getAutoPatrolWaypointWorldPose(waypoint, entity.components.transform);
      return { ...waypoint, world: { ...pose, position: getSceneCameraPosition(pose) } };
    });
  },
  setPose: (pose: { alpha: number; beta: number; radius: number; target: { x: number; y: number; z: number } }) => {
    const current = camera()!;
    current.setTarget(new Vector3(pose.target.x, pose.target.y, pose.target.z));
    current.alpha = pose.alpha; current.beta = pose.beta; current.radius = pose.radius;
    current.inertialAlphaOffset = current.inertialBetaOffset = current.inertialRadiusOffset = 0;
    current.inertialPanningX = current.inertialPanningY = 0;
  },
  save: () => serializeScene(useEditorStore.getState().scene),
  reopen: (content: string) => {
    useEditorStore.getState().loadSceneFromContent(content, '巡检取景.scene.json');
    useEditorStore.getState().selectEntity(route.id);
  },
  dispose: () => root.unmount(),
} });
