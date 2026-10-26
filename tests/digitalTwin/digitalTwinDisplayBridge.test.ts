import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptiveResolutionController } from '../../src/runtime/babylon/AdaptiveResolutionController.ts';

import {
  getDigitalTwinViewerHardwareScalingLevel,
  parseDigitalTwinHostRenderPixelRatioState,
  syncDigitalTwinViewerRenderSize,
} from '../../src/player/digitalTwinDisplayBridge.ts';

test('Viewer宿主重复DPR同步交给视口协调，不能把临时运动等级覆盖成基础等级', () => {
  let level = 1, baseCalls = 0, resizeCalls = 0;
  const engine = { getHardwareScalingLevel: () => level, setHardwareScalingLevel: (value: number) => { level = value; } };
  const controller = new AdaptiveResolutionController(engine);
  controller.update({ enabled: true, moving: true, now: 0 });
  assert.equal(level, 1.5);
  syncDigitalTwinViewerRenderSize({ engine, resize: () => resizeCalls++, setBaseHardwareScalingLevel: requested => {
    baseCalls++; assert.equal(requested, controller.getSnapshot().baselineLevel);
  } }, { devicePixelRatio: 1 });
  controller.update({ enabled: true, moving: true, now: 1 });
  assert.equal(level, 1.5); assert.equal(controller.getSnapshot().suspended, false);
  assert.equal(baseCalls, 1); assert.equal(resizeCalls, 1);
  controller.update({ enabled: false, moving: false, now: 2 }); assert.equal(level, 1);
});

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
