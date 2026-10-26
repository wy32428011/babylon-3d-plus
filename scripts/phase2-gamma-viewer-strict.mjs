/* global window, document */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright';
import { createBusinessGiViewerServer } from '../tests/helpers/phase2GiViewer.mjs';

const options = { report: 'output/phase2-completion-20261025/b8-gamma-business-6/report.json', output: null };
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--report') options.report = process.argv[++index];
  else if (process.argv[index] === '--output') options.output = process.argv[++index];
  else throw new Error('未知strict Viewer诊断参数：' + process.argv[index]);
}
assert.ok(options.output);
const output = path.resolve(options.output); assert.ok(output.startsWith(path.resolve('output') + path.sep));
await fs.mkdir(output);
const previous = JSON.parse(await fs.readFile(options.report, 'utf8'));
const expected = previous.snapshot ? previous : JSON.parse(await fs.readFile(previous.previousReport, 'utf8'));
const archive = previous.packages.dist.filePath, sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'RUNNING', scope: 'same exact case6 DIST; independent fresh Chrome profile; no bake or camera/worldMatrix mutation',
  archive, archiveSha256: sha(await fs.readFile(archive)), cameraReframed: false, forcedWorldMatrixCalls: 0,
  requests: [], errors: [], consoleErrors: [], samples: [], elapsedMs: null };
let context, server, page;
const started = Date.now();

function installObserver() {
  const state = { runtime: null, events: [], phases: [], core: [], hooks: [], previous: new Map(), wrapped: null, original: null, lastPhase: null };
  function findRuntime() {
    const root = document.getElementById('root'), key = Object.keys(root ?? {}).find(key => key.startsWith('__reactContainer$'));
    const first = root?.[key], stack = first ? [first.stateNode?.current ?? first] : [], seen = new Set(); let found;
    const visit = value => { if (!value || typeof value !== 'object') return; const current = value.current ?? value;
      if (current.scene?.meshes && !current.scene.isDisposed && typeof current.getLightingBakeRuntimeError === 'function') found = current; };
    while (stack.length && seen.size < 30000) {
      const fiber = stack.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
      for (const value of Object.values(fiber.memoizedProps ?? {})) visit(value);
      let hook = fiber.memoizedState; for (let count = 0; hook && count < 500; count++, hook = hook.next) visit(hook.memoizedState);
      stack.push(fiber.child, fiber.sibling);
    }
    return found;
  }
  function entrance() { return state.runtime?.getModelEntranceSnapshot?.() ?? null; }
  function raw(watch) {
    const mesh = watch.source.mesh, material = mesh.material;
    const binding = state.runtime?.effects?.modelEntranceRuntime?.bindings?.find(value => value.mesh === mesh);
    return { key: watch.source.entry.key, name: watch.source.entry.name, meshId: mesh.uniqueId,
      materialId: material?.uniqueId ?? null, materialName: material?.name, materialClass: material?.getClassName?.(),
      visibility: mesh.visibility, isVisible: mesh.isVisible, layerMask: mesh.layerMask, geometryId: mesh.geometry?.uniqueId,
      expectedVisibility: watch.visibility, expectedVisible: watch.visible, expectedGeometryId: watch.geometry?.uniqueId,
      expectedMaterialFingerprint: watch.material, expectedWorld: Array.from(watch.matrix?.m ?? []), cachedWorld: Array.from(mesh._worldMatrix?.m ?? []),
      entranceBinding: binding ? { originalId: binding.original?.uniqueId, originalName: binding.original?.name, replacementId: binding.replacement?.uniqueId,
        replacementName: binding.replacement?.name, currentIsReplacement: material === binding.replacement, currentIsOriginal: material === binding.original } : null };
  }
  state.timer = setInterval(() => {
    state.runtime ??= findRuntime(); if (!state.runtime) return;
    const lighting = state.runtime.environment?.lightingRuntime;
    if (!lighting) return;
    const phase = entrance();
    if (phase?.status !== state.lastPhase) {
      state.lastPhase = phase?.status;
      state.phases.push({ at: performance.now(), entrance: phase, runtimeError: state.runtime.getLightingBakeRuntimeError(),
        bindings: (state.runtime.effects?.modelEntranceRuntime?.bindings ?? []).slice(0, 4).map(binding => ({ mesh: binding.mesh.name, id: binding.mesh.uniqueId,
          original: binding.original?.name, current: binding.mesh.material?.name, plugins: binding.plugins.map(plugin => plugin.progress) })) });
    }
    if (!state.original) {
      state.original = lighting.invalidate;
      state.wrapped = function (message) {
        const watches = (this.state?.staticWatch ?? []).filter(watch => String(message).includes(watch.source.entry.name));
        state.events.push({ type: 'invalidate', at: performance.now(), message, entrance: entrance(), watches: watches.map(raw) });
        return Reflect.apply(state.original, this, [message]);
      };
      lighting.invalidate = state.wrapped;
      state.hooks.push({ target: lighting, name: 'invalidate', original: state.original, wrapped: state.wrapped });
      for (const name of ['requestChange', 'commitState', 'dynamicMaterialReplaced']) {
        const original = lighting[name]; if (typeof original !== 'function') continue;
        const wrapped = function (...args) {
          const result = Reflect.apply(original, this, args), phase = entrance();
          if (phase && phase.status !== 'idle' && phase.status !== 'completed' && state.core.filter(row => row.name === name).length < 25 && (name !== 'dynamicMaterialReplaced' || result)) {
            const entry = { at: performance.now(), name, entrance: phase.status, progress: phase.progress,
              args: name === 'requestChange' ? args.map(value => typeof value === 'string' ? value : typeof value) : undefined,
              result: typeof result === 'boolean' ? result : undefined, records: this.state?.records?.length, proxies: this.state?.ownedProxies?.size };
            if (name === 'dynamicMaterialReplaced') entry.pointerChanges = (this.state?.records ?? []).filter(row => row.dynamic && row.proxy && row.source.mesh.material !== row.sourceMaterial).slice(0, 8).map(row => {
              const owner = row.source.mesh.sourceMesh ?? row.source.mesh;
              const carrier = this.state.records.find(item => item.mesh === owner && !item.proxy);
              const binding = state.runtime.effects?.modelEntranceRuntime?.bindings?.find(item => item.mesh === owner);
              return { mesh: row.mesh.name, source: row.source.mesh.name, sourceId: row.source.mesh.uniqueId, sourceClass: row.source.mesh.getClassName(),
              sourceOwner: row.source.mesh.sourceMesh?.name, sourceOwnerId: owner.uniqueId, ownerClass: owner.getClassName(),
              sourceCurrent: row.source.mesh.material?.name, sourceCurrentId: row.source.mesh.material?.uniqueId,
              storedSource: row.sourceMaterial?.name, storedSourceId: row.sourceMaterial?.uniqueId,
              current: row.mesh.material?.name, expectedWorking: row.workingMaterial?.name,
              carrierExpectedId: carrier?.workingMaterial?.uniqueId, carrierExpectedName: carrier?.workingMaterial?.name,
              ownerCurrentIsExpected: Boolean(carrier && owner.material === carrier.workingMaterial),
              entranceLink: binding ? { meshId: binding.mesh.uniqueId, originalId: binding.original?.uniqueId, replacementId: binding.replacement?.uniqueId,
                currentIsReplacement: owner.material === binding.replacement, originalIsCarrierExpected: binding.original === carrier?.workingMaterial } : null };
            });
            if (name === 'requestChange') entry.stack = new Error().stack?.split('\n').slice(0, 8).join('\n');
            state.core.push(entry);
          }
          return result;
        };
        lighting[name] = wrapped; state.hooks.push({ target: lighting, name, original, wrapped });
      }
    }
    for (const watch of lighting.state?.staticWatch ?? []) {
      const current = raw(watch), previous = state.previous.get(current.key);
      if (!previous || previous.materialId !== current.materialId || previous.visibility !== current.visibility || previous.geometryId !== current.geometryId) {
        state.events.push({ type: previous ? 'source-identity-change' : 'initial-watch', at: performance.now(), previous: previous ?? null, current, entrance: entrance() });
        state.previous.set(current.key, current);
      }
    }
  }, 25);
  state.read = () => {
    const runtime = state.runtime; if (!runtime) return { runtimeFound: false, at: performance.now() };
    const scene = runtime.scene, engine = scene.getEngine();
    const active = scene.getActiveMeshes(), rendered = new Set(active.data.slice(0, active.length));
    return { runtimeFound: true, at: performance.now(), ready: scene.isReady(), initial: runtime.getInitialLoadSnapshot(),
      runtimeError: runtime.getLightingBakeRuntimeError(), entrance: entrance(), gpu: engine.getGlInfo(),
      hudErrors: [...document.querySelectorAll('.player-status p')].map(node => node.textContent).filter(value => /混合光照|重新烘焙/.test(value)),
      maps: scene.meshes.filter(mesh => mesh.metadata?.lightingDerived && mesh.isVerticesDataPresent('lightingBakeUV')).map(mesh => ({ name: mesh.name,
        key: mesh.metadata.lightingSourceKey, enabled: mesh.isEnabled(), visible: mesh.isVisible, rendered: rendered.has(mesh),
        gamma: mesh.subMeshes.some(sub => sub.effect?.defines?.match(/(?:^|\n)#define BAKED_INDIRECT_GAMMA(?:\s|$)/)),
        giPlugin: Boolean(mesh.material?.pluginManager?.getPlugin('BakedIndirectLighting')),
        entrancePlugin: Boolean(mesh.material?.pluginManager?.getPlugin('DigitalTwinModelEntrance')),
        entranceProgress: mesh.material?.pluginManager?.getPlugin('DigitalTwinModelEntrance')?.progress ?? null,
        entranceShader: mesh.subMeshes.some(sub => sub.effect?.fragmentSourceCode?.includes('dtEntranceParams')) })) };
  };
  state.restore = () => { clearInterval(state.timer); const lighting = state.runtime?.environment?.lightingRuntime;
    for (const hook of state.hooks) if (hook.target[hook.name] === hook.wrapped) hook.target[hook.name] = hook.original;
    return !state.original || lighting?.invalidate === state.original; };
  state.resources = () => {
    const scene = state.runtime?.scene; if (!scene) return null;
    const disposed = value => typeof value?.isDisposed === 'function' ? value.isDisposed() : value?.isDisposed ?? value?._isDisposed ?? null;
    const texture = value => ({ name: value.name, url: value.url, type: value.constructor.name, disposed: disposed(value), ready: value.isReady() });
    const material = value => value ? { name: value.name, id: value.uniqueId, type: value.getClassName(), disposed: disposed(value), inScene: scene.materials.includes(value),
      textures: value.getActiveTextures().slice(0, 12).map(texture) } : null;
    const notReady = [];
    for (const mesh of scene.meshes) {
      if (!mesh.subMeshes?.length) continue;
      let ready, error; try { ready = mesh.isReady(true); } catch (failure) { ready = false; error = String(failure); }
      if (!ready) notReady.push({ name: mesh.name, id: mesh.uniqueId, parent: mesh.parent?.name, disposed: disposed(mesh), enabled: mesh.isEnabled(), directlyEnabled: mesh.isEnabled(false), visible: mesh.isVisible,
        visibility: mesh.visibility, layerMask: mesh.layerMask, derived: Boolean(mesh.metadata?.lightingDerived), sourceKey: mesh.metadata?.lightingSourceKey,
        material: material(mesh.material), error });
      if (notReady.length >= 20) break;
    }
    return { pendingCount: scene._pendingData?.length, pending: (scene._pendingData ?? []).slice(0, 20).map(value => ({ type: value.constructor?.name, name: value.name, url: value.url ?? value._url, disposed: disposed(value) })),
      notReady, texturesNotReady: scene.textures.filter(value => !value.isReady()).slice(0, 20).map(texture), meshCount: scene.meshes.length, materialCount: scene.materials.length };
  };
  window.__phase2GammaReview = state;
}

try {
  const hosted = await createBusinessGiViewerServer(archive, '9000000000000000001', report.requests); server = hosted.server;
  context = await chromium.launchPersistentContext(path.join(output, 'chrome-profile'), { channel: 'chrome', headless: true, viewport: { width: 1440, height: 960 } });
  await context.addInitScript(installObserver);
  await context.route('**/*', route => { const url = new URL(route.request().url()); return ['http:', 'https:'].includes(url.protocol) && url.origin !== hosted.origin ? route.abort() : route.continue(); });
  page = context.pages()[0] ?? await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(hosted.origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForFunction(() => { const state = window.__phase2GammaReview?.read(); return state?.runtimeFound && (state.runtimeError || state.maps.length > 0); }, null, { timeout: 25000 });
  const samplingStarted = Date.now();
  while (Date.now() - samplingStarted < 20000) {
    report.samples.push(await page.evaluate(() => window.__phase2GammaReview.read()));
    const last = report.samples.at(-1);
    if (Date.now() - samplingStarted >= 6000 && (last.runtimeError && last.initial?.progress?.loading === false || last.entrance?.status === 'completed')) break;
    await page.waitForTimeout(200);
  }
  report.events = await page.evaluate(() => window.__phase2GammaReview.events);
  report.entrancePhases = await page.evaluate(() => window.__phase2GammaReview.phases);
  report.coreTrace = await page.evaluate(() => window.__phase2GammaReview.core);
  report.resourceReadiness = await page.evaluate(() => window.__phase2GammaReview.resources());
  report.screenshot = path.join(output, 'viewer-final.png'); await page.screenshot({ path: report.screenshot });
  const stable = report.samples.slice(-8); report.final = report.samples.at(-1);
  assert.ok(stable.every(row => row.ready && row.runtimeError === null && row.hudErrors.length === 0), '最终1.6秒必须ready、runtimeError=null、HUD无光照错误');
  assert.equal(report.final.maps.length, expected.snapshot.surfaces.length); assert.ok(report.final.maps.every(row => row.enabled && row.visible && row.gamma));
  assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  if (page && !page.isClosed()) { report.events ??= await page.evaluate(() => window.__phase2GammaReview?.events).catch(() => null);
    report.final ??= await page.evaluate(() => window.__phase2GammaReview?.read()).catch(() => null);
    report.observerRestored = await page.evaluate(() => window.__phase2GammaReview?.restore()).catch(() => false); }
  await context?.close(); report.ownedBrowserClosed = true;
  if (server) await new Promise(resolve => server.close(resolve)); report.ownedServerClosed = true;
  report.archiveUnchanged = sha(await fs.readFile(archive)) === report.archiveSha256; report.elapsedMs = Date.now() - started;
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, output, elapsedMs: report.elapsedMs, error: report.error }));
}
