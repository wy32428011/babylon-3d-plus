/**
 * S2诊断窗口专用；函数自包含，可直接通过page.evaluate安装。
 * 只读真实Runtime/SDK对象，绝不调用render/isReady/collect/getWorldMatrix，
 * 不包装customRenderFunction或修改PerfCounter。RTT普通before/after也被readiness触发，
 * 因而真正face绘制只按ObjectRenderer的RenderingManager before/after观察。
 */
export function installPhase2ShadowCacheAudit({ runtime, scene, shadowRuntime, maxRecords = 8192, measurementScoped = false, measurementState, exposeGlobal = false } = {}) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100000) throw new Error('S2 maxRecords必须是1..100000整数。');
  runtime ??= globalThis.__phase2ClassificationAudit?.runtime;
  measurementState ??= globalThis.__phase2ClassificationAudit;
  shadowRuntime ??= runtime?.environment?.shadowRuntime;
  scene ??= runtime?.scene ?? shadowRuntime?.scene;
  if (!scene || typeof scene.getEngine !== 'function' || typeof shadowRuntime?.getHybridMetrics !== 'function') throw new Error('S2缺少真实scene/SceneShadowRuntime.getHybridMetrics。');
  if (shadowRuntime.scene && shadowRuntime.scene !== scene) throw new Error('S2 scene与shadowRuntime不属于同一对象。');
  if (!(shadowRuntime.localGenerators instanceof Map) || !(shadowRuntime.secondaryDirectionalGenerators instanceof Map) || !(shadowRuntime.hybridCaches instanceof Map)) throw new Error('S2实际Runtime generator/cache registry不受支持。');
  const fields = ['staticRenders', 'dynamicRenders', 'cacheHits', 'cacheInvalidations'];
  const engine = scene.getEngine(), targets = new Map(), ids = new WeakMap(), faces = [], samples = [], problems = [], retired = [];
  let sequence = 0, disposed = false, dropped = 0, completed = 0, recording = !measurementScoped, activeValue = null, activeDescriptor, ownedGet, ownedSet;
  let globalDescriptor;
  const id = value => { if (!ids.has(value)) ids.set(value, ++sequence); return ids.get(value); };
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const copy = value => JSON.parse(JSON.stringify(value));
  const counters = value => Object.fromEntries(fields.map(key => [key, count(value?.[key])]));
  const difference = (before, after) => Object.fromEntries(fields.map(key => [key, before && after && before[key] !== null && after[key] !== null && after[key] >= before[key] ? after[key] - before[key] : null]));
  const active = () => { if (!measurementScoped) return true; if (!recording || activeValue === null) return false;
    const current = Object.getOwnPropertyDescriptor(measurementState, 'active');
    if (current?.get !== ownedGet || current?.set !== ownedSet) { problems.push({ reason: 'measurement.active owner changed during window' }); return false; }
    return true;
  };
  const frame = () => typeof scene.getFrameId === 'function' ? scene.getFrameId() : null;
  const drawCounter = () => { const counter = engine._drawCalls;
    if (!counter || counter.constructor?.Enabled !== true) return { value: null, generation: null, reason: 'installed engine._drawCalls/PerfCounter.Enabled unavailable or disabled' };
    return { value: count(counter.current), generation: count(counter.count), reason: count(counter.current) === null || count(counter.count) === null ? 'non-finite/unsafe draw counter' : null };
  };
  const metrics = () => { const value = shadowRuntime.getHybridMetrics(); return { cumulative: counters(value), raw: copy(value) }; };
  const configuration = () => ({ mode: shadowRuntime.settings?.mode ?? null, quality: shadowRuntime.settings?.quality ?? null,
    enabled: shadowRuntime.settings?.enabled ?? null, cacheStaticShadows: shadowRuntime.hybridOptions?.cacheStaticShadows ?? null, dynamicShadows: shadowRuntime.hybridOptions?.dynamicShadows ?? null });
  let initial = measurementScoped ? null : metrics();
  const remove = record => { for (const [observable, observer] of record.observers) observable.remove(observer); record.observers.length = 0;
    for (const pending of record.pending) problems.push({ reason: 'target retired/disposed with unmatched actual face begin', targetId: record.targetId, face: pending.face });
    record.pending.length = 0;
  };
  const add = (record, observable, callback) => { if (typeof observable?.add !== 'function' || typeof observable?.remove !== 'function') throw new Error('S2 required installed observable unavailable');
    const observer = observable.add((...args) => { try { callback(...args); } catch (error) { problems.push({ reason: 'diagnostic observer failed', message: String(error) }); } });
    if (!observer) throw new Error('S2 observer installation failed'); record.observers.push([observable, observer]);
  };
  const describe = record => ({ targetId: record.targetId, textureId: record.target.uniqueId ?? null, name: record.target.name ?? null, owner: record.owner,
    notifications: record.notifications, actualFaceBegins: record.begins, actualFaceCompletes: record.completes, faceIndices: [...record.faceIndices].sort((a, b) => a - b),
    observedDrawCalls: record.drawCalls, unavailableDrawIntervals: record.unavailableDrawIntervals, pendingFaces: record.pending.length });
  const refreshTargets = () => {
    if (disposed || !recording) return;
    const generators = new Map(); if (shadowRuntime.primaryGenerator) generators.set(shadowRuntime.primaryGenerator, ['primary']);
    for (const [key, generator] of shadowRuntime.localGenerators) generators.set(generator, [...(generators.get(generator) ?? []), 'local:' + key]);
    for (const [light, generator] of shadowRuntime.secondaryDirectionalGenerators) generators.set(generator, [...(generators.get(generator) ?? []), 'secondary:' + light.uniqueId]);
    const wanted = new Map();
    for (const [generator, roles] of generators) {
      if (typeof generator?.getShadowMap !== 'function') { problems.push({ reason: 'unknown generator API' }); continue; }
      const light = generator.getLight?.(), owner = { generatorId: id(generator), lightId: light?.uniqueId ?? null, lightName: light?.name ?? null, roles };
      for (const target of new Set([generator.getShadowMap(), generator.getShadowMapForRendering?.()])) if (target) {
        if (wanted.has(target) && wanted.get(target).generator !== generator) problems.push({ reason: 'same RTT owned by multiple generators', targetId: id(target) });
        else wanted.set(target, { generator, owner });
      }
    }
    for (const [target, record] of targets) if (!wanted.has(target)) { remove(record); retired.push(describe(record)); targets.delete(target); }
    for (const [target, ownership] of wanted) {
      if (targets.has(target)) continue;
      const renderer = target._objectRenderer;
      if (!renderer?.onBeforeRenderingManagerRenderObservable || !renderer.onAfterRenderingManagerRenderObservable) {
        problems.push({ reason: 'RTT actual ObjectRenderer manager observables unavailable; no fabricated render count', targetId: id(target) }); continue;
      }
      const record = { target, targetId: id(target), ...ownership, observers: [], pending: [], notifications: { before: 0, after: 0 }, begins: 0, completes: 0, faceIndices: new Set(), drawCalls: 0, unavailableDrawIntervals: 0 };
      const cache = () => shadowRuntime.hybridCaches.get(record.generator);
      try {
        add(record, target.onBeforeRenderObservable, () => { if (active()) record.notifications.before++; });
        add(record, target.onAfterRenderObservable, () => { if (active()) record.notifications.after++; });
        add(record, renderer.onBeforeRenderingManagerRenderObservable, faceIndex => {
          if (!active()) return;
          record.begins++;
          record.pending.push({ face: faceIndex, frame: frame(), renderPassId: engine.currentRenderPassId ?? null, draw: drawCounter(), cache: counters(cache()?.metrics) });
        });
        add(record, renderer.onAfterRenderingManagerRenderObservable, faceIndex => {
          if (!active()) return;
          const before = record.pending.pop(); if (!before || before.face !== faceIndex) { problems.push({ reason: 'unmatched actual face end', targetId: record.targetId, faceIndex }); return; }
          const after = drawCounter(), afterFrame = frame(), generationStable = before.draw.generation !== null && before.draw.generation === after.generation;
          const valid = generationStable && before.draw.value !== null && after.value !== null && after.value >= before.draw.value && before.frame === afterFrame;
          const drawCalls = valid ? after.value - before.draw.value : null;
          const row = { targetId: record.targetId, owner: record.owner, face: faceIndex, frame: before.frame, renderPassId: before.renderPassId,
            drawBefore: before.draw, drawAfter: after, drawCalls, unavailableReason: valid ? null : 'counter unavailable/reset or render interval crossed frame',
            cacheDelta: difference(before.cache, counters(cache()?.metrics)) };
          record.completes++; completed++; record.faceIndices.add(faceIndex);
          if (drawCalls === null) record.unavailableDrawIntervals++; else record.drawCalls += drawCalls;
          if (faces.length < maxRecords) faces.push(row); else dropped++;
        });
        if (renderer.onFastPathRenderObservable) add(record, renderer.onFastPathRenderObservable, face => { if (active()) problems.push({ reason: 'SDK snapshot fast path bypassed RenderingManager; no fabricated draw interval', targetId: record.targetId, face }); });
      } catch (error) { remove(record); throw error; }
      targets.set(target, record);
    }
  };
  const boundary = label => { const observed = metrics(); if (label === 'measurement-start') initial = observed;
    samples.push({ label, frame: frame(), configuration: configuration(), cumulative: observed.cumulative, deltaFromInstall: difference(initial?.cumulative, observed.cumulative), raw: observed.raw });
  };
  const restoreActive = () => {
    if (!measurementScoped || !activeDescriptor) return;
    const current = Object.getOwnPropertyDescriptor(measurementState, 'active');
    if (current?.get === ownedGet && current?.set === ownedSet && current.configurable === activeDescriptor.configurable && current.enumerable === activeDescriptor.enumerable) Object.defineProperty(measurementState, 'active', { ...activeDescriptor, value: activeValue });
    else problems.push({ reason: 'measurement.active descriptor changed by another owner; preserved' });
  };
  let sceneObserver;
  try {
    if (measurementScoped) {
      activeDescriptor = Object.getOwnPropertyDescriptor(measurementState ?? {}, 'active');
      if (!activeDescriptor || activeDescriptor.get || activeDescriptor.set || activeDescriptor.value !== null || !activeDescriptor.configurable || !activeDescriptor.writable) throw new Error('S2 requires own configurable inactive measurement.active data descriptor');
      ownedGet = () => activeValue;
      ownedSet = next => {
        if (disposed) { activeValue = next; return; }
        const prior = activeValue;
        if (prior === null && next !== null) {
          try { recording = true; refreshTargets(); boundary('measurement-start'); }
          catch (error) { problems.push({ reason: 'measurement-start diagnostic failed', message: String(error) }); }
          finally { activeValue = next; }
        } else { activeValue = next;
          if (prior !== null && next === null) { recording = false; try { boundary('measurement-end'); } catch (error) { problems.push({ reason: 'measurement-end diagnostic failed', message: String(error) }); } }
        }
      };
      Object.defineProperty(measurementState, 'active', { configurable: activeDescriptor.configurable, enumerable: activeDescriptor.enumerable, get: ownedGet, set: ownedSet });
    }
    refreshTargets(); sceneObserver = scene.onBeforeRenderObservable.add(() => { try { refreshTargets(); } catch (error) { problems.push({ reason: 'target refresh diagnostic failed', message: String(error) }); } });
    if (!sceneObserver) throw new Error('S2 scene observer unavailable');
  }
  catch (error) { for (const record of targets.values()) remove(record); restoreActive(); throw error; }
  const sample = (label = '') => { if (disposed) throw new Error('S2 audit已释放。');
    if (measurementScoped) throw new Error('S2 scoped audit only samples original measurement.active boundaries');
    refreshTargets(); const observed = metrics();
    const value = { label, frame: frame(), configuration: configuration(), cumulative: observed.cumulative, deltaFromInstall: difference(initial.cumulative, observed.cumulative), raw: observed.raw }; samples.push(value); return copy(value); };
  const snapshot = () => ({ status: problems.length || dropped || [...retired, ...targets.values()].some(record => record.unavailableDrawIntervals || record.pending?.length)
    || samples.some(value => Object.values(value.deltaFromInstall).some(count => count === null)) ? 'INCOMPLETE' : completed ? 'OBSERVED' : 'NO_FACE_OBSERVATIONS', disposed,
    metricSemantics: 'staticRenders is the real existing static pass counter (sometimes labelled cacheRenders); not exclusively cache allocation. cacheHits/cacheInvalidations retain original units. Face draw intervals exclude readiness-only RTT notifications and include actual static/dynamic submesh draws; framebuffer blits are not draw calls.',
    measurementScoped, configuration: configuration(), initial: copy(initial), samples: copy(samples), targets: [...retired, ...[...targets.values()].map(describe)], faceIntervals: copy(faces), completedFaceIntervals: completed,
    droppedFaceRecords: dropped, problems: copy(problems), measurementIsGpuTiming: false });
  const dispose = () => { if (disposed) return snapshot();
    if (!measurementScoped) sample('dispose'); else { if (recording) problems.push({ reason: 'measurement disposed without original active end' }); recording = false; restoreActive(); }
    scene.onBeforeRenderObservable.remove(sceneObserver);
    for (const record of targets.values()) remove(record); disposed = true;
    if (exposeGlobal) { const current = Object.getOwnPropertyDescriptor(globalThis, '__phase2ShadowCacheAudit');
      if (current?.value === control) { if (globalDescriptor) Object.defineProperty(globalThis, '__phase2ShadowCacheAudit', globalDescriptor); else delete globalThis.__phase2ShadowCacheAudit; }
      else problems.push({ reason: 'global diagnostic owner changed; preserved' }); }
    return snapshot(); };
  const control = { sample, refreshTargets, snapshot, dispose };
  if (exposeGlobal) { globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__phase2ShadowCacheAudit');
    if (globalDescriptor) { dispose(); throw new Error('S2 global diagnostic already owned'); }
    Object.defineProperty(globalThis, '__phase2ShadowCacheAudit', { configurable: true, writable: true, value: control }); return snapshot(); }
  return control;
}
