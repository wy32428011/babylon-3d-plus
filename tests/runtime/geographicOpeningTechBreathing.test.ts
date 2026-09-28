import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOpeningBreathingPeriod, readOpeningBreathing, readOpeningScanPosition } from '../../src/runtime/opening/geographicOpeningBreathing.ts';

const settings = {breathingEnabled:true,breathingIntensity:.65,breathingPeriodSeconds:4};

test('呼吸使用真实秒并按配置周期重复，峰谷对称且保持稳定中值', () => {
  assert.equal(readOpeningBreathing(0,settings),1);
  assert.ok(Math.abs(readOpeningBreathing(1,settings)-1.2275)<1e-12);
  assert.ok(Math.abs(readOpeningBreathing(3,settings)-.7725)<1e-12);
  for(const time of [0,.37,1,10,1234.56]) {
    assert.ok(Math.abs(readOpeningBreathing(time,settings)-readOpeningBreathing(time+4,settings))<1e-10);
  }
});

test('关闭、强度零与简化动效均精确返回静态基线，不闪烁', () => {
  for(const time of [0,.5,1,2,3,99]) {
    assert.equal(readOpeningBreathing(time,{...settings,breathingEnabled:false}),1);
    assert.equal(readOpeningBreathing(time,{...settings,breathingIntensity:0}),1);
    assert.equal(readOpeningBreathing(time,settings,false),1);
  }
});

test('独立相位便于节点错峰，暂停与确定性寻帧不会依赖调用次数', () => {
  assert.equal(readOpeningBreathing(0,settings,true,.25),readOpeningBreathing(1,settings));
  const atHoldStart=readOpeningBreathing(10,settings);
  const atHoldLater=readOpeningBreathing(11,settings);
  assert.notEqual(atHoldStart,atHoldLater);
  assert.equal(readOpeningBreathing(11,settings),atHoldLater);
  assert.equal(readOpeningBreathing(10,settings),atHoldStart);
});

test('非法周期和强度被安全归一化，最大强度仍是温和有界增益', () => {
  assert.equal(normalizeOpeningBreathingPeriod(Number.NaN),4);
  assert.equal(normalizeOpeningBreathingPeriod(0),4);
  assert.equal(normalizeOpeningBreathingPeriod(.5),2);
  assert.equal(normalizeOpeningBreathingPeriod(30),10);
  assert.equal(readOpeningBreathing(1,{...settings,breathingIntensity:Number.NaN}),1);
  assert.equal(readOpeningBreathing(Number.NaN,settings),1);
  for(let time=0;time<40;time+=.07) {
    const gain=readOpeningBreathing(time,{...settings,breathingIntensity:99});
    assert.ok(gain>=.65 && gain<=1.35);
  }
});

test('扫描线在可见纹理外完成循环，真实时间推进时连续扫过地图', () => {
  assert.equal(readOpeningScanPosition(0,4),-.15);
  assert.equal(readOpeningScanPosition(4,4),-.15);
  assert.ok(Math.abs(readOpeningScanPosition(2,4)-.5)<1e-12);
  assert.ok(readOpeningScanPosition(3.999,4)>1);
  assert.ok(readOpeningScanPosition(1.001,4)>readOpeningScanPosition(1,4));
});
