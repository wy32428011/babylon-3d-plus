import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  exitElementFullscreen,
  getFullscreenElement,
  isElementFullscreen,
  isOwnedFullscreenElement,
  requestElementFullscreen,
} from '../../src/shared/ui/elementFullscreen.ts';

function installDocumentMock(value: object | undefined): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, 'document');
  } else {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value,
    });
  }
  return () => {
    if (previous) {
      Object.defineProperty(globalThis, 'document', previous);
      return;
    }
    Reflect.deleteProperty(globalThis, 'document');
  };
}

test('requestElementFullscreen 优先使用标准 API', async () => {
  const calls: string[] = [];
  const element = {
    requestFullscreen: async () => {
      calls.push('standard');
    },
    webkitRequestFullscreen: () => {
      calls.push('webkit');
    },
  } as unknown as HTMLElement;

  await requestElementFullscreen(element);
  assert.deepEqual(calls, ['standard']);
});

test('requestElementFullscreen 在缺少标准 API 时回退 webkit', async () => {
  const calls: string[] = [];
  const element = {
    webkitRequestFullscreen: () => {
      calls.push('webkit');
    },
  } as unknown as HTMLElement;

  await requestElementFullscreen(element);
  assert.deepEqual(calls, ['webkit']);
});

test('getFullscreenElement 与 isElementFullscreen 读取标准全屏目标', () => {
  const element = { id: 'scene' } as unknown as Element;
  const restore = installDocumentMock({ fullscreenElement: element });
  try {
    assert.equal(getFullscreenElement(), element);
    assert.equal(isElementFullscreen(element), true);
    assert.equal(isElementFullscreen({ id: 'other' } as unknown as Element), false);
  } finally {
    restore();
  }
});

test('exitElementFullscreen 在没有全屏元素时直接结束', async () => {
  const restore = installDocumentMock({
    fullscreenElement: null,
    exitFullscreen: async () => {
      throw new Error('不应调用 exitFullscreen');
    },
  });
  try {
    await exitElementFullscreen();
  } finally {
    restore();
  }
});

test('exitElementFullscreen 只退出属于指定元素的系统全屏', async () => {
  const owned = { id: 'shell' } as unknown as HTMLElement;
  const foreign = { id: 'other' } as unknown as HTMLElement;
  let exited = false;
  const restore = installDocumentMock({
    fullscreenElement: foreign,
    exitFullscreen: async () => {
      exited = true;
    },
  });
  try {
    assert.equal(isOwnedFullscreenElement(owned), false);
    await exitElementFullscreen(owned);
    assert.equal(exited, false);
    await exitElementFullscreen(foreign);
    assert.equal(exited, true);
  } finally {
    restore();
  }
});

test('Toolbar、EditorLayout 和 Player 接上场景全屏入口', async () => {
  const [toolbarSource, layoutSource, layoutCss, globalCss, playerSource, playerCss] = await Promise.all([
    readFile(new URL('../../src/editor/ui/Toolbar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/editor/layout/EditorLayout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/editor/layout/EditorLayout.module.css', import.meta.url), 'utf8'),
    readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8'),
    readFile(new URL('../../src/player/PlayerApp.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/player/player.css', import.meta.url), 'utf8'),
  ]);

  assert.match(toolbarSource, /全屏显示场景 \(F11\)/);
  assert.match(toolbarSource, /onToggleSceneFullscreen/);
  assert.match(toolbarSource, /<FullscreenGlyph exit=\{props\.sceneFullscreen\} \/>/);
  assert.ok(
    toolbarSource.indexOf('onStopRuntimePreview') < toolbarSource.indexOf('onToggleSceneFullscreen'),
    '全屏按钮必须放在运行/停止控件附近',
  );

  assert.match(layoutSource, /useElementFullscreen\(editorShellRef, \{ fallbackToLayoutMaximize: true \}\)/);
  assert.match(layoutSource, /key === 'f11'/);
  assert.match(layoutSource, /hasVisibleEditorOverlay/);
  assert.match(layoutSource, /data-scene-fullscreen/);
  assert.match(layoutCss, /\.editorShellFullscreen/);
  assert.match(globalCss, /\[data-scene-fullscreen='true'\] \.scene-viewport/);

  assert.match(playerSource, /className="player-fullscreen-button"/);
  assert.match(playerSource, /useElementFullscreen\(playerRootRef\)/);
  assert.match(playerCss, /\.player-fullscreen-button/);
});
