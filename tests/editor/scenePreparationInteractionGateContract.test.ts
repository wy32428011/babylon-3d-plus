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
    /function handleWindowKeyDown\(event: KeyboardEvent\): void \{\s*if \(isScenePreparationActive\(\)\) \{\s*event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);\s*return;/,
  );
  assert.match(layoutSource, /window\.addEventListener\('keydown', handleWindowKeyDown, true\)/);
  assert.match(layoutSource, /window\.removeEventListener\('keydown', handleWindowKeyDown, true\)/);
  assert.match(
    sceneViewSource,
    /const handleKeyDown = \(event: KeyboardEvent\): void => \{\s*if \(isScenePreparationActive\(\)\) \{\s*event\.preventDefault\(\);\s*return;/,
  );
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
});
