/* global window, document */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';

const execute = promisify(execFile);

/** 基线来自本次仓库 HEAD，禁止用近似重写代替被比较的实际旧算法。 */
export function buildLightingGiBaseline(samplerSource, runtimeSource) {
  const parse = (name, source) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sampler = parse('lightingProbes.ts', samplerSource), runtime = parse('SceneLightingRuntime.ts', runtimeSource);
  const method = (file, className, name) => {
    const owner = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
    const member = owner?.members.find(node => ts.isMethodDeclaration(node) && node.name?.getText(file) === name);
    if (!member?.body) throw new Error('无法定位工厂 GI 性能基线：' + className + '.' + name);
    return member.getText(file).replace(/^private\s+/, '');
  };
  const sample = method(sampler, 'LightingProbeSampler', 'sample');
  if (!sample.includes('.filter(') || !sample.includes('.slice(0, 8)')) throw new Error('HEAD 探针基线已经变化，不能将其冒充原全量可见性查询。');
  const applyWorld = runtime.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'applyWorldMatrix');
  if (!applyWorld) throw new Error('无法定位工厂 GI 性能基线 applyWorldMatrix。');
  const source = 'class LegacyLightingProbeSampler {' + sample + '}\nclass LegacySceneLightingRuntime {'
    + method(runtime, 'SceneLightingRuntime', 'probeVisible') + '\n' + method(runtime, 'SceneLightingRuntime', 'updateDynamicBindings')
    + '}\n' + applyWorld.getText(runtime);
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}

export function summarizeLightingGiFrames(values) {
  assert.ok(values.length && values.every(value => Number.isFinite(value) && value >= 0), '帧时间必须来自完整有限的实际样本');
  const sorted = [...values].sort((a, b) => a - b);
  return { meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * 0.95)], maxMs: sorted.at(-1) };
}

export function assertLightingGiSample(sample) {
  assert.ok(sample.gi.applied && sample.gi.staticBindings > 0 && sample.gi.probeCount > 0, '必须实际应用完整 GI 资源后采样');
  assert.equal(sample.frames, sample.expectedFrames, '只有完整帧序列才能进入性能对照');
  assert.ok(Object.values(sample.conditions).every(value => value === 0), '前台、资源、相机和姿态必须全程有效');
  for (const state of [sample.nativeWindowBefore, sample.nativeWindowAfter]) {
    assert.ok(state.visible && !state.minimized && state.focused && state.webContentsFocused, '采样窗口必须保持真实前台');
  }
}


/** 只扫描实际捕获结果，不修正、截断或丢弃任何导出的数值。 */
export function inspectLightingBakePrimitive(mesh) {
  const positionsCount = mesh.positions?.length ?? 0, indicesCount = mesh.indices?.length ?? 0, vertexCount = positionsCount / 3;
  const reasons = [], invalidIndices = [];
  if (!positionsCount || positionsCount % 3) reasons.push('invalid-positions-length');
  if (!indicesCount) reasons.push('empty-indices');
  if (indicesCount % 3) reasons.push('index-count-not-triangles');
  let maximumIndex = null, minimumIndex = null;
  for (let offset = 0; offset < indicesCount; offset++) {
    const value = mesh.indices[offset];
    if (Number.isFinite(value)) { maximumIndex = Math.max(maximumIndex ?? -Infinity, value); minimumIndex = Math.min(minimumIndex ?? Infinity, value); }
    const reason = !Number.isInteger(value) ? 'not-integer' : value < 0 || value >= vertexCount ? 'out-of-range' : null;
    if (reason && invalidIndices.length < 12) invalidIndices.push({ offset, value: Number.isFinite(value) ? value : String(value), reason });
  }
  if (invalidIndices.length) reasons.push('invalid-index');
  return reasons.length ? { key: mesh.key, entityId: mesh.entityId, nodeKey: mesh.nodeKey, name: mesh.name,
    positionsCount, vertexCount, indicesCount, maximumIndex, minimumIndex, reasons, invalidIndices } : null;
}


/** 临时性能场景只隔离外部活动；恢复路径保留真实烘焙结果及全部物理配置。 */
export function prepareLightingFactorySceneForPerformance(file, { resume = false } = {}) {
  const content = structuredClone(file), scene = content.scene;
  assert.ok(scene?.entities && Array.isArray(scene.entityIds), '工厂场景结构无效');
  if (resume) {
    const result = scene.sceneSettings?.lighting?.result;
    assert.ok(scene.sceneSettings?.lighting?.bake?.enabled && result?.signature && result.geometrySignature
      && result.assets?.length && result.surfaces?.length, '恢复工厂GI必须包含已启用的真实完整GI结果');
  }
  scene.selectedEntityId = null;
  scene.mqttConfig = { ...scene.mqttConfig, enabled: false };
  scene.fetchConfig = { ...scene.fetchConfig, url: '', apiKey: '' };
  scene.sceneSettings.openingAnimation = { ...scene.sceneSettings.openingAnimation, enabled: false };
  if (!resume) {
    const lighting = scene.sceneSettings.lighting;
    lighting.shadows.enabled = true;
    lighting.bake = { ...lighting.bake, enabled: false, quality: 'preview', atlasSize: 1024, texelsPerMeter: 8,
      probeSpacing: 6, maxTextureMiB: 64, cacheStaticShadows: false, dynamicShadows: true };
    lighting.result = null;
  }
  return content;
}

export function assertLightingFactoryResumeEvidence(proof, snapshot, sourceHash) {
  assert.equal(proof?.status, 'PASS', '恢复GI需要实际engine成功的重放证据');
  const hasOriginalSource = proof.originalSourceScenePath !== undefined || proof.originalSourceSceneSha256Before !== undefined
    || proof.originalSourceSceneSha256After !== undefined || proof.originalSceneSignature !== undefined || proof.originalCompiledSignature !== undefined;
  if (hasOriginalSource) {
    assert.equal(proof.originalSourceSceneSha256Before, sourceHash, '恢复GI证据必须对应原始工厂SHA');
    assert.equal(proof.originalSourceSceneSha256After, sourceHash, '原始工厂在重放后必须保持不变');
    assert.ok(typeof proof.sourceSceneSha256Before === 'string' && proof.sourceSceneSha256Before, '重放证据缺少临时捕获场景SHA');
    assert.equal(proof.sourceSceneSha256After, proof.sourceSceneSha256Before, '临时捕获场景在重放后必须保持不变');
    // 原D文件与隔离copy的字节可以不同，但两份正式反序列化后应用相同烘焙设置的物理输入必须严格相同。
    for (const field of ['sceneSignature', 'compiledSignature', 'originalSceneSignature', 'originalCompiledSignature']) {
      assert.equal(proof[field], proof.inputSignature, '原始及捕获场景的正式物理签名必须等于原输入：' + field);
    }
  } else {
    assert.equal(proof.sourceSceneSha256Before, sourceHash, '恢复GI证据必须对应原始工厂SHA');
    assert.equal(proof.sourceSceneSha256After, sourceHash, '原始工厂在重放后必须保持不变');
  }
  assert.ok(Array.isArray(proof.inputHashesBefore) && proof.inputHashesBefore.length, '恢复GI必须记录全部原始输入哈希');
  assert.deepEqual(proof.inputHashesAfter, proof.inputHashesBefore, '原始捕获输入必须保持逐字节不变');
  for (const key of ['expectedStaticMeshCount', 'expectedReceiverCount', 'expectedTriangleCount']) assert.ok(Number.isSafeInteger(proof[key]) && proof[key] > 0, '重放证据缺少完整输入计数：' + key);
  assert.equal(snapshot?.signature, proof.inputSignature, '恢复GI场景与完整输入签名不一致');
  assert.equal(snapshot.geometrySignature, proof.geometrySignature, '恢复GI场景与完整输入几何签名不一致');
  assert.equal(snapshot.statistics.meshCount, proof.expectedStaticMeshCount, '恢复GI结果遗漏静态输入');
  assert.equal(snapshot.statistics.triangleCount, proof.expectedTriangleCount, '恢复GI结果三角面范围不一致');
  assert.equal(proof.snapshot?.signature, snapshot.signature, '重放报告与恢复场景GI不一致');
  assert.deepEqual(proof.snapshot.assets, snapshot.assets, '恢复场景资源必须来自真实重放结果');
  assert.deepEqual(proof.snapshot.surfaces, snapshot.surfaces, '恢复场景表面必须来自完整重放结果');
}

export function assertLightingFactoryResumeBindings(bound, proof) {
  assert.equal(bound.error, null, '恢复GI运行时存在实际错误');
  assert.ok(bound.statePresent && bound.sceneReady, '必须实际加载并应用GI，不能仅凭结果文件采样');
  assert.equal(bound.actualSignature, proof.inputSignature, '当前文档与完整GI输入签名不一致');
  assert.equal(bound.boundSignature, proof.inputSignature, '实际绑定GI结果与完整输入签名不一致');
  assert.equal(bound.actualGeometrySignature, proof.geometrySignature, '当前实际几何与完整GI输入签名不一致');
  assert.equal(bound.boundGeometrySignature, proof.geometrySignature, '实际绑定GI几何与完整输入签名不一致');
  assert.equal(bound.staticPrimitiveCount, proof.expectedStaticMeshCount, '实际静态输入范围不完整');
  assert.equal(bound.staticReceiverPrimitiveCount, proof.expectedReceiverCount, '实际静态接收表面范围不完整');
  assert.equal(bound.missingPrimitiveCount, 0, '实际GI遗漏静态表面覆盖');
  assert.equal(bound.snapshotSurfaceCount, proof.snapshot.surfaces.length, '实际GI表面清单与重放结果不一致');
  assert.equal(bound.staticBoundSurfaceCount, bound.snapshotSurfaceCount, '实际GI绑定未覆盖所有静态表面');
  assert.ok(bound.resourcesReady && bound.probeCount > 0, '实际GI资源尚未完整可用');
  if (proof.snapshot.statistics.probeCount !== undefined) assert.equal(bound.probeCount, proof.snapshot.statistics.probeCount, '实际探针数量与重放结果不一致');
}

async function readResumeBindings(page) {
  return page.evaluate(async () => {
    const { runtime, store } = window.lightingSmoke;
    await runtime.waitForLightingReady();
    const lighting = runtime.environment?.lightingRuntime ?? runtime.lightingRuntime;
    const { getSceneLightingBakeSignature } = await import('/electron/shared/sceneLightingBakeContract.ts');
    const { getLightingGeometrySignature, lightingSourceVisible, sourceGeometryMesh } = await import('/src/runtime/babylon/lightingRuntimeCapture.ts');
    lighting.getClassification();
    const state = lighting.state, snapshot = state?.snapshot, sources = lighting.sources ?? [];
    const primitiveKeys = [], receiverKeys = [];
    for (const source of sources) {
      if (source.entry.mobility !== 'static' || !lightingSourceVisible(source)) continue;
      const mesh = sourceGeometryMesh(source.mesh), groups = mesh.subMeshes;
      const keys = groups.length ? groups.flatMap((group, index) => (mesh.isUnIndexed ? group.verticesCount : group.indexCount)
        ? [source.entry.key + '/primitive:' + index] : []) : [source.entry.key + '/primitive:0'];
      primitiveKeys.push(...keys); if (source.entry.bakeIndirect) receiverKeys.push(...keys);
    }
    const covered = new Set((snapshot?.surfaces ?? []).map(surface => surface.key.replace(/\/tile:[^/]+$/, '')));
    const missing = receiverKeys.filter(key => !covered.has(key));
    const assets = snapshot?.assets ?? [];
    const resourcesReady = Boolean(state && assets.every(asset => asset.kind === 'geometry' ? state.resources.geometries.has(asset.id)
      : asset.kind === 'lightmap' ? state.resources.textures.get(asset.id)?.isReady() : asset.id === snapshot.probeAssetId));
    const probeCount = state ? [...state.resources.probes.cells.values()].reduce((sum, list) => sum + list.length, 0) : 0;
    return { error: runtime.getLightingBakeRuntimeError(), diagnostic: lighting.getDiagnostic?.(), statePresent: Boolean(state), sceneReady: runtime.scene.isReady(),
      actualSignature: getSceneLightingBakeSignature(store.getState().scene), boundSignature: snapshot?.signature,
      actualGeometrySignature: getLightingGeometrySignature(sources), boundGeometrySignature: snapshot?.geometrySignature,
      staticPrimitiveCount: primitiveKeys.length, staticReceiverPrimitiveCount: receiverKeys.length, missingPrimitiveCount: missing.length, missingPrimitiveExamples: missing.slice(0, 16),
      snapshotSurfaceCount: snapshot?.surfaces.length ?? 0, staticBoundSurfaceCount: state?.records.filter(record => !record.dynamic && record.binding.enabled && record.binding.texture?.isReady()).length ?? 0,
      dynamicRecords: state?.records.filter(record => record.dynamic).length ?? 0, resourcesReady, probeCount,
      geometryAssetsLoaded: state?.resources.geometries.size ?? 0, textureAssetsLoaded: state?.resources.textures.size ?? 0 };
  });
}

async function installCaptureDiagnostics(page, bindingName) {
  await page.evaluate(async ({ bindingName, inspectSource }) => {
    const smoke = window.lightingSmoke, runtime = smoke.runtime;
    const lighting = runtime.environment?.lightingRuntime ?? runtime.lightingRuntime;
    const { sourceGeometryMesh } = await import('/src/runtime/babylon/lightingRuntimeCapture.ts');
    const inspect = new Function('return (' + inspectSource + ')')();
    const own = Object.getOwnPropertyDescriptor(lighting, 'captureBakeInput'), original = lighting.captureBakeInput;
    const metadata = source => {
      const mesh = sourceGeometryMesh(source.mesh), indices = mesh.getIndices(), positions = mesh.getVerticesData('position');
      return { sourceKey: source.entry.key, entityId: source.entry.entityId, nodeKey: source.entry.nodeKey, name: source.entry.name,
        ownerEntityId: source.entry.policyContext?.ownerEntityId, mobility: source.entry.mobility,
        sourceMesh: { name: source.mesh.name, id: source.mesh.uniqueId, className: source.mesh.getClassName() },
        geometryMesh: { name: mesh.name, id: mesh.uniqueId, className: mesh.getClassName(), geometryId: mesh.geometry?.uniqueId,
          isUnIndexed: mesh.isUnIndexed, positionsCount: positions?.length ?? 0, vertexCount: mesh.getTotalVertices(), indicesCount: indices?.length ?? 0,
          materialName: mesh.material?.name, materialClass: mesh.material?.getClassName(), fillMode: mesh.material?.fillMode },
        subMeshes: (mesh.subMeshes ?? []).map((group, index) => {
          const material = group.getMaterial?.() ?? mesh.material;
          return { index, materialIndex: group.materialIndex, indexStart: group.indexStart, indexCount: group.indexCount,
            verticesStart: group.verticesStart, verticesCount: group.verticesCount,
            actualSliceCount: indices ? Math.max(0, Math.min(indices.length, group.indexStart + group.indexCount) - Math.min(indices.length, group.indexStart)) : 0,
            materialName: material?.name, materialClass: material?.getClassName(), fillMode: material?.fillMode };
        }) };
    };
    const records = () => {
      const candidates = new Map();
      for (const source of lighting.sources ?? []) if (source.entry.mobility === 'dynamic') {
        const entry = source.entry, owner = entry.policyContext?.ownerEntityId ?? entry.entityId;
        const candidate = candidates.get(owner) ?? { ownerEntityId: owner, sourceCount: 0, names: [], deviceTypes: [] };
        candidate.sourceCount++;
        if (candidate.names.length < 4 && !candidate.names.includes(entry.name)) candidate.names.push(entry.name);
        if (entry.deviceType && !candidate.deviceTypes.includes(entry.deviceType)) candidate.deviceTypes.push(entry.deviceType);
        candidates.set(owner, candidate);
      }
      return { sourceCount: lighting.sources?.length ?? 0, staticSources: lighting.sources?.filter(source => source.entry.mobility === 'static').length ?? 0,
        dynamicSources: lighting.sources?.filter(source => source.entry.mobility === 'dynamic').length ?? 0,
        activeGiRecords: lighting.state ? { total: lighting.state.records.length, dynamic: lighting.state.records.filter(record => record.dynamic).length } : null,
        shadowOnlyRecords: lighting.shadowInstances?.records?.length ?? null,
        workloadCandidates: [...candidates.values()].sort((a, b) => a.sourceCount - b.sourceCount) };
    };
    const wrapped = async function (...args) {
      let input;
      try { input = await original.apply(this, args); }
      catch (error) {
        await window[bindingName]({ captureFailed: true, message: error instanceof Error ? error.message : String(error), records: records(),
          staticSources: (lighting.sources ?? []).filter(source => source.entry.mobility === 'static').map(metadata) });
        throw error;
      }
      const sourceByKey = new Map((lighting.sources ?? []).map(source => [source.entry.key, source]));
      const invalid = [];
      for (const mesh of input.meshes) {
        const issue = inspect(mesh); if (!issue) continue;
        const match = /^(.*)\/primitive:(\d+)$/.exec(mesh.key), source = match ? sourceByKey.get(match[1]) : null;
        invalid.push({ ...issue, primitiveIndex: match ? Number(match[2]) : null, source: source ? metadata(source) : null });
      }
      const report = { captureFailed: false, signature: input.signature, geometrySignature: input.geometrySignature,
        exportedMeshes: input.meshes.length, invalidMeshes: invalid.length, invalid, records: records(),
        staticSources: (lighting.sources ?? []).filter(source => source.entry.mobility === 'static').map(metadata) };
      // Node端先落盘，再把同一原始input交回正式IPC预检，保留实际validator的结论。
      await window[bindingName](report);
      return input;
    };
    lighting.captureBakeInput = wrapped;
    smoke.factoryGiCaptureDiagnostics = { dispose() {
      if (lighting.captureBakeInput === wrapped) { if (own) Object.defineProperty(lighting, 'captureBakeInput', own); else delete lighting.captureBakeInput; }
      delete smoke.factoryGiCaptureDiagnostics;
    } };
  }, { bindingName, inspectSource: inspectLightingBakePrimitive.toString() });
}

async function installProbeComparison(page, source, workloadEntityId) {
  await page.evaluate(async ({ source, workloadEntityId }) => {
    const smoke = window.lightingSmoke, runtime = smoke.runtime;
    const lighting = runtime.environment?.lightingRuntime ?? runtime.lightingRuntime;
    if (!lighting?.state?.resources?.probes) throw new Error('GI 未实际应用，不能安装探针对照。');
    // 从当前真实对象取得构造器，避免Vite原始包与优化包的双模块实例使计数漏掉当前算法。
    const Matrix = lighting.state.staticWatch[0].matrix.constructor, Vector3 = runtime.scene.activeCamera.position.constructor;
    const { Ray } = await import('/node_modules/@babylonjs/core/Culling/ray.js');
    const { sourceGeometryMesh, lightingSourceVisible } = await import('/src/runtime/babylon/lightingRuntimeCapture.ts');
    const { lightingMaterialValueSignature, restoreLightingMaterialValues } = await import('/src/runtime/babylon/lightingRuntimeMaterial.ts');
    const baseline = new Function('Ray', 'Matrix', 'Vector3', 'sourceGeometryMesh', 'lightingSourceVisible', 'lightingMaterialValueSignature', 'restoreLightingMaterialValues',
      source + '\nreturn { sample: LegacyLightingProbeSampler.prototype.sample, update: LegacySceneLightingRuntime.prototype.updateDynamicBindings, visible: LegacySceneLightingRuntime.prototype.probeVisible };')
      (Ray, Matrix, Vector3, sourceGeometryMesh, lightingSourceVisible, lightingMaterialValueSignature, restoreLightingMaterialValues);
    const prototype = Object.getPrototypeOf(lighting), samplerPrototype = Object.getPrototypeOf(lighting.state.resources.probes);
    const originals = { update: prototype.updateDynamicBindings, sample: samplerPrototype.sample, visible: Object.getOwnPropertyDescriptor(prototype, 'probeVisible'), invert: Matrix.Invert };
    const sourceMethods = [], meshMethods = [], seenMeshes = new Set(), expectedPoses = new Map();
    const metrics = { bindingsCalls: 0, bindingsCpuMs: 0, sampleCalls: 0, sampleCpuMs: 0, visibilityCalls: 0, visibilityCpuMs: 0, matrixReads: 0, matrixInversions: 0, triangleTests: 0 };
    const controlledRecords = workloadEntityId ? lighting.state.records.filter(record => record.dynamic
      && (record.source.entry.entityId === workloadEntityId || record.source.entry.policyContext?.ownerEntityId === workloadEntityId)) : [];
    if (workloadEntityId && !controlledRecords.length) throw new Error('指定设备宿主不存在实际GI动态记录：' + workloadEntityId);
    const harness = { mode: 'optimized', collecting: false, visibilityDepth: 0, poseChanged: false, metrics, lighting, state: lighting.state, controlledRecords };
    const reset = () => { for (const key of Object.keys(metrics)) metrics[key] = 0; harness.poseChanged = false; };
    const sources = new Set([...lighting.state.staticWatch.map(watch => watch.source), ...lighting.state.records.map(record => record.source)]);
    for (const source of sources) {
      const original = source.getWorldMatrix, world = original.call(source);
      if (world) expectedPoses.set(source, Array.from(world.m));
      const wrapped = function (...args) {
        const value = original.apply(this, args);
        if (harness.collecting && harness.visibilityDepth) metrics.matrixReads++;
        const expected = expectedPoses.get(source);
        if (harness.collecting && expected && value && expected.some((number, index) => Math.abs(number - value.m[index]) > 1e-9)) harness.poseChanged = true;
        return value;
      };
      source.getWorldMatrix = wrapped; sourceMethods.push({ source, original, wrapped });
      const mesh = sourceGeometryMesh(source.mesh);
      if (seenMeshes.has(mesh)) continue;
      seenMeshes.add(mesh);
      const intersects = mesh.intersects, wrappedIntersects = function (...args) {
        if (harness.collecting && harness.visibilityDepth) metrics.triangleTests++;
        return intersects.apply(this, args);
      };
      mesh.intersects = wrappedIntersects; meshMethods.push({ mesh, original: intersects, wrapped: wrappedIntersects });
    }
    const wrappedInvert = function (...args) { if (harness.collecting && harness.visibilityDepth) metrics.matrixInversions++; return originals.invert.apply(this, args); };
    Matrix.Invert = wrappedInvert;
    const wrappedSample = function (position, visible = () => true) {
      const started = performance.now();
      if (harness.collecting) metrics.sampleCalls++;
      try {
        return (harness.mode === 'baseline' ? baseline.sample : originals.sample).call(this, position, point => {
          const started = performance.now();
          if (harness.collecting) metrics.visibilityCalls++;
          harness.visibilityDepth++;
          try { return visible(point); }
          finally { harness.visibilityDepth--; if (harness.collecting) metrics.visibilityCpuMs += performance.now() - started; }
        });
      } finally { if (harness.collecting) metrics.sampleCpuMs += performance.now() - started; }
    };
    const wrappedUpdate = function (...args) {
      const started = performance.now(); if (harness.collecting) metrics.bindingsCalls++;
      try { return (harness.mode === 'baseline' ? baseline.update : originals.update).apply(this, args); }
      finally { if (harness.collecting) metrics.bindingsCpuMs += performance.now() - started; }
    };
    samplerPrototype.sample = wrappedSample; prototype.updateDynamicBindings = wrappedUpdate; prototype.probeVisible = baseline.visible;
    const gi = () => {
      const state = lighting.state;
      return { applied: state === harness.state && !lighting.getError() && [...(state?.resources.textures.values() ?? [])].every(texture => texture.isReady()),
        signature: state?.snapshot.signature, assets: state?.snapshot.assets, statistics: state?.snapshot.statistics,
        staticBindings: state?.records.filter(record => !record.dynamic && record.binding.texture && record.binding.enabled).length ?? 0,
        records: state?.records.length ?? 0, dynamicRecords: state?.records.filter(record => record.dynamic).length ?? 0,
        dynamicBindings: state?.records.filter(record => record.dynamic && record.binding.probes && record.binding.enabled).length ?? 0,
        controlledWorkload: workloadEntityId ? { entityId: workloadEntityId, records: controlledRecords.length,
          coveredRecords: controlledRecords.filter(record => record.binding.probes && record.binding.enabled).length,
          parts: controlledRecords.map(record => ({ key: record.source.entry.key, entityId: record.source.entry.entityId,
            ownerEntityId: record.source.entry.policyContext?.ownerEntityId, nodeKey: record.source.entry.nodeKey, name: record.source.entry.name })) } : null,
        probeCount: state ? [...state.resources.probes.cells.values()].reduce((sum, probes) => sum + probes.length, 0) : 0 };
    };
    const camera = () => {
      const scene = runtime.scene, current = scene.activeCamera, engine = scene.getEngine();
      return { id: current.uniqueId, position: Array.from(current.position.asArray()), target: current.getTarget?.().asArray(),
        view: Array.from(current.getViewMatrix().m), projection: Array.from(current.getProjectionMatrix().m),
        viewport: [engine.getRenderWidth(), engine.getRenderHeight(), engine.getHardwareScalingLevel()], dpr: window.devicePixelRatio };
    };
    const dispose = () => {
      if (prototype.updateDynamicBindings === wrappedUpdate) prototype.updateDynamicBindings = originals.update;
      if (samplerPrototype.sample === wrappedSample) samplerPrototype.sample = originals.sample;
      if (prototype.probeVisible === baseline.visible) {
        if (originals.visible) Object.defineProperty(prototype, 'probeVisible', originals.visible); else delete prototype.probeVisible;
      }
      if (Matrix.Invert === wrappedInvert) Matrix.Invert = originals.invert;
      for (const { source, original, wrapped } of sourceMethods) if (source.getWorldMatrix === wrapped) source.getWorldMatrix = original;
      for (const { mesh, original, wrapped } of meshMethods) if (mesh.intersects === wrapped) mesh.intersects = original;
      if (smoke.factoryGi === harness) delete smoke.factoryGi;
    };
    Object.assign(harness, { reset, gi, camera, dispose }); smoke.factoryGi = harness;
  }, { source, workloadEntityId });
}

async function collectProbeFrames(page, mode, workload, expectedFrames) {
  return page.evaluate(({ mode, workload, expectedFrames }) => new Promise((resolve, reject) => {
    const smoke = window.lightingSmoke, harness = smoke.factoryGi, runtime = smoke.runtime, scene = runtime.scene;
    const beforeCamera = harness.camera(), cameraSignature = JSON.stringify(beforeCamera), beforeGi = harness.gi();
    if (!beforeGi.applied || !scene.isReady()) { reject(new Error('GI 或真实工厂材质未准备完成。')); return; }
    if (workload === 'probe-resample' && !beforeGi.controlledWorkload?.coveredRecords) { reject(new Error('没有实际探针覆盖的动态接收者，无法验证探针CPU成本。')); return; }
    harness.mode = mode; harness.collecting = false;
    const force = scene.onBeforeRenderObservable.add(() => {
      if (workload === 'probe-resample') for (const record of harness.controlledRecords) record.lastProbePosition = null;
    }, -1, true);
    const conditions = { hiddenFrames: 0, unfocusedFrames: 0, preparingFrames: 0, cameraChangedFrames: 0, resourceChangedFrames: 0, poseChangedFrames: 0 };
    let warmFrames = 0, previous = null, finished = false;
    const times = [], start = performance.now();
    const finish = timeout => {
      if (finished) return; finished = true; clearTimeout(timer); harness.collecting = false;
      scene.onAfterRenderObservable.remove(observer); scene.onBeforeRenderObservable.remove(force);
      const gi = harness.gi();
      if (!gi.applied || !scene.isReady()) conditions.resourceChangedFrames++;
      if (harness.poseChanged) conditions.poseChangedFrames++;
      let pixels = null;
      try {
        const canvas = scene.getEngine().getRenderingCanvas(), readback = document.createElement('canvas');
        readback.width = Math.min(320, canvas.width); readback.height = Math.min(200, canvas.height);
        const context = readback.getContext('2d'); context.drawImage(canvas, 0, 0, readback.width, readback.height);
        const rgba = context.getImageData(0, 0, readback.width, readback.height).data, colors = new Set();
        let sum = 0; for (let i = 0; i < rgba.length; i += 16) { colors.add(rgba[i] + ',' + rgba[i + 1] + ',' + rgba[i + 2]); sum += rgba[i] + rgba[i + 1] + rgba[i + 2]; }
        pixels = { colors: colors.size, channelSum: sum, width: readback.width, height: readback.height, dataUrl: readback.toDataURL('image/png') };
      } catch (error) { conditions.resourceChangedFrames++; pixels = { error: String(error) }; }
      resolve({ mode, workload, frames: times.length, expectedFrames, timeout, elapsedMs: performance.now() - start,
        rawFrameMs: times, cpu: { ...harness.metrics }, conditions, cameraBefore: beforeCamera, cameraAfter: harness.camera(), gi, pixels });
    };
    const timer = setTimeout(() => finish(true), 180_000);
    const observer = scene.onAfterRenderObservable.add(() => {
      const now = performance.now();
      if (warmFrames++ < 60) { previous = now; return; }
      if (!harness.collecting) { harness.reset(); harness.collecting = true; previous = now; return; }
      times.push(now - previous); previous = now;
      if (document.hidden || document.visibilityState !== 'visible') conditions.hiddenFrames++;
      if (!document.hasFocus()) conditions.unfocusedFrames++;
      if (smoke.preparation?.isScenePreparationActive() || runtime.getInitialLoadSnapshot().progress.loading) conditions.preparingFrames++;
      if (JSON.stringify(harness.camera()) !== cameraSignature) conditions.cameraChangedFrames++;
      if (harness.lighting.state !== harness.state || harness.lighting.getError() || scene.getEngine()._gl?.isContextLost?.()) conditions.resourceChangedFrames++;
      if (times.length >= expectedFrames || Object.values(conditions).some(value => value !== 0) || harness.poseChanged) finish(false);
    });
  }), { mode, workload, expectedFrames });
}

async function measureManagerExposure(page) {
  await page.evaluate(() => window.lightingSmoke.store.getState().openLightingManager({ tab: 'overview' }));
  const dialog = page.getByRole('dialog', { name: '光照与烘焙管理器', exact: true });
  await dialog.waitFor({ state: 'visible' });
  const details = dialog.locator('details').filter({ has: page.locator('summary', { hasText: '显示效果' }) });
  if (!await details.evaluate(node => node.open)) await details.locator('summary').click();
  const input = dialog.getByRole('spinbutton', { name: '曝光', exact: true }), original = await input.inputValue();
  await page.evaluate(() => {
    const entries = []; let observer = null;
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) { observer = new PerformanceObserver(list => entries.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })))); observer.observe({ type: 'longtask', buffered: false }); }
    window.lightingSmoke.managerTiming = { started: performance.now(), entries, observer };
  });
  await input.fill(String(Math.min(4, Math.max(0.1, Number(original) + 0.05))));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const timing = await page.evaluate(() => {
    const timing = window.lightingSmoke.managerTiming; timing.observer?.disconnect();
    const result = { elapsedMs: performance.now() - timing.started, longTasks: timing.entries, implementation: 'current-ui-in-all-modes' };
    delete window.lightingSmoke.managerTiming; return result;
  });
  await input.fill(original);
  await dialog.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  return timing;
}


/** 正式帧采样结束后才执行；比较同一真实分类事实的重复构建与曝光草稿缓存。 */
async function measureManagerClassificationCpu(page, expectedGiSignature) {
  const measured = await page.evaluate(async expectedGiSignature => {
    const { createLightingManagerDraft, buildLightingManagerRows, createLightingManagerRowsSelector }
      = await import('/src/editor/panels/lightingBakeManagerModel.ts');
    const { runtime, store } = window.lightingSmoke, before = store.getState();
    const scene = before.scene, history = before.history, sessionId = before.sceneSessionId;
    const lighting = runtime.environment?.lightingRuntime ?? runtime.lightingRuntime, lightingState = lighting.state;
    if (runtime.getLightingBakeRuntimeError() || scene.sceneSettings.lighting.result?.signature !== expectedGiSignature) {
      throw new Error('管理器分类微测量必须使用正式帧采样的同一真实GI场景。');
    }
    const sceneBefore = JSON.stringify(scene), entries = runtime.getLightingClassification();
    const draft = createLightingManagerDraft(scene, sessionId), selector = createLightingManagerRowsSelector();
    // facts、entity和entities大图的共享引用先短路，仅递归核对纯函数生成的派生结构，避免逐行序列化整场景。
    const equivalent = (left, right) => {
      if (Object.is(left, right)) return true;
      if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
      if (Array.isArray(left) !== Array.isArray(right) || Array.isArray(left) && left.length !== right.length) return false;
      if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
      const keys = Object.keys(left);
      if (keys.length !== Object.keys(right).length) return false;
      for (const key of keys) if (!Object.hasOwn(right, key) || !equivalent(left[key], right[key])) return false;
      return true;
    };
    let started = performance.now(), coldRecomputed = buildLightingManagerRows(scene, entries, draft);
    const recomputeColdMs = performance.now() - started;
    started = performance.now(); const cachedRows = selector(draft, entries);
    const selectorColdBuildMs = performance.now() - started;
    const coldEquivalent = equivalent(coldRecomputed, cachedRows); coldRecomputed = null;
    const iterations = 5, recomputeMs = [], cacheSelectMs = [], exposureValues = [], order = [], cacheIdentityHits = [], rowsEquivalent = [];
    const baseExposure = draft.appearance.exposure, direction = baseExposure >= 3.5 ? -1 : 1;
    for (let index = 0; index < iterations; index++) {
      const exposure = baseExposure + direction * 0.01 * (index + 1);
      const exposureDraft = { ...draft, appearance: { ...draft.appearance, exposure } };
      exposureValues.push(exposure);
      let rebuiltRows, selectedRows;
      const recompute = () => {
        const began = performance.now(); rebuiltRows = buildLightingManagerRows(scene, entries, exposureDraft);
        recomputeMs.push(performance.now() - began);
      };
      const cached = () => {
        const began = performance.now(); selectedRows = selector(exposureDraft, entries);
        cacheSelectMs.push(performance.now() - began);
      };
      // 交替顺序减少固定先后顺序的影响；结构校验与草稿创建均不计入被测调用耗时。
      if (index % 2 === 0) { order.push('recompute/cache'); recompute(); cached(); }
      else { order.push('cache/recompute'); cached(); recompute(); }
      cacheIdentityHits.push(selectedRows === cachedRows);
      rowsEquivalent.push(rebuiltRows.length === entries.length && selectedRows.length === entries.length && equivalent(rebuiltRows, selectedRows));
    }
    const after = store.getState();
    return {
      scope: '当前分类函数的重复计算 vs 曝光缓存；组件微测量，不是旧UI整体A/B或FPS提升。计时仅包含各次函数调用，语义核对在计时外。',
      coldMeaning: '新selector空缓存的首次构建；不是JavaScript虚拟机冷启动。',
      sceneId: scene.id ?? null, sceneSessionId: sessionId, giSignature: expectedGiSignature,
      entityCount: scene.entityIds.length, classificationFactCount: entries.length, rowCount: cachedRows.length, iterations,
      cold: { recomputeMs: recomputeColdMs, selectorBuildMs: selectorColdBuildMs, rowsEquivalent: coldEquivalent },
      raw: { recomputeMs, cacheSelectMs, exposureValues, order, cacheIdentityHits, rowsEquivalent },
      cacheHitCount: cacheIdentityHits.filter(Boolean).length,
      validation: {
        allRowsEquivalent: coldEquivalent && rowsEquivalent.every(Boolean),
        rowCountMatchesFacts: cachedRows.length === entries.length,
        cacheRowsIdentityStable: cacheIdentityHits.every(Boolean),
        classificationReferenceStable: runtime.getLightingClassification() === entries,
        sceneIdentityUnchanged: after.scene === scene, sceneContentUnchanged: JSON.stringify(scene) === sceneBefore,
        historyIdentityUnchanged: after.history === history, sceneSessionUnchanged: after.sceneSessionId === sessionId,
        lightingStateUnchanged: lighting.state === lightingState,
      },
    };
  }, expectedGiSignature);
  measured.recompute = summarizeLightingGiFrames(measured.raw.recomputeMs);
  measured.cacheSelect = summarizeLightingGiFrames(measured.raw.cacheSelectMs);
  return measured;
}

/** 完整工厂由外层加载和隔离；本函数只在相同资产/姿态下切换原探针查询算法。 */
export async function runLightingFactoryGiPerformance({ application, page, result, output, focusWindow, readWindowState, readGpuMemory, waitForReady, resumeScenePath = process.env.LIGHTING_FACTORY_GI_RESUME_SCENE || null, resumeEvidence }) {
  result.gi = { status: 'RUNNING', scope: '完整静态输入、正式CPU烘焙与实际GI绑定；自然帧单独报告。受控探针重采样必须明确选择一个设备宿主，保留该宿主全部动态部件；绝不默认强制全场。计时包含对两组相同的测量包装开销。管理器操作均为当前UI，不能作为旧UI性能对照。', samples: [] };
  const save = () => writeFile(path.join(output, 'factory-gi-performance.json'), JSON.stringify(result, null, 2));
  const memory = () => application.evaluate(({ app }) => app.getAppMetrics().map(process => ({ pid: process.pid, type: process.type, memory: process.memory, cpu: process.cpu })));
  let comparisonInstalled = false, captureInstalled = false, diagnosticStage = 'original';
  const diagnosticBinding = '__lightingFactoryGiInput_' + Date.now();
  try {
    await waitForReady(); await focusWindow();
    if (resumeScenePath) {
      assert.ok(resumeEvidence, '恢复GI性能验收需要正式重放报告');
      result.gi.resumeSource = { scenePath: path.resolve(resumeScenePath), proof: result.resumeSource };
      result.gi.resumeBindings = await readResumeBindings(page);
      await save();
      assertLightingFactoryResumeBindings(result.gi.resumeBindings, resumeEvidence);
      result.gi.savedScenePath = path.resolve(resumeScenePath);
      result.gi.engineSkipped = true; result.gi.captureSkipped = true;
      result.gi.processMemoryAfterLoad = await memory();
      console.log('[lighting-factory-gi] 恢复已真实绑定GI：' + result.gi.resumeBindings.staticPrimitiveCount + ' 个完整静态primitive，'
        + result.gi.resumeBindings.staticBoundSurfaceCount + ' 个图集表面绑定，动态 ' + result.gi.resumeBindings.dynamicRecords);
      await save();
    } else {
      await page.exposeFunction(diagnosticBinding, async diagnostic => {
        result.gi.inputDiagnostics ??= [];
        result.gi.inputDiagnostics.push({ stage: diagnosticStage, ...diagnostic });
        await writeFile(path.join(output, 'factory-gi-input-diagnostics.json'), JSON.stringify(result.gi.inputDiagnostics, null, 2));
        await save();
      });
      await installCaptureDiagnostics(page, diagnosticBinding); captureInstalled = true;
      result.gi.originalPreflight = await page.evaluate(() => window.lightingSmoke.runtime.preflightLightingBake(window.lightingSmoke.store.getState().scene));
      await page.evaluate(() => {
        const { store, runtime } = window.lightingSmoke;
        store.getState().setLightingDraftPreview(null); store.getState().closeLightingManager();
        store.getState().updateLightingBakeSettings({ enabled: true, quality: 'preview', texelsPerMeter: 4, atlasSize: 1024, probeSpacing: 20, maxTextureMiB: 256, device: 'cpu', cacheStaticShadows: true });
        runtime.syncLighting(store.getState().scene);
      });
      await waitForReady();
      diagnosticStage = 'configured';
      result.gi.configuredPreflight = await page.evaluate(() => window.lightingSmoke.runtime.preflightLightingBake(window.lightingSmoke.store.getState().scene));
      for (const key of ['meshCount', 'receiverCount', 'triangleCount', 'vertexCount', 'receiverArea', 'geometryBytes']) assert.equal(result.gi.configuredPreflight[key], result.gi.originalPreflight[key], '不能删减真实工厂静态源：' + key);
      await save();
      console.log('[lighting-factory-gi] 完整输入预检：' + result.gi.configuredPreflight.meshCount + ' 个源，' + result.gi.configuredPreflight.triangleCount + ' 三角面，图集下界 ' + result.gi.configuredPreflight.minAtlasCount + '，探针 ' + result.gi.configuredPreflight.probeCount);
      assert.ok(!result.gi.configuredPreflight.issues.some(issue => issue.severity === 'error'), '完整工厂GI预检不通过；已保存实际成本，不能静默删对象或降低本次明确设置。');
      if (process.env.LIGHTING_FACTORY_GI_PREFLIGHT_ONLY === '1') { result.gi.status = 'PREFLIGHT_ONLY'; await save(); return result; }
      result.gi.processMemoryBeforeBake = await memory();
      const started = Date.now();
      console.log('[lighting-factory-gi] 正式启动完整工厂CPU GI烘焙，保持全部静态输入');
      await page.evaluate(() => window.lightingSmoke.store.getState().requestLightingBake());
      await page.waitForFunction(() => {
        const { store, runtime } = window.lightingSmoke, state = store.getState();
        if (state.lightingBakeStatus.phase === 'error' || state.lightingBakeStatus.phase === 'cancelled') throw new Error(state.lightingBakeStatus.message);
        return !state.lightingBakeRequest && Boolean(state.scene.sceneSettings.lighting.result) && !runtime.getLightingBakeRuntimeError();
      }, null, { timeout: 3_600_000 });
      await page.evaluate(() => window.lightingSmoke.runtime.waitForLightingReady()); await waitForReady();
      result.gi.bakeDurationMs = Date.now() - started; result.gi.processMemoryAfterBake = await memory();
      await page.getByRole('button', { name: '保存场景', exact: true }).click();
      await page.waitForFunction(() => { const state = window.lightingSmoke.store.getState(); return Boolean(state.scene.sceneSettings.lighting.result?.signature && state.persistedSceneContent?.includes(state.scene.sceneSettings.lighting.result.signature)); }, null, { timeout: 60_000 });
      result.gi.savedScenePath = result.sceneCopyPath;
      await save();
    }
    const [{ stdout: sampler }, { stdout: runtime }, { stdout: ref }] = await Promise.all([
      execute('git', ['show', 'HEAD:src/runtime/babylon/lightingProbes.ts'], { maxBuffer: 4 * 1024 * 1024 }),
      execute('git', ['show', 'HEAD:src/runtime/babylon/SceneLightingRuntime.ts'], { maxBuffer: 4 * 1024 * 1024 }),
      execute('git', ['rev-parse', 'HEAD']),
    ]);
    result.gi.baseline = { gitRef: ref.trim(), samplerSha256: createHash('sha256').update(sampler).digest('hex'), runtimeSha256: createHash('sha256').update(runtime).digest('hex') };
    const workloadEntityId = process.env.LIGHTING_FACTORY_GI_WORKLOAD_ENTITY_ID || null;
    await installProbeComparison(page, buildLightingGiBaseline(sampler, runtime), workloadEntityId); comparisonInstalled = true;
    result.gi.applied = await page.evaluate(() => window.lightingSmoke.factoryGi.gi());
    assert.ok(result.gi.applied.applied && result.gi.applied.staticBindings > 0, '没有实际应用完整GI，不能只凭后台成功采样');
    await save();
    console.log('[lighting-factory-gi] 已应用 ' + result.gi.applied.records + ' 个记录，动态 ' + result.gi.applied.dynamicRecords + '，探针覆盖 ' + result.gi.applied.dynamicBindings + '；受控宿主 ' + (workloadEntityId || '未指定（仅自然帧）') + '，受控完整动态部件 ' + (result.gi.applied.controlledWorkload?.records ?? 0));
    const workloads = workloadEntityId ? [['natural', 240], ['probe-resample', 120]] : [['natural', 240]];
    for (const [index, mode] of ['baseline', 'optimized', 'optimized', 'baseline'].entries()) {
      for (const [workload, frames] of workloads) {
        const nativeWindowBefore = await focusWindow(); await waitForReady();
        const sample = await collectProbeFrames(page, mode, workload, frames);
        sample.index = index; sample.nativeWindowBefore = nativeWindowBefore; sample.nativeWindowAfter = await readWindowState();
        if (sample.rawFrameMs.length) sample.frameTime = summarizeLightingGiFrames(sample.rawFrameMs);
        result.gi.samples.push(sample); await save(); assertLightingGiSample(sample);
        console.log('[lighting-factory-gi] ' + (index + 1) + '/4 ' + mode + '/' + workload + '：' + sample.frameTime.meanMs.toFixed(2) + ' ms/frame，探针CPU ' + sample.cpu.sampleCpuMs.toFixed(2) + ' ms，射线 ' + sample.cpu.triangleTests);
        assert.ok(sample.pixels?.colors > 20, '实际GI像素不能是空白');
        if (workload === 'probe-resample') assert.ok(sample.cpu.sampleCalls > 0 && sample.cpu.visibilityCalls > 0, '探针成本必须来自实际查询');
        if (result.gi.samples.length > 1) assert.deepEqual(sample.cameraBefore, result.gi.samples[0].cameraBefore, '所有段必须保持同一相机、分辨率和DPR');
        await page.screenshot({ path: path.join(output, 'factory-gi-' + index + '-' + mode + '-' + workload + '.png') });
      }
      result.gi.samples.at(-1).managerExposure = await measureManagerExposure(page);
      if (index === 0 || index === 2) result.gi.samples.at(-1).gpuProcessMemory = await readGpuMemory();
      await save();
    }
    // 组件微测量单独放在全部正式帧窗口之后，先归还探针包装，避免污染既有A/B/B/A或混用口径。
    if (comparisonInstalled) { await page.evaluate(() => window.lightingSmoke.factoryGi?.dispose()); comparisonInstalled = false; }
    result.gi.managerClassificationCpu = await measureManagerClassificationCpu(page, result.gi.applied.signature);
    await save();
    assert.ok(Object.values(result.gi.managerClassificationCpu.validation).every(Boolean), '真实管理器分类微测量必须保持语义、缓存身份和输入状态一致');
    assert.equal(result.gi.managerClassificationCpu.cacheHitCount, result.gi.managerClassificationCpu.iterations, '只改曝光必须全部命中分类缓存');
    result.gi.status = workloadEntityId ? 'PASS' : 'PARTIAL_NO_CONTROLLED_WORKLOAD'; await save(); return result;
  } catch (error) {
    result.gi.status = 'FAIL'; result.gi.error = error instanceof Error ? error.message : String(error); await save(); throw error;
  } finally {
    if (comparisonInstalled) await page.evaluate(() => window.lightingSmoke.factoryGi?.dispose());
    if (captureInstalled) await page.evaluate(() => window.lightingSmoke.factoryGiCaptureDiagnostics?.dispose());
    if (captureInstalled && typeof page.removeExposedBinding === 'function') await page.removeExposedBinding(diagnosticBinding);
  }
}
