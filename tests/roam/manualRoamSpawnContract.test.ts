import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { sanitizeManualRoamSpawnPose } from '../../src/runtime/roam/manualRoamCore.ts';

const [
  projectLibrarySource,
  projectPanelSource,
  sceneViewSource,
  playerSource,
  runtimeSource,
  spawnMarkerRuntimeSource,
  roamRuntimeSource,
  roamCollisionPolicySource,
] = await Promise.all([
  readFile(new URL('../../src/editor/assets/projectLibrary.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/editor/panels/SceneViewPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/player/PlayerApp.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/runtime/babylon/SceneRuntime.ts', import.meta.url), 'utf8'),
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

test('项目库中的手动漫游条目可点击并可拖放到编辑场景', () => {
  assertSourceMatches(
    projectLibrarySource,
    /name:\s*'手动漫游'[\s\S]*?builtIn:\s*\{\s*kind:\s*'manual-roam-spawn'\s*\}/,
    '项目库应把“手动漫游”声明为 manual-roam-spawn 内置资源。',
  );
  assertSourceMatches(
    projectPanelSource,
    /createManualRoamSpawn/,
    '点击资源卡片应创建或选中出生点。',
  );
  assertSourceMatches(
    sceneViewSource,
    /builtInAsset\.kind === 'manual-roam-spawn'[\s\S]*?createManualRoamSpawn\(placementPosition\)/,
    '拖放资源卡片应按场景拾取坐标创建或移动出生点。',
  );
});

test('没有手动漫游 POI 时运行预览和 Viewer 不显示漫游功能', () => {
  assertSourceMatches(
    sceneViewSource,
    /hasManualRoamSpawnEntity\(sceneDocument\)/,
    '编辑器应按场景出生点判断是否开放手动漫游。',
  );
  assertSourceMatches(
    sceneViewSource,
    /isRuntimePreview && hasManualRoamSpawn \? \(/,
    '运行预览只有摆放手动漫游 POI 后才显示漫游面板。',
  );
  assertSourceMatches(
    playerSource,
    /hasManualRoamSpawnEntity\(sceneDocument\)/,
    'Viewer 应按发布场景出生点判断是否开放手动漫游。',
  );
  assertSourceMatches(
    playerSource,
    /allowCameraControl && sceneHasManualRoamSpawn/,
    'Viewer 没有手动漫游 POI 时不应创建漫游运行时。',
  );
  assertSourceMatches(
    playerSource,
    /allowCameraControl && hasManualRoamSpawn \? \(/,
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

test('编辑态出生点辅助人物纳入 SceneRuntime，并在运行预览和 Viewer 中隐藏', () => {
  assertSourceMatches(runtimeSource, /EditorManualRoamSpawnRuntime/, 'SceneRuntime 应同步编辑态出生点辅助人物。');
  assertSourceMatches(
    runtimeSource,
    /disableEditorManualRoamSpawnMarkers\(\): void/,
    'SceneRuntime 应提供 Viewer 永久隐藏辅助人物的接口。',
  );
  assertSourceMatches(
    runtimeSource,
    /beginTelemetryPreview\(\): void \{[\s\S]*?manualRoamSpawn/i,
    '进入运行预览时应隐藏编辑态出生点辅助人物。',
  );
  assertSourceMatches(
    runtimeSource,
    /endTelemetryPreview\(\): void \{[\s\S]*?manualRoamSpawn/i,
    '退出运行预览时应恢复编辑态出生点辅助人物。',
  );
  assertSourceMatches(
    playerSource,
    /disableEditorManualRoamSpawnMarkers\(\)/,
    'Viewer 应永久隐藏仅供编辑定位的辅助人物。',
  );
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
