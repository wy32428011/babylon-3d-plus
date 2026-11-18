import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// 此回归必须独立运行，显式指定中台源码，绝不读取开发者机器的默认路径。
const editorRoot = process.cwd();
const centralRoot = process.env.CENTRAL_DATA_PLATFORM_ROOT;
if (!centralRoot) throw new Error('请设置 CENTRAL_DATA_PLATFORM_ROOT 为中台仓库根目录');
const require = createRequire(path.join(editorRoot, 'package.json'));
const { build, normalizePath } = await import(pathToFileURL(require.resolve('vite')).href);

async function loadControllers() {
  const source = (base, relative) => normalizePath(path.resolve(base, relative));
  const viewer = source(editorRoot, 'src/player/DigitalTwinInteractionController.ts');
  const host = source(centralRoot, 'frontend/src/pages/BigscreenDesigner/utils/digitalTwinRuntimeHostBridge.ts');
  const coordinator = source(centralRoot, 'frontend/src/pages/BigscreenDesigner/utils/digitalTwinRuntimeInteraction.ts');
  for (const file of [viewer, host, coordinator]) {
    if (!existsSync(file)) throw new Error(`跨仓测试源码不存在：${file}`);
  }
  const virtualId = 'virtual:inspection-cross-repository';
  const resolvedId = `\0${virtualId}`;
  const result = await build({
    root: editorRoot,
    configFile: false,
    logLevel: 'error',
    plugins: [{
      name: 'inspection-cross-repository-fixture',
      resolveId(id) { return id === virtualId ? resolvedId : null; },
      load(id) {
        if (id !== resolvedId) return null;
        return `export { DigitalTwinInteractionController, DigitalTwinInspectionController } from ${JSON.stringify(viewer)};\n`
          + `export { DigitalTwinIframeBridgeController } from ${JSON.stringify(host)};\n`
          + `export { DigitalTwinRuntimeInteractionCoordinator } from ${JSON.stringify(coordinator)};\n`;
      },
    }],
    build: {
      ssr: true,
      write: false,
      rollupOptions: { input: virtualId, output: { format: 'es', codeSplitting: false } },
    },
  });
  assert.equal(result.output.length, 1);
  assert.equal(result.output[0].type, 'chunk');
  return import(`data:text/javascript;base64,${Buffer.from(result.output[0].code).toString('base64')}`);
}

class FakeScheduler {
  nextId = 1;
  tasks = new Map();

  setTimer = (callback, delay) => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, delay });
    return id;
  };

  clearTimer = id => { this.tasks.delete(id); };
}

// 投递使用结构化克隆和异步队列，保留两个 iframe 的 source 与 origin 边界。
class MessageWindows {
  hostOrigin = 'https://platform.example';
  viewerOrigin = 'https://viewer.example';
  parent = { name: 'parent' };
  frames = { scene: { name: 'scene' }, detail: { name: 'detail' } };
  listeners = { host: new Set(), scene: new Set(), detail: new Set() };
  queue = [];
  trace = [];
  held = [];
  holdNext = null;

  subscribe = destination => listener => {
    this.listeners[destination].add(listener);
    return () => this.listeners[destination].delete(listener);
  };

  postToFrame = (frame, message, targetOrigin) => {
    assert.equal(targetOrigin, this.viewerOrigin);
    assert.ok(frame === this.frames.scene || frame === this.frames.detail);
    const destination = frame.name;
    const data = structuredClone(message);
    this.trace.push({ direction: 'toViewer', destination, data });
    this.queue.push({ destination, event: { data, origin: this.hostOrigin, source: this.parent } });
  };

  postToParent = frame => (message, targetOrigin) => {
    assert.equal(targetOrigin, this.hostOrigin);
    const data = structuredClone(message);
    const item = { destination: 'host', event: { data, origin: this.viewerOrigin, source: frame } };
    this.trace.push({ direction: 'toHost', destination: frame.name, data });
    if (this.holdNext?.(item)) {
      this.holdNext = null;
      this.held.push(item);
    } else {
      this.queue.push(item);
    }
  };

  enqueueHost = (data, source, origin = this.viewerOrigin) => {
    this.queue.push({ destination: 'host', event: { data: structuredClone(data), origin, source } });
  };

  async drain() {
    let deliveries = 0;
    for (let round = 0; round < 100; round++) {
      while (this.queue.length) {
        if (++deliveries > 10_000) throw new Error('跨窗口消息数量超出测试限制');
        const { destination, event } = this.queue.shift();
        for (const listener of [...this.listeners[destination]]) listener(event);
      }
      await new Promise(resolve => setImmediate(resolve));
      if (!this.queue.length) return;
    }
    throw new Error('跨窗口消息没有收敛');
  }
}

// 只替代图形运行时；聚焦结果和详情事件仍由真实控制器发送。
function createSceneRuntime(targets, getScene) {
  const byEntity = new Map(Object.entries(targets).map(([assetCode, target]) => [target.entityId, { assetCode, ...target }]));
  let transition = null;
  return {
    hardwareGpuVerified: true,
    assetIndex: {
      entityIdsByAssetCode: new Map(Object.entries(targets).map(([assetCode, target]) => [assetCode, [target.entityId]])),
      effectiveVisibilityByEntityId: new Map([...byEntity.keys()].map(id => [id, true])),
    },
    slotIndex: { locators: [], standaloneEntityIdsByAssetId: new Map(), effectiveVisibilityByEntityId: new Map() },
    getFocusBounds: () => ({
      center: { x: 0, y: 0, z: 0 }, radiusMeters: 1, geometryReady: true,
      requestedEntityCount: 1, resolvedEntityCount: 1, geometryReadyEntityCount: 1,
    }),
    focusOnBounds: (_bounds, options) => { transition = options; },
    completeFocus: () => {
      assert.ok(transition, '未收到场景聚焦请求');
      const current = transition;
      transition = null;
      current.onCompleted();
    },
    triggerTargetClick: entityId => {
      const target = byEntity.get(entityId);
      assert.ok(target);
      getScene().notifyInspectionDeviceSelected({
        assetCode: target.assetCode, entityId, device: target.inspection.device,
      });
    },
    resolveInspectionTarget: (entityId, assetCode) => {
      const target = byEntity.get(entityId);
      return target?.assetCode === assetCode ? { assetCode, entityId, inspection: target.inspection } : null;
    },
    cancelCameraTransition: reason => {
      const current = transition;
      transition = null;
      current?.onCancelled?.(reason);
      return Boolean(current);
    },
    setExternalHighlightEntityIds: () => {},
    setExternalSlotHighlight: () => {},
    clearExternalHighlight: () => {},
    getPatrolPhase: () => 'idle',
    pausePatrol: () => {},
    notifyCameraChangedWhilePaused: () => {},
  };
}

function makeBinding(deviceNo) {
  return {
    schemaVersion: 1,
    device: { namespace: 'site', deviceType: 'pump', deviceNo },
    model: {
      dataPlatformModel: { sourceKey: 'fixture', kind: 'model', resourceId: '1', modelPath: 'pump.glb' },
      versionId: '2', contentSha256: 'a'.repeat(64), sourcePath: 'pump.glb',
      sourceUrl: 'editor-asset://pump.glb', metaPath: 'meta.json',
      metaUrl: 'editor-asset://meta.json', unitScaleToMeters: 1,
    },
    configuration: { id: 'fixture-configuration', parameters: {} },
    parts: Array.from({ length: 600 }, (_, index) => {
      const id = String(index).padStart(4, '0');
      return { partKey: `part-${id}`, name: `Part ${id}`, nodePath: `part-${id}`,
        axis: { x: 0, y: 1, z: 0 }, distanceMeters: 0.1, fixed: false };
    }),
  };
}

test('两仓真实桥接串联设备详情、记录定位和过期消息隔离', async () => {
  const {
    DigitalTwinInteractionController, DigitalTwinInspectionController,
    DigitalTwinIframeBridgeController, DigitalTwinRuntimeInteractionCoordinator,
  } = await loadControllers();
  const windows = new MessageWindows();
  const scheduler = new FakeScheduler();
  const selections = [];
  const opens = [];
  const loads = [];
  const operations = [];
  const loadResults = [];
  const targets = {
    'PUMP-A': { entityId: 'entity-a', inspection: makeBinding('0008') },
    'PUMP-B': { entityId: 'entity-b', inspection: makeBinding('0009') },
  };
  let requestSequence = 0;
  let sessionSequence = 0;
  let deferredPart = null;
  let deferredSelection = null;
  const coordinator = new DigitalTwinRuntimeInteractionCoordinator({
    onAssetClicked: (payload, source) => selections.push({ payload, source }),
    createRequestId: () => `record-${++requestSequence}`,
    setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer,
  });
  const bridgeOptions = role => ({
    runtimeWidgetId: role, endpointRole: role, ...(role === 'detail' ? { ownerSceneId: 'scene' } : {}),
    subscribeToMessages: windows.subscribe('host'), postToFrame: windows.postToFrame,
    createSessionId: () => `${role}-session-${++sessionSequence}`,
    setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer,
  });
  const sceneBridge = new DigitalTwinIframeBridgeController(bridgeOptions('scene'));
  const detailBridge = new DigitalTwinIframeBridgeController(bridgeOptions('detail'));
  const scene = new DigitalTwinInteractionController({
    parentWindow: windows.parent, viewerOrigin: windows.viewerOrigin,
    subscribeToMessages: windows.subscribe('scene'), postToParent: windows.postToParent(windows.frames.scene),
    setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer,
  });
  const detail = new DigitalTwinInspectionController({
    parentWindow: windows.parent, viewerOrigin: windows.viewerOrigin,
    subscribeToMessages: windows.subscribe('detail'), postToParent: windows.postToParent(windows.frames.detail),
    load: (payload, signal) => { signal.throwIfAborted(); loads.push(payload); },
    selectPart: (payload, signal) => {
      signal.throwIfAborted();
      operations.push(payload);
      if (payload.partKey === deferredPart) {
        return new Promise(resolve => {
          deferredSelection = { signal, resolve: () => {
            if (!signal.aborted) detail.notifyPartSelected(payload);
            resolve();
          } };
        });
      }
      assert.equal(detail.notifyPartSelected(payload), true);
    },
    setProgress: () => {}, reset: () => {},
  });
  const runtime = createSceneRuntime(targets, () => scene);
  const trace = type => windows.trace.filter(entry => entry.data.type === type);
  const currentPayload = () => selections.at(-1)?.payload;
  const identity = () => {
    const selected = coordinator.getInspectionSelection();
    assert.ok(selected);
    return { loadId: selected.loadId, assetCode: selected.assetCode };
  };
  const beginFocus = async (assetCode, partKey) => {
    coordinator.focusAsset('records', 'scene', assetCode, partKey);
    await windows.drain();
  };
  const completeFocus = async () => { runtime.completeFocus(); await windows.drain(); };
  const navigate = async (assetCode, partKey) => { await beginFocus(assetCode, partKey); await completeFocus(); };

  try {
    // 仿真宿主的详情面板：收到场景打开事件后，将该真实载荷交给详情 bridge。
    coordinator.registerRuntime('scene', sceneBridge);
    coordinator.registerRuntime('detail', detailBridge);
    sceneBridge.subscribe(event => {
      if (event.type !== 'inspectionOpen') return;
      opens.push(event.payload);
      loadResults.push(detailBridge.submitInspection({ type: 'command.inspectionLoad', payload: event.payload }));
    });
    scene.setAllowedParentOrigins([windows.hostOrigin]);
    detail.setAllowedParentOrigins([windows.hostOrigin]);
    scene.markViewerReady(runtime);
    detail.markViewerReady();
    sceneBridge.configureTarget({ origin: windows.viewerOrigin, getContentWindow: () => windows.frames.scene });
    detailBridge.configureTarget({ origin: windows.viewerOrigin, getContentWindow: () => windows.frames.detail });
    sceneBridge.handleIframeLoad();
    detailBridge.handleIframeLoad();
    await windows.drain();
    assert.equal(sceneBridge.getState().phase, 'viewerReady');
    assert.equal(detailBridge.getState().phase, 'viewerReady');
    assert.equal(sceneBridge.getState().inspection.phase, 'ready');
    assert.equal(detailBridge.getState().inspection.phase, 'ready');
    assert.ok(detailBridge.getState().inspection.capabilities.includes('selectionCause'));
    assert.ok(detailBridge.getState().inspection.capabilities.includes('cancelSelect'));
    const handshakes = trace('host.hello');
    assert.equal(handshakes.length, 2);
    assert.notEqual(handshakes[0].data.sessionId, handshakes[1].data.sessionId);

    scene.notifyInspectionDeviceSelected({ assetCode: 'PUMP-A', entityId: 'entity-a', device: targets['PUMP-A'].inspection.device });
    await windows.drain();
    assert.deepEqual(currentPayload(), { assetCode: 'PUMP-A', entityId: 'entity-a', namespace: 'site', deviceType: 'pump', deviceNo: '0008' });
    await navigate('PUMP-A', 'part-0001');
    assert.equal(trace('command.openInspectionAsset').length, 1);
    assert.equal(trace('command.inspectionLoad').length, 1);
    assert.equal(loads.length, 1);
    assert.equal(loads[0].inspection.parts.length, 600);
    assert.deepEqual(await loadResults[0], { ok: true });
    assert.equal(coordinator.getInspectionSelection()?.partKey, 'part-0001');
    assert.deepEqual(currentPayload(), { assetCode: 'PUMP-A', entityId: 'entity-a', namespace: 'site', deviceType: 'pump', deviceNo: '0008', partKey: 'part-0001' });
    assert.equal(coordinator.getSnapshot().searchStates.records.phase, 'idle');

    // 手动选中事件没有请求因果，仍须按当前设备正常传播。
    assert.equal(detail.notifyPartSelected({ ...identity(), partKey: 'part-0002' }), true);
    await windows.drain();
    const manualA = trace('event.inspectionPartSelected').at(-1).data;
    assert.equal(manualA.payload.causeRequestId, undefined);
    assert.equal(coordinator.getInspectionSelection()?.partKey, 'part-0002');

    // 记录定位途中再选另一条，旧详情操作必须收到取消信号。
    deferredPart = 'part-0003';
    await navigate('PUMP-A', deferredPart);
    assert.ok(deferredSelection);
    assert.equal(deferredSelection.signal.aborted, false);
    await beginFocus('PUMP-A', 'part-0004');
    assert.equal(deferredSelection.signal.aborted, true);
    assert.ok(trace('command.inspectionCancelSelect').length > 0);
    deferredSelection.resolve();
    await windows.drain();
    await completeFocus();
    assert.equal(coordinator.getInspectionSelection()?.partKey, 'part-0004');
    assert.equal(coordinator.getSnapshot().searchStates.records.phase, 'idle');
    assert.equal(trace('command.openInspectionAsset').length, 1);
    assert.equal(trace('command.inspectionLoad').length, 1);

    // 延迟转发旧的真实零件事件，随后完成另一条记录定位并确认旧事件被过滤。
    windows.holdNext = item => item.event.data.type === 'event.inspectionPartSelected'
      && item.event.data.payload.partKey === 'part-0005';
    await navigate('PUMP-A', 'part-0005');
    assert.equal(windows.held.length, 1);
    assert.ok(windows.held[0].event.data.payload.causeRequestId);
    await navigate('PUMP-A', 'part-0006');
    assert.equal(coordinator.getInspectionSelection()?.partKey, 'part-0006');
    const selectionCount = selections.length;
    windows.queue.push(windows.held.shift());
    await windows.drain();
    assert.equal(selections.length, selectionCount);
    assert.equal(coordinator.getInspectionSelection()?.partKey, 'part-0006');
    assert.equal(trace('command.openInspectionAsset').length, 1);
    assert.equal(trace('command.inspectionLoad').length, 1);

    // 新设备使用新加载代次；即使来源窗口正确，旧设备事件也不能改写当前上下文。
    assert.equal(scene.openInspection({ assetCode: 'PUMP-B', entityId: 'entity-b', inspection: targets['PUMP-B'].inspection }), true);
    await windows.drain();
    assert.equal(opens.length, 2);
    assert.equal(loads.length, 2);
    assert.deepEqual(await loadResults[1], { ok: true });
    assert.notEqual(opens[0].loadId, opens[1].loadId);
    windows.enqueueHost(manualA, windows.frames.detail);
    await windows.drain();
    assert.equal(coordinator.getInspectionSelection()?.assetCode, 'PUMP-B');
    assert.equal(coordinator.getInspectionSelection()?.partKey, null);
    assert.equal(detail.notifyPartSelected({ ...identity(), partKey: 'part-0010' }), true);
    await windows.drain();
    const manualB = trace('event.inspectionPartSelected').at(-1).data;
    const bIdentity = identity();
    const countBeforeInvalid = selections.length;
    windows.enqueueHost(manualB, {}, windows.viewerOrigin);
    windows.enqueueHost(manualB, windows.frames.detail, 'https://untrusted.example');
    await windows.drain();
    assert.equal(selections.length, countBeforeInvalid);
    assert.equal(coordinator.getInspectionSelection()?.partKey, 'part-0010');

    assert.equal(detail.notifyClosed(bIdentity), true);
    await windows.drain();
    assert.equal(coordinator.getInspectionSelection(), null);
    assert.deepEqual(currentPayload(), { assetCode: 'PUMP-B', entityId: 'entity-b', namespace: 'site', deviceType: 'pump', deviceNo: '0009' });
    const countAfterClose = selections.length;
    windows.enqueueHost(manualB, windows.frames.detail);
    await windows.drain();
    assert.equal(selections.length, countAfterClose);
    assert.equal(coordinator.getInspectionSelection(), null);

    // 场景 iframe 重载后，同一窗口发来的旧会话消息必须失效。
    const previousOpen = trace('event.openInspection').at(-1).data;
    const previousSession = previousOpen.sessionId;
    sceneBridge.handleIframeLoad();
    await windows.drain();
    assert.equal(sceneBridge.getState().inspection.phase, 'ready');
    assert.notEqual(trace('host.hello').at(-1).data.sessionId, previousSession);
    const openCount = opens.length;
    windows.enqueueHost(previousOpen, windows.frames.scene);
    await windows.drain();
    assert.equal(opens.length, openCount);
    assert.equal(coordinator.getInspectionSelection(), null);
    assert.deepEqual(currentPayload(), { assetCode: 'PUMP-B', entityId: 'entity-b', namespace: 'site', deviceType: 'pump', deviceNo: '0009' });
  } finally {
    coordinator.dispose();
    sceneBridge.dispose();
    detailBridge.dispose();
    scene.dispose();
    detail.dispose();
    assert.equal(scheduler.tasks.size, 0);
  }
});

test('平台版本加载与普通低模上下文跨仓兼容，快速切换丢弃旧加载', async () => {
  const { DigitalTwinInteractionController, DigitalTwinInspectionController, DigitalTwinIframeBridgeController } = await loadControllers();
  const windows = new MessageWindows();
  const scheduler = new FakeScheduler();
  const loads = [];
  const sceneEvents = [];
  const detailEvents = [];
  let completeOld;
  const bridges = {};
  for (const role of ['scene', 'detail']) {
    bridges[role] = new DigitalTwinIframeBridgeController({
      runtimeWidgetId: role, endpointRole: role,
      subscribeToMessages: windows.subscribe('host'), postToFrame: windows.postToFrame,
      createSessionId: () => `${role}-platform-session`,
      setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer,
    });
  }
  const scene = new DigitalTwinInteractionController({
    parentWindow: windows.parent, viewerOrigin: windows.viewerOrigin,
    subscribeToMessages: windows.subscribe('scene'), postToParent: windows.postToParent(windows.frames.scene),
    setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer,
  });
  const detail = new DigitalTwinInspectionController({
    parentWindow: windows.parent, viewerOrigin: windows.viewerOrigin,
    subscribeToMessages: windows.subscribe('detail'), postToParent: windows.postToParent(windows.frames.detail),
    load(payload, signal) {
      loads.push({ payload, signal });
      if (payload.loadId === 'old') return new Promise(resolve => { completeOld = resolve; });
    },
    selectPart() {}, setProgress() {}, reset() {},
  });
  try {
    bridges.scene.subscribe(event => sceneEvents.push(event));
    bridges.detail.subscribe(event => detailEvents.push(event));
    scene.setAllowedParentOrigins([windows.hostOrigin]);
    detail.setAllowedParentOrigins([windows.hostOrigin]);
    scene.markViewerReady(createSceneRuntime({}, () => scene));
    detail.markViewerReady();
    for (const role of ['scene', 'detail']) {
      bridges[role].configureTarget({ origin: windows.viewerOrigin, getContentWindow: () => windows.frames[role] });
      bridges[role].handleIframeLoad();
    }
    await windows.drain();
    assert.ok(bridges.scene.getState().inspection.capabilities.includes('deviceContext'));
    assert.ok(bridges.detail.getState().inspection.capabilities.includes('modelVersionLoad'));
    scene.notifyDeviceContext({ assetCode: 'PUMP-01', entityId: 'e1', deviceType: 'PUMP' });
    await windows.drain();
    assert.deepEqual(sceneEvents.find(event => event.type === 'deviceContext')?.payload,
      { assetCode: 'PUMP-01', entityId: 'e1', deviceType: 'PUMP' });
    const load = loadId => ({ loadId, assetCode: loadId === 'old' ? 'PUMP-01' : 'PUMP-02', entityId: loadId,
      inspection: { schemaVersion: 2, source: 'model-version', device: { deviceType: 'PUMP' },
        model: { modelId: '2052962163445780481', versionId: '2052962163445780482',
          fileUrl: 'https://platform.example/api/v1/files/pump-v1.glb', fileExtension: '.glb', unitScaleToMeters: 1 },
        parts: makeBinding('unused').parts,
      } });
    const oldResult = bridges.detail.submitInspection({ type: 'command.inspectionLoadModelVersion', payload: load('old') });
    await windows.drain();
    assert.equal(loads.length, 1);
    const newResult = bridges.detail.submitInspection({ type: 'command.inspectionLoadModelVersion', payload: load('new') });
    await windows.drain();
    assert.equal(loads[0].signal.aborted, true);
    assert.deepEqual(await newResult, { ok: true });
    assert.equal((await oldResult).ok, false);
    completeOld();
    await windows.drain();
    assert.deepEqual(detailEvents.filter(event => event.type === 'inspectionLoaded').map(event => event.payload.loadId), ['new']);
    assert.equal(loads[1].payload.inspection.model.versionId, '2052962163445780482');
    assert.equal(loads[1].payload.inspection.device.namespace, undefined);
    scene.notifyDeviceContext(null);
    await windows.drain();
    assert.equal(sceneEvents.filter(event => event.type === 'deviceContext').at(-1).payload, null);
  } finally {
    completeOld?.();
    bridges.scene.dispose(); bridges.detail.dispose(); scene.dispose(); detail.dispose();
    assert.equal(scheduler.tasks.size, 0);
  }
});
