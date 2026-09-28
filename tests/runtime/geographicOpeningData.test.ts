import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

type Geometry = { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] };
const data = JSON.parse(readFileSync(new URL('../../src/runtime/opening/data/geographicBoundaries.json', import.meta.url), 'utf8')) as Record<string, Geometry> & {world: Geometry[]};
const points = (geometry: Geometry) => geometry.coordinates.flat(geometry.type === 'Polygon' ? 1 : 2) as number[][];
const bounds = (geometry: Geometry) => {
  const all = points(geometry);
  return {west:Math.min(...all.map(p=>p[0])),east:Math.max(...all.map(p=>p[0])),south:Math.min(...all.map(p=>p[1])),north:Math.max(...all.map(p=>p[1]))};
};

test('世界数据覆盖真实大陆且所有打包坐标合法', () => {
  assert.ok(data.world.length > 100);
  for (const geometry of [...data.world,data.china,data.jiangsu,data.wuxi,data.huishan]) {
    assert.ok(points(geometry).length > 3);
    for (const [longitude,latitude] of points(geometry)) {
      assert.ok(Number.isFinite(longitude) && longitude >= -180 && longitude <= 180);
      assert.ok(Number.isFinite(latitude) && latitude >= -90 && latitude <= 90);
    }
  }
});

test('无锡使用江苏无锡市完整范围，不能误选同名巫溪县或旧城区轮廓', () => {
  const wuxi = bounds(data.wuxi);
  assert.ok(wuxi.west > 119 && wuxi.west < 119.7);
  assert.ok(wuxi.east > 120.5 && wuxi.east < 121);
  assert.ok(wuxi.south > 30.8 && wuxi.south < 31.3);
  assert.ok(wuxi.north > 31.8 && wuxi.north < 32.2);
  const huishan = bounds(data.huishan);
  assert.ok(huishan.west >= wuxi.west && huishan.east <= wuxi.east);
  assert.ok(huishan.south >= wuxi.south && huishan.north <= wuxi.north);
});

test('惠山区保留足够边界细节，默认落点处于区级展示范围内', () => {
  const huishan = bounds(data.huishan);
  assert.ok(points(data.huishan).length > 50);
  assert.ok(120.3 > huishan.west && 120.3 < huishan.east);
  assert.ok(31.68 > huishan.south && 31.68 < huishan.north);
});

test('参考图样式使用真实国界和省界数据，地理字段完整且不会产生非法纹理坐标', () => {
  const countries = JSON.parse(readFileSync(new URL('../../src/runtime/opening/data/worldCountryBoundaries.json', import.meta.url), 'utf8')) as {name:string;geometry:Geometry}[];
  const provinces = JSON.parse(readFileSync(new URL('../../src/runtime/opening/data/chinaProvinceBoundaries.json', import.meta.url), 'utf8')) as {name:string;geometry:Geometry}[];
  assert.ok(countries.length >= 150);
  assert.equal(provinces.length, 34);
  assert.ok(provinces.some(item => /Jiangsu/i.test(item.name)));
  for (const item of [...countries,...provinces]) {
    assert.equal(typeof item.name, 'string');
    assert.ok(points(item.geometry).length > 3);
    for (const [longitude,latitude] of points(item.geometry)) {
      assert.ok(Number.isFinite(longitude) && longitude >= -180 && longitude <= 180);
      assert.ok(Number.isFinite(latitude) && latitude >= -90 && latitude <= 90);
    }
  }
});
