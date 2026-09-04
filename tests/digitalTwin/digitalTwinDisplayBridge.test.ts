import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getDigitalTwinViewerHardwareScalingLevel,
  parseDigitalTwinHostRenderPixelRatioState,
  syncDigitalTwinViewerRenderSize,
} from '../../src/player/digitalTwinDisplayBridge.ts';

test('Viewer 默认按浏览器 DPR 渲染，并接受宿主传入的大屏实际像素比', () => {
  assert.equal(getDigitalTwinViewerHardwareScalingLevel({ devicePixelRatio: 2 }), 0.5);
  assert.equal(getDigitalTwinViewerHardwareScalingLevel({
    devicePixelRatio: 1,
    hostRenderPixelRatio: 1.5,
  }), 2 / 3);
  assert.equal(getDigitalTwinViewerHardwareScalingLevel({
    devicePixelRatio: 4,
    hostRenderPixelRatio: 4,
  }), 0.5);
});

test('Viewer 严格解析宿主渲染像素比并拒绝越界或额外字段', () => {
  assert.deepEqual(parseDigitalTwinHostRenderPixelRatioState({
    channel: 'zending.digital-twin.display',
    version: 1,
    type: 'host.renderPixelRatioChanged',
    payload: { renderPixelRatio: 2 },
  }), { renderPixelRatio: 2 });
  assert.equal(parseDigitalTwinHostRenderPixelRatioState({
    channel: 'zending.digital-twin.display',
    version: 1,
    type: 'host.renderPixelRatioChanged',
    payload: { renderPixelRatio: 4 },
  }), null);
  assert.equal(parseDigitalTwinHostRenderPixelRatioState({
    channel: 'zending.digital-twin.display',
    version: 1,
    type: 'host.renderPixelRatioChanged',
    payload: { renderPixelRatio: 2, extra: true },
  }), null);
});

test('Viewer 在像素比变化后同步硬件缩放并刷新画布尺寸', () => {
  let hardwareScalingLevel = 1;
  let resizeCount = 0;
  syncDigitalTwinViewerRenderSize({
    engine: {
      getHardwareScalingLevel: () => hardwareScalingLevel,
      setHardwareScalingLevel: (value) => { hardwareScalingLevel = value; },
    },
    resize: () => { resizeCount += 1; },
  }, { devicePixelRatio: 2 });

  assert.equal(hardwareScalingLevel, 0.5);
  assert.equal(resizeCount, 1);
});
