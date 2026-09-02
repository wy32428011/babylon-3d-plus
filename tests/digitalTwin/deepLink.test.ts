import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { findDataPlatformDeepLink, parseDataPlatformDeepLink } from '../../electron/deepLink.ts';

test('parseDataPlatformDeepLink 解析可信 HTTP(S) 项目深链', () => {
  assert.deepEqual(
    parseDataPlatformDeepLink('zending3d://open-project?baseUrl=https%3A%2F%2Ftwin.example.com%2Fplatform%2F&projectId=2054201280000000001'),
    { baseUrl: 'https://twin.example.com/platform', projectId: '2054201280000000001' },
  );
});

test('parseDataPlatformDeepLink 可携带与 API 分离的大屏页面地址', () => {
  assert.deepEqual(
    parseDataPlatformDeepLink(
      'zending3d://open-project?baseUrl=http%3A%2F%2F127.0.0.1%3A8086&webBaseUrl=http%3A%2F%2F127.0.0.1%3A8001%2F&projectId=42',
    ),
    {
      baseUrl: 'http://127.0.0.1:8086',
      webBaseUrl: 'http://127.0.0.1:8001',
      projectId: '42',
    },
  );
  assert.equal(
    parseDataPlatformDeepLink(
      'zending3d://open-project?baseUrl=http%3A%2F%2F127.0.0.1%3A8086&webBaseUrl=javascript%3Aalert(1)&projectId=42',
    ),
    null,
  );
});

test('parseDataPlatformDeepLink 拒绝凭据、非 HTTP 地址和非法项目 ID', () => {
  assert.equal(parseDataPlatformDeepLink('zending3d://open-project?baseUrl=https%3A%2F%2Fuser%3Apass%40example.com&projectId=1'), null);
  assert.equal(parseDataPlatformDeepLink('zending3d://open-project?baseUrl=file%3A%2F%2FC%3A%2Ftemp&projectId=1'), null);
  assert.equal(parseDataPlatformDeepLink('zending3d://open-project?baseUrl=https%3A%2F%2Fexample.com&projectId=..%2F1'), null);
  assert.equal(parseDataPlatformDeepLink('zending3d://open-project?baseUrl=https%3A%2F%2Fexample.com&projectId=0'), null);
  assert.equal(parseDataPlatformDeepLink('https://example.com'), null);
});

test('findDataPlatformDeepLink 从启动参数中查找首个合法深链', () => {
  assert.deepEqual(
    findDataPlatformDeepLink(['editor.exe', '--flag', 'bad', 'zending3d://open-project?baseUrl=http%3A%2F%2F127.0.0.1%3A8086&projectId=42']),
    { baseUrl: 'http://127.0.0.1:8086', projectId: '42' },
  );
  assert.equal(findDataPlatformDeepLink(['editor.exe', '--flag']), null);
});

test('旧版深链未携带页面地址时不应将 API 地址写作大屏页面地址', async () => {
  const appSource = await readFile(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /\.\.\.\(deepLink\.webBaseUrl \? \{ webBaseUrl: deepLink\.webBaseUrl \} : \{\}\)/);
  assert.doesNotMatch(appSource, /webBaseUrl: deepLink\.webBaseUrl \?\? deepLink\.baseUrl/);
});
