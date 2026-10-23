/* global window, document */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 安装纯读取快照函数；矩阵和 bounds 读取不强制重算，不冻结合法投影变化。 */
async function installSnapshotReader(page) {
  await page.evaluate(() => {
    const read = () => {
      const { runtime, store } = window.lightingSmoke, scene = runtime.scene, engine = scene.getEngine();
      const camera = scene.activeCamera;
      const preparation = window.lightingSmoke.preparation;
      const preparationState = preparation?.getScenePreparationSnapshot?.();
      const vector = value => value?.asArray ? Array.from(value.asArray()) : null;
      const matrix = value => value?.asArray ? Array.from(value.asArray()) : null;
      return {
        at: performance.now(), frameId: scene.getFrameId(), visibility: document.visibilityState,
        hidden: document.hidden, hasFocus: document.hasFocus(), runtimeMode: store.getState().runtimeMode,
        preparation: { active: preparation?.isScenePreparationActive?.() ?? null, phase: preparationState?.phase,
          completed: preparationState?.completed, editingAllowed: preparationState?.editingAllowed },
        contextLost: engine._gl?.isContextLost?.() ?? null,
        viewport: [engine.getRenderWidth(), engine.getRenderHeight(), engine.getHardwareScalingLevel()],
        camera: camera ? {
          id: camera.uniqueId, name: camera.name, type: camera.getClassName(),
          position: vector(camera.position), globalPosition: vector(camera.globalPosition),
          target: vector(camera.getTarget?.()), rotation: vector(camera.rotation),
          alpha: camera.alpha, beta: camera.beta, radius: camera.radius, minZ: camera.minZ, maxZ: camera.maxZ,
          fov: camera.fov, mode: camera.mode, viewport: camera.viewport?.toArray?.() ?? [
            camera.viewport.x, camera.viewport.y, camera.viewport.width, camera.viewport.height,
          ],
          view: matrix(camera.getViewMatrix()), projection: matrix(camera.getProjectionMatrix()),
          inertia: Object.fromEntries(['inertialAlphaOffset', 'inertialBetaOffset', 'inertialRadiusOffset',
            'inertialPanningX', 'inertialPanningY'].map(key => [key, camera[key] ?? null])),
        } : null,
        caches: [...runtime.shadowRuntime.hybridCaches.entries()].map(([generator, cache]) => {
          const light = generator.getLight(), bounds = generator.shadowCastersBoundingInfo?.boundingBox;
          const cascades = Number.isInteger(generator.numCascades) ? generator.numCascades : 0;
          return {
            light: light.name, lightId: light.uniqueId, position: vector(light.position),
            direction: vector(light.direction), enabled: cache.enabled, cacheRevision: cache.revision,
            stateRevision: cache.state.revision, metrics: { ...cache.metrics }, cachedFaces: cache.faces.size,
            shadowMaxZ: generator.shadowMaxZ ?? light.shadowMaxZ,
            autoCalcDepthBounds: generator.autoCalcDepthBounds, depthClamp: generator.depthClamp,
            freezeShadowCastersBoundingInfo: generator.freezeShadowCastersBoundingInfo,
            // CSM 的 minimumWorld 会在逐级联计算中复用为光空间，故记录本地字段及原始聚合值。
            casterBounds: bounds ? { minimum: vector(bounds.minimum), maximum: vector(bounds.maximum) } : null,
            casterAggregateMin: vector(generator._scbiMin), casterAggregateMax: vector(generator._scbiMax),
            transforms: cascades ? Array.from({ length: cascades }, (_, i) => matrix(generator.getCascadeTransformMatrix(i)))
              : [matrix(generator.getTransformMatrix())],
            groups: (cache.activeGroups ?? []).map(group => ({
              id: group.id, statics: group.statics.map(list => list.length),
              dynamics: group.dynamics.map(list => list.length),
            })),
          };
        }),
      };
    };
    window.lightingSmoke.factoryProfileSnapshot = read;
  });
}

async function collectFrames(page, { cacheEnabled, warmFrames = 20, sampleFrames = 30, timeoutMs = 120_000 }) {
  return page.evaluate(({ cacheEnabled, warmFrames, sampleFrames, timeoutMs }) => new Promise(resolve => {
    const runtime = window.lightingSmoke.runtime, scene = runtime.scene;
    const read = window.lightingSmoke.factoryProfileSnapshot;
    const started = performance.now(), times = [], renderTimes = [], outsideRenderTimes = [], changes = [], renderErrors = [];
    const fingerprints = value => ({
      camera: JSON.stringify(value.camera), viewport: JSON.stringify(value.viewport),
      visibility: JSON.stringify([value.visibility, value.hasFocus, value.contextLost]),
      preparation: JSON.stringify(value.preparation),
      casters: JSON.stringify(value.caches.map(cache => [cache.casterAggregateMin, cache.casterAggregateMax, cache.casterBounds])),
      lights: JSON.stringify(value.caches.map(cache => [cache.position, cache.direction, cache.shadowMaxZ])),
      transforms: JSON.stringify(value.caches.map(cache => cache.transforms)),
      dispatch: JSON.stringify(value.caches.map(cache => cache.groups)),
    });
    let frames = 0, previousTime = null, before = null, previous = null, finished = false;
    const ownRender = Object.getOwnPropertyDescriptor(scene, 'render'), originalRender = scene.render;
    const changedFrames = {}, conditions = { hiddenFrames: 0, unfocusedFrames: 0, contextLostFrames: 0,
      preparationActiveFrames: 0, cacheOptionMismatchFrames: 0 };
    const summary = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { meanMs: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
        p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
        maxMs: sorted.length ? sorted.at(-1) : null };
    };
    const finish = timedOut => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (scene.render === wrappedRender) {
        if (ownRender) Object.defineProperty(scene, 'render', ownRender); else delete scene.render;
      }
      const sorted = [...times].sort((a, b) => a - b);
      let after = null;
      try { after = read(); } catch (error) { renderErrors.push('诊断快照失败：' + String(error)); }
      resolve({
        requestedCacheEnabled: cacheEnabled, warmFrames, requestedFrames: sampleFrames, frames: times.length,
        timedOut, durationMs: performance.now() - started,
        meanMs: times.length ? times.reduce((sum, value) => sum + value, 0) / times.length : null,
        medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
        p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
        frameIntervalsMs: times, before, after, changedFrames, changes, conditions,
        sceneRenderCpu: { ...summary(renderTimes), samplesMs: renderTimes },
        outsideSceneRender: { ...summary(outsideRenderTimes), samplesMs: outsideRenderTimes },
        renderErrors,
        stableConditions: !timedOut && !Object.values(conditions).some(Boolean)
          && !changedFrames.camera && !changedFrames.viewport && !changedFrames.lights
          && !changedFrames.casters && !changedFrames.transforms && !renderErrors.length,
        instrumentation: 'sceneRenderCpu包装完整scene.render，包含其全部observer；outsideSceneRender为前次render结束到下次开始的间隔。指纹读取在计时区间之后，不遍历网格，不查询GPU时间。',
      });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const afterRender = (callStart, now) => {
      frames++;
      if (frames < warmFrames) return;
      const current = read();
      if (previousTime === null) {
        previousTime = now; before = current; previous = fingerprints(current); return;
      }
      times.push(now - previousTime); renderTimes.push(now - callStart);
      outsideRenderTimes.push(Math.max(0, callStart - previousTime)); previousTime = now;
      if (current.hidden) conditions.hiddenFrames++;
      if (!current.hasFocus) conditions.unfocusedFrames++;
      if (current.contextLost) conditions.contextLostFrames++;
      if (current.preparation.active) conditions.preparationActiveFrames++;
      if (!current.caches.length || current.caches.some(cache => cache.enabled !== cacheEnabled)) conditions.cacheOptionMismatchFrames++;
      const next = fingerprints(current);
      for (const key of Object.keys(next)) if (next[key] !== previous[key]) {
        changedFrames[key] = (changedFrames[key] ?? 0) + 1;
        if (changes.length < 12) changes.push({ frame: times.length, field: key, at: now });
      }
      previous = next;
      if (times.length >= sampleFrames) finish(false);
    };
    const wrappedRender = function (...args) {
      const callStart = performance.now();
      try { return originalRender.apply(this, args); }
      catch (error) { renderErrors.push(error instanceof Error ? error.message : String(error)); throw error; }
      finally {
        if (!finished) {
          try { afterRender(callStart, performance.now()); }
          catch (error) { renderErrors.push('诊断读取失败：' + String(error)); finish(false); }
        }
      }
    };
    scene.render = wrappedRender;
  }), { cacheEnabled, warmFrames, sampleFrames, timeoutMs });
}

/** GPU query 与 CPU 包装放在独立短窗口，不混入上面的 on/off/on 帧间隔。 */
async function profileCopyFace(page, frames = 30) {
  return page.evaluate(frames => new Promise(resolve => {
    const runtime = window.lightingSmoke.runtime, scene = runtime.scene;
    const read = window.lightingSmoke.factoryProfileSnapshot, before = read();
    const cpu = [], gpu = [], pending = [], cacheRestores = [], glRestores = [], instrumentationErrors = [];
    const contexts = new Map(), diagnostics = { skippedBusyQueries: 0, skippedCapacityQueries: 0, disjointEvents: 0, unavailableGpuQueries: 0 };
    let activeCall = null, profiling = true, frameCount = 0, drainFrames = 0, finished = false, observer;
    const summarize = values => {
      const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
      return { count: sorted.length, totalMs: sorted.reduce((a, b) => a + b, 0),
        meanMs: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
        p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
        maxMs: sorted.length ? sorted.at(-1) : null };
    };
    const poll = () => {
      for (const [gl, info] of contexts) {
        if (!info.extension || gl.isContextLost()) continue;
        if (gl.getParameter(info.extension.GPU_DISJOINT_EXT)) {
          diagnostics.disjointEvents++;
          for (let i = pending.length - 1; i >= 0; i--) if (pending[i].gl === gl) {
            gl.deleteQuery(pending[i].query); pending.splice(i, 1);
          }
        }
      }
      for (let i = pending.length - 1; i >= 0; i--) {
        const item = pending[i];
        if (item.gl.isContextLost() || !item.gl.getQueryParameter(item.query, item.gl.QUERY_RESULT_AVAILABLE)) continue;
        const ns = item.gl.getQueryParameter(item.query, item.gl.QUERY_RESULT);
        if (Number.isFinite(ns)) gpu.push({ ...item.sample, ms: ns / 1_000_000 });
        item.gl.deleteQuery(item.query); pending.splice(i, 1);
      }
    };
    const finish = timedOut => {
      if (finished) return; finished = true; profiling = false;
      scene.onAfterRenderObservable.remove(observer); clearTimeout(timer);
      try { poll(); } catch (error) { instrumentationErrors.push(String(error)); }
      const unresolvedQueries = pending.length;
      for (const item of pending) try { item.gl.deleteQuery(item.query); } catch (error) { instrumentationErrors.push(String(error)); }
      for (const restore of [...cacheRestores.reverse(), ...glRestores.reverse()]) {
        try { restore(); } catch (error) { instrumentationErrors.push(String(error)); }
      }
      let after = null;
      try { after = read(); } catch (error) { instrumentationErrors.push(String(error)); }
      resolve({
        requestedFrames: frames, measuredFrames: Math.min(frameCount, frames), drainFrames, timedOut,
        before, after, diagnostics, unresolvedQueries, instrumentationErrors,
        extensions: [...contexts.values()].map(info => ({ renderer: info.renderer, available: Boolean(info.extension) })),
        cpu: Object.fromEntries(['save', 'restore'].map(kind => [kind, {
          copyFace: summarize(cpu.filter(item => item.kind === kind).map(item => item.ms)),
          blitFramebuffer: summarize(cpu.filter(item => item.kind === kind).map(item => item.blitMs)),
        }])),
        gpu: Object.fromEntries(['save', 'restore'].map(kind => [kind, summarize(gpu.filter(item => item.kind === kind).map(item => item.ms))])),
        cpuSamples: cpu, gpuSamples: gpu,
        note: 'CPU为API调用墙钟；GPU为有效且非disjoint的TIME_ELAPSED查询。无gl.finish、readPixels或阻塞等待；查询不可用/冲突/未完成不计作0。',
      });
    };
    const timer = setTimeout(() => finish(true), 120_000);
    try {
    for (const [generator, cache] of runtime.shadowRuntime.hybridCaches) {
      const gl = cache.gl;
      if (gl && !contexts.has(gl)) {
        const extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        contexts.set(gl, { extension, renderer: scene.getEngine().getGlInfo().renderer });
        const own = Object.getOwnPropertyDescriptor(gl, 'blitFramebuffer'), originalBlit = gl.blitFramebuffer;
        const wrappedBlit = function (...args) {
          const start = performance.now();
          try { return originalBlit.apply(this, args); }
          finally { if (activeCall) activeCall.blitMs += performance.now() - start; }
        };
        gl.blitFramebuffer = wrappedBlit;
        glRestores.push(() => {
          if (gl.blitFramebuffer !== wrappedBlit) return;
          if (own) Object.defineProperty(gl, 'blitFramebuffer', own); else delete gl.blitFramebuffer;
        });
      }
      const own = Object.getOwnPropertyDescriptor(cache, 'copyFace'), original = cache.copyFace;
      const wrapped = function (face, save) {
        if (!profiling) return original.call(this, face, save);
        const sample = { light: generator.getLight().name, frame: scene.getFrameId(), face: cache.faceIndex,
          kind: save ? 'save' : 'restore', blitMs: 0, ms: 0 };
        const extension = contexts.get(gl)?.extension;
        let query = null;
        if (gl && extension && !gl.isContextLost()) {
          if (gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) diagnostics.skippedBusyQueries++;
          else if (pending.length >= 128) diagnostics.skippedCapacityQueries++;
          else { query = gl.createQuery(); if (query) gl.beginQuery(extension.TIME_ELAPSED_EXT, query); }
        } else diagnostics.unavailableGpuQueries++;
        const previousCall = activeCall, start = performance.now(); activeCall = sample;
        try { return original.call(this, face, save); }
        finally {
          sample.ms = performance.now() - start; activeCall = previousCall; cpu.push(sample);
          if (query) { gl.endQuery(extension.TIME_ELAPSED_EXT); pending.push({ gl, query, sample: { ...sample } }); }
        }
      };
      cache.copyFace = wrapped;
      cacheRestores.push(() => {
        if (cache.copyFace !== wrapped) return;
        if (own) Object.defineProperty(cache, 'copyFace', own); else delete cache.copyFace;
      });
    }
    observer = scene.onAfterRenderObservable.add(() => {
      frameCount++;
      try { poll(); } catch (error) { instrumentationErrors.push(String(error)); finish(false); return; }
      if (frameCount < frames) return;
      profiling = false;
      if (!pending.length || ++drainFrames >= 8) finish(false);
    });
    } catch (error) { instrumentationErrors.push(String(error)); finish(false); }
  }), frames);
}

/**
 * 正式 Editor、实际资产上的诊断，不产生性能验收 PASS。
 * readGpuMemory/waitForReady 由工厂加载器注入，避免复制验证入口或循环依赖。
 */
export async function runLightingFactoryProfile({ page, result, output, readGpuMemory, waitForReady, focusWindow, readWindowState }) {
  result.status = 'DIAGNOSTIC';
  const profile = result.profile = {
    startedAt: new Date().toISOString(), completed: false,
    scope: '同一已完整加载场景、同一hybrid模式的cache on/off/on短诊断；不作为正式FPS或收益验收。',
    phases: [],
  };
  const file = path.join(output, 'factory-profile.json');
  const save = () => writeFile(file, JSON.stringify(result, null, 2));
  let originalOptions;
  try {
    profile.nativeBefore = await readWindowState();
    await focusWindow();
    originalOptions = await page.evaluate(async () => {
      const { runtime, store } = window.lightingSmoke, current = store.getState().scene;
      const options = { ...runtime.shadowRuntime.hybridOptions };
      store.setState({ scene: { ...current, sceneSettings: { ...current.sceneSettings,
        lighting: { ...current.sceneSettings.lighting, bake: { ...current.sceneSettings.lighting.bake, cacheStaticShadows: true } } } } });
      runtime.syncDocument(store.getState().scene);
      await runtime.environmentRuntime.setLightingMode('scene');
      const camera = runtime.scene.activeCamera, clearedInertia = {};
      for (const key of ['inertialAlphaOffset', 'inertialBetaOffset', 'inertialRadiusOffset', 'inertialPanningX', 'inertialPanningY']) {
        if (typeof camera?.[key] === 'number') { clearedInertia[key] = camera[key]; camera[key] = 0; }
      }
      window.lightingSmoke.factoryProfileClearedInertia = clearedInertia;
      return options;
    });
    await waitForReady();
    await installSnapshotReader(page);
    profile.nativeFocused = await readWindowState();
    profile.baseline = await page.evaluate(() => ({
      snapshot: window.lightingSmoke.factoryProfileSnapshot(),
      clearedInertia: window.lightingSmoke.factoryProfileClearedInertia,
      projectionFrozen: false,
    }));
    await save();
    for (const [index, enabled] of [true, false, true].entries()) {
      console.log(`[lighting-factory-profile] ${index + 1}/3 cache ${enabled ? 'on' : 'off'}，20 warm + 30 frames`);
      await page.evaluate(enabled => {
        const shadow = window.lightingSmoke.runtime.shadowRuntime;
        shadow.setHybridMeshRoles(shadow.hybridMeshRoles, { ...shadow.hybridOptions, cacheStaticShadows: enabled });
      }, enabled);
      const phase = await collectFrames(page, { cacheEnabled: enabled });
      phase.index = index; phase.nativeWindow = await readWindowState();
      try { phase.gpuProcessMemory = await readGpuMemory(); }
      catch (error) { phase.gpuProcessMemoryError = error instanceof Error ? error.message : String(error); }
      profile.phases.push(phase); await save();
      console.log(`[lighting-factory-profile] cache ${enabled ? 'on' : 'off'} mean ${phase.meanMs?.toFixed(2) ?? 'n/a'} ms，stable=${phase.stableConditions}`);
      if (phase.timedOut || phase.renderErrors.length) {
        profile.stoppedReason = phase.timedOut ? '等待真实渲染帧超时，保留部分诊断，不继续对照。'
          : '渲染或诊断读取发生错误，保留部分诊断，不继续对照。';
        return result;
      }
    }
    console.log('[lighting-factory-profile] 独立30帧copyFace CPU/GPU计时');
    profile.copyFace = await profileCopyFace(page);
    profile.nativeAfter = await readWindowState();
    profile.completed = !profile.copyFace.timedOut && profile.copyFace.measuredFrames === profile.copyFace.requestedFrames
      && profile.copyFace.instrumentationErrors.length === 0;
    profile.usableForCostComparison = profile.phases.every(phase => phase.stableConditions);
    await save();
    return result;
  } catch (error) {
    profile.error = error instanceof Error ? error.message : String(error);
    await save(); throw error;
  } finally {
    if (!page.isClosed()) {
      try {
        if (originalOptions) await page.evaluate(options => {
          const shadow = window.lightingSmoke.runtime.shadowRuntime;
          shadow.setHybridMeshRoles(shadow.hybridMeshRoles, options);
        }, originalOptions);
        await page.evaluate(() => {
          delete window.lightingSmoke.factoryProfileSnapshot;
          delete window.lightingSmoke.factoryProfileClearedInertia;
        });
      } catch (error) { profile.restoreError = error instanceof Error ? error.message : String(error); }
    }
    profile.finishedAt = new Date().toISOString(); await save();
  }
}
