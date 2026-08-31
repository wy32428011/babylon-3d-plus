import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const playerSource = await readFile(new URL('../../src/player/PlayerApp.tsx', import.meta.url), 'utf8');

test('发布 Viewer 只在模型和环境真实结算后放行自动巡检', () => {
  assert.match(playerSource, /const autoPatrolStartGate = new DeferredAutoPatrolStartGate\(\)/);
  assert.match(
    playerSource,
    /const initialLoadGate = new PlayerInitialLoadGate\([\s\S]*?onSettled: \(\) => autoPatrolStartGate\.markReady\(\)/,
  );
  assert.match(playerSource, /const forceCompleteInitialLoad = \(\) => initialLoadGate\.forceComplete\(\)/);
  assert.match(playerSource, /initialLoadGate\.update\(progress\);\s*setModelLoadProgress\(progress\);/);
  assert.match(playerSource, /initialLoadGate\.startTracking\(\);\s*runtime\.sync\(sceneDocument\);/);
});

test('发布 Viewer 的自动配置、大屏命令和控制面板共用延迟启动门禁', () => {
  assert.match(
    playerSource,
    /const autoStartRoute = findAutoStartPatrolRoute\(patrolRoutes\);[\s\S]*?autoPatrolStartGate\.request\(/,
  );
  assert.match(
    playerSource,
    /startAutoPatrol: \(\) => \{[\s\S]*?autoPatrolStartGate\.request\(/,
  );
  assert.match(
    playerSource,
    /case 'start':[\s\S]*?autoPatrolStartGateRef\.current[\s\S]*?startGate\.request\(/,
  );
  assert.match(playerSource, /autoPatrolStartGate\.dispose\(\)/);
});

test('停止、手动漫游和历史回放会取消尚未执行的巡检启动', () => {
  assert.match(playerSource, /beginHistoryReplay[\s\S]*?cancelPending\(\)/);
  assert.match(playerSource, /startManualRoam:[\s\S]*?cancelPending\(\)/);
  assert.match(playerSource, /case 'stop':[\s\S]*?cancelPending\(\)/);
  assert.match(playerSource, /case 'emergency-stop':[\s\S]*?cancelPending\(\)/);
  assert.match(playerSource, /handleManualRoamEnabled[\s\S]*?cancelPending\(\)/);
});

test('大屏再次点击自动巡检会取消待启动任务并停止已运行巡检', () => {
  assert.match(
    playerSource,
    /startAutoPatrol: \(\) => \{[\s\S]*?if \(nextControl === null\) \{[\s\S]*?autoPatrolStartGate\.cancelPending\(\);[\s\S]*?autoPatrolPlayback\?\.stop\(\);[\s\S]*?return;/,
  );
  assert.match(
    playerSource,
    /autoPatrolStartGate\.request\(\(\) => \{[\s\S]*?openedDigitalTwinFloatingControlRef\.current !== 'auto-patrol'/,
  );
});
