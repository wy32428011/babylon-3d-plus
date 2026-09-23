import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [runtimeModule, mappingModule, telemetryModule, contract] = await importIsolatedTypeScriptModules<readonly [typeof import('../../src/runtime/effects/EffectDataRuntime'), typeof import('../../src/editor/model/effectDataMapping'), typeof import('../../src/runtime/mqtt/deviceTelemetry'), typeof import('../../electron/shared/effectDataContract')]>(['src/runtime/effects/EffectDataRuntime.ts', 'src/editor/model/effectDataMapping.ts', 'src/runtime/mqtt/deviceTelemetry.ts', 'electron/shared/effectDataContract.ts']);
const { EffectDataRuntime } = runtimeModule;
const binding = (mode: string = 'mqtt'): any => ({ mode, sourceId: 'factory-a', deviceType: 'rgv', assetCode: '000317', expectedIntervalMs: 1000, staleAfterMs: 5000, missing: 'pause', http: { mode: 'data-source', dataSourceId: '42', namespace: 'space-a', pollIntervalMs: 1000, timeoutMs: 2000 }, mappings: [], dataset: { enabled: false, rowsPath: '', idPath: 'id', xPath: 'x', yPath: 'y', zPath: 'z', valuePath: 'value', labelPath: 'name' }, trigger: { enabled: false, field: '', operator: 'eq', value: '', debounceMs: 0 } });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('MQTT requires complete source/type/asset identity and honors source and receive freshness', () => {
  const store = new telemetryModule.DeviceTelemetryStore();
  const rt = new EffectDataRuntime({ telemetryStore: store });
  for (const sourceId of ['factory-a', 'factory-b']) {
    const snapshot = telemetryModule.parseDeviceTelemetryMessage('dt/factory/logistics/rgv/000317/twindatadriven/joint', JSON.stringify({ data: [{ e: '000317', p: 'speed', v: sourceId === 'factory-a' ? 0 : 9 }] }), { kind: 'epv', sourceId })!;
    store.upsert({ ...snapshot, receivedAt: 10000, sourceTimestamp: 9900 });
  }
  assert.equal(rt.read(binding(), null, true, 11000).fields.speed, 0);
  assert.equal(rt.read({ ...binding(), sourceId: '' }, null, true, 11000).status, 'invalid');
  assert.equal(rt.read(binding(), null, true, 16000).status, 'stale');
  rt.dispose();
});

test('HTTP requests share full identity and preserve leading-zero IDs; inactive reads never request', async () => {
  const calls: any[] = []; let now = 10000;
  const rt = new EffectDataRuntime({ clock: () => now, transport: async request => { calls.push(request); return { success: true, data: { statusCode: 200, responseBody: JSON.stringify({ speed: 0 }) } }; } });
  const config = binding('http');
  assert.equal(rt.read(config, null, false).status, 'waiting'); assert.equal(calls.length, 0);
  rt.read(config, null, true); rt.read(config, null, true); await flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].assetCode, '000317');
  assert.equal(rt.read(config, null, true).fields.speed, 0);
  now = 10500; rt.read(config, null, true); assert.equal(calls.length, 1); rt.dispose();
});

test('HTTP policy changes can increase polling interval and apply the new timeout to later requests', async () => {
  let now = 10000; const calls: { request: any; at: number }[] = [];
  const rt = new EffectDataRuntime({ clock: () => now, transport: async request => { calls.push({ request, at: now }); return { success: true, data: { statusCode: 200, responseBody: '{}' } }; } });
  const fast = binding('http'); fast.http.pollIntervalMs = 500; fast.http.timeoutMs = 1000;
  rt.read(fast, null, true); await flush(); rt.releaseUnused();
  const slow = { ...fast, http: { ...fast.http, pollIntervalMs: 30000, timeoutMs: 30000 } };
  now = 10500; rt.read(slow, null, true); await flush(); rt.releaseUnused(); assert.equal(calls.length, 1);
  now = 40000; rt.read(slow, null, true); await flush(); rt.releaseUnused();
  assert.deepEqual(calls.map(call => [call.at, call.request.timeoutMs]), [[10000, 1000], [40000, 30000]]);
  now = 40500; rt.read(slow, null, true); await flush(); rt.releaseUnused(); assert.equal(calls.length, 2);
  rt.dispose();
});

test('shared HTTP readers use shortest active policy and relax it after the faster reader leaves', async () => {
  let now = 10000; const calls: { request: any; at: number }[] = [];
  const rt = new EffectDataRuntime({ clock: () => now, transport: async request => { calls.push({ request, at: now }); return { success: true, data: { statusCode: 200, responseBody: '{}' } }; } });
  const fast = binding('http'); fast.http.pollIntervalMs = 500; fast.http.timeoutMs = 1000;
  const slow = { ...fast, http: { ...fast.http, pollIntervalMs: 5000, timeoutMs: 8000 } };
  assert.equal(rt.read(fast, null, true).key, rt.read(slow, null, true).key); await flush(); rt.releaseUnused();
  now = 10500; rt.read(fast, null, true); rt.read(slow, null, true); await flush(); rt.releaseUnused();
  assert.equal(calls.length, 2);
  now = 11000; rt.read(slow, null, true); await flush(); rt.releaseUnused(); assert.equal(calls.length, 2);
  now = 15500; rt.read(slow, null, true); await flush(); rt.releaseUnused();
  assert.deepEqual(calls.map(call => [call.at, call.request.timeoutMs]), [[10000, 1000], [10500, 1000], [15500, 8000]]);
  rt.dispose();
});

test('an in-flight HTTP request keeps its starting timeout and the next attempt uses the new policy', async () => {
  let now = 10000; const calls: any[] = [];
  const rt = new EffectDataRuntime({ clock: () => now, transport: request => { calls.push(request); return calls.length === 1 ? new Promise(() => undefined) : Promise.resolve({ success: true, data: { statusCode: 200, responseBody: '{}' } }); } });
  const original = binding('http'); original.http.pollIntervalMs = 500; original.http.timeoutMs = 100;
  rt.read(original, null, true); rt.releaseUnused();
  const changed = { ...original, http: { ...original.http, timeoutMs: 2000 } };
  rt.read(changed, null, true); rt.releaseUnused(); await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(rt.read(changed, null, false).status, 'error'); assert.equal(calls[0].timeoutMs, 100);
  now = 10500; rt.read(changed, null, true); await flush(); rt.releaseUnused();
  assert.equal(calls.length, 2); assert.equal(calls[1].timeoutMs, 2000); assert.equal(rt.read(changed, null, false).status, 'online'); rt.dispose();
});

test('relaxing a queued reader postpones its request without consuming extra concurrency', async () => {
  let now = 10000; const calls: string[] = []; let resolveBusy: ((value: unknown) => void) | undefined;
  const reply = { success: true, data: { statusCode: 200, responseBody: '{}' } };
  const rt = new EffectDataRuntime({ clock: () => now, maxConcurrent: 1, transport: request => { calls.push(request.assetCode); return request.assetCode === 'busy' ? new Promise(resolve => { resolveBusy = resolve; }) : Promise.resolve(reply); } });
  const fast = binding('http'); fast.http.pollIntervalMs = 500;
  rt.read(fast, null, true); await flush(); rt.releaseUnused();
  now = 10500; rt.read({ ...fast, assetCode: 'busy' }, null, true); rt.read(fast, null, true); rt.releaseUnused();
  const slow = { ...fast, http: { ...fast.http, pollIntervalMs: 30000 } };
  rt.read(slow, null, true); resolveBusy!(reply); await flush(); rt.releaseUnused();
  assert.deepEqual(calls, ['000317', 'busy']);
  now = 40000; rt.read(slow, null, true); await flush(); rt.releaseUnused();
  assert.deepEqual(calls, ['000317', 'busy', '000317']); rt.dispose();
});

test('released HTTP responses cannot repopulate cache and active requests have bounded concurrency', async () => {
  const pending: { resolve: (value: unknown) => void; signal: AbortSignal }[] = [];
  const rt = new EffectDataRuntime({ maxConcurrent: 1, transport: (_request, signal) => new Promise(resolve => pending.push({ resolve, signal })) });
  rt.read(binding('http'), null, true);
  const second = rt.read({ ...binding('http'), assetCode: 'b' }, null, true);
  assert.equal(pending.length, 1); rt.releaseUnused([second.key]); assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve({ success: true, data: { statusCode: 200, responseBody: '{}' } }); await flush();
  assert.equal(pending.length, 2); pending[1].resolve({ success: true, data: { statusCode: 200, responseBody: '{}' } }); await flush();
  assert.equal(rt.read(binding('http'), null, false).status, 'waiting'); rt.dispose();
});

test('safe mapping preserves missing values, zero and immutable component; rejects unsafe paths', () => {
  const data = binding(); data.mappings = [{ field: 'speed', target: 'speed', scale: 0.1, offset: 0, values: [] }, { field: 'missing', target: 'intensity', scale: 1, offset: 0, values: [] }, { field: '__proto__.polluted', target: 'enabled', scale: 1, offset: 0, values: [] }];
  const component: any = { effectKind: 'flow-arrows', enabled: true, primaryColor: '#00ffff', secondaryColor: '#ffffff', speed: 3, intensity: 2, density: 1, configuration: { version: 2, data, parameters: {} } };
  const result: any = { status: 'online', fields: { speed: 0 }, receivedAt: 1, message: '', key: 'k' };
  const mapped = mappingModule.applyEffectDataMappings(component, result);
  assert.equal(mapped.component.speed, 0); assert.equal(mapped.component.intensity, 2); assert.equal(component.speed, 3); assert.equal(mapped.issues.length, 2);
});

test('dataset ordering is stable by string ID; duplicate IDs and invalid numeric fields produce diagnostics', () => {
  const data = binding(); data.dataset.enabled = true; data.dataset.rowsPath = 'rows';
  const component: any = { effectKind: 'data-bars', enabled: true, primaryColor: '#00ffff', secondaryColor: '#ffffff', speed: 1, intensity: 1, density: 1, visual: { points: [], values: [], labels: [] }, configuration: { version: 2, data, parameters: {} } };
  const rows = [{ id: 'b', x: 2, y: 0, z: 0, value: 4, name: 'B' }, { id: 'a', x: 1, y: 0, z: 0, value: 0, name: 'A' }, { id: 'a', x: 0, y: 0, z: 0, value: 3 }, { id: 'c', x: null, y: 0, z: 0, value: 2 }];
  const mapped = mappingModule.applyEffectDataMappings(component, { status: 'online', fields: { rows }, data: { rows }, receivedAt: 1, message: '', key: 'k' });
  assert.deepEqual(mapped.component.visual!.values, [0, 4]); assert.deepEqual(mapped.component.visual!.labels, ['A', 'B']); assert.equal(mapped.issues.length, 2);
});

test('request contract rejects arbitrary destinations, headers and numeric asset identifiers', () => {
  const request = { requestId: 'read_1', mode: 'data-source', dataSourceId: '123', assetCode: '000317', timeoutMs: 1000 };
  assert.throws(() => contract.validateEffectDataRequest({ ...request, url: 'https://invalid.example' }));
  assert.throws(() => contract.validateEffectDataRequest({ ...request, headers: { Authorization: 'fixture' } }));
  assert.throws(() => contract.validateEffectDataRequest({ ...request, assetCode: 317 }));
  assert.throws(() => contract.validateEffectDataRequest({ ...request, dataSourceId: '../detail' }));
  assert.deepEqual(contract.effectDataEndpoint(request as any), { path: 'api/v1/data-sources/fetch', body: { id: '123', runParams: { assetCode: '000317' } } });
  assert.throws(() => contract.validateEffectDataRequest({ requestId: 'r', mode: 'mqtt-latest', namespace: '', deviceType: 'rgv', assetCode: '000317', timeoutMs: 1000 }));
});

test('MQTT source timestamp can expire while broker delivery time is recent', () => {
  const snapshot = telemetryModule.parseDeviceTelemetryMessage('dt/factory/logistics/rgv/000317/twindatadriven/joint', '{"data":[]}', { kind: 'epv', sourceId: 'factory-a' })!;
  const rt = new EffectDataRuntime({ telemetryStore: { getSnapshot: () => ({ ...snapshot, receivedAt: 10000, sourceTimestamp: 1000 }) } });
  assert.equal(rt.read(binding(), null, true, 10000).status, 'stale');
  assert.equal(rt.read({ ...binding(), mode: 'inherit' }, { sourceId: 'factory-a', deviceType: 'rgv', assetCode: '000317' }, true, 10000).status, 'stale');
  rt.dispose();
});

test('latest MQTT HTTP unwraps payloadJson through existing EPV parser and verifies device identity', () => {
  const request: any = { requestId: 'r', mode: 'mqtt-latest', namespace: 'space', deviceType: 'rgv', assetCode: '000317', timeoutMs: 1000 };
  const response: any = { success: true, data: { device: { namespace: 'space', deviceType: 'rgv', deviceNo: '000317', lastSuccessAt: '2026-01-01T00:00:00Z' }, payloadJson: JSON.stringify({ data: [{ e: '000317', p: 'speed', v: 0 }, { e: 'other', p: 'speed', v: 99 }] }) } };
  assert.equal(runtimeModule.parseEffectDataResponse(response, request).fields.speed, 0);
  assert.equal(runtimeModule.parseEffectDataResponse(response, request).sourceTimestamp, Date.parse('2026-01-01T00:00:00Z'));
  assert.throws(() => runtimeModule.parseEffectDataResponse({ ...response, data: { ...response.data, device: { ...response.data.device, deviceNo: '317' } } }, request));
  assert.throws(() => runtimeModule.parseEffectDataResponse({ ...response, data: { ...response.data, payloadJson: '{invalid' } }, request));
});

test('HTTP missing, malformed and non-2xx source replies produce explicit diagnostics and retry with bounded polling', async () => {
  let now = 10000; const responses = [{ success: false, code: 'DATA_FLOW_MQTT_DATA_NOT_FOUND', message: 'ignored response text' }, { success: true, data: { statusCode: 503, responseBody: '{}' } }, { success: true, data: { statusCode: 200, responseBody: 'invalid' } }];
  const rt = new EffectDataRuntime({ clock: () => now, transport: async () => responses.shift() });
  const config = binding('http'); rt.read(config, null, true); await flush();
  assert.equal(rt.read(config, null, true).status, 'missing');
  now += 1001; rt.read(config, null, true); await flush(); assert.match(rt.read(config, null, true).message, /503/);
  now += 1001; rt.read(config, null, true); await flush(); assert.match(rt.read(config, null, true).message, /JSON/); rt.dispose();
});

test('HTTP cache and concurrency are bounded; disposal aborts active and queued work', async () => {
  const signals: AbortSignal[] = [];
  const rt = new EffectDataRuntime({ maxEntries: 2, maxConcurrent: 1, transport: (_request, signal) => { signals.push(signal); return new Promise(() => undefined); } });
  rt.read(binding('http'), null, true); rt.read({ ...binding('http'), assetCode: '2' }, null, true);
  assert.equal(rt.read({ ...binding('http'), assetCode: '3' }, null, true).status, 'invalid'); assert.equal(signals.length, 1);
  rt.dispose(); await flush(); assert.equal(signals[0].aborted, true); assert.equal(signals.length, 1);
});

test('field mappings reject stale samples and invalid sink values; parameter whitelist is enforced', () => {
  const data = binding(); data.mappings = [{ field: 'value', target: 'configuration.parameters.radius', scale: 1, offset: 0, values: [] }, { field: 'text', target: 'primaryColor', scale: 1, offset: 0, values: [] }, { field: 'value', target: 'configuration.target.entityId', scale: 1, offset: 0, values: [] }];
  const component: any = { effectKind: 'radar-sector', enabled: true, primaryColor: '#00ffff', speed: 1, configuration: { version: 2, data, parameters: { radius: 2 } } };
  const result: any = { status: 'online', fields: { value: 5, text: 'url(invalid)' }, receivedAt: 1, message: '', key: 'k' };
  const definitions: any[] = [{ key: 'radius', label: '半径', type: 'number', min: 1, max: 10, bindable: true }];
  const mapped = mappingModule.applyEffectDataMappings(component, result, { parameterDefinitions: definitions });
  assert.equal(mapped.component.configuration!.parameters.radius, 5); assert.equal(component.configuration.parameters.radius, 2); assert.equal(mapped.issues.length, 2);
  assert.equal(mappingModule.applyEffectDataMappings(component, { ...result, status: 'stale' }).component, component);
  assert.equal(mappingModule.readEffectField(Object.create({ inherited: 3 }), 'inherited'), undefined);
  assert.equal(mappingModule.readEffectField({ nested: [0] }, 'nested[0]'), 0);
  const overSpeed = { ...component, configuration: { ...component.configuration, data: { ...data, mappings: [{ field: 'value', target: 'speed', scale: 100, offset: 0, values: [] }] } } };
  const overSpeedResult = mappingModule.applyEffectDataMappings(overSpeed, result);
  assert.equal(overSpeedResult.component.speed, 1); assert.equal(overSpeedResult.issues.length, 1);
});

test('dataset supports array root and region IDs without mismatching geometry', () => {
  const data = binding(); data.dataset.enabled = true; data.dataset.rowsPath = '$';
  const component: any = { effectKind: 'region-level', configuration: { version: 2, data, parameters: { regions: [{ id: 'b', points: [1] }, { id: 'a', points: [2] }] } } };
  const rows = [{ id: 'a', x: 0, y: 0, z: 0, value: 7, name: 'A' }, { id: 'b', x: 4, y: 0, z: 0, value: 3, name: 'B' }];
  const mapped = mappingModule.applyEffectDataMappings(component, { status: 'online', fields: {}, data: rows, receivedAt: 1, message: '', key: 'k' });
  assert.deepEqual(mapped.component.configuration!.parameters.regions, [{ id: 'b', points: [1], value: 3, name: 'B' }, { id: 'a', points: [2], value: 7, name: 'A' }]);
  assert.equal(mapped.component.visual, undefined, '显式多边形无需重建中心点几何');
});

test('bindable vector parameters accept complete vectors and convert all axes without changing authored offsets', () => {
  const data = binding();
  data.mappings = [{ field: 'camera', target: 'configuration.parameters.cameraOffset', scale: .001, offset: .5, values: [] }, { field: 'target', target: 'configuration.parameters.targetOffset', scale: 2, offset: -1, values: [] }];
  const component: any = { effectKind: 'target-follow', configuration: { version: 2, data, parameters: { cameraOffset: { x: 0, y: 3, z: -5 }, targetOffset: { x: 0, y: 0, z: 0 } } } };
  const definitions: any[] = ['cameraOffset', 'targetOffset'].map(key => ({ key, label: key, type: 'vector', bindable: true }));
  const result: any = { status: 'online', fields: { camera: { x: 1000, y: 2000, z: -3000 }, target: { x: 1, y: 0, z: 3 } }, key: 'one', receivedAt: 1, message: '' };
  const mapped = mappingModule.applyEffectDataMappings(component, result, { parameterDefinitions: definitions });
  assert.deepEqual(mapped.issues, []);
  assert.deepEqual(mapped.component.configuration!.parameters.cameraOffset, { x: 1.5, y: 2.5, z: -2.5 });
  assert.deepEqual(mapped.component.configuration!.parameters.targetOffset, { x: 1, y: -1, z: 5 });
  assert.deepEqual(component.configuration.parameters.cameraOffset, { x: 0, y: 3, z: -5 });
  assert.notEqual(mapped.component.configuration!.parameters.cameraOffset, result.fields.camera);
});

test('vector mapping rejects missing axes, functions, prototype data, accessors and out-of-range results', () => {
  const data = binding(); data.mappings = [{ field: 'offset', target: 'configuration.parameters.cameraOffset', scale: 1, offset: 0, values: [] }];
  const initial = { x: 0, y: 3, z: -5 };
  const component: any = { effectKind: 'target-follow', configuration: { version: 2, data, parameters: { cameraOffset: initial } } };
  const definitions: any[] = [{ key: 'cameraOffset', label: 'cameraOffset', type: 'vector', bindable: true }];
  let getterReads = 0;
  const accessor = { y: 2, z: 3 }; Object.defineProperty(accessor, 'x', { enumerable: true, get() { getterReads++; return 1; } });
  const invalid = [{ x: 1, y: 2 }, () => ({ x: 1, y: 2, z: 3 }), { x: Infinity, y: 2, z: 3 }, { x: 100001, y: 2, z: 3 }, Object.assign(Object.create({ x: 1 }), { y: 2, z: 3 }), JSON.parse('{"x":1,"y":2,"z":3,"__proto__":{"bad":true}}'), accessor];
  for (const offset of invalid) {
    const mapped = mappingModule.applyEffectDataMappings(component, { status: 'online', fields: { offset }, receivedAt: 1, message: '', key: 'k' }, { parameterDefinitions: definitions });
    assert.equal(mapped.issues.length, 1); assert.deepEqual(mapped.component.configuration!.parameters.cameraOffset, initial);
  }
  assert.equal(getterReads, 0, '非法 accessor 不能被执行');
  const mapped = mappingModule.applyEffectDataMappings(component, { status: 'online', fields: { offset: { x: 1, y: 2, z: 3 } }, receivedAt: 1, message: '', key: 'k' }, { parameterDefinitions: [{ ...definitions[0], bindable: false }] });
  assert.equal(mapped.issues.length, 1);
});

test('existing region polygons update by ID from value-only records and use runtime name field', () => {
  const data = binding(); data.dataset.enabled = true; data.dataset.rowsPath = 'rows';
  const pointsA = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }], pointsB = [{ x: 2, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 3, y: 0, z: 1 }];
  const component: any = { effectKind: 'region-level', visual: { points: [{ x: 99, y: 0, z: 99 }], values: [99], labels: ['原始采样点'] }, configuration: { version: 2, data, parameters: { regions: [{ id: 'b', name: '原 B', value: 5, points: pointsB }, { id: 'a', name: '原 A', value: 6, points: pointsA }] } } };
  const mapped = mappingModule.applyEffectDataMappings(component, { status: 'online', fields: { rows: [{ id: 'a', value: 0, name: '新 A' }, { id: 'b', value: 12 }, { id: 'unknown', value: 3 }] }, receivedAt: 1, message: '', key: 'k' });
  assert.deepEqual(mapped.component.configuration!.parameters.regions, [{ id: 'b', name: '原 B', value: 12, points: pointsB }, { id: 'a', name: '新 A', value: 0, points: pointsA }]);
  assert.deepEqual(component.configuration.parameters.regions[1], { id: 'a', name: '原 A', value: 6, points: pointsA });
  assert.deepEqual(mapped.component.visual, component.visual);
  assert.equal(mapped.issues.length, 1); assert.match(mapped.issues[0], /unknown/);
});

test('point datasets still reject missing coordinates instead of placing samples at the origin', () => {
  const data = binding(); data.dataset.enabled = true; data.dataset.rowsPath = 'rows';
  for (const kind of ['heatmap', 'data-bars', 'region-level']) {
    const component: any = { effectKind: kind, configuration: { version: 2, data, parameters: {} } };
    const mapped = mappingModule.applyEffectDataMappings(component, { status: 'online', fields: { rows: [{ id: 'a', value: 4 }, { id: 'b', x: 1, z: 2, value: 3 }] }, receivedAt: 1, message: '', key: 'k' });
    assert.equal(mapped.issues.length, 2); assert.deepEqual(mapped.component.visual!.points, []);
  }
});

test('dataset coordinates convert millimeters to meters and preserve requested coordinate space', () => {
  const data = binding(); data.dataset = { ...data.dataset, enabled: true, rowsPath: 'rows', unitScale: .001, coordinateSpace: 'world' };
  const component: any = { effectKind: 'data-bars', configuration: { version: 2, data, parameters: {} } };
  const result: any = { status: 'online', fields: { rows: [{ id: 'A', x: 12000, y: 1500, z: -2000, value: 10 }] }, key: 'key', receivedAt: 1, message: '' };
  const mapped = mappingModule.applyEffectDataMappings(component, result);
  assert.deepEqual(mapped.component.visual!.points, [{ x: 12, y: 1.5, z: -2 }]);
  assert.equal(mapped.component.configuration!.data.dataset.coordinateSpace, 'world');
  assert.equal(component.visual, undefined);
  assert.equal(mappingModule.applyEffectDataMappings({ ...component, configuration: { ...component.configuration, data: { ...data, dataset: { ...data.dataset, unitScale: 0 } } } }, result).issues.length, 1);
});

test('trigger debounces both transitions, resets on target change and never equates missing data to zero', () => {
  const config = binding(); config.trigger = { enabled: true, field: 'speed', operator: 'gt', value: '0', debounceMs: 100 };
  const sample: any = { status: 'online', fields: { speed: 1 }, key: 'one', receivedAt: 0, message: '' };
  let result = mappingModule.evaluateEffectTrigger(config, sample, mappingModule.createEffectTriggerState(), 0);
  assert.equal(result.active, false); result = mappingModule.evaluateEffectTrigger(config, sample, result.state, 100); assert.equal(result.active, true);
  result = mappingModule.evaluateEffectTrigger(config, { ...sample, fields: { speed: 0 } }, result.state, 150); assert.equal(result.active, true);
  result = mappingModule.evaluateEffectTrigger(config, { ...sample, fields: { speed: 0 } }, result.state, 250); assert.equal(result.active, false);
  assert.equal(mappingModule.evaluateEffectTrigger(config, { ...sample, key: 'two' }, result.state, 251).active, false);
  assert.equal(mappingModule.evaluateEffectTrigger(config, { ...sample, fields: {} }, result.state, 999).active, false);
});

test('browser transport calls only fixed configured endpoints and unwraps actual HTTP responses', async () => {
  const received: { path: string | undefined; method: string | undefined; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk.toString();
    received.push({ path: request.url, method: request.method, body: JSON.parse(text) });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ success: true, data: { statusCode: 200, responseBody: '{"value":0}' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  runtimeModule.configureEffectDataTransport({ apiBaseUrl: `http://127.0.0.1:${address.port}` });
  const rt = new EffectDataRuntime(); const config = binding('http');
  try {
    rt.read(config, null, true);
    let result = rt.read(config, null, true);
    for (let i = 0; i < 100 && result.status === 'waiting'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = rt.read(config, null, true); }
    assert.equal(result.status, 'online'); assert.equal(result.fields.value, 0);
    assert.deepEqual(received, [{ path: '/api/v1/data-sources/fetch', method: 'POST', body: { id: '42', runParams: { assetCode: '000317' } } }]);
  } finally { rt.dispose(); runtimeModule.configureEffectDataTransport(null); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('browser transport rejects credential-bearing bases and HTTP redirects', async () => {
  assert.throws(() => runtimeModule.configureEffectDataTransport({ apiBaseUrl: 'https://user:secret@example.invalid' }));
  assert.throws(() => runtimeModule.configureEffectDataTransport({ apiBaseUrl: 'https://example.invalid/?token=secret' }));
  const server = createServer((_request, response) => { response.writeHead(302, { Location: 'http://127.0.0.1:1/unexpected' }); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  runtimeModule.configureEffectDataTransport({ apiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  const rt = new EffectDataRuntime(); const config = binding('http');
  try {
    rt.read(config, null, true); let result = rt.read(config, null, true);
    for (let i = 0; i < 100 && result.status === 'waiting'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = rt.read(config, null, true); }
    assert.equal(result.status, 'error');
  } finally { rt.dispose(); runtimeModule.configureEffectDataTransport(null); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('HTTP timeout frees capacity and is reported distinctly', async () => {
  const rt = new EffectDataRuntime({ transport: () => new Promise(() => undefined) }); const config = binding('http'); config.http.timeoutMs = 100;
  rt.read(config, null, true); await new Promise(resolve => setTimeout(resolve, 125));
  assert.equal(rt.read(config, null, true).status, 'error'); assert.match(rt.read(config, null, true).message, /超时/); rt.dispose();
});
