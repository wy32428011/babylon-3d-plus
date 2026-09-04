import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDigitalTwinHostFullscreenRequest,
  parseDigitalTwinHostFullscreenState,
} from '../../src/player/digitalTwinFullscreenBridge.ts';

test('内嵌 Viewer 只发送无业务数据的宿主全屏切换请求', () => {
  assert.deepEqual(createDigitalTwinHostFullscreenRequest(), {
    channel: 'zending.digital-twin.fullscreen',
    version: 1,
    type: 'viewer.toggleHostFullscreen',
  });
});

test('Viewer 严格解析宿主全屏状态并拒绝额外字段', () => {
  assert.deepEqual(parseDigitalTwinHostFullscreenState({
    channel: 'zending.digital-twin.fullscreen',
    version: 1,
    type: 'host.fullscreenChanged',
    payload: { fullscreen: true },
  }), { fullscreen: true });
  assert.equal(parseDigitalTwinHostFullscreenState({
    channel: 'zending.digital-twin.fullscreen',
    version: 1,
    type: 'host.fullscreenChanged',
    payload: { fullscreen: true, extra: true },
  }), null);
  assert.equal(parseDigitalTwinHostFullscreenState(null), null);
});
