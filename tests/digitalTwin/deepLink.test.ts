import assert from 'node:assert/strict';
import test from 'node:test';
import { findDataPlatformDeepLink, parseDataPlatformDeepLink } from '../../electron/deepLink.ts';

test('parseDataPlatformDeepLink 解析可信 HTTP(S) 项目深链', () => {
  assert.deepEqual(
    parseDataPlatformDeepLink('zending3d://open-project?baseUrl=https%3A%2F%2Ftwin.example.com%2Fplatform%2F&projectId=2054201280000000001'),
    { baseUrl: 'https://twin.example.com/platform', projectId: '2054201280000000001' },
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
