import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, appType: 'custom',
  server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true },
  ssr: { noExternal: ['@linkiez/dxf-renew'] } });
after(() => server.close());
const { useEditorStore } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
const { createEmptySceneDocument } = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
const { serializeScene } = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
const initial = useEditorStore.getState();
after(() => useEditorStore.setState(initial, true));
beforeEach(() => {
  const scene = createEmptySceneDocument('性能运行入口测试');
  scene.mqttConfig = { ...scene.mqttConfig, enabled: true, simulatorEnabled: true };
  useEditorStore.setState({ ...initial, scene, runtimeMode: 'edit' }, true);
});

test('性能运行沿用原运行预览并启用诊断，停止后恢复编辑且关闭诊断', () => {
  const beforeScene = serializeScene(useEditorStore.getState().scene);
  const result = useEditorStore.getState().startRuntimePreview({ performance: true });
  assert.equal(result.ok, true);
  assert.equal(useEditorStore.getState().runtimeMode, 'preview');
  assert.equal(useEditorStore.getState().runtimePerformanceEnabled, true);
  assert.equal(serializeScene(useEditorStore.getState().scene), beforeScene);
  useEditorStore.getState().stopRuntimePreview();
  assert.equal(useEditorStore.getState().runtimeMode, 'edit');
  assert.equal(useEditorStore.getState().runtimePerformanceEnabled, false);
});

test('普通运行保持原行为，不开启性能会话；重复开始不重置现有会话', () => {
  useEditorStore.getState().startRuntimePreview();
  assert.equal(useEditorStore.getState().runtimePerformanceEnabled, false);
  useEditorStore.getState().stopRuntimePreview();
  useEditorStore.getState().startRuntimePreview({ performance: true });
  const logs = useEditorStore.getState().logs;
  useEditorStore.getState().startRuntimePreview();
  assert.equal(useEditorStore.getState().runtimePerformanceEnabled, true);
  assert.equal(useEditorStore.getState().logs, logs);
});

test('MQTT 未启用时性能运行仍被预检拒绝，不进入运行态或开启诊断', () => {
  const scene = useEditorStore.getState().scene;
  useEditorStore.setState({ scene: { ...scene, mqttConfig: { ...scene.mqttConfig, enabled: false } } });
  const result = useEditorStore.getState().startRuntimePreview({ performance: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'mqtt-disabled');
  assert.equal(useEditorStore.getState().runtimeMode, 'edit');
  assert.equal(useEditorStore.getState().runtimePerformanceEnabled, false);
});

test('环境加载未完成时性能运行不绕过加载门控', () => {
  useEditorStore.setState({ environmentRuntimeSnapshot: { ...initial.environmentRuntimeSnapshot, phase: 'loading' } });
  const result = useEditorStore.getState().startRuntimePreview({ performance: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'environment-load-active');
  assert.equal(useEditorStore.getState().runtimeMode, 'edit');
  assert.equal(useEditorStore.getState().runtimePerformanceEnabled, false);
});
