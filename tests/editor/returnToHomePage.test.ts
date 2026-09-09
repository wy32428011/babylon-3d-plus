import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import {
  getReturnToHomePageBlockMessage,
  RETURN_TO_HOME_PAGE_LABEL,
  RETURN_TO_HOME_PAGE_UNSAVED_CONFIRM,
} from '../../src/editor/home/returnToHomePage.ts';

test('无忙碌任务时允许返回首页', () => {
  assert.equal(getReturnToHomePageBlockMessage({}), null);
});

test('真实返回处理：清理完成后重置场景；取消、发布阻断和清理失败均不离开', async () => {
  const source = await readFile(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  async function handleBackToHome(');
  const end = source.indexOf("\n  if (view === 'home')", start);
  assert.ok(start >= 0 && end > start);
  const method = stripTypeScriptTypes(source.slice(start, end));
  const events: string[] = [];
  let unsaved = false;
  let confirmed = true;
  let publishActive = false;
  let fail = false;
  let finish!: () => void;
  const back = runInNewContext(`(${method})`, {
    returningHomeRef: { current: false },
    window: {
      alert: () => events.push('alert'), confirm: () => confirmed,
      editorApi: {
        getDigitalTwinPublishContext: async () => ({ publishActive }),
        closeDataPlatformProject: async () => {
          events.push('close');
          if (fail) throw new Error('cleanup failed');
          await new Promise<void>((resolve) => { finish = resolve; });
        },
      },
    },
    getReturnToHomePageBlockMessage, RETURN_TO_HOME_PAGE_UNSAVED_CONFIRM,
    useEditorStore: { getState: () => ({
      hasUnsavedChanges: () => unsaved,
      stopRuntimePreview: () => events.push('stop'),
      resetSceneToBlank: () => events.push('reset'),
    }) },
    setView: (view: string) => events.push(view),
  }) as (before?: () => Promise<void>) => Promise<void>;

  const pending = back(async () => { events.push('before'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['before', 'close']);
  finish();
  await pending;
  assert.deepEqual(events, ['before', 'close', 'stop', 'reset', 'home']);
  events.length = 0;
  unsaved = true; confirmed = false;
  await back();
  assert.deepEqual(events, []);
  confirmed = true; publishActive = true;
  await back();
  assert.deepEqual(events, ['alert']);
  events.length = 0;
  publishActive = false; fail = true;
  await assert.rejects(back(), /cleanup failed/);
  assert.deepEqual(events, ['close']);
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

  assert.match(layoutSource, /onBackToHome=\{\(\) => void handleBackToHome\(\)\}/);
  assert.match(layoutSource, /getReturnToHomePageBlockMessage/);
  assert.match(layoutSource, /export function EditorLayout\(\{ onBackToHome \}: EditorLayoutProps\)/);

  assert.match(appSource, /<EditorLayout onBackToHome=\{handleBackToHome\} \/>/);
  assert.ok(appSource.indexOf('if (!confirmed) return;', appSource.indexOf('async function handleBackToHome')) < appSource.indexOf('await beforeLeave?.();'));
  assert.match(layoutSource, /scenePreparationActive: isScenePreparationActive\(\) && !cancelRuntimeLoading/);
  assert.match(layoutSource, /cancelProjectLoading\(window.editorApi\?\.cancelDataPlatformProjectLoading\)/);
  assert.match(appSource, /setView\('home'\)/);
  assert.match(appSource, /stopRuntimePreview\(\)/);
  assert.match(appSource, /RETURN_TO_HOME_PAGE_UNSAVED_CONFIRM/);
  assert.equal(RETURN_TO_HOME_PAGE_LABEL, '返回首页');
  assert.match(RETURN_TO_HOME_PAGE_UNSAVED_CONFIRM, /未保存修改/);

  assert.match(cssSource, /\.toolbar-home-button \{/);
});
