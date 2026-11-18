import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { AssetContainer, MeshBuilder, NullEngine, Scene, SceneLoader } from '@babylonjs/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { hasManualRoamSpawnEntity } from '../../src/editor/model/manualRoamSpawn.ts';
import { sanitizeManualRoamSpawnPose } from '../../src/runtime/roam/manualRoamCore.ts';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';

const modules = await createP4SsrTestModules([
  '/src/editor/assets/AssetDatabase.ts',
  '/src/editor/panels/scene-view/useSceneAssetDropHandler.ts',
  '/src/editor/panels/scene-view/SceneViewportOverlays.tsx',
  '/src/editor/model/SceneDocument.ts',
  '/src/runtime/roam/ManualRoamRuntime.ts',
  '/src/runtime/babylon/SceneRuntime.ts',
]);
after(() => modules.close());

const [
  projectLibrarySource,
  projectPanelSource,
  sceneViewSource,
  playerSource,
  spawnMarkerRuntimeSource,
  roamRuntimeSource,
  roamCollisionPolicySource,
] = await Promise.all([
  readFile(new URL('../../src/editor/assets/projectLibrary.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/editor/panels/SceneViewPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/player/PlayerApp.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/runtime/babylon/EditorManualRoamSpawnRuntime.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../src/runtime/roam/ManualRoamRuntime.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../src/runtime/roam/manualRoamCollisionPolicy.ts', import.meta.url), 'utf8'),
]);

function assertSourceMatches(source: string, pattern: RegExp, message: string): void {
  assert.equal(pattern.test(source), true, message);
}

test('出生姿态只接受有限世界坐标，并归一化初始水平朝向', () => {
  const normalized = sanitizeManualRoamSpawnPose({
    position: { x: 12, y: 1.25, z: -4 },
    yaw: Math.PI * 3,
  });
  assert.deepEqual(normalized, {
    position: { x: 12, y: 1.25, z: -4 },
    yaw: -Math.PI,
  });

  assert.equal(sanitizeManualRoamSpawnPose(null), null);
  assert.equal(sanitizeManualRoamSpawnPose({
    position: { x: Number.NaN, y: 0, z: 0 },
    yaw: 0,
  }), null);
  assert.equal(sanitizeManualRoamSpawnPose({
    position: { x: 0, y: 0, z: 0 },
    yaw: Number.POSITIVE_INFINITY,
  }), null);
});

test('项目库中的手动漫游条目可点击并可拖放到编辑场景', async (t) => {
  assertSourceMatches(
    projectLibrarySource,
    /name:\s*'手动漫游'[^\n]*builtIn:\s*\{\s*kind:\s*'manual-roam-spawn'\s*\}/,
    '项目库应把“手动漫游”声明为 manual-roam-spawn 内置资源。',
  );
  assertSourceMatches(
    projectPanelSource,
    /if \(item\.builtIn\.kind === 'manual-roam-spawn'\) \{\s*createManualRoamSpawn\(\)/,
    '点击资源卡片应创建或选中出生点。',
  );
  assert.match(projectPanelSource, /setData\(BUILT_IN_ASSET_DRAG_MIME_TYPE, encodeBuiltInAssetDragPayload\(item\.builtIn\)\)/);
  assert.match(sceneViewSource, /\{[^}]*\bhandleCanvasDrop\s*\}\s*=\s*useSceneAssetDropHandler\(/);
  assert.match(sceneViewSource, /onDrop=\{handleCanvasDrop\}/);

  const { BUILT_IN_ASSET_DRAG_MIME_TYPE: mime, encodeBuiltInAssetDragPayload } =
    await modules.ssrLoadModule('/src/editor/assets/AssetDatabase.ts');
  const { useSceneAssetDropHandler } =
    await modules.ssrLoadModule('/src/editor/panels/scene-view/useSceneAssetDropHandler.ts');
  const payload = encodeBuiltInAssetDragPayload({ kind: 'manual-roam-spawn' });
  const groundPoint = { x: 12, y: 1.25, z: -4 };
  const pick = t.mock.fn(() => groundPoint);
  const place = t.mock.fn();
  const { handleCanvasDrop } = useSceneAssetDropHandler({
    isRuntimePreview: false,
    runtimeRef: { current: { getGroundPointAtCanvasPoint: pick } },
    clickSnapshotRef: { current: null },
    createManualRoamSpawn: place,
  });
  const canvas = {};
  handleCanvasDrop({
    clientX: 93, clientY: 41, currentTarget: canvas, preventDefault() {},
    dataTransfer: { types: [mime], getData: (type: string) => type === mime ? payload : '' },
  });
  assert.deepEqual(pick.mock.calls.map(call => call.arguments), [[93, 41, canvas]]);
  assert.deepEqual(place.mock.calls.map(call => call.arguments), [[groundPoint]], '拖放必须使用拾取的世界坐标');
});

test('没有手动漫游 POI 时运行预览和 Viewer 不显示漫游功能', async () => {
  assertSourceMatches(
    sceneViewSource,
    /const hasManualRoamSpawn = useMemo\(\s*\(\) => hasManualRoamSpawnEntity\(\{\s*entityIds: sceneEntityIds, entities: sceneEntities\s*\}\)/,
    '编辑器应根据当前场景实体判断是否开放手动漫游。',
  );
  assert.match(sceneViewSource, /<SceneViewportOverlays\b[^>]*\bhasManualRoamSpawn\b/);
  const { SceneViewportOverlays } = await modules.ssrLoadModule('/src/editor/panels/scene-view/SceneViewportOverlays.tsx');
  const { createInitialManualRoamSnapshot } = await modules.ssrLoadModule('/src/runtime/roam/ManualRoamRuntime.ts');
  const { createEmptySceneDocument, createManualRoamSpawnEntity } =
    await modules.ssrLoadModule('/src/editor/model/SceneDocument.ts');
  const sceneDocument = createEmptySceneDocument();
  const renderOverlays = (isRuntimePreview: boolean) => renderToStaticMarkup(createElement(SceneViewportOverlays, {
    isRuntimePreview, sceneDocument, hasManualRoamSpawn: hasManualRoamSpawnEntity(sceneDocument),
    manualRoamSnapshot: createInitialManualRoamSnapshot(), opening: { active: false },
    hierarchySelectionIds: [], autoPatrolRoutes: [], viewportCamera: null, cameraOrientation: 'orbit',
  }));
  const roamPanel = /<section\b[^>]*aria-label="手动漫游"/;
  assert.doesNotMatch(renderOverlays(true), roamPanel, '空场景运行预览不显示漫游面板');
  const spawn = createManualRoamSpawnEntity();
  sceneDocument.entityIds.push(spawn.id);
  sceneDocument.entities[spawn.id] = spawn;
  assert.match(renderOverlays(true), roamPanel, '放入出生点后运行预览显示漫游面板');
  assert.doesNotMatch(renderOverlays(false), roamPanel, '回到编辑态后隐藏运行面板');

  assertSourceMatches(
    playerSource,
    /const sceneHasManualRoamSpawn = hasManualRoamSpawnEntity\(sceneDocument\);\s*if \(!disposed\) setHasManualRoamSpawn\(sceneHasManualRoamSpawn\)/,
    'Viewer 应按发布场景出生点判断是否开放手动漫游。',
  );
  assertSourceMatches(
    playerSource,
    /allowCameraControl && sceneHasManualRoamSpawn\)\s*\{\s*manualRoam = new ManualRoamRuntime\(/,
    'Viewer 没有手动漫游 POI 时不应创建漫游运行时。',
  );
  assertSourceMatches(
    playerSource,
    /allowCameraControl && hasManualRoamSpawn\s*\?\s*\(\s*<ManualRoamControls\b/,
    'Viewer 只有摆放手动漫游 POI 后才显示漫游面板。',
  );
});

test('编辑器和 Viewer 都把场景出生姿态传给手动漫游运行时', () => {
  assertSourceMatches(
    sceneViewSource,
    /resolveManualRoamSpawnPose/,
    '编辑器应解析场景中的漫游出生点。',
  );
  assertSourceMatches(
    sceneViewSource,
    /new ManualRoamRuntime\(\{[\s\S]*?resolveSpawnPose:\s*\(\)\s*=>\s*resolveManualRoamSpawnPose\(/,
    '编辑器应给手动漫游运行时传入最新出生姿态解析器。',
  );
  assertSourceMatches(
    playerSource,
    /resolveManualRoamSpawnPose/,
    'Viewer 应解析发布场景中的漫游出生点。',
  );
  assertSourceMatches(
    playerSource,
    /new ManualRoamRuntime\(\{[\s\S]*?resolveSpawnPose:\s*\(\)\s*=>\s*resolveManualRoamSpawnPose\(/,
    'Viewer 应给手动漫游运行时传入发布场景的出生姿态解析器。',
  );
});

test('每次启用漫游优先使用显式出生姿态，非法姿态仍可回退相机推导', () => {
  assertSourceMatches(
    roamRuntimeSource,
    /resolveSpawnPose\?:\s*\(\)\s*=>/,
    '运行时选项应支持动态解析出生姿态。',
  );
  assertSourceMatches(
    roamRuntimeSource,
    /return sanitizeManualRoamSpawnPose\(this\.options\.resolveSpawnPose\(\)\)/,
    '运行时应在使用场景出生姿态前执行有限值清洗。',
  );
  assertSourceMatches(
    roamRuntimeSource,
    /setEnabled\(enabled: boolean\): void \{[\s\S]*?if \(enabled\)[\s\S]*?resolveExplicitSpawnPose\(\)[\s\S]*?initializeExplicitSpawn\([\s\S]*?ensureSpawnInitialized\(/,
    '每次启用手动漫游都应优先解析显式出生姿态，无有效配置时再回退相机。',
  );
  assertSourceMatches(
    roamRuntimeSource,
    /initializeExplicitSpawn\(pose:[\s\S]*?spawnPosition[\s\S]*?spawnYaw[\s\S]*?collider\.position/,
    '显式出生姿态应同时更新复位目标和角色碰撞体。',
  );
});

test('编辑态出生点辅助人物纳入 SceneRuntime，并在运行预览和 Viewer 中隐藏', async (t) => {
  assertSourceMatches(
    playerSource,
    /runtime\.disableEditorManualRoamSpawnMarkers\(\);[^}]*?runtime\.sync\(sceneDocument\)/,
    'Viewer 首次同步场景前应永久禁用编辑辅助人物。',
  );
  const { SceneRuntime } = await modules.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');
  const { createEmptySceneDocument, createManualRoamSpawnEntity } =
    await modules.ssrLoadModule('/src/editor/model/SceneDocument.ts');
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const runtime = new SceneRuntime(scene);
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  const spawn = createManualRoamSpawnEntity({ x: 1, y: 2, z: 3 });
  spawn.components.manualRoamSpawn.avatar = { name: '人物', sourcePath: 'avatar.glb', sourceUrl: 'avatar.glb' };
  const document = { ...createEmptySceneDocument(), entityIds: [spawn.id], entities: { [spawn.id]: spawn } };
  const avatar = MeshBuilder.CreateBox('spawn-avatar', {}, scene);
  const container = new AssetContainer(scene);
  container.meshes.push(avatar);
  container.rootNodes.push(avatar);
  container.removeAllFromScene();
  const load = t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => container);

  runtime.sync(document);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(load.mock.callCount(), 1);
  assert.ok(scene.meshes.includes(avatar) && avatar.isEnabled() && avatar.isPickable);
  runtime.beginTelemetryPreview();
  assert.equal(avatar.isEnabled(), false, '进入运行预览后应隐藏编辑辅助人物');
  assert.equal(avatar.isPickable, false);
  runtime.endTelemetryPreview();
  assert.ok(avatar.isEnabled() && avatar.isPickable, '回到编辑态应恢复同一辅助人物');

  runtime.disableEditorManualRoamSpawnMarkers();
  runtime.sync(document);
  assert.ok(avatar.isDisposed());
  assert.equal(runtime.getGizmoTargetByEntityId(spawn.id), null);
  assert.equal(load.mock.callCount(), 1, 'Viewer 禁用后再次同步不能重建辅助人物');
  assertSourceMatches(
    spawnMarkerRuntimeSource,
    /isComplete\(entity: Entity\): boolean \{\s*if \(!this\.editorEnabled\) return !this\.entries\.has\(entity\.id\);/,
    'Viewer 永久禁用辅助人物后，无残留条目应视为运行时同步已完成。',
  );
});

test('编辑态出生点辅助人物不会参与手动漫游静态碰撞', () => {
  assertSourceMatches(
    roamCollisionPolicySource,
    /metadata\?\.editorManualRoamSpawn/,
    '手动漫游碰撞注册应排除编辑态出生点辅助人物。',
  );
});

test('辅助人物归一化不会原地修改 Gizmo 根节点的缓存世界矩阵', () => {
  assertSourceMatches(
    spawnMarkerRuntimeSource,
    /const inverseWorld = node\.getWorldMatrix\(\)\.clone\(\)\.invert\(\);/,
    '计算人物局部包围盒时必须克隆世界矩阵后再求逆。',
  );
});

test('辅助人物聚焦包围盒排除 GLB 的零顶点根网格', () => {
  const methodBody = spawnMarkerRuntimeSource.match(
    /getWorldBoundsMeshes\(entityId: string\): AbstractMesh\[\] \{([\s\S]*?)\n  \}/,
  )?.[1];
  assert.ok(methodBody, '应保留辅助人物世界包围盒网格解析方法。');
  assert.match(
    methodBody,
    /\.filter\(\(mesh\) =>[\s\S]*?mesh\.getTotalVertices\(\)\s*>\s*0/,
    '场景聚焦只能使用有实际几何的辅助人物网格，避免零顶点根节点把相机拉远。',
  );
});
