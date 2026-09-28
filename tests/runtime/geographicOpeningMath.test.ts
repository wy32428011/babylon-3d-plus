import assert from 'node:assert/strict';
import test from 'node:test';
import { projectGeographicPoint, getOpeningFrame, getRoutePoint } from '../../src/runtime/opening/geographicOpeningMath.ts';

test('球面所有经纬点保持单位球半径，展开后的端点保持确定的经纬位置', () => {
  for (const [longitude, latitude] of [[105, 0], [120.3, 31.68], [-70, 45], [10, -70]]) {
    const sphere = projectGeographicPoint(longitude, latitude, 0, 0);
    assert.ok(Math.abs(Math.hypot(...sphere) - 1) < 1e-9);
    const map = projectGeographicPoint(longitude, latitude, 1, 0);
    assert.equal(map[2], 0);
    assert.ok(Math.abs(map[1] - latitude * Math.PI / 180) < 1e-9);
  }
});

test('展开过程连续且完成后不再受地球自转角度影响', () => {
  const before = projectGeographicPoint(120.3, 31.68, 0.499999, 0.2);
  const after = projectGeographicPoint(120.3, 31.68, 0.500001, 0.2);
  assert.ok(Math.hypot(...before.map((v, i) => v - after[i])) < 0.0001);
  assert.deepEqual(projectGeographicPoint(120.3, 31.68, 1, 0.2), projectGeographicPoint(120.3, 31.68, 1, 2));
});

test('完整时间轴覆盖旋转地球到惠山区并最终显露业务场景', () => {
  assert.equal(getOpeningFrame(0, 18).phase, 'globe');
  assert.equal(getOpeningFrame(4, 18).phase, 'unfold');
  assert.equal(getOpeningFrame(6, 18).phase, 'routes');
  assert.equal(getOpeningFrame(9, 18).phase, 'china');
  assert.equal(getOpeningFrame(11, 18).phase, 'jiangsu');
  assert.equal(getOpeningFrame(13, 18).phase, 'wuxi');
  assert.equal(getOpeningFrame(15, 18).phase, 'huishan');
  assert.equal(getOpeningFrame(17, 18).phase, 'handoff');
  assert.equal(getOpeningFrame(18, 18).phase, 'complete');
  assert.equal(getOpeningFrame(18, 18).opacity, 0);
});

test('时间缩放、越界值和跳过后的终点均保持稳定', () => {
  assert.equal(getOpeningFrame(8, 9).phase, getOpeningFrame(16, 18).phase);
  assert.equal(getOpeningFrame(-1, 18).progress, 0);
  assert.equal(getOpeningFrame(999, 18).progress, 1);
  assert.equal(getOpeningFrame(Number.NaN, 18).progress, 0);
});

test('飞线始终锚定地图出发点和终点，中间抬升为可见弧线', () => {
  const origin: [number, number] = [120.3, 31.68];
  const destination: [number, number] = [2.35, 48.86];
  assert.deepEqual(getRoutePoint(origin, destination, 0), projectGeographicPoint(...origin, 1, 0));
  const end = getRoutePoint(origin, destination, 1);
  const expected = projectGeographicPoint(...destination, 1, 0);
  assert.ok(Math.hypot(...end.map((v, i) => v - expected[i])) < 1e-9);
  assert.ok(getRoutePoint(origin, destination, 0.5)[2] < -0.1);
});

test('参考图构图以中国为主，欧洲在左、美洲在右，飞线坐标与地图一致', () => {
  const china = projectGeographicPoint(120.3, 31.68, 1);
  const europe = projectGeographicPoint(2.35, 48.86, 1);
  const america = projectGeographicPoint(-74.01, 40.71, 1);
  assert.ok(Math.abs(china[0] + 0.5) < 0.1);
  assert.ok(europe[0] < china[0]);
  assert.ok(america[0] > china[0]);
  assert.deepEqual(getRoutePoint([120.3,31.68],[-74.01,40.71],1), america);
});

test('中国完整构图插入六秒国内飞线停留，结束后才继续江苏', () => {
  const arrival = getOpeningFrame(10,18,6);
  assert.equal(arrival.phase,'china-routes');
  assert.equal(arrival.label,'中国业务网络');
  assert.equal(arrival.time,10);
  assert.equal(arrival.chinaHoldElapsedSeconds,0);
  assert.equal(arrival.totalDurationSeconds,24);
  const holding = getOpeningFrame(13,18,6);
  assert.equal(holding.phase,'china-routes');
  assert.equal(holding.time,10);
  assert.equal(holding.chinaHoldElapsedSeconds,3);
  assert.equal(holding.chinaHoldProgress,.5);
  assert.equal(holding.progress,13/24);
  const departure = getOpeningFrame(16,18,6);
  assert.equal(departure.phase,'jiangsu');
  assert.equal(departure.time,10);
  assert.equal(departure.chinaHoldElapsedSeconds,6);
  assert.equal(getOpeningFrame(17,18,6).time,11);
  const completed = getOpeningFrame(24,18,6);
  assert.equal(completed.phase,'complete');
  assert.equal(completed.opacity,0);
  assert.equal(completed.progress,1);
  assert.equal(completed.elapsedSeconds,24);
});

test('停留为零精确保留旧阶段与时长，不出现国内飞线阶段', () => {
  for(const elapsed of [0,3,5,8,9.99,10,12,14,16,18,99]) {
    const legacy = getOpeningFrame(elapsed,18);
    const zeroHold = getOpeningFrame(elapsed,18,0);
    assert.deepEqual(zeroHold,legacy);
    assert.notEqual(zeroHold.phase,'china-routes');
    assert.equal(zeroHold.totalDurationSeconds,18);
    assert.equal(zeroHold.chinaHoldElapsedSeconds,0);
    assert.equal(zeroHold.chinaHoldProgress,0);
  }
});

test('停留采用实际秒且不随基础动画时长缩放', () => {
  const shortBase = getOpeningFrame(5,9,6);
  assert.equal(shortBase.phase,'china-routes');
  assert.equal(shortBase.totalDurationSeconds,15);
  assert.equal(getOpeningFrame(8,9,6).chinaHoldElapsedSeconds,3);
  assert.equal(getOpeningFrame(10.999,9,6).phase,'china-routes');
  assert.equal(getOpeningFrame(11,9,6).phase,'jiangsu');
  assert.equal(getOpeningFrame(11.5,9,6).time,11);
  assert.equal(getOpeningFrame(15,9,6).phase,'complete');
  const longBase = getOpeningFrame(20,36,6);
  assert.equal(longBase.phase,'china-routes');
  assert.equal(getOpeningFrame(23,36,6).chinaHoldElapsedSeconds,3);
  assert.equal(getOpeningFrame(26,36,6).phase,'jiangsu');
  assert.equal(getOpeningFrame(42,36,6).phase,'complete');
});

test('更长停留保留完整中国构图和连续光头时钟', () => {
  const holding = getOpeningFrame(100,18,120);
  assert.equal(holding.phase,'china-routes');
  assert.equal(holding.time,10);
  assert.equal(holding.chinaHoldElapsedSeconds,90);
  assert.equal(holding.totalDurationSeconds,138);
  assert.equal(getOpeningFrame(131,18,120).time,11);
  for(const boundary of [10,130]) {
    const before = getOpeningFrame(boundary-1e-6,18,120);
    const after = getOpeningFrame(boundary+1e-6,18,120);
    assert.ok(Math.abs(before.time-after.time)<3e-6);
    const previousMotion = before.time + before.chinaHoldElapsedSeconds;
    const nextMotion = after.time + after.chinaHoldElapsedSeconds;
    assert.ok(nextMotion >= previousMotion && nextMotion-previousMotion<3e-6);
    assert.ok(after.progress > before.progress);
    assert.equal(after.opacity,1);
  }
});

test('非法停留安全降级为零，越界寻帧仍到达含停留的真实终点', () => {
  for(const hold of [-1,Number.NaN,Number.POSITIVE_INFINITY]) {
    assert.deepEqual(getOpeningFrame(10,18,hold),getOpeningFrame(10,18,0));
  }
  const final = getOpeningFrame(999,18,6);
  assert.equal(final.elapsedSeconds,24);
  assert.equal(final.chinaHoldElapsedSeconds,6);
  assert.equal(final.chinaHoldProgress,1);
  assert.equal(final.time,18);
  const reducedStart = getOpeningFrame(18*16/18+6,18,6);
  assert.equal(reducedStart.phase,'handoff');
  assert.equal(reducedStart.time,16);
});
