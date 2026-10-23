import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createBrowserMqttLoader } from '../../src/runtime/mqtt/browserMqttLoader.ts';

test('浏览器 default-only ESM 命名空间返回真实 connect API 并保留对象 receiver', async () => {
  const url = 'data:text/javascript,export default { calls: 0, connect() { this.calls++; return this; } }';
  const namespace = await import(url);
  // 直接传入原生 ESM namespace，不能以 plain object 代替浏览器模块边界。
  const load = createBrowserMqttLoader(async () => namespace);
  const loaded = await load();
  assert.equal(typeof loaded.connect, 'function', '浏览器 MQTT API 必须能调用 mqtt.connect');
  assert.equal(loaded, namespace.default);
  assert.equal(loaded.connect('ws://fixture'), namespace.default);
  assert.equal(namespace.default.calls, 1);
});

test('已安装 MQTT 浏览器包的条件入口可直接加载，保留 default API 身份与缓存', async () => {
  const source = readFileSync(new URL('../../node_modules/mqtt/dist/mqtt.esm.js', import.meta.url), 'utf8');
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const namespace = await import(url);
  assert.deepEqual(Object.keys(namespace), ['default']);
  const load = createBrowserMqttLoader(async () => namespace);
  const first = load();
  assert.equal(load(), first);
  const api = await first;
  assert.equal(api, namespace.default);
  assert.equal(api.connect, namespace.default.connect);
  assert.equal(typeof api.connect, 'function');
});

test('命名导出保持原对象，并发只导入一次；不正确导出清空缓存后可重试', async () => {
  const api = { connect() {} };
  let count = 0;
  const load = createBrowserMqttLoader(async () => { count++; return count === 1 ? { default: {} } : api; });
  const first = load();
  assert.equal(load(), first);
  await assert.rejects(first, /MQTT.*connect/);
  assert.equal(await load(), api);
  assert.equal(await load(), api);
  assert.equal(count, 2);
});
