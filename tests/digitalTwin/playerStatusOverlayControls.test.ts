import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindStatusOverlayPointerChordToggle,
  getStatusOverlayChordTransition,
  resolveInitialPlayerStatusOverlayVisibility,
  shouldShowPlayerStatusOverlay,
} from '../../src/player/statusOverlayControls.ts';

test('数字孪生发布 Viewer 默认隐藏运行状态层，普通部署仍遵循配置', () => {
  assert.equal(resolveInitialPlayerStatusOverlayVisibility(true, true), false);
  assert.equal(resolveInitialPlayerStatusOverlayVisibility(false, true), false);
  assert.equal(resolveInitialPlayerStatusOverlayVisibility(true, false), true);
  assert.equal(resolveInitialPlayerStatusOverlayVisibility(false, false), false);
});

test('鼠标左右键组合每次完整按压只触发一次状态层切换', () => {
  const primaryOnly = getStatusOverlayChordTransition(1, false);
  assert.deepEqual(primaryOnly, { chordPressed: false, shouldToggle: false });

  const firstChord = getStatusOverlayChordTransition(3, primaryOnly.chordPressed);
  assert.deepEqual(firstChord, { chordPressed: true, shouldToggle: true });

  const repeatedChordEvent = getStatusOverlayChordTransition(3, firstChord.chordPressed);
  assert.deepEqual(repeatedChordEvent, { chordPressed: true, shouldToggle: false });

  const releasedPrimary = getStatusOverlayChordTransition(2, repeatedChordEvent.chordPressed);
  assert.deepEqual(releasedPrimary, { chordPressed: false, shouldToggle: false });

  const secondChord = getStatusOverlayChordTransition(7, releasedPrimary.chordPressed);
  assert.deepEqual(secondChord, { chordPressed: true, shouldToggle: true });
});

test('加载和阻断信息始终可见，运行态仅在用户开启或发生异常时显示', () => {
  assert.equal(shouldShowPlayerStatusOverlay('loading', false, false), true);
  assert.equal(shouldShowPlayerStatusOverlay('blocked', false, false), true);
  assert.equal(shouldShowPlayerStatusOverlay('ready', false, false), false);
  assert.equal(shouldShowPlayerStatusOverlay('ready', true, false), true);
  assert.equal(shouldShowPlayerStatusOverlay('ready', false, true), true);
});

function createPointerEvent(type: string, buttons: number, pointerType = 'mouse'): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    buttons: { value: buttons },
    pointerType: { value: pointerType },
  });
  return event;
}

test('状态层绑定器通过 pointermove 捕获追加鼠标键并在释放后允许再次切换', () => {
  const canvas = new EventTarget();
  const windowTarget = new EventTarget();
  let toggleCount = 0;
  const cleanup = bindStatusOverlayPointerChordToggle(canvas, windowTarget, () => {
    toggleCount += 1;
  });

  canvas.dispatchEvent(createPointerEvent('pointerdown', 1));
  canvas.dispatchEvent(createPointerEvent('pointermove', 3));
  canvas.dispatchEvent(createPointerEvent('pointermove', 3));
  assert.equal(toggleCount, 1);

  const contextMenu = new Event('contextmenu', { cancelable: true });
  canvas.dispatchEvent(contextMenu);
  assert.equal(contextMenu.defaultPrevented, true);

  windowTarget.dispatchEvent(createPointerEvent('pointerup', 0));
  canvas.dispatchEvent(createPointerEvent('pointerdown', 2));
  canvas.dispatchEvent(createPointerEvent('pointermove', 3));
  assert.equal(toggleCount, 2);

  windowTarget.dispatchEvent(createPointerEvent('pointerup', 0));
  canvas.dispatchEvent(createPointerEvent('pointerdown', 1, 'touch'));
  canvas.dispatchEvent(createPointerEvent('pointermove', 3, 'touch'));
  assert.equal(toggleCount, 2);

  cleanup();
  canvas.dispatchEvent(createPointerEvent('pointermove', 3));
  assert.equal(toggleCount, 2);
});
