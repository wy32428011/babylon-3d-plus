import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const toolbarSource = readFileSync(resolve(process.cwd(), 'src/editor/ui/Toolbar.tsx'), 'utf8');
const cssSource = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');

test('MQTT 弹窗提供可访问的测试按钮和四态结果', () => {
  assert.match(toolbarSource, /aria-label="测试 MQTT 连接"/);
  assert.match(toolbarSource, /aria-live="polite"/);
  assert.match(toolbarSource, /未测试/);
  assert.match(toolbarSource, /连接测试中/);
  assert.match(toolbarSource, /连接成功/);
  assert.match(toolbarSource, /连接失败/);
  assert.match(toolbarSource, /startMqttConnectionTest/);
});

test('MQTT 弹窗关闭和连接字段变化会取消旧测试', () => {
  assert.match(toolbarSource, /queueMqttConnectionTestCancellation/);
  assert.match(toolbarSource, /await previousHandle\.cancel\(\)/);
  assert.match(toolbarSource, /resetMqttConnectionTest/);
  assert.match(toolbarSource, /handleCloseMqttConfigDialog/);
});

test('快速重测会等待旧连接清理并用 generation 拒绝过期草稿', () => {
  assert.match(toolbarSource, /mqttConnectionTestGenerationRef/);
  assert.match(toolbarSource, /await previousHandle\.cancel\(\)/);
  assert.match(toolbarSource, /generation !== mqttConnectionTestGenerationRef\.current/);
});

test('弹窗同时保留正式运行状态和独立测试状态', () => {
  assert.match(toolbarSource, /当前状态：\{MQTT_STATUS_LABELS\[mqttRuntimeStatus\.state\]\}/);
  assert.match(toolbarSource, /当前连接状态：\{mqttConnectionTestState\.message\}/);
});

test('MQTT 测试状态包含 idle testing success error 样式', () => {
  for (const state of ['idle', 'testing', 'success', 'error']) {
    assert.match(cssSource, new RegExp('mqtt-connection-test-status-' + state));
  }
  assert.match(cssSource, /mqtt-connection-test-actions/);
});
