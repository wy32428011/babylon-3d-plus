import assert from 'node:assert/strict';
import test from 'node:test';

import { bindSceneModelSelectionPointer } from '../../src/shared/sceneModelSelectionPointer.ts';

function createPointerEvent(
  type: string,
  input: Partial<{
    pointerId: number;
    button: number;
    buttons: number;
    clientX: number;
    clientY: number;
    isPrimary: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  }> = {},
): Event {
  const event = new Event(type);
  Object.defineProperties(event, {
    pointerId: { value: input.pointerId ?? 1 },
    button: { value: input.button ?? 0 },
    buttons: { value: input.buttons ?? (type === 'pointerup' ? 0 : 1) },
    clientX: { value: input.clientX ?? 10 },
    clientY: { value: input.clientY ?? 20 },
    isPrimary: { value: input.isPrimary ?? true },
    ctrlKey: { value: input.ctrlKey ?? false },
    metaKey: { value: input.metaKey ?? false },
  });
  return event;
}

test('Viewer 短按在释放坐标触发选择且不触发相机手动接管', () => {
  const canvas = new EventTarget();
  const clicks: unknown[] = [];
  let dragCount = 0;
  const cleanup = bindSceneModelSelectionPointer(canvas, {
    clickTolerancePx: 4,
    onSelectionClick: (result) => clicks.push(result),
    onDragStarted: () => { dragCount += 1; },
  });

  canvas.dispatchEvent(createPointerEvent('pointerdown', { clientX: 100, clientY: 200 }));
  canvas.dispatchEvent(createPointerEvent('pointerup', { clientX: 102, clientY: 201 }));

  assert.deepEqual(clicks, [{ clientX: 102, clientY: 201, toggleSelection: false }]);
  assert.equal(dragCount, 0);
  cleanup();
});

test('Viewer 拖拽越过阈值只通知一次手动接管且不会触发选择', () => {
  const canvas = new EventTarget();
  let clickCount = 0;
  let dragCount = 0;
  const cleanup = bindSceneModelSelectionPointer(canvas, {
    clickTolerancePx: 4,
    onSelectionClick: () => { clickCount += 1; },
    onDragStarted: () => { dragCount += 1; },
  });

  canvas.dispatchEvent(createPointerEvent('pointerdown', { clientX: 10, clientY: 10 }));
  canvas.dispatchEvent(createPointerEvent('pointermove', { clientX: 20, clientY: 10 }));
  canvas.dispatchEvent(createPointerEvent('pointermove', { clientX: 30, clientY: 10 }));
  canvas.dispatchEvent(createPointerEvent('pointerup', { clientX: 30, clientY: 10 }));

  assert.equal(clickCount, 0);
  assert.equal(dragCount, 1);
  cleanup();
});

test('清理绑定后不再处理选择事件', () => {
  const canvas = new EventTarget();
  let clickCount = 0;
  const cleanup = bindSceneModelSelectionPointer(canvas, {
    clickTolerancePx: 4,
    onSelectionClick: () => { clickCount += 1; },
    onDragStarted: () => {},
  });
  cleanup();

  canvas.dispatchEvent(createPointerEvent('pointerdown'));
  canvas.dispatchEvent(createPointerEvent('pointerup'));
  assert.equal(clickCount, 0);
});

