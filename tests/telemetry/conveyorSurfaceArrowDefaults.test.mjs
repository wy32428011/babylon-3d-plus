import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConveyorArrowModules } from '../helpers/conveyorSurfaceArrowModules.mjs';

const [bindings] = await loadConveyorArrowModules(['src/editor/model/telemetryBinding.ts']);
test('新建和旧场景输送线缺省开启表面箭头，其它类型不注入', () => {
  assert.equal(bindings.createDefaultTelemetryBinding('CONVEYOR').surfaceArrows?.enabled, true);
  assert.equal(bindings.normalizeTelemetryBindingComponent({ enabled: true, deviceType: 'conveyor' }).surfaceArrows?.enabled, true);
  assert.equal(bindings.createDefaultTelemetryBinding('stacker').surfaceArrows, undefined);
  assert.equal(bindings.normalizeTelemetryBindingComponent({ deviceType: 'lift' }).surfaceArrows, undefined);
});
test('已有明确关闭和新配置按原意保留，归一化可重复执行', () => {
  const config = bindings.normalizeTelemetryBindingComponent({ deviceType: 'conveyor', surfaceArrows: {
    enabled: false, style: 'flow-arrows', breathingEnabled: false,
    directionBinding: { mode: 'point', field: 'PLC.dir', forwardValue: '0001', reverseValue: '0002', stopValue: '0000' },
  } });
  assert.equal(config.surfaceArrows.enabled, false);
  assert.equal(config.surfaceArrows.directionBinding.forwardValue, '0001');
  assert.deepEqual(bindings.normalizeTelemetryBindingComponent(config), config);
});
