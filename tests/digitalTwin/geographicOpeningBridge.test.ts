import assert from 'node:assert/strict';
import test from 'node:test';
import { GeographicOpeningBridge } from '../../src/player/geographicOpeningBridge.ts';

function fixture(embedded = true) {
  const parent = {};
  const posted: unknown[] = [];
  let listener: ((event: { data: unknown; source: unknown; origin: string }) => void) | undefined;
  const timers = new Map<number, () => void>();
  const visibilityChanges: boolean[] = [];
  let nextTimer = 0;
  const bridge = new GeographicOpeningBridge({
    enabled: true, embedded, parentWindow: parent, viewerOrigin: 'https://viewer.test',
    allowedParentOrigins: ['https://host.test'],
    subscribeToMessages: callback => { listener = callback; return () => { listener = undefined; }; },
    postToParent: message => posted.push(message),
    setTimer: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimer: id => { timers.delete(id as number); },
  });
  const send = (data: unknown, overrides = {}) => listener?.({ data, source: parent, origin: 'https://host.test', ...overrides });
  const hello = (sessionId = 'session-1') => send({ channel: 'zending.digital-twin.bridge', version: 1, type: 'host.hello', sessionId });
  const visible = (sessionId = 'session-1', overrides = {}) => send({ channel: 'zending.opening.v1', version: 1, type: 'host.visible', sessionId }, overrides);
  const visibility = (visible: boolean, sessionId = 'session-1', overrides = {}) => send({ channel: 'zending.opening.v1', version: 1, type: 'host.visibility', sessionId, visible }, overrides);
  return { bridge, posted, timers, hello, visible, visibility, visibilityChanges, send };
}

test('新宿主后台打开会保留首播，超过旧降级时间后显示仍可开始', async () => {
  const f = fixture();
  try {
    f.hello();
    let settled = false;
    const ready = f.bridge.waitForHostVisible().then(value => { settled = true; return value; });
    const legacyTimeout = [...f.timers.values()][0];
    f.visibility(false);
    // 即使已进入任务队列的旧计时器迟到执行，也不能跳过支持可见性协议的新宿主。
    legacyTimeout();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(f.timers.size, 0);
    f.visibility(true);
    assert.equal(await ready, true);
    assert.equal(f.bridge.isHostVisible(), true);
  } finally { f.bridge.dispose(); }
});

test('提前收到新宿主可见状态会保留，隐藏更新会撤回提前可见确认', async () => {
  const f = fixture();
  f.bridge.subscribeVisibility(() => f.visibilityChanges.push(f.bridge.isHostVisible()));
  try {
    f.hello();
    f.visibility(true);
    assert.equal(await f.bridge.waitForHostVisible(), true);
    f.visibility(false);
    let settled = false;
    const ready = f.bridge.waitForHostVisible().then(value => { settled = true; return value; });
    f.visible();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(f.timers.size, 0);
    f.visibility(true);
    assert.equal(await ready, true);
    assert.deepEqual(f.visibilityChanges, [true, false, true]);
  } finally { f.bridge.dispose(); }
});

test('新宿主可见状态拒绝错误来源、旧会话、多余字段及非法布尔值', async () => {
  const f = fixture();
  try {
    f.hello();
    const ready = f.bridge.waitForHostVisible();
    f.visibility(false, 'old-session');
    f.visibility(false, 'session-1', { source: {} });
    f.visibility(false, 'session-1', { origin: 'https://other.test' });
    const base = { channel: 'zending.opening.v1', version: 1, type: 'host.visibility', sessionId: 'session-1' };
    for (const data of [{ ...base, visible: false, extra: true }, { ...base, visible: 'false' }, base]) f.send(data);
    assert.equal(f.timers.size, 1);
    f.visibility(false);
    assert.equal(f.timers.size, 0);
    f.hello('session-2');
    assert.equal(f.timers.size, 1);
    f.visibility(true);
    assert.equal(f.bridge.isHostVisible(), false);
    f.visibility(true, 'session-2');
    assert.equal(await ready, true);
  } finally { f.bridge.dispose(); }
});

test('新宿主无限期隐藏仅保留事件等待，取消和销毁后迟到可见不能复活', async () => {
  for (const action of ['abort', 'skip', 'dispose']) {
    const f = fixture();
    f.hello();
    f.visibility(false);
    const controller = new AbortController();
    const ready = f.bridge.waitForHostVisible(controller.signal);
    assert.equal(f.timers.size, 0);
    if (action === 'abort') controller.abort();
    else if (action === 'skip') f.bridge.setPhase('skipped');
    else f.bridge.dispose();
    assert.equal(await ready, false);
    f.visibility(true);
    assert.equal(await f.bridge.waitForHostVisible(), false);
    f.bridge.dispose();
  }
});

test('可见性订阅仅在变化时通知，播放阶段去重不会重复握手，释放后不再通知', () => {
  const f = fixture();
  f.hello();
  const observed: boolean[] = [];
  const unsubscribe = f.bridge.subscribeVisibility(() => observed.push(f.bridge.isHostVisible()));
  f.visibility(true);
  f.visibility(true);
  f.bridge.setPhase('playing');
  const count = f.posted.length;
  f.bridge.setPhase('playing');
  assert.equal(f.posted.length, count);
  f.visibility(false);
  unsubscribe();
  f.visibility(true);
  assert.deepEqual(observed, [true, false]);
  f.bridge.dispose();
  f.visibility(false);
  assert.deepEqual(observed, [true, false]);
});

test('旧会话已进入任务队列的降级计时不能跳过新会话的等待', async () => {
  const f = fixture();
  try {
    f.hello();
    let settled = false;
    const ready = f.bridge.waitForHostVisible().then(value => { settled = true; return value; });
    const staleTimeout = [...f.timers.values()][0];
    f.hello('session-2');
    staleTimeout();
    await Promise.resolve();
    assert.equal(settled, false);
    f.visibility(true, 'session-2');
    assert.equal(await ready, true);
  } finally { f.bridge.dispose(); }
});

test('内嵌开场只接受同一宿主同一会话的可见确认', async () => {
  const f = fixture();
  try {
    f.hello();
    let settled = false;
    const ready = f.bridge.waitForHostVisible().then(value => { settled = true; return value; });
    f.visible('old-session');
    f.visible('session-1', { source: {} });
    f.visible('session-1', { origin: 'https://other.test' });
    await Promise.resolve();
    assert.equal(settled, false);
    f.visible();
    assert.equal(await ready, true);
    assert.equal(f.timers.size, 0);
    f.bridge.setPhase('completed');
    assert.deepEqual(f.posted.at(-1), { channel: 'zending.opening.v1', version: 1, sessionId: 'session-1', type: 'viewer.state', phase: 'completed' });
  } finally { f.bridge.dispose(); }
});

test('旧宿主超时跳过并释放等待，迟到确认不会重启开场', async () => {
  const f = fixture();
  f.hello();
  const ready = f.bridge.waitForHostVisible();
  [...f.timers.values()][0]();
  assert.equal(await ready, false);
  f.visible();
  assert.equal(await f.bridge.waitForHostVisible(), false);
  f.bridge.dispose();
});

test('独立 Viewer 无需宿主握手，取消和销毁均可释放内嵌等待', async () => {
  const standalone = fixture(false);
  assert.equal(await standalone.bridge.waitForHostVisible(), true);
  standalone.bridge.dispose();
  for (const action of ['abort', 'dispose']) {
    const f = fixture();
    const controller = new AbortController();
    const ready = f.bridge.waitForHostVisible(controller.signal);
    if (action === 'abort') controller.abort(); else f.bridge.dispose();
    assert.equal(await ready, false);
    assert.equal(f.timers.size, 0);
    f.bridge.dispose();
  }
});

test('会话切换丢弃旧可见确认，重发当前开场阶段', async () => {
  const f = fixture();
  f.hello();
  f.visible();
  f.hello('session-2');
  const ready = f.bridge.waitForHostVisible();
  f.visible();
  assert.equal(f.timers.size, 1);
  f.visible('session-2');
  assert.equal(await ready, true);
  f.bridge.dispose();
});

test('资源准备之前的可见确认不替代真正开始时的确认', async () => {
  const f = fixture();
  f.hello();
  f.visible();
  let settled = false;
  const ready = f.bridge.waitForHostVisible().then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  f.visible();
  assert.equal(await ready, true);
  f.hello('session-2');
  const nextReady = f.bridge.waitForHostVisible();
  assert.equal(f.timers.size, 1);
  f.visible('session-2');
  assert.equal(await nextReady, true);
  f.bridge.dispose();
});

test('非法 hello、未知字段以及未握手的确认不能开始开场', async () => {
  const f = fixture();
  f.send({ channel: 'zending.digital-twin.bridge', version: 1, type: 'host.hello', sessionId: 'session-1' }, { origin: 'https://bad.test' });
  f.send({ channel: 'zending.digital-twin.bridge', version: 1, type: 'host.hello', sessionId: 'session-1', extra: true });
  assert.equal(f.posted.length, 0);
  const ready = f.bridge.waitForHostVisible();
  f.visible();
  assert.equal(f.timers.size, 1);
  f.hello();
  f.send({ channel: 'zending.opening.v1', version: 1, type: 'host.visible', sessionId: 'session-1', extra: true });
  assert.equal(f.timers.size, 1);
  f.visible();
  assert.equal(await ready, true);
  f.bridge.dispose();
});

test('终态和已取消信号不会启动等待；等待中跳过会清理计时器', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await f.bridge.waitForHostVisible(controller.signal), false);
  const ready = f.bridge.waitForHostVisible();
  assert.equal(f.bridge.waitForHostVisible(), ready);
  f.bridge.setPhase('skipped');
  assert.equal(await ready, false);
  assert.equal(f.timers.size, 0);
  assert.equal(await f.bridge.waitForHostVisible(), false);
  f.bridge.dispose();
  f.bridge.setPhase('waiting');
  assert.equal(await f.bridge.waitForHostVisible(), false);
});

test('播放中释放桥接会通知宿主跳过，避免业务组件永久等待', () => {
  const f = fixture();
  f.hello();
  f.bridge.setPhase('playing');
  f.bridge.dispose();
  assert.equal((f.posted.at(-1) as { phase: string }).phase, 'skipped');
});
