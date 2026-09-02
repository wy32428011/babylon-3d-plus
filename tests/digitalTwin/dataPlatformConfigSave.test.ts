import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { resolveSavedDataPlatformPageConfig } from '../../electron/ipc/dataPlatformBindingStore.ts';

test('保存数据中台配置时保留用户填写的大屏页面地址，不再被前端端口覆盖', () => {
  assert.deepEqual(resolveSavedDataPlatformPageConfig({
    baseUrl: 'http://127.0.0.1:8086',
    storedBaseUrl: 'http://127.0.0.1:8086',
    storedWebBaseUrl: 'http://127.0.0.1:8001',
    storedFrontendPort: 8001,
    requestedWebBaseUrl: 'http://192.168.50.34:8001',
    requestedFrontendPort: 8001,
    hasRequestedWebBaseUrl: true,
    hasRequestedFrontendPort: true,
  }), {
    webBaseUrl: 'http://192.168.50.34:8001',
    frontendPort: 8001,
  });
});

test('大屏页面地址留空且填写了前端端口时，仍按 API 主机加端口推导', () => {
  assert.deepEqual(resolveSavedDataPlatformPageConfig({
    baseUrl: 'http://127.0.0.1:8086',
    storedBaseUrl: 'http://127.0.0.1:8086',
    storedWebBaseUrl: 'http://127.0.0.1:8001',
    storedFrontendPort: 8001,
    requestedWebBaseUrl: '',
    requestedFrontendPort: 9001,
    hasRequestedWebBaseUrl: true,
    hasRequestedFrontendPort: true,
  }), {
    webBaseUrl: 'http://127.0.0.1:9001',
    frontendPort: 9001,
  });
});

test('首页配置弹窗只提交 API 服务地址，不再提供页面地址和前端端口', async () => {
  const [homeSource, ipcSource] = await Promise.all([
    readFile(new URL('../../src/editor/home/HomePage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/ipc/dataPlatformIpc.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(homeSource, /saveDataPlatformConfig\(\{\s*baseUrl: configDraft,\s*\}\)/s);
  assert.doesNotMatch(homeSource, /webBaseConfigDraft|frontendPortConfigDraft/);
  assert.doesNotMatch(homeSource, /数据中台前端端口|大屏页面地址/);
  assert.match(homeSource, /onMouseDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(ipcSource, /resolveSavedDataPlatformPageConfig\(/);
  assert.doesNotMatch(
    ipcSource,
    /value\.webBaseUrl === undefined \|\| \(frontendPort !== undefined && frontendPort !== null\)/,
  );
});

test('配置异步加载完成时不会覆盖已打开弹窗中的用户输入', async () => {
  const homeSource = await readFile(new URL('../../src/editor/home/HomePage.tsx', import.meta.url), 'utf8');

  assert.match(
    homeSource,
    /if \(!isConfigDialogOpenRef\.current \|\| !configDraftsDirtyRef\.current\) \{\s*setConfigDraft\(config\.baseUrl\);\s*\}/s,
  );
});
