import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLightingGiBaseline, assertLightingGiSample, summarizeLightingGiFrames, inspectLightingBakePrimitive, prepareLightingFactorySceneForPerformance, assertLightingFactoryResumeEvidence, assertLightingFactoryResumeBindings } from '../helpers/lightingFactoryGiPerformance.mjs';

test('GI性能harness只接受可定位的原算法并去除TypeScript注解', () => {
  const built = buildLightingGiBaseline('class LightingProbeSampler { sample(position: number[], visible: Function) { return this.values.filter(visible).slice(0, 8); } }',
    'function applyWorldMatrix(mesh: any, matrix: any): void { mesh.matrix = matrix; } class SceneLightingRuntime { private probeVisible(point: number[]): boolean { return true; } private updateDynamicBindings(force: boolean): void { this.probeVisible([]); } }');
  assert.ok(built.includes('class LegacyLightingProbeSampler')); assert.ok(built.includes('class LegacySceneLightingRuntime'));
  assert.ok(!built.includes('private probeVisible')); assert.throws(() => buildLightingGiBaseline('class Empty {}', 'class Empty {}'), /基线/);
});

test('GI性能结果不能接受无资源、隐藏、相机变化或不完整样本', () => {
  const valid = { frames: 240, expectedFrames: 240, conditions: { hiddenFrames: 0, unfocusedFrames: 0, preparingFrames: 0, cameraChangedFrames: 0, resourceChangedFrames: 0, poseChangedFrames: 0 },
    gi: { applied: true, staticBindings: 1, dynamicBindings: 1, probeCount: 8 }, nativeWindowBefore: { visible: true, minimized: false, focused: true, webContentsFocused: true },
    nativeWindowAfter: { visible: true, minimized: false, focused: true, webContentsFocused: true } };
  assert.doesNotThrow(() => assertLightingGiSample(valid));
  assert.throws(() => assertLightingGiSample({ ...valid, gi: { ...valid.gi, applied: false } }), /GI/);
  assert.throws(() => assertLightingGiSample({ ...valid, conditions: { ...valid.conditions, hiddenFrames: 1 } }), /有效/);
  assert.throws(() => assertLightingGiSample({ ...valid, frames: 239 }), /完整/);
  assert.deepEqual(summarizeLightingGiFrames([1, 2, 3, 100]), { meanMs: 26.5, medianMs: 3, p95Ms: 100, maxMs: 100 });
});

test('捕获诊断区分空切片、非三角索引数和越界，并保留完整primitive身份', () => {
  const base = { key: 'device/part/primitive:3', entityId: 'device', nodeKey: 'part', name: '支架', positions: [0,0,0,1,0,0,0,1,0], indices: [0,1,2] };
  assert.equal(inspectLightingBakePrimitive(base), null);
  const empty = inspectLightingBakePrimitive({ ...base, indices: [] });
  assert.equal(empty.key, base.key); assert.equal(empty.indicesCount, 0); assert.ok(empty.reasons.includes('empty-indices'));
  const invalid = inspectLightingBakePrimitive({ ...base, indices: [0,1,3,2] });
  assert.equal(invalid.maximumIndex, 3); assert.equal(invalid.vertexCount, 3); assert.ok(invalid.reasons.includes('index-count-not-triangles')); assert.ok(invalid.reasons.includes('invalid-index'));
  assert.deepEqual(invalid.invalidIndices, [{ offset: 2, value: 3, reason: 'out-of-range' }]);
});

test('恢复工厂GI保留真实snapshot和全部实体配置，仅隔离遥测且不改输入文件对象', () => {
  const snapshot = { signature: 'lighting-full', geometrySignature: 'geometry-full', assets: [{ id: 'g' }], surfaces: [{ key: 'full/primitive:0' }], statistics: { meshCount: 821, triangleCount: 870875 } };
  const content = { version: 6, scene: { entities: { a: { components: { transform: { position: { x: 1, y: 2, z: 3 } } } } }, entityIds: ['a'], selectedEntityId: 'a',
    mqttConfig: { enabled: true }, fetchConfig: { url: 'service', apiKey: 'fixture' }, sceneSettings: { lighting: { shadows: { enabled: true }, bake: { enabled: true, texelsPerMeter: 4 }, result: snapshot, policy: { version: 1 } }, openingAnimation: { enabled: true } } } };
  const before = structuredClone(content), prepared = prepareLightingFactorySceneForPerformance(content, { resume: true });
  assert.deepEqual(content, before); assert.deepEqual(prepared.scene.entities, before.scene.entities);
  assert.deepEqual(prepared.scene.sceneSettings.lighting, before.scene.sceneSettings.lighting);
  const fresh = prepareLightingFactorySceneForPerformance(content);
  assert.equal(fresh.scene.sceneSettings.lighting.bake.enabled, false); assert.equal(fresh.scene.sceneSettings.lighting.result, null);
  assert.deepEqual(fresh.scene.entities, before.scene.entities);
  assert.equal(prepared.scene.mqttConfig.enabled, false); assert.equal(prepared.scene.fetchConfig.url, ''); assert.equal(prepared.scene.sceneSettings.openingAnimation.enabled, false);
  assert.throws(() => prepareLightingFactorySceneForPerformance({ ...content, scene: { ...content.scene, sceneSettings: { lighting: { bake: { enabled: true } } } } }, { resume: true }), /恢复.*GI/);
});

test('恢复性能验收拒绝仅有文件、源SHA不符、几何签名失配、漏静态表面或资源未实际可用', () => {
  const snapshot = { signature: 'lighting-full', geometrySignature: 'geometry-full', assets: [{ id: 'g' }], surfaces: [{ key: 'full/primitive:0' }], statistics: { meshCount: 821, triangleCount: 870875 } };
  const proof = { status: 'PASS', sourceSceneSha256Before: 'original-sha', sourceSceneSha256After: 'original-sha', expectedStaticMeshCount: 821, expectedReceiverCount: 821, expectedTriangleCount: 870875,
    inputSignature: snapshot.signature, geometrySignature: snapshot.geometrySignature, snapshot, inputHashesBefore: [{ path: 'raw.json', sha256: 'raw', byteLength: 123 }], inputHashesAfter: [{ path: 'raw.json', sha256: 'raw', byteLength: 123 }] };
  assert.doesNotThrow(() => assertLightingFactoryResumeEvidence(proof, snapshot, 'original-sha'));
  assert.throws(() => assertLightingFactoryResumeEvidence(proof, snapshot, 'other-sha'), /原始/);
  const bindings = { error: null, statePresent: true, sceneReady: true, actualSignature: 'lighting-full', boundSignature: 'lighting-full', actualGeometrySignature: 'geometry-full', boundGeometrySignature: 'geometry-full', staticPrimitiveCount: 821,
    staticReceiverPrimitiveCount: 821, missingPrimitiveCount: 0, staticBoundSurfaceCount: 1, snapshotSurfaceCount: 1, resourcesReady: true, probeCount: 264 };
  assert.doesNotThrow(() => assertLightingFactoryResumeBindings(bindings, proof));
  assert.throws(() => assertLightingFactoryResumeBindings({ ...bindings, statePresent: false }, proof), /GI/);
  assert.throws(() => assertLightingFactoryResumeBindings({ ...bindings, actualGeometrySignature: 'other' }, proof), /几何/);
  assert.throws(() => assertLightingFactoryResumeBindings({ ...bindings, missingPrimitiveCount: 1 }, proof), /静态/);
  assert.throws(() => assertLightingFactoryResumeBindings({ ...bindings, resourcesReady: false }, proof), /资源/);
});

test('恢复证据区分原D场景和隔离copy的字节哈希，四个正式物理签名仍必须等于捕获输入', () => {
  const snapshot = { signature: 'lighting-full', geometrySignature: 'geometry-full', assets: [{ id: 'g' }], surfaces: [{ key: 'full/primitive:0' }], statistics: { meshCount: 821, triangleCount: 870875 } };
  const proof = { status: 'PASS', originalSourceScenePath: 'D:/factory/Scenes/original.scene.json', originalSourceSceneSha256Before: 'original-d-sha', originalSourceSceneSha256After: 'original-d-sha',
    sourceScenePath: 'C:/temp/Scenes/factory-readonly-copy.scene.json', sourceSceneSha256Before: 'isolated-copy-sha', sourceSceneSha256After: 'isolated-copy-sha',
    sceneSignature: 'lighting-full', compiledSignature: 'lighting-full', originalSceneSignature: 'lighting-full', originalCompiledSignature: 'lighting-full',
    expectedStaticMeshCount: 821, expectedReceiverCount: 821, expectedTriangleCount: 870875, inputSignature: 'lighting-full', geometrySignature: 'geometry-full', snapshot,
    inputHashesBefore: [{ path: 'raw.json', sha256: 'raw', byteLength: 123 }], inputHashesAfter: [{ path: 'raw.json', sha256: 'raw', byteLength: 123 }] };
  assert.doesNotThrow(() => assertLightingFactoryResumeEvidence(proof, snapshot, 'original-d-sha'));
  assert.throws(() => assertLightingFactoryResumeEvidence({ ...proof, originalSourceSceneSha256After: 'changed' }, snapshot, 'original-d-sha'), /原始/);
  assert.throws(() => assertLightingFactoryResumeEvidence({ ...proof, sourceSceneSha256After: 'changed' }, snapshot, 'original-d-sha'), /捕获|临时/);
  for (const field of ['sceneSignature', 'compiledSignature', 'originalSceneSignature', 'originalCompiledSignature']) {
    assert.throws(() => assertLightingFactoryResumeEvidence({ ...proof, [field]: 'different-physical-input' }, snapshot, 'original-d-sha'), /物理签名/);
  }
});
