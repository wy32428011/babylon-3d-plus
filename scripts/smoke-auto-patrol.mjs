import assert from 'node:assert/strict';
import { ArcRotateCamera, Matrix, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { createServer } from 'vite';

const server = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
  ssr: { noExternal: ['@linkiez/dxf-renew'] },
});

function assertVectorClose(actual, expected, message) {
  assert.ok(actual, message);
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(actual[axis] - expected[axis]) <= 1e-6, `${message} ${axis}`);
  }
}

let editorStore;
let editorStoreSnapshot;
try {
  const { useEditorStore } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
  const {
    createEmptySceneDocument,
    createAutoPatrolEntity,
  } = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
  const {
    cloneAutoPatrolComponent,
  } = await server.ssrLoadModule('/src/editor/model/autoPatrol.ts');
  const { serializeScene, deserializeScene } = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
  const { SceneRuntime } = await server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');

  editorStore = useEditorStore;
  editorStoreSnapshot = useEditorStore.getState();
  const scene = createEmptySceneDocument('自动巡检 Smoke');
  useEditorStore.setState({
    scene,
    runtimeMode: 'edit',
    history: { undoStack: [], redoStack: [] },
    hierarchySelectionIds: [],
    selectedAutoPatrolWaypointId: null,
    autoPatrolCameraRequest: null,
    autoPatrolPlaybackRequest: null,
    logs: [],
  });

  useEditorStore.getState().createAutoPatrol({ x: 10, y: 0, z: -5 });
  let state = useEditorStore.getState();
  const firstRouteId = state.scene.selectedEntityId;
  assert.ok(firstRouteId);
  assert.equal(state.scene.entities[firstRouteId].name, '自动巡检');
  assert.deepEqual(state.scene.entities[firstRouteId].components.transform.scale, { x: 1, y: 1, z: 1 });

  const captures = [
    { alpha: 0.4, beta: 1.1, radius: 30, target: { x: 2, y: 3, z: 4 } },
    { alpha: 1.7, beta: 0.8, radius: 18, target: { x: 20, y: 6, z: -12 } },
  ];
  for (const pose of captures) {
    useEditorStore.getState().selectAutoPatrolWaypoint(null);
    useEditorStore.getState().requestAutoPatrolCapture();
    const request = useEditorStore.getState().autoPatrolCameraRequest;
    assert.equal(request?.kind, 'capture');
    useEditorStore.getState().consumeAutoPatrolCameraRequest(request.id, pose);
  }

  state = useEditorStore.getState();
  let firstComponent = state.scene.entities[firstRouteId].components.autoPatrol;
  assert.equal(firstComponent.waypoints.length, 2);
  assert.equal(state.selectedAutoPatrolWaypointId, firstComponent.waypoints[1].id);

  const overwriteWaypointId = firstComponent.waypoints[0].id;
  firstComponent = {
    ...firstComponent,
    waypoints: firstComponent.waypoints.map((waypoint, index) => index === 0
      ? { ...waypoint, travelDurationSeconds: 3, dwellSeconds: 2 }
      : waypoint),
  };
  useEditorStore.getState().updateSelectedAutoPatrol(firstComponent, '设置覆盖保留时间');
  useEditorStore.getState().selectAutoPatrolWaypoint(overwriteWaypointId);
  useEditorStore.getState().requestAutoPatrolCapture();
  const overwriteRequest = useEditorStore.getState().autoPatrolCameraRequest;
  assert.equal(overwriteRequest?.kind, 'capture');
  useEditorStore.getState().consumeAutoPatrolCameraRequest(
    overwriteRequest.id,
    { alpha: 2.1, beta: 1.2, radius: 24, target: { x: -8, y: 4, z: 16 } },
  );
  firstComponent = useEditorStore.getState().scene.entities[firstRouteId].components.autoPatrol;
  assert.equal(firstComponent.waypoints.length, 2);
  assert.equal(firstComponent.waypoints[0].id, overwriteWaypointId);
  assert.equal(firstComponent.waypoints[0].travelDurationSeconds, 3);
  assert.equal(firstComponent.waypoints[0].dwellSeconds, 2);

  useEditorStore.getState().updateSelectedAutoPatrol({ ...firstComponent, autoStart: true }, '设置自动启动');
  assert.equal(useEditorStore.getState().scene.entities[firstRouteId].components.autoPatrol.autoStart, true);
  let configuredFirstComponent = useEditorStore.getState().scene.entities[firstRouteId].components.autoPatrol;
  useEditorStore.getState().updateSelectedAutoPatrol({ ...configuredFirstComponent, enabled: false }, '停用自动启动路线');
  assert.equal(useEditorStore.getState().scene.entities[firstRouteId].components.autoPatrol.autoStart, true);
  configuredFirstComponent = useEditorStore.getState().scene.entities[firstRouteId].components.autoPatrol;
  useEditorStore.getState().updateSelectedAutoPatrol({ ...configuredFirstComponent, enabled: true }, '恢复自动启动路线');

  useEditorStore.getState().copySelectedEntities();
  useEditorStore.getState().pasteEntityClipboard();
  state = useEditorStore.getState();
  const pastedRouteId = state.scene.selectedEntityId;
  assert.ok(pastedRouteId && pastedRouteId !== firstRouteId);
  assert.equal(state.scene.entities[pastedRouteId].components.autoPatrol.autoStart, false);
  assert.equal(state.scene.entities[pastedRouteId].components.autoPatrol.waypoints.length, 2);

  useEditorStore.getState().createAutoPatrol({ x: -20, y: 0, z: 4 });
  state = useEditorStore.getState();
  const secondRouteId = state.scene.selectedEntityId;
  const secondComponent = cloneAutoPatrolComponent(firstComponent, { disableAutoStart: true });
  useEditorStore.getState().updateSelectedAutoPatrol({ ...secondComponent, autoStart: true }, '切换自动启动路线');
  state = useEditorStore.getState();
  assert.equal(state.scene.entities[firstRouteId].components.autoPatrol.autoStart, false);
  assert.equal(state.scene.entities[secondRouteId].components.autoPatrol.autoStart, true);

  const selectedWaypointId = state.scene.entities[secondRouteId].components.autoPatrol.waypoints[0].id;
  useEditorStore.getState().selectAutoPatrolWaypoint(selectedWaypointId);
  useEditorStore.getState().deleteSelectedEntity();
  state = useEditorStore.getState();
  assert.equal(state.scene.entities[secondRouteId].components.autoPatrol.waypoints.length, 1);
  assert.equal(state.scene.entities[secondRouteId].components.autoPatrol.autoStart, true);
  useEditorStore.getState().undo();
  assert.equal(useEditorStore.getState().scene.entities[secondRouteId].components.autoPatrol.waypoints.length, 2);

  const content = serializeScene(useEditorStore.getState().scene);
  const parsed = JSON.parse(content);
  parsed.scene.entities[secondRouteId].components.transform.scale = { x: 5, y: 2, z: 8 };
  parsed.scene.entities[firstRouteId].components.autoPatrol.autoStart = true;
  parsed.scene.entities[secondRouteId].components.autoPatrol.autoStart = true;
  const restored = deserializeScene(JSON.stringify(parsed));
  assert.deepEqual(restored.entities[secondRouteId].components.transform.scale, { x: 1, y: 1, z: 1 });
  const autoStartRoutes = restored.entityIds.filter((entityId) => restored.entities[entityId]?.components.autoPatrol?.autoStart);
  assert.equal(autoStartRoutes.length, 1);

  const engine = new NullEngine({ renderWidth: 320, renderHeight: 240 });
  const babylonScene = new Scene(engine);
  babylonScene.activeCamera = new ArcRotateCamera('auto-patrol-smoke-camera', 0, 1, 10, Vector3.Zero(), babylonScene);
  const runtime = new SceneRuntime(babylonScene);
  try {
    const runtimeDocument = createEmptySceneDocument('自动巡检运行时 Smoke');
    const runtimeRoute = createAutoPatrolEntity({ x: 4, y: 2, z: 6 });
    runtimeRoute.components.autoPatrol = cloneAutoPatrolComponent(firstComponent, { disableAutoStart: true });
    runtimeDocument.entityIds = [runtimeRoute.id];
    runtimeDocument.entities = { [runtimeRoute.id]: runtimeRoute };
    runtimeDocument.selectedEntityId = runtimeRoute.id;
    runtime.sync(runtimeDocument);
    runtime.setAutoPatrolSelection(runtimeRoute.id, null);

    const bounds = runtime.getEntitiesWorldBounds([runtimeRoute.id]);
    assertVectorClose(bounds?.center, { x: 4, y: 2, z: 6 }, '巡检路线必须参与文件夹组包围盒');
    assert.equal(
      runtime.beginFolderGroupTranslation(
        [runtimeRoute.id],
        { [runtimeRoute.id]: runtimeRoute.components.transform.position },
      ),
      true,
    );
    assert.equal(runtime.updateFolderGroupTranslation({ x: 3, y: 0, z: 0 }), true);
    runtime.flushGroupTranslationPreview();
    assertVectorClose(
      runtime.getGizmoTargetByEntityId(runtimeRoute.id)?.position,
      { x: 7, y: 2, z: 6 },
      '文件夹组预览必须移动巡检路线运行时根节点',
    );
    runtime.cancelFolderGroupTranslation();
    assertVectorClose(
      runtime.getGizmoTargetByEntityId(runtimeRoute.id)?.position,
      { x: 4, y: 2, z: 6 },
      '取消文件夹组预览必须恢复巡检路线',
    );

    const rotationDelta = Matrix.RotationY(Math.PI / 2);
    assert.equal(
      runtime.beginFolderGroupRotation(
        [runtimeRoute.id],
        { [runtimeRoute.id]: runtimeRoute.components.transform },
      ),
      true,
    );
    assert.equal(runtime.updateFolderGroupRotation(Array.from(rotationDelta.m)), true);
    const rotatedTransforms = runtime.getFolderGroupRotationTransforms();
    assert.ok(rotatedTransforms?.[runtimeRoute.id]);
    const expectedRotatedPosition = Vector3.TransformCoordinates(
      new Vector3(4, 2, 6),
      rotationDelta,
    );
    assertVectorClose(
      rotatedTransforms[runtimeRoute.id].position,
      expectedRotatedPosition,
      '文件夹组旋转必须计算巡检路线最终 Transform',
    );
    assertVectorClose(
      runtime.getGizmoTargetByEntityId(runtimeRoute.id)?.position,
      expectedRotatedPosition,
      '文件夹组旋转预览必须更新巡检路线运行时根节点',
    );
    assert.ok(
      Math.abs(rotatedTransforms[runtimeRoute.id].rotation.y - Math.PI / 2) <= 1e-6,
      '文件夹组旋转必须更新巡检路线朝向',
    );
    runtime.cancelFolderGroupRotation();
    assertVectorClose(
      runtime.getGizmoTargetByEntityId(runtimeRoute.id)?.position,
      { x: 4, y: 2, z: 6 },
      '取消文件夹组旋转预览必须恢复巡检路线',
    );
  } finally {
    runtime.dispose();
    babylonScene.dispose();
    engine.dispose();
  }

  console.log(JSON.stringify({
    ok: true,
    firstRouteId,
    secondRouteId,
    routeCount: restored.entityIds.filter((entityId) => restored.entities[entityId]?.components.autoPatrol).length,
    waypointCount: restored.entities[secondRouteId].components.autoPatrol.waypoints.length,
  }, null, 2));
} finally {
  if (editorStore && editorStoreSnapshot) editorStore.setState(editorStoreSnapshot, true);
  await server.close();
}
