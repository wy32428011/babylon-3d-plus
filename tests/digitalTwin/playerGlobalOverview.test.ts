import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { resolveInitialPlayerStatusOverlayVisibility } from '../../src/player/statusOverlayControls.ts';
import { evaluateSourceExpression, namedArrow } from '../helpers/playerContractTestHelpers.ts';
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
  const calls: unknown[] = [];
  const camera = { alpha: 1, beta: 2, radius: 3 };
  const viewport = { cancelCameraTransition: (reason: string) => calls.push(['camera-cancel', reason]) };
  const clearViewerSelection = evaluateSourceExpression(playerSource, namedArrow('clearViewerSelection'), {
    localHighlightedEntityIds: ['selected'],
    setViewerSelectedEntityIds: (ids: string[]) => calls.push(['selection', ids]),
    runtime: {
      setClickHighlightTrackExclusion: (ids: string[]) => calls.push(['exclusions', ids]),
      clearLocalHighlight: () => calls.push('local-clear'),
      clearExternalHighlight: () => calls.push('external-clear'),
    },
  });
  for (const digitalTwin of [true, false]) {
    calls.length = 0;
    const overview = evaluateSourceExpression(playerSource, namedArrow('globalOverview'), {
      restorePlayerGlobalOverview, clearViewerSelection, resolveInitialPlayerStatusOverlayVisibility,
      cancelOpeningForCommand: () => calls.push('opening-cancel'),
      autoPatrolStartGate: { cancelPending: () => calls.push('patrol-cancel') },
      pauseHistoryReplay: () => calls.push('history-stop'),
      autoPatrolPlayback: { stop: () => calls.push('patrol-stop') },
      manualRoamRuntime: { setEnabled: (value: boolean) => calls.push(['roam', value]) },
      updateOpenedDigitalTwinFloatingControl: (value: null) => calls.push(['control', value]),
      viewport, sceneDocument: { sceneSettings: { camera } },
      parsedConfig: { viewer: { showStatusOverlay: true }, digitalTwin },
      setChartMarkerError: (value: string) => calls.push(['error', value]),
      setStatusOverlayVisible: (value: boolean) => calls.push(['overlay', value]),
      applySavedSceneCameraView: (receivedViewport: unknown, receivedCamera: unknown, options: unknown) => {
        assert.equal(receivedViewport, viewport);
        assert.equal(receivedCamera, camera);
        calls.push(['camera-restore', options]);
      },
    });
    overview();
    assert.deepEqual(calls, ['opening-cancel', 'patrol-cancel', 'history-stop', 'patrol-stop',
      ['roam', false], ['control', null], ['camera-cancel', 'replaced'], ['selection', []],
      ['exclusions', []], 'local-clear', 'external-clear', ['error', ''], ['overlay', !digitalTwin],
      ['camera-restore', { animate: true, lockStandardOrientation: false }]]);
  }
});
