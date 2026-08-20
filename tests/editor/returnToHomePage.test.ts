import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getReturnToHomePageBlockMessage,
  RETURN_TO_HOME_PAGE_LABEL,
  RETURN_TO_HOME_PAGE_UNSAVED_CONFIRM,
} from '../../src/editor/home/returnToHomePage.ts';

test('无忙碌任务时允许返回首页', () => {
  assert.equal(getReturnToHomePageBlockMessage({}), null);
});

test('忙碌任务会阻止返回首页，场景准备优先', () => {
  assert.match(getReturnToHomePageBlockMessage({ scenePreparationActive: true }) ?? '', /场景准备/);
  assert.match(getReturnToHomePageBlockMessage({ publishActive: true }) ?? '', /发布/);
  assert.match(getReturnToHomePageBlockMessage({ deploymentExportBusy: true }) ?? '', /导出/);
  assert.match(getReturnToHomePageBlockMessage({ cadImportActive: true }) ?? '', /CAD/);
  assert.match(
    getReturnToHomePageBlockMessage({
      scenePreparationActive: true,
      publishActive: true,
      deploymentExportBusy: true,
      cadImportActive: true,
    }) ?? '',
    /场景准备/,
  );
});

test('Toolbar、EditorLayout 和 App 接上返回首页入口', async () => {
  const [toolbarSource, layoutSource, appSource, cssSource] = await Promise.all([
    readFile(new URL('../../src/editor/ui/Toolbar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/editor/layout/EditorLayout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8'),
  ]);

  assert.match(toolbarSource, new RegExp(`aria-label=\\{RETURN_TO_HOME_PAGE_LABEL\\}`));
  assert.match(toolbarSource, /props\.onBackToHome\(\)/);
  assert.match(toolbarSource, /className="toolbar-button toolbar-home-button"/);
  assert.ok(
    toolbarSource.indexOf('toolbar-home-button') < toolbarSource.indexOf('toolbar-scroll'),
    '返回按钮必须固定在滚动区外',
  );

  assert.match(layoutSource, /onBackToHome=\{handleBackToHome\}/);
  assert.match(layoutSource, /getReturnToHomePageBlockMessage/);
  assert.match(layoutSource, /export function EditorLayout\(\{ onBackToHome \}: EditorLayoutProps\)/);

  assert.match(appSource, /<EditorLayout onBackToHome=\{\(\) => void handleBackToHome\(\)\} \/>/);
  assert.match(appSource, /setView\('home'\)/);
  assert.match(appSource, /stopRuntimePreview\(\)/);
  assert.match(appSource, /RETURN_TO_HOME_PAGE_UNSAVED_CONFIRM/);
  assert.equal(RETURN_TO_HOME_PAGE_LABEL, '返回首页');
  assert.match(RETURN_TO_HOME_PAGE_UNSAVED_CONFIRM, /未保存修改/);

  assert.match(cssSource, /\.toolbar-home-button \{/);
});
