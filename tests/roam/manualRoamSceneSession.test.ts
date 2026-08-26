import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runtimeSource = await readFile(
  new URL('../../src/runtime/roam/ManualRoamRuntime.ts', import.meta.url),
  'utf8',
);
const sceneViewSource = await readFile(
  new URL('../../src/editor/panels/SceneViewPanel.tsx', import.meta.url),
  'utf8',
);

test('场景会话切换时结束手动漫游并使旧出生点失效', () => {
  assert.match(
    runtimeSource,
    /invalidateSpawn\(\): void \{[\s\S]*?this\.setEnabled\(false\)[\s\S]*?this\.spawnInitialized = false;[\s\S]*?this\.fallbackGroundRequired = false;/,
  );
  assert.match(
    sceneViewSource,
    /useEffect\(\(\) => \{[\s\S]*?manualRoamSceneSessionIdRef\.current[\s\S]*?manualRoamRef\.current\?\.invalidateSpawn\(\);[\s\S]*?\}, \[sceneSessionId\]\);/,
  );
});

test('运行时低频清理后来转为 thin instance 的原生碰撞登记', () => {
  assert.match(runtimeSource, /const COLLISION_MESH_RECONCILE_INTERVAL_MS = 180;/);
  assert.match(
    runtimeSource,
    /reconcileCollisionMeshes\(nowMs: number, force = false\): void \{[\s\S]*?this\.lastCollisionMeshReconcileMs = nowMs;[\s\S]*?this\.unregisterCollisionMesh\(mesh\);/,
  );
  assert.match(
    runtimeSource,
    /mesh instanceof Mesh[\s\S]*?mesh\.thinInstanceCount > 0/,
  );
  assert.match(runtimeSource, /metadata\?\.modelArraySourceEntityId/);
  assert.match(runtimeSource, /metadata\?\.manualRoamCollisionProxy/);
  assert.match(
    runtimeSource,
    /const refreshed = this\.collisionProxyPool\?\.sync\([\s\S]*?if \(refreshed && this\.fallbackGround\.isEnabled\(\)\) \{[\s\S]*?this\.disableFallbackGroundWhenSceneFloorIsReady\(\);/,
  );
});

test('备用地面跟随大坐标场景的相机目标定位', () => {
  assert.match(
    runtimeSource,
    /this\.fallbackGround\.position\.copyFromFloats\(\s*cameraTarget\.x,\s*cameraTarget\.y - 0\.002,\s*cameraTarget\.z,\s*\);/,
  );
});
