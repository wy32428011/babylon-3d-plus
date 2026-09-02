import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
after(() => viteServer.close());

const {
  createDataPlatformScreenSelectionMessage,
  parseDataPlatformScreenCommand,
} = await viteServer.ssrLoadModule('/src/runtime/babylon/dataPlatformScreenBridge.ts') as typeof import('../../src/runtime/babylon/dataPlatformScreenBridge.ts');

test('大屏消息协议解析选中和聚焦指令，并拒绝未知字段', () => {
  assert.deepEqual(parseDataPlatformScreenCommand({
    channel: 'zending.data-platform-screen.bridge',
    version: 1,
    type: 'screen.focusEntity',
    payload: { assetCode: 'STACKER-001' },
  }), {
    channel: 'zending.data-platform-screen.bridge',
    version: 1,
    type: 'screen.focusEntity',
    payload: { assetCode: 'STACKER-001' },
  });

  assert.equal(parseDataPlatformScreenCommand({
    channel: 'zending.data-platform-screen.bridge',
    version: 1,
    type: 'screen.selectEntity',
    payload: { entityId: 'entity-1', extra: true },
  }), null);
  assert.equal(parseDataPlatformScreenCommand({
    channel: 'zending.data-platform-screen.bridge',
    version: 1,
    type: 'screen.selectEntity',
    payload: { entityId: 'entity-1', assetCode: 'STACKER-001' },
  }), null);
});

test('Viewer 回传三维选中结果时限制数量并保留来源字段', () => {
  assert.deepEqual(createDataPlatformScreenSelectionMessage(['entity-1', 'entity-1', 'entity-2'], 'entity-1'), {
    channel: 'zending.data-platform-screen.bridge',
    version: 1,
    type: 'viewer.selectionChanged',
    payload: {
      entityIds: ['entity-1', 'entity-2'],
      primaryEntityId: 'entity-1',
      source: '3d',
    },
  });
});
