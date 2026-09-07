import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { restorePlayerGlobalOverview } from '../../src/player/playerGlobalOverview.ts';

const playerSource = readFileSync(new URL('../../src/player/PlayerApp.tsx', import.meta.url), 'utf8');

test('全局概览按安全顺序关闭交互模式并恢复发布初始状态', () => {
  const calls: string[] = [];

  restorePlayerGlobalOverview({
    cancelPendingAutoPatrol: () => calls.push('cancel-pending-patrol'),
    stopHistoryReplay: () => calls.push('stop-history-replay'),
    stopAutoPatrol: () => calls.push('stop-auto-patrol'),
    disableManualRoam: () => calls.push('disable-manual-roam'),
    closeFloatingControls: () => calls.push('close-floating-controls'),
    cancelCameraTransition: () => calls.push('cancel-camera-transition'),
    clearSelection: () => calls.push('clear-selection'),
    resetStatusOverlay: () => calls.push('reset-status-overlay'),
    restoreInitialCamera: () => calls.push('restore-initial-camera'),
  });

  assert.deepEqual(calls, [
    'cancel-pending-patrol',
    'stop-history-replay',
    'stop-auto-patrol',
    'disable-manual-roam',
    'close-floating-controls',
    'cancel-camera-transition',
    'clear-selection',
    'reset-status-overlay',
    'restore-initial-camera',
  ]);
});

test('发布 Viewer 将全局概览接到完整初始态恢复链路', () => {
  assert.match(playerSource, /globalOverview: \(\) => restorePlayerGlobalOverview\(\{/);
  assert.match(playerSource, /cancelPendingAutoPatrol: \(\) => autoPatrolStartGate\.cancelPending\(\)/);
  assert.match(playerSource, /stopAutoPatrol: \(\) => autoPatrolPlayback\?\.stop\(\)/);
  assert.match(playerSource, /disableManualRoam: \(\) => manualRoamRuntime\?\.setEnabled\(false\)/);
  assert.match(playerSource, /closeFloatingControls: \(\) => updateOpenedDigitalTwinFloatingControl\(null\)/);
  assert.match(playerSource, /runtime\?\.clearLocalHighlight\(\);[\s\S]*?runtime\?\.clearExternalHighlight\(\);/);
  assert.match(playerSource, /applySavedSceneCameraView\(viewport!, sceneDocument\.sceneSettings\.camera/);
});
