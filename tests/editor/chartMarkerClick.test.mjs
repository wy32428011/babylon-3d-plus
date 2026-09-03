import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

function createEntity(id, name, chartMarker) {
  return {
    id, name, parentId: null, childrenIds: [], visible: true, locked: false,
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      ...(chartMarker ? { chartMarker } : {}),
    },
  };
}

function createScene(chartMarker) {
  return { entities: {
    marker: createEntity('marker', '工站立标', chartMarker),
    station: createEntity('station', '一次注液'),
    sensor: createEntity('sensor', '温度传感器'),
  } };
}

function createEffects(focusReady = true) {
  const calls = [];
  const errors = [];
  return { calls, errors, effects: {
    focusEntity(id) { calls.push(['focus', id]); return focusReady; },
    selectEntity(id) { calls.push(['select', id]); },
    refreshMarker(id) { calls.push(['refresh', id]); },
    showTheme(screen) { calls.push(['theme', screen]); },
    reportError(message) { errors.push(message); },
  } };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const event = (...actions) => ({ type: 'left-click', actions });

test('图表立标点击动作调度', async (t) => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => server.close());
  const { executeChartMarkerClick: execute } = await server.ssrLoadModule('/src/runtime/babylon/chartMarkerClick.ts');

  await t.test('多个事件按列表顺序执行，并分别使用聚焦与选择目标', () => {
    const scene = createScene({ clickEvents: [
      event({ type: 'focus', targetEntityId: 'station' }, { type: 'select', targetEntityId: 'sensor' }),
      event(),
      event({ type: 'refresh' }, { type: 'select', targetEntityId: 'station' }, { type: 'focus', targetEntityId: 'sensor' }),
    ] });
    const run = createEffects();
    assert.equal(execute(scene, 'marker', run.effects), true);
    assert.deepEqual(run.calls, [
      ['focus', 'station'], ['select', 'sensor'], ['refresh', 'marker'], ['select', 'station'], ['focus', 'sensor'],
    ]);
    assert.deepEqual(run.errors, []);
  });

  await t.test('没有动作的立标、缺失实体及普通实体不接管点击', () => {
    for (const component of [{}, { clickAction: 'none' }, { clickEvents: [] }, { clickEvents: [event(), event()] }]) {
      const scene = createScene(component);
      for (const id of ['marker', 'station', 'missing']) {
        const run = createEffects();
        assert.equal(execute(scene, id, run.effects), false);
        assert.deepEqual(run.calls, []);
        assert.deepEqual(run.errors, []);
      }
    }
  });

  await t.test('旧版聚焦与刷新动作仍作用于当前立标，新列表优先', () => {
    for (const type of ['focus', 'refresh']) {
      const run = createEffects();
      assert.equal(execute(createScene({ clickAction: type, clickEvents: [] }), 'marker', run.effects), true);
      assert.deepEqual(run.calls, [[type, 'marker']]);
      assert.deepEqual(run.errors, []);
    }
    const run = createEffects();
    execute(createScene({ clickAction: 'focus', clickEvents: [event({ type: 'select', targetEntityId: 'sensor' })] }), 'marker', run.effects);
    assert.deepEqual(run.calls, [['select', 'sensor']]);
    assert.deepEqual(run.errors, []);
  });

  await t.test('失效和未设置目标仅跳过当前动作，汇总错误后仍执行后续动作', () => {
    const scene = createScene({ clickEvents: [
      event({ type: 'focus', targetEntityId: 'deleted' }, { type: 'select', targetEntityId: '' }),
      event({ type: 'refresh' }, { type: 'focus', targetEntityId: 'deleted' }, { type: 'select', targetEntityId: 'station' }),
    ] });
    const run = createEffects();
    assert.equal(execute(scene, 'marker', run.effects), true);
    assert.deepEqual(run.calls, [['refresh', 'marker'], ['select', 'station']]);
    assert.equal(run.errors.length, 1, '一次点击只报告一次汇总错误');
    assert.match(run.errors[0], /工站立标.*对象聚焦.*已不存在/);
    assert.match(run.errors[0], /工站立标.*选中物体.*尚未设置/);
    assert.equal(run.errors[0].split('\n').length, 2, '相同失效动作不重复刷屏');
  });

  await t.test('主题与对象动作按顺序联动，未绑定主题仅跳过当前动作', () => {
    const first = { projectId: 'p', screenId: 'one', name: '工站信息', screenUrl: 'https://screen.example/one' };
    const second = { ...first, screenId: 'two', screenUrl: 'https://screen.example/two' };
    const scene = deepFreeze(createScene({ clickEvents: [event(
      { type: 'focus', targetEntityId: 'station' },
      { type: 'theme', screen: first },
      { type: 'select', targetEntityId: 'sensor' },
      { type: 'theme' },
      { type: 'theme', screen: second },
    )] }));
    const before = JSON.stringify(scene);
    const run = createEffects();
    assert.equal(execute(scene, 'marker', run.effects), true);
    assert.deepEqual(run.calls, [['focus', 'station'], ['theme', first], ['select', 'sensor'], ['theme', second]]);
    assert.equal(run.errors.length, 1);
    assert.match(run.errors[0], /主题展示尚未绑定大屏/);
    assert.equal(JSON.stringify(scene), before, '展示主题不应更改持久化场景');
  });

  await t.test('原型属性名不能被当作场景目标对象', () => {
    const scene = createScene({ clickEvents: [event(
      { type: 'focus', targetEntityId: '__proto__' },
      { type: 'select', targetEntityId: 'constructor' },
      { type: 'select', targetEntityId: 'sensor' },
    )] });
    const run = createEffects();
    assert.equal(execute(scene, 'marker', run.effects), true);
    assert.deepEqual(run.calls, [['select', 'sensor']]);
    assert.match(run.errors[0], /已不存在/);
    assert.equal(execute(scene, '__proto__', run.effects), false);
  });

  await t.test('目标几何未就绪会报告对象名称，后续选中和刷新动作继续执行', () => {
    const scene = createScene({ clickEvents: [event(
      { type: 'focus', targetEntityId: 'station' },
      { type: 'select', targetEntityId: 'sensor' },
      { type: 'refresh' },
    )] });
    const run = createEffects(false);
    assert.equal(execute(scene, 'marker', run.effects), true);
    assert.deepEqual(run.calls, [['focus', 'station'], ['select', 'sensor'], ['refresh', 'marker']]);
    assert.equal(run.errors.length, 1);
    assert.match(run.errors[0], /一次注液.*三维几何尚未就绪.*无法聚焦/);
  });

  await t.test('重复执行保留冻结的场景和嵌套事件配置，不消费或改写动作', () => {
    const scene = createScene({ clickAction: 'none', clickEvents: [event(
      { type: 'focus', targetEntityId: 'station' },
      { type: 'select', targetEntityId: 'sensor' },
      { type: 'refresh' },
    )] });
    const before = structuredClone(scene);
    const actions = scene.entities.marker.components.chartMarker.clickEvents[0].actions;
    deepFreeze(scene);
    for (let count = 0; count < 2; count += 1) {
      const run = createEffects();
      assert.equal(execute(scene, 'marker', run.effects), true);
      assert.deepEqual(run.calls, [['focus', 'station'], ['select', 'sensor'], ['refresh', 'marker']]);
      assert.deepEqual(run.errors, []);
      assert.deepEqual(scene, before);
      assert.equal(scene.entities.marker.components.chartMarker.clickEvents[0].actions, actions);
    }
  });
});
