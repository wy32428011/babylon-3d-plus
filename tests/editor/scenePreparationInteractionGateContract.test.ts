import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('场景准备期间拦截编辑器全局快捷键和场景视图键盘操作', async () => {
  const [layoutSource, sceneViewSource] = await Promise.all([
    readFile(new URL('../../src/editor/layout/EditorLayout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/editor/panels/SceneViewPanel.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(layoutSource, /isScenePreparationActive\(\)/);
  assert.match(
    layoutSource,
    /function handleWindowKeyDown\(event: KeyboardEvent\): void \{\s*if \(isScenePreparationActive\(\)\) \{[\s\S]*?event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);\s*return;/,
  );
  assert.match(layoutSource, /data-scene-loading-action/);
  assert.match(layoutSource, /\['Tab', 'Enter', ' '\]\.includes\(event\.key\)/);
  assert.match(layoutSource, /window\.addEventListener\('keydown', handleWindowKeyDown, true\)/);
  assert.match(layoutSource, /window\.removeEventListener\('keydown', handleWindowKeyDown, true\)/);
  assert.match(
    sceneViewSource,
    /const handleKeyDown = \(event: KeyboardEvent\): void => \{\s*if \(isScenePreparationActive\(\)\) \{[\s\S]*?event\.preventDefault\(\);\s*return;/,
  );
  assert.match(sceneViewSource, /event\.target\.closest\('\[data-scene-loading-action\]'\)/);
  assert.match(
    sceneViewSource,
    /const handleKeyDown = \(event: KeyboardEvent\): void => \{\s*if \(isScenePreparationActive\(\)\) return;\s*if \(event\.key !== 'Escape'\) return;/,
  );
});

test('场景准备蒙版声明忙碌状态并阻止键盘焦点进入底层编辑器', async () => {
  const [overlaySource, sharedMaskSource] = await Promise.all([
    readFile(
      new URL('../../src/editor/loading/ScenePreparationOverlay.tsx', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../../src/shared/ui/SceneLoadingMask.tsx', import.meta.url),
      'utf8',
    ),
  ]);

  assert.match(sharedMaskSource, /aria-busy="true"/);
  assert.match(overlaySource, /tabIndex=\{-1\}/);
  assert.match(overlaySource, /overlayRef\.current\?\.focus\(\)/);
  assert.match(overlaySource, /取消加载并返回首页/);
  assert.match(overlaySource, /state\.runtime\.forcedSettled && !transaction/);
  assert.match(overlaySource, /event\.key !== 'Tab'/);
  assert.match(overlaySource, /event\.preventDefault\(\); first\?\.focus\(\)/);
});
