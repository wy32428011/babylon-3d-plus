/* global window, document, requestAnimationFrame */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import unzipper from 'unzipper';
import { prepareBusinessGiSubset } from '../lightingBake/phase2GiBusinessSubset.mjs';
import { inspectBusinessGiDist, createBusinessGiViewerServer } from './phase2GiViewer.mjs';
import { validateLightingLightmapMipAsset } from '../../dist-electron/shared/sceneLightingLightmapMips.js';
import { installPhase2GlRestoreTrace } from '../../scripts/lib/phase2GlRestoreTrace.mjs';

export const mipsSha = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** 用户明确批准的恢复验收协议；自然AA与Mip资源字节仍保持exact。 */
export const mipsContextRestoreProtocol = Object.freeze({ id: 'phase2-b9-context-restore-rgb1-alpha0-v1',
  naturalAaMaxRgbaDelta: 0, contextRestoreMaxRgbDelta: 1, contextRestoreMaxAlphaDelta: 0, mipBytesMustBeExact: true });

/** Node侧独立比较完整RGBA；相同SHA声明也不能替代实际逐byte比较。 */
export function compareMipsRestoreRgba({ before0, before1, after }) {
  for (const value of [before0, before1, after]) if (!value || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || value.width <= 0 || value.height <= 0 || !Buffer.isBuffer(value.rgba) || value.rgba.length !== value.width * value.height * 4) throw new Error('B9 restore像素证据缺少完整RGBA。');
  const equal = (left, right) => left.width === right.width && left.height === right.height && left.rgba.equals(right.rgba);
  const aaStable = equal(before0, before1);
  const dimensionsEqual = before1.width === after.width && before1.height === after.height;
  let maxRgbDelta = 0, maxAlphaDelta = 0, differentPixels = 0, alphaDifferentPixels = 0, rgbOverOnePixels = 0;
  if (dimensionsEqual) for (let offset = 0; offset < before1.rgba.length; offset += 4) {
    const rgb = [0, 1, 2].map(channel => Math.abs(before1.rgba[offset + channel] - after.rgba[offset + channel]));
    const alpha = Math.abs(before1.rgba[offset + 3] - after.rgba[offset + 3]), maximum = Math.max(...rgb);
    maxRgbDelta = Math.max(maxRgbDelta, maximum); maxAlphaDelta = Math.max(maxAlphaDelta, alpha);
    if (maximum || alpha) differentPixels++; if (alpha) alphaDifferentPixels++; if (maximum > 1) rgbOverOnePixels++;
  }
  const statistics = dimensionsEqual ? { maxRgbDelta, maxAlphaDelta, differentPixels, alphaDifferentPixels, rgbOverOnePixels } :
    { maxRgbDelta: null, maxAlphaDelta: null, differentPixels: null, alphaDifferentPixels: null, rgbOverOnePixels: null };
  const common = { protocol: mipsContextRestoreProtocol, dimensionsEqual, ...statistics };
  if (!aaStable) return { ...common, status: 'INCONCLUSIVE_NATURAL_AA_UNSTABLE', aaStable: false, restoreIdentical: null, restoreWithinTolerance: null, functionalPass: false };
  const restoreIdentical = equal(before1, after), restoreWithinTolerance = dimensionsEqual
    && maxRgbDelta <= mipsContextRestoreProtocol.contextRestoreMaxRgbDelta && maxAlphaDelta <= mipsContextRestoreProtocol.contextRestoreMaxAlphaDelta;
  return { ...common, status: restoreWithinTolerance ? restoreIdentical ? 'PASS_RESTORE_RGBA_IDENTICAL' : 'PASS_RESTORE_RGBA_WITHIN_RGB1_ALPHA0' : 'FAIL_RESTORE_RGBA_MISMATCH',
    aaStable: true, restoreIdentical, restoreWithinTolerance, functionalPass: restoreWithinTolerance };
}

/** 独立native对照首次加载即无GI；只改内存副本，不保存原场景或改其它设置。 */
export function makeNativeRestoreControlDocument(document) {
  const copy = structuredClone(document), lighting = copy?.scene?.sceneSettings?.lighting;
  if (!lighting?.bake || !lighting.result) throw new Error('native对照必须来自明确已保存的GI场景。');
  lighting.bake.enabled = false; lighting.result = null;
  return copy;
}

/** 诊断保留完整差异，绝不把native结果回写成B9放宽门。 */
export function summarizeNativeRestoreRgba({ before0, before1, after }) {
  const exact = compareMipsRestoreRgba({ before0, before1, after });
  if (before1.width !== after.width || before1.height !== after.height) throw new Error('native对照恢复后buffer尺寸改变。');
  let differentPixels = 0, differentComponents = 0, maxRgb = 0, alphaPixels = 0;
  const bounds = { minX: before1.width, minY: before1.height, maxX: -1, maxY: -1 };
  for (let offset = 0; offset < before1.rgba.length; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) { const delta = Math.abs(before1.rgba[offset + channel] - after.rgba[offset + channel]);
      if (delta) { changed = true; differentComponents++; if (channel === 3) alphaPixels++; else maxRgb = Math.max(maxRgb, delta); } }
    if (changed) { differentPixels++; const pixel = offset / 4, x = pixel % before1.width, y = Math.floor(pixel / before1.width);
      bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x); bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y); }
  }
  return { status: 'DIAGNOSTIC_NATIVE_CONTROL_NOT_B9_PASS', functionalPass: false, aaStable: exact.aaStable,
    observation: !exact.aaStable ? 'INCONCLUSIVE_NATURAL_AA_UNSTABLE' : exact.restoreIdentical ? 'NATIVE_RESTORE_EXACT_ZERO' : 'NATIVE_RESTORE_RGBA_DIFFERENCE',
    differentPixels, differentComponents, maxRgb, alphaPixels, bounds: differentPixels ? bounds : null };
}

/** 标准glTF PBR四顶点平面，经产品真实GLB loader加载；不伪装运行时材质或原业务资产。 */
function pbrPlaneGlb() {
  const arrays = [new Float32Array([-1.5, 0, -1.5, 1.5, 0, -1.5, 1.5, 0, 1.5, -1.5, 0, 1.5]),
    new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), new Uint16Array([0, 2, 1, 0, 3, 2])];
  let offset = 0;
  const views = arrays.map(array => { const view = { buffer: 0, byteOffset: offset, byteLength: array.byteLength }; offset += array.byteLength; return view; });
  const binary = Buffer.concat(arrays.map(array => Buffer.from(array.buffer)));
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0', generator: 'Phase2 owned single-chart PBR fixture' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ name: 'ActualPbrPlane', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: 'ActualGltfPbr', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [.35, .65, .9, 1], metallicFactor: .15, roughnessFactor: .7 } }],
    buffers: [{ byteLength: binary.length }], bufferViews: views, accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1.5, 0, -1.5], max: [1.5, 0, 1.5] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' }, { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' }] }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]), header = Buffer.alloc(20), binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + padded.length + binary.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16); binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binHeader, binary]);
}

export async function prepareMipsBusinessFixture({ sourceScene, entityId, output }) {
  const preparation = await prepareBusinessGiSubset({ sourceScene, entityIds: [entityId], output, environment: 'omit', previewBudget: true });
  const document = JSON.parse(await fs.readFile(preparation.scenePath, 'utf8')), scene = document.scene;
  const cabinet = scene.entities[entityId];
  const anchor = cabinet.components.transform.position;
  for (const entity of Object.values(scene.entities)) if (entity.components.modelAsset) entity.components.lighting = {
    mobility: 'static', bakeIndirect: false, castShadows: true, receiveShadows: true, nodeOverrides: {},
  };
  // 新平面和原柜同父级，用原局部坐标锚定；不猜祖先世界矩阵，也不改原柜Transform。
  const base = (id, name, position) => ({ id, name, visible: true, locked: false, parentId: cabinet.parentId, childrenIds: [], components: {
    transform: { position, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    lighting: { mobility: 'static', bakeIndirect: true, castShadows: true, receiveShadows: true, nodeOverrides: {} },
  } });
  const ground = base('phase2-mips-standard-ground', 'B9真实Standard地面', { x: anchor.x, y: anchor.y - .05, z: anchor.z });
  ground.components.meshRenderer = { meshKind: 'plane', materialColor: '#b7aa82' };
  ground.components.transform.scale = { x: 6, y: 1, z: 6 };
  const glb = pbrPlaneGlb(), glbPath = path.join(output, 'Assets', 'Models', 'Phase2MipPbrPlane.glb'); await fs.writeFile(glbPath, glb, { flag: 'wx' });
  const pbr = base('phase2-mips-pbr-plane', 'B9真实GLB PBR平面', { x: anchor.x + 5, y: anchor.y, z: anchor.z });
  pbr.components.modelAsset = { assetCode: 'PHASE2-MIP-PBR', sourcePath: glbPath, sourceUrl: 'editor-asset://local/' + encodeURIComponent(glbPath),
    assetRevision: mipsSha(glb), lengthUnit: 'meter', unitScaleToMeters: 1 };
  for (const entity of [ground, pbr]) { scene.entities[entity.id] = entity; scene.entityIds.push(entity.id);
    if (entity.parentId) scene.entities[entity.parentId].childrenIds.push(entity.id); }
  scene.name = 'B9独立业务遮挡柜与真实Standard/PBR单chart平面';
  scene.sceneSettings.modelEntrance = { ...scene.sceneSettings.modelEntrance, enabled: false };
  scene.sceneSettings.lighting.bake = { ...scene.sceneSettings.lighting.bake, device: 'cpu', atlasSize: 1024, quality: 'preview', texelsPerMeter: 4, probeSpacing: 4, maxTextureMiB: 128 };
  await fs.writeFile(preparation.scenePath, JSON.stringify(document, null, 2) + '\n');
  return { ...preparation, fixture: { cabinetEntityId: entityId, standardEntityId: ground.id, pbrEntityId: pbr.id, pbrGlbPath: glbPath, pbrGlbSha256: mipsSha(glb),
    scope: 'Owned scene changes only: original cabinet geometry/parameters/transform preserved, nonreceiver shadow occluder; two explicit new single-chart receivers; small functional fixture' } };
}

async function uiState(page) {
  return page.evaluate(async () => { const scene = window.phase2Mips.store.getState().scene;
    const { getSceneLightingBakeSignature } = await import('/electron/shared/sceneLightingBakeContract.ts');
    return { version: scene.sceneSettings.lighting.version, bake: scene.sceneSettings.lighting.bake, signature: getSceneLightingBakeSignature(scene) }; });
}

export async function exerciseMipsUi({ page, levels, encoding, scenePath, reopen = true }) {
  const report = { before: await uiState(page) }; assert.equal(report.before.bake.lightmapMipLevels, undefined);
  await page.getByRole('button', { name: '光照与烘焙管理器', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '光照与烘焙管理器', exact: true });
  await manager.getByLabel('光照贴图Mip层级', { exact: true }).selectOption(String(levels));
  const gamma = manager.locator('label.lighting-manager-toggle').filter({ has: page.getByText('暗部精度（Gamma RGBM）', { exact: true }) }).locator('input[type="checkbox"]');
  await gamma.setChecked(encoding === 'rgbm-gamma');
  await page.getByRole('button', { name: '应用配置', exact: true }).click();
  await page.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
  report.enabled = await uiState(page); assert.equal(report.enabled.version, 3); assert.equal(report.enabled.bake.lightmapMipLevels, levels);
  assert.equal(report.enabled.signature, report.before.signature, '配方设置不改变物理输入signature');
  await page.getByRole('button', { name: '撤销 (Ctrl+Z)', exact: true }).click(); report.undo = await uiState(page);
  assert.deepEqual(report.undo, report.before);
  await page.getByRole('button', { name: '重做', exact: true }).click(); report.redo = await uiState(page); assert.deepEqual(report.redo, report.enabled);
  if (reopen) {
    await page.getByRole('button', { name: '保存场景', exact: true }).click();
    for (let attempt = 0; attempt < 100; attempt++) { const file = JSON.parse(await fs.readFile(scenePath, 'utf8')); if (file.scene.sceneSettings.lighting.bake.lightmapMipLevels === levels) break; await pause(100); }
    const saved = JSON.parse(await fs.readFile(scenePath, 'utf8')); assert.equal(saved.scene.sceneSettings.lighting.bake.lightmapMipLevels, levels);
    await page.evaluate(() => { window.phase2Mips.settingsRuntimeBeforeReopen = window.phase2Mips.runtime; });
    await page.getByRole('button', { name: '返回首页', exact: true }).click();
    await page.locator('.home-recent-card').filter({ hasText: path.basename(scenePath) }).getByRole('button', { name: '打开', exact: true }).click();
    await page.waitForFunction(level => { const runtime = window.phase2Mips.runtime; return runtime && runtime !== window.phase2Mips.settingsRuntimeBeforeReopen && !runtime.scene.isDisposed && runtime.scene.isReady()
      && !runtime.getInitialLoadSnapshot().progress.loading && window.phase2Mips.store.getState().scene.sceneSettings.lighting.bake.lightmapMipLevels === level;
    }, levels, { timeout: 180000 });
    await page.evaluate(() => { delete window.phase2Mips.settingsRuntimeBeforeReopen; });
    report.reopened = await uiState(page); assert.deepEqual(report.reopened, report.enabled);
  }
  return report;
}

/** 成功产物必须经真实保存/首页重开再验；设置预保存不能代替result重开。 */
export async function waitForMipsLighting(page) {
  return page.evaluate(async () => { let timer;
    try { await Promise.race([window.phase2Mips.runtime.waitForLightingReady(), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('B9 runtime lightingReady exceeded 30s')), 30000);
    })]); }
    finally { clearTimeout(timer); }
  });
}

export async function saveReopenMipsResult({ page, scenePath, expectedSnapshot, levels, encoding, checkpoint = async () => {} }) {
  await checkpoint('result-save-requested');
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  await page.waitForFunction(signature => window.phase2Mips.store.getState().persistedSceneContent?.includes(signature), expectedSnapshot.signature);
  const bytes = await fs.readFile(scenePath), saved = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(saved.scene.sceneSettings.lighting.result, expectedSnapshot);
  await checkpoint('result-saved-before-home');
  await page.evaluate(() => { window.phase2Mips.resultRuntimeBeforeReopen = window.phase2Mips.runtime; });
  await page.getByRole('button', { name: '返回首页', exact: true }).click();
  await page.locator('.home-recent-card').filter({ hasText: path.basename(scenePath) }).getByRole('button', { name: '打开', exact: true }).click();
  await checkpoint('result-recent-opened-waiting-new-runtime');
  await page.waitForFunction(signature => { const runtime = window.phase2Mips.runtime;
    return runtime && runtime !== window.phase2Mips.resultRuntimeBeforeReopen && !runtime.scene.isDisposed && !runtime.getInitialLoadSnapshot().progress.loading && runtime.scene.isReady()
      && window.phase2Mips.store.getState().scene.sceneSettings.lighting.result?.signature === signature;
  }, expectedSnapshot.signature, { timeout: 180000 });
  await checkpoint('result-new-runtime-ready-waiting-lighting');
  await waitForMipsLighting(page);
  const reopened = await page.evaluate(() => { delete window.phase2Mips.resultRuntimeBeforeReopen;
    const lighting = window.phase2Mips.store.getState().scene.sceneSettings.lighting;
    return { version: lighting.version, bake: lighting.bake, result: lighting.result, runtimeError: window.phase2Mips.runtime.getLightingBakeRuntimeError() }; });
  assert.equal(reopened.version, 3); assert.equal(reopened.bake.lightmapMipLevels, levels); assert.equal(reopened.bake.lightmapEncoding ?? 'rgbm', encoding);
  assert.equal(reopened.runtimeError, null); assert.deepEqual(reopened.result, expectedSnapshot);
  assert.equal(mipsSha(await fs.readFile(scenePath)), mipsSha(bytes), '重开不得重写已保存产物');
  return { sceneSha256: mipsSha(bytes), version: reopened.version, levels: reopened.bake.lightmapMipLevels, encoding: reopened.bake.lightmapEncoding ?? 'rgbm',
    resultExactlyPreserved: true, surfaces: reopened.result.surfaces.length, assetShaVerifiedAfterReopen: await inspectMipsAssets(reopened.result), runtimeError: reopened.runtimeError };
}

export async function inspectMipsAssets(snapshot) {
  const lightmaps = snapshot.assets.filter(asset => asset.kind === 'lightmap'); assert.ok(lightmaps.length);
  return Promise.all(lightmaps.map(async asset => { const bytes = await fs.readFile(decodeURIComponent(new URL(asset.url).pathname.slice(1)));
    assert.equal(mipsSha(bytes), asset.sha256); assert.equal(bytes.length, asset.byteLength);
    const decoded = validateLightingLightmapMipAsset(asset, bytes, snapshot.statistics.textureBytes);
    return { asset, levels: decoded.levels.map((level, lod) => ({ lod, width: level.width, height: level.height, sha256: mipsSha(level.rgba) })) };
  }));
}

export async function verifyMipArchiveStore(file, entryScenePath, dist = false) {
  const archive = await unzipper.Open.file(file), entry = archive.files.find(entry => entry.path === entryScenePath); assert.ok(entry);
  const scene = JSON.parse((await entry.buffer()).toString('utf8')).scene;
  const manifest = dist ? JSON.parse((await archive.files.find(entry => entry.path === 'project/asset-manifest.json').buffer()).toString('utf8')) : null;
  return scene.sceneSettings.lighting.result.assets.filter(asset => asset.kind === 'lightmap').map(asset => {
    const physical = dist ? path.posix.join('project/assets', manifest.assets.find(row => row.logicalUrl === asset.url).path.replaceAll('\\', '/'))
      : /^[a-z][a-z0-9+.-]*:/i.test(asset.url) ? decodeURIComponent(new URL(asset.url).pathname.slice(1)) : decodeURIComponent(asset.url);
    const resource = archive.files.find(entry => entry.path === physical); assert.ok(resource); assert.equal(resource.compressionMethod, 0, '已验证mip容器实际ZIP条目必须STORE');
    assert.equal(resource.uncompressedSize, asset.byteLength); return { id: asset.id, path: physical, compressionMethod: resource.compressionMethod, bytes: resource.uncompressedSize };
  });
}

/** 在真实产品scene只读核shader/sampler/每级GPU字节；恢复试验使用原生context-loss流程。 */
export async function installMipsProbe({ moduleUrl, expectedLevels }) {
  let store;
  if (moduleUrl) { const module = await import(moduleUrl); store = Object.values(module).find(value => Array.isArray(value?.Instances)); }
  const runtime = () => {
    if (window.phase2Mips?.runtime) return window.phase2Mips.runtime;
    const root = document.getElementById('root'), first = root?.[Object.keys(root ?? {}).find(key => key.startsWith('__reactContainer$'))];
    const queue = first ? [first.stateNode?.current ?? first] : [], seen = new Set();
    while (queue.length && seen.size < 30000) { const fiber = queue.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
      for (let hook = fiber.memoizedState, count = 0; hook && count++ < 500; hook = hook.next) { const value = hook.memoizedState?.current ?? hook.memoizedState;
        if (value?.scene?.meshes && typeof value.getLightingBakeRuntimeError === 'function') return value; }
      queue.push(fiber.child, fiber.sibling);
    }
    return null;
  };
  const scene = () => runtime()?.scene ?? store?.Instances.flatMap(engine => engine.scenes).find(scene => !scene.isDisposed && scene.meshes.some(mesh => mesh.metadata?.lightingDerived));
  const maps = () => scene()?.meshes.filter(mesh => mesh.metadata?.lightingDerived && mesh.isVerticesDataPresent('lightingBakeUV')) ?? [];
  const bindingFor = mesh => { const plugin = mesh.material?.pluginManager?.getPlugin('BakedIndirectLighting'), binding = plugin?.binding?.(mesh), texture = binding?.texture;
    return { plugin, binding, texture, owned: Boolean(texture && plugin?.getOwnedTextures?.().has(texture)) }; };
  const textures = () => [...new Set(maps().map(mesh => bindingFor(mesh)).filter(value => value.owned && value.texture.getInternalTexture()?.mipLevelCount === expectedLevels + 1).map(value => value.texture))];
  const digest = async bytes => { let timer;
    try { const result = await Promise.race([crypto.subtle.digest('SHA-256', bytes), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('B9 GPU readback digest exceeded 5s')), 5000);
    })]); return [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join(''); }
    finally { clearTimeout(timer); }
  };
  window.__phase2MipsProbe?.dispose?.();
  const subscriptions = new Map(); let samplerReceipts = new WeakMap(), expectedLoss = null, lossSequence = 0;
  const expectedLossEvents = [];
  const inExpectedLoss = () => Boolean(expectedLoss?.active && scene()?.getEngine()._gl.isContextLost());
  const auditErrors = [];
  const glError = (stage, details = {}) => { const current = scene(), gl = current.getEngine()._gl, code = gl.getError();
    if (code === gl.NO_ERROR) return null;
    const error = { stage, code, contextLost: gl.isContextLost(), frameId: current.getFrameId(), ...details,
      framebufferStatus: gl.checkFramebufferStatus(gl.FRAMEBUFFER), framebufferBound: Boolean(gl.getParameter(gl.FRAMEBUFFER_BINDING)) };
    if (auditErrors.length < 32) auditErrors.push(error); return error;
  };
  const checked = (stage, operation, details) => { const value = operation(), error = glError(stage, details); if (error) throw new Error('B9 audit GL error ' + JSON.stringify(error)); return value; };
  const observed = (stage, operation) => { if (auditErrors.length) return undefined; return checked(stage, operation); };
  const observeBindings = () => { for (const mesh of maps()) if (!subscriptions.has(mesh)) subscriptions.set(mesh, mesh.onAfterRenderObservable.add(() => {
    if (inExpectedLoss()) { expectedLoss.skippedSamplerObservations++; return; }
    if (auditErrors.length || glError('drawSampler.preexisting', { sourceKey: mesh.metadata.lightingSourceKey })) return;
    try {
    const current = scene(), engine = current.getEngine(), gl = engine._gl;
    const effect = mesh.subMeshes?.map(sub => sub.effect).find(effect => effect?.defines?.includes('BAKED_INDIRECT_MAP'));
    const program = effect?.getPipelineContext()?.program;
    // 仅接受该GI program真实绘制结束时的绑定；其它pass不伪装成主shader采样证据。
    if (!program || checked('drawSampler.currentProgram', () => gl.getParameter(gl.CURRENT_PROGRAM)) !== program) return;
    const { binding, texture, owned } = bindingFor(mesh), location = effect.getUniform('lightingBakeSampler');
    const unit = location ? checked('drawSampler.getUniform', () => gl.getUniform(program, location)) : null, active = checked('drawSampler.activeTexture', () => gl.getParameter(gl.ACTIVE_TEXTURE));
    let matches = false;
    try { if (Number.isInteger(unit)) { checked('drawSampler.activateUnit', () => gl.activeTexture(gl.TEXTURE0 + unit)); matches = Boolean(texture && checked('drawSampler.textureBinding', () => gl.getParameter(gl.TEXTURE_BINDING_2D)) === texture.getInternalTexture()?._hardwareTexture?.underlyingResource); } }
    finally { checked('drawSampler.restoreUnit', () => gl.activeTexture(active)); }
    samplerReceipts.set(mesh, { frameId: current.getFrameId(), sourceKey: mesh.metadata.lightingSourceKey, textureId: texture?.uniqueId ?? null, owned,
      bindingEnabled: binding?.enabled ?? false, encoding: binding?.encoding ?? null, levelCount: binding?.mipLevelCount ?? null, unit, actualSamplerMatches: matches });
    } catch (error) { if (!auditErrors.length) auditErrors.push({ stage: 'drawSampler.exception', message: String(error) }); }
  })); };
  window.__phase2MipsProbe = {
    getContext() { return scene().getEngine()._gl; },
    getFrameId() { return scene().getFrameId(); },
    isExpectedLossActive() { return inExpectedLoss(); },
    dispose() { for (const [mesh, observer] of subscriptions) mesh.onAfterRenderObservable.remove(observer); subscriptions.clear(); },
    waitFrames() { return new Promise((resolve, reject) => { let count = 0, frame;
      const timer = setTimeout(() => { window.cancelAnimationFrame(frame); reject(new Error('B9 six render frames exceeded 5s')); }, 5000);
      const next = () => { if (++count === 6) { clearTimeout(timer); resolve(); } else frame = requestAnimationFrame(next); }; frame = requestAnimationFrame(next);
    }); },
    frame() { const current = scene(), camera = current?.activeCamera, list = maps(); if (!camera?.setTarget || !list.length) return false;
      // 使用渲染已维护的world bounds；不force worldMatrix，不改几何或脚本频率。
      const boxes = list.map(mesh => mesh.getBoundingInfo().boundingBox), low = ['x', 'y', 'z'].map(axis => Math.min(...boxes.map(box => box.minimumWorld[axis]))),
        high = ['x', 'y', 'z'].map(axis => Math.max(...boxes.map(box => box.maximumWorld[axis])));
      const center = low.map((value, index) => (value + high[index]) / 2), radius = Math.max(2, Math.hypot(...low.map((value, index) => high[index] - value)) * 1.25);
      camera.setTarget(camera.position.clone().copyFromFloats(...center));
      if (typeof camera.radius === 'number') { camera.radius = radius; camera.alpha = -.85; camera.beta = 1.05; }
      camera.minZ = .01; camera.maxZ = Math.max(camera.maxZ, radius * 10); return true;
    },
    diagnostics() { return [...auditErrors]; },
    snapshot() { const current = scene(), owner = runtime(); if (!current) return null;
      if (inExpectedLoss()) return { ready: false, expectedLossActive: true, lastExpectedLoss: { ...expectedLoss }, expectedLossEvents: [...expectedLossEvents], auditErrors: [...auditErrors], maps: [] };
      if (!auditErrors.length) glError('snapshot.preexisting'); observeBindings(); const engine = current.getEngine(), gl = engine._gl;
      const active = current.getActiveMeshes(), rendered = new Set(active.data.slice(0, active.length));
      return { frameId: current.getFrameId(), ready: current.isReady(), runtimeFound: Boolean(owner), runtimeError: owner?.getLightingBakeRuntimeError() ?? null,
        hudErrors: [...document.querySelectorAll('.player-status p')].map(node => node.textContent).filter(value => /混合光照|重新烘焙/.test(value)),
        gpu: { version: engine.webGLVersion, info: engine.getGlInfo(), contextLost: gl.isContextLost(), highp: observed('snapshot.shaderPrecision', () => gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT))?.precision },
        maps: maps().map(mesh => { const effect = mesh.subMeshes?.map(sub => sub.effect).find(effect => effect?.defines?.includes('BAKED_INDIRECT_MAP'));
          const program = effect?.getPipelineContext()?.program, attached = program ? observed('snapshot.getAttachedShaders', () => gl.getAttachedShaders(program)) : null,
            source = (attached ?? []).map(shader => observed('snapshot.getShaderSource', () => gl.getShaderSource(shader))).join('\n');
          const binding = bindingFor(mesh);
          return { name: mesh.name, sourceKey: mesh.metadata.lightingSourceKey, materialClass: mesh.material?.getClassName(), rendered: rendered.has(mesh), ready: mesh.isReady(true), indices: mesh.getTotalIndices(),
            textureId: binding.texture?.uniqueId ?? null, ownedTexture: binding.owned, textureLevels: binding.texture?.getInternalTexture()?.mipLevelCount ?? null, samplerReceipt: samplerReceipts.get(mesh) ?? null,
            mipDefine: Boolean(effect?.defines?.match(/(?:^|\n)#define BAKED_INDIRECT_MIPS(?:\s|$)/)), gammaDefine: Boolean(effect?.defines?.match(/(?:^|\n)#define BAKED_INDIRECT_GAMMA(?:\s|$)/)),
            actualHighpVarying: /(?:varying|in|out)\s+highp\s+vec2\s+vLightingBakeUV/.test(source),
            active: program && effect.getUniform('lightingBakeActive') ? observed('snapshot.getUniformActive', () => gl.getUniform(program, effect.getUniform('lightingBakeActive'))) : null };
        }), textureCount: textures().length, auditErrors: [...auditErrors], lastExpectedLoss: expectedLoss ? { ...expectedLoss } : null, expectedLossEvents: [...expectedLossEvents] };
    },
    async readLevels() { const current = scene(), engine = current.getEngine(), gl = engine._gl, records = [];
      if (inExpectedLoss()) throw new Error('B9 FBO audit requested during explicit expected context-loss window');
      const preexisting = glError('readLevels.preexisting'); if (preexisting || auditErrors.length) throw new Error('B9 preexisting GL error ' + JSON.stringify(preexisting ?? auditErrors));
      const oldFramebuffer = checked('readLevels.getFramebuffer', () => gl.getParameter(gl.FRAMEBUFFER_BINDING)), fbo = checked('readLevels.createFramebuffer', () => gl.createFramebuffer());
      let originalError, cleanupError;
      try { checked('readLevels.bindFramebuffer', () => gl.bindFramebuffer(gl.FRAMEBUFFER, fbo));
        for (const texture of textures()) { const internal = texture.getInternalTexture(), hardware = internal._hardwareTexture.underlyingResource;
          checked('readLevels.bindTexture', () => engine._bindTextureDirectly(gl.TEXTURE_2D, internal, true, true), { textureId: texture.uniqueId });
          const extension = engine.getCaps().textureAnisotropicFilterExtension;
          const parameter = (name, value) => checked('readLevels.getTexParameter.' + name, () => gl.getTexParameter(gl.TEXTURE_2D, value), { textureId: texture.uniqueId, parameter: value });
          const record = { textureId: texture.uniqueId, sources: maps().filter(mesh => bindingFor(mesh).texture === texture).map(mesh => mesh.metadata.lightingSourceKey).sort(),
            width: internal.width, height: internal.height, levelCount: internal.mipLevelCount,
            sampler: { base: parameter('base', gl.TEXTURE_BASE_LEVEL), max: parameter('max', gl.TEXTURE_MAX_LEVEL),
              maxLod: parameter('maxLod', gl.TEXTURE_MAX_LOD), min: parameter('min', gl.TEXTURE_MIN_FILTER), mag: parameter('mag', gl.TEXTURE_MAG_FILTER),
              wrapS: parameter('wrapS', gl.TEXTURE_WRAP_S), wrapT: parameter('wrapT', gl.TEXTURE_WRAP_T),
              aniso: extension ? parameter('aniso', extension.TEXTURE_MAX_ANISOTROPY_EXT) : null }, levels: [] };
          const arrays = [];
          for (let lod = 0; lod <= expectedLevels; lod++) { const width = Math.max(1, internal.width >> lod), height = Math.max(1, internal.height >> lod), rgba = new Uint8Array(width * height * 4);
            const details = { textureId: texture.uniqueId, lod, width, height, isTexture: checked('readLevels.isTexture', () => gl.isTexture(hardware)) };
            checked('readLevels.attach', () => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, hardware, lod), details);
            const status = checked('readLevels.framebufferStatus', () => gl.checkFramebufferStatus(gl.FRAMEBUFFER), details);
            if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('B9 FBO incomplete ' + JSON.stringify({ ...details, status }));
            checked('readLevels.readPixels', () => gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba), details); arrays.push({ lod, width, height, rgba }); }
          records.push({ record, arrays });
        }
      } catch (error) { originalError = error; }
      finally { try { checked('readLevels.restoreFramebuffer', () => gl.bindFramebuffer(gl.FRAMEBUFFER, oldFramebuffer)); checked('readLevels.deleteFramebuffer', () => gl.deleteFramebuffer(fbo));
        checked('readLevels.unbindTexture', () => engine._bindTextureDirectly(gl.TEXTURE_2D, null, true, true)); checked('readLevels.wipeCaches', () => engine.wipeCaches(true));
      } catch (error) { cleanupError = error; } }
      if (originalError && cleanupError) throw new AggregateError([originalError, cleanupError], 'B9 FBO readback and cleanup failed');
      if (originalError) throw originalError; if (cleanupError) throw cleanupError;
      // digest的await在GL状态完全恢复后执行，不能跨render frame保留临时FBO。
      for (const { record, arrays } of records) record.levels = await Promise.all(arrays.map(async ({ rgba, ...meta }) => ({ ...meta, sha256: await digest(rgba) })));
      return records.map(value => value.record);
    },
    async pixels() { if (inExpectedLoss()) throw new Error('B9 pixel audit requested during explicit expected context-loss window');
      const current = scene(), preexisting = glError('pixels.preexisting'); if (preexisting || auditErrors.length) throw new Error('B9 pixels preexisting GL error ' + JSON.stringify(preexisting ?? auditErrors));
      return new Promise((resolve, reject) => { const state = { observer: null, finished: false };
      const done = (error, value) => { if (state.finished) return; state.finished = true; clearTimeout(timer); current.onAfterRenderObservable.remove(state.observer); if (error) reject(error); else resolve(value); };
      const timer = setTimeout(() => done(new Error('B9 after-render pixels/digest exceeded 5s')), 5000);
      try { state.observer = current.onAfterRenderObservable.addOnce(async () => { try { const engine = current.getEngine(), gl = engine._gl;
        const width = engine.getRenderWidth(), height = engine.getRenderHeight(), bytes = new Uint8Array(width * height * 4);
        checked('pixels.readPixels', () => gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes), { width, height });
        const colors = new Set(); for (let index = 0; index < bytes.length; index += 4) colors.add(bytes[index] * 65536 + bytes[index + 1] * 256 + bytes[index + 2]);
        const frameId = current.getFrameId(); let encoded = ''; for (let offset = 0; offset < bytes.length; offset += 8192) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        done(null, { width, height, frameId, colors: colors.size, sha256: await digest(bytes), base64: window.btoa(encoded) }); } catch (error) { done(error); } }); } catch (error) { done(error); } }); },
    async restore() { const engine = scene().getEngine(), extension = engine._gl.getExtension('WEBGL_lose_context'); if (!extension) throw new Error('actual context loss extension unavailable');
      if (expectedLoss?.active) throw new Error('B9 overlapping expected context-loss window');
      const token = { id: ++lossSequence, active: true, phase: 'requested', requestedFrame: scene().getFrameId(), lostFrame: null, restoredFrame: null, skippedSamplerObservations: 0 };
      expectedLoss = token; samplerReceipts = new WeakMap();
      return new Promise((resolve, reject) => { const observers = { lost: null, restored: null }; let restoreTimer, finished = false, stage = 'waiting-loss';
        const done = error => { if (finished) return; finished = true; clearTimeout(timer); clearTimeout(restoreTimer); engine.onContextLostObservable.remove(observers.lost); engine.onContextRestoredObservable.remove(observers.restored);
          token.active = false; if (error) token.phase = 'failed';
          if (error) reject(error); else resolve(true); };
        const timer = setTimeout(() => done(new Error('B9 actual context loss/restore exceeded 20s: ' + stage)), 20000);
        try { observers.lost = engine.onContextLostObservable.addOnce(() => { stage = 'waiting-restore'; token.phase = 'lost'; token.lostFrame = scene().getFrameId();
          const gl = engine._gl, code = gl.getError(), contextLost = gl.isContextLost();
          expectedLossEvents.push({ tokenId: token.id, stage: 'actual-context-lost', code, contextLost, frameId: token.lostFrame });
          if (!contextLost || code !== gl.NO_ERROR && code !== gl.CONTEXT_LOST_WEBGL) { auditErrors.push({ stage: 'expectedLoss.unexpectedGLError', code, contextLost }); done(new Error('B9 unexpected error during explicit loss ' + code)); return; }
          restoreTimer = setTimeout(() => { try { extension.restoreContext(); } catch (error) { done(error); } }, 25); });
          observers.restored = engine.onContextRestoredObservable.addOnce(() => { token.phase = 'restored'; token.restoredFrame = scene().getFrameId(); token.active = false;
            samplerReceipts = new WeakMap(); expectedLossEvents.push({ tokenId: token.id, stage: 'actual-context-restored', frameId: token.restoredFrame }); done(); }); extension.loseContext(); } catch (error) { done(error); }
      });
    },
  };
}

export async function verifyMipsProbe(target, expected, { restore = true, expectedEncoding, geometry, checkpoint = async () => {}, diagnosticRestore = false, artifacts } = {}) {
  assert.ok(['rgbm', 'rgbm-gamma'].includes(expectedEncoding), '实际shader验收必须给明确base encoding');
  assert.ok(geometry && Number.isSafeInteger(geometry.triangles) && geometry.triangles > 0 && geometry.keys.length > 0);
  const counts = values => Object.fromEntries([...new Set(values)].sort().map(key => [key, values.filter(value => value === key).length]));
  assert.ok(artifacts?.output && /^[a-z0-9-]+$/i.test(artifacts.prefix), '完整RGBA必须保存至明确owned output/prefix');
  const realOutput = await fs.realpath(artifacts.output), realRoot = await fs.realpath(path.resolve('output')), relative = path.relative(realRoot, realOutput);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const capturePixels = async (label, screenshot = false) => { const captured = await target.evaluate(() => window.__phase2MipsProbe.pixels()), { base64, ...metadata } = captured;
    const rgba = Buffer.from(base64, 'base64'); assert.equal(rgba.length, metadata.width * metadata.height * 4); assert.equal(mipsSha(rgba), metadata.sha256); assert.ok(metadata.colors > 16, '真实三维buffer必须非空白');
    const file = path.join(realOutput, artifacts.prefix + '-' + label + '.rgba'); await fs.writeFile(file, rgba, { flag: 'wx' });
    const saved = await fs.readFile(file); assert.equal(saved.length, rgba.length); assert.equal(mipsSha(saved), metadata.sha256);
    const evidence = { ...metadata, bytes: saved.length, file };
    if (screenshot) { evidence.screenshot = path.join(realOutput, artifacts.prefix + '-' + label + '.png'); const page = typeof target.screenshot === 'function' ? target : target.page(); await page.screenshot({ path: evidence.screenshot }); }
    return { evidence, width: metadata.width, height: metadata.height, rgba: saved };
  };
  await checkpoint('probe-waiting-ready');
  await target.waitForFunction(() => { const value = window.__phase2MipsProbe?.snapshot(); if (value?.auditErrors.length) throw new Error('B9 GL diagnostics ' + JSON.stringify(value.auditErrors));
    return value?.ready && value.maps.length > 0 && value.maps.every(row => row.ready); }, null, { timeout: 180000 });
  assert.equal(await target.evaluate(() => window.__phase2MipsProbe.frame()), true);
  await target.evaluate(() => window.__phase2MipsProbe.waitFrames());
  const assertState = state => { assert.deepEqual(state.auditErrors, []); assert.equal(state.runtimeFound, true); assert.equal(state.ready, true); assert.equal(state.runtimeError, null); assert.deepEqual(state.hudErrors, []);
    assert.equal(state.gpu.version, 2); assert.ok(state.gpu.highp >= 23); assert.equal(state.gpu.contextLost, false); assert.doesNotMatch(JSON.stringify(state.gpu.info), /swiftshader|llvmpipe|warp|software|basic render driver/i);
    assert.ok(state.maps.some(row => row.rendered && row.materialClass === 'StandardMaterial'), 'Standard接收面必须实际绘制');
    assert.ok(state.maps.some(row => row.rendered && row.materialClass === 'PBRMaterial'), '真实GLB PBR接收面必须实际绘制');
    assert.equal(state.maps.length, geometry.keys.length); assert.equal(state.maps.reduce((sum, row) => sum + row.indices / 3, 0), geometry.triangles);
    assert.deepEqual(counts(state.maps.map(row => row.sourceKey)), counts(geometry.keys), '实际GI代理来源/每来源表面数不得丢失或重复');
    assert.ok(state.maps.every(row => row.mipDefine && row.actualHighpVarying && row.active === 1 && row.gammaDefine === (expectedEncoding === 'rgbm-gamma')));
    assert.ok(state.maps.every(row => row.ownedTexture && row.textureId !== null && row.textureLevels === expected[0].asset.levelCount));
    for (const row of state.maps) { const receipt = row.samplerReceipt;
      assert.ok(receipt && receipt.owned && receipt.bindingEnabled && receipt.actualSamplerMatches, '实际绘制的GI sampler必须绑定该proxy受控texture');
      assert.equal(receipt.sourceKey, row.sourceKey); assert.equal(receipt.textureId, row.textureId); assert.equal(receipt.levelCount, row.textureLevels);
      assert.ok(expected.some(value => value.asset.encoding === receipt.encoding)); assert.ok(receipt.frameId >= state.frameId - 2 && receipt.frameId <= state.frameId, 'sampler收据必须来自当前渲染帧附近');
      if (state.lastExpectedLoss?.restoredFrame !== null && state.lastExpectedLoss?.restoredFrame !== undefined) assert.ok(receipt.frameId > state.lastExpectedLoss.restoredFrame, '必须使用本次真实restore边界之后的新frame sampler收据');
    } };
  const state = await target.evaluate(() => window.__phase2MipsProbe.snapshot()); await checkpoint('probe-state-observed', { state }); assertState(state);
  await checkpoint('probe-binding-shader-passed-reading-levels', { state });
  const levels = await target.evaluate(() => window.__phase2MipsProbe.readLevels()); assert.ok(levels.length);
  for (const texture of levels) { assert.ok(expected.some(row => JSON.stringify(row.levels) === JSON.stringify(texture.levels)), '每级实际GPU RGBA必须等于已验SHA的真实producer容器');
    assert.deepEqual(texture.sampler, { base: 0, max: texture.levelCount - 1, maxLod: texture.levelCount - 1, min: 9987, mag: 9729, wrapS: 33071, wrapT: 33071, aniso: texture.sampler.aniso === null ? null : 1 }); }
  await checkpoint('probe-levels-passed-reading-pixels', { state, levels });
  const before0 = await capturePixels('before-AA0'); await target.evaluate(() => window.__phase2MipsProbe.waitFrames()); const before1 = await capturePixels('before-AA1', true);
  const pixels = before1.evidence;
  const report = { state, levels, pixels, beforeAA: { first: before0.evidence, second: before1.evidence, stable: before0.width === before1.width && before0.height === before1.height && before0.rgba.equals(before1.rgba) } };
  if (diagnosticRestore) {
    await checkpoint('DIAGNOSTIC_NOT_FUNCTIONAL_PASS-starting-restore-trace', report);
    const installation = await target.evaluate(installPhase2GlRestoreTrace, { exposeGlobal: true }); let diagnosticException;
    try { await target.evaluate(() => window.__phase2MipsProbe.restore());
      await target.waitForFunction(() => window.__phase2MipsProbe.snapshot()?.ready, null, { timeout: 30000 });
      await target.evaluate(() => window.__phase2MipsProbe.waitFrames());
    } catch (error) { diagnosticException = String(error.stack ?? error); }
    finally { const trace = await target.evaluate(() => globalThis.__phase2GlRestoreTrace.stop());
      report.diagnostic = { status: 'DIAGNOSTIC_NOT_FUNCTIONAL_PASS', installation, trace, diagnosticException, functionalPass: false };
      await checkpoint('DIAGNOSTIC_NOT_FUNCTIONAL_PASS-trace-complete', report);
    }
    return report;
  }
  if (restore) { await checkpoint('probe-pixels-passed-restoring-context', { state, levels, pixels }); await target.evaluate(() => window.__phase2MipsProbe.restore()); await target.waitForFunction(() => window.__phase2MipsProbe.snapshot()?.ready, null, { timeout: 30000 });
    await target.evaluate(() => window.__phase2MipsProbe.waitFrames());
    const restoredState = await target.evaluate(() => window.__phase2MipsProbe.snapshot()); await checkpoint('probe-restored-state-observed', { before: report, state: restoredState }); assertState(restoredState);
    const restoredLevels = await target.evaluate(() => window.__phase2MipsProbe.readLevels()); report.restored = { state: restoredState, levels: restoredLevels };
    await checkpoint('probe-restored-levels-observed', report);
    assert.deepEqual(report.restored.levels, levels, '真实context恢复完整chain及sampler不能变'); }
  report.stable = [];
  await checkpoint('probe-restore-passed-stability-window');
  for (let count = 0; count < 10; count++) { const current = await target.evaluate(() => window.__phase2MipsProbe.snapshot()); assertState(current); report.stable.push({ ready: current.ready, runtimeError: current.runtimeError, hudErrors: current.hudErrors }); await pause(200); }
  const after = await capturePixels('after-restore', true); report.afterRestorePixels = after.evidence;
  report.pixelComparison = compareMipsRestoreRgba({ before0, before1, after }); report.functionalPass = report.pixelComparison.functionalPass;
  await checkpoint('probe-complete-restore-rgba-comparison', report);
  if (report.pixelComparison.status === 'FAIL_RESTORE_RGBA_MISMATCH') throw new Error('B9自然AA稳定但context恢复后完整RGBA不同。');
  report.status = report.functionalPass ? 'PASS' : 'INCONCLUSIVE_NATURAL_AA_UNSTABLE';
  return report;
}

/** 只读真实native绘制收据；GL资源只查询，不替换program/材质或接管render。 */
export function installNativeRestoreControl({ fixture }) {
  const runtime = window.phase2Mips.runtime, current = runtime.scene, engine = current.getEngine(), gl = engine._gl;
  const standard = runtime.presentation.meshes.get(fixture.standardEntityId), model = runtime.assets.models.get(fixture.pbrEntityId);
  const pbr = model?.meshes.filter(mesh => mesh.getTotalIndices() > 0) ?? [];
  if (!standard || pbr.length !== 1) throw new Error('native对照必须精确定位一个Standard与一个真实model PBR面。');
  const targets = [standard, pbr[0]], receipts = new Map(), subscriptions = [], errors = [];
  // presentation存直接Mesh；模型池的AbstractMesh[]则可含原生InstancedMesh，其真实draw通知归sourceMesh。
  const drawOwners = new Map(targets.map(mesh => { const instance = mesh.getClassName() === 'InstancedMesh', owner = instance ? mesh.sourceMesh : mesh;
    if (mesh.metadata?.lightingDerived || mesh.getScene() !== current || !owner?.onAfterRenderObservable?.add
      || instance && (!owner.instances.includes(mesh) || owner.getScene() !== current)) throw new Error('native对照缺精确Mesh/InstancedMesh原生draw owner关系。');
    return [mesh, owner]; }));
  let disposed = false;
  const check = (stage, details = {}) => { const code = gl.getError(); if (code !== gl.NO_ERROR) { const row = { ...details, stage, code, frameId: current.getFrameId(), contextLost: gl.isContextLost() };
    if (errors.length < 32) errors.push(row); throw new Error('native对照GL错误 ' + JSON.stringify(row)); } };
  const plain = value => ArrayBuffer.isView(value) ? Array.from(value) : value;
  const samplerTargets = new Map([[gl.SAMPLER_2D, gl.TEXTURE_BINDING_2D], [gl.SAMPLER_2D_SHADOW, gl.TEXTURE_BINDING_2D], [gl.INT_SAMPLER_2D, gl.TEXTURE_BINDING_2D], [gl.UNSIGNED_INT_SAMPLER_2D, gl.TEXTURE_BINDING_2D],
    [gl.SAMPLER_CUBE, gl.TEXTURE_BINDING_CUBE_MAP], [gl.SAMPLER_CUBE_SHADOW, gl.TEXTURE_BINDING_CUBE_MAP], [gl.INT_SAMPLER_CUBE, gl.TEXTURE_BINDING_CUBE_MAP], [gl.UNSIGNED_INT_SAMPLER_CUBE, gl.TEXTURE_BINDING_CUBE_MAP],
    [gl.SAMPLER_3D, gl.TEXTURE_BINDING_3D], [gl.INT_SAMPLER_3D, gl.TEXTURE_BINDING_3D], [gl.UNSIGNED_INT_SAMPLER_3D, gl.TEXTURE_BINDING_3D], [gl.SAMPLER_2D_ARRAY, gl.TEXTURE_BINDING_2D_ARRAY],
    [gl.SAMPLER_2D_ARRAY_SHADOW, gl.TEXTURE_BINDING_2D_ARRAY], [gl.INT_SAMPLER_2D_ARRAY, gl.TEXTURE_BINDING_2D_ARRAY], [gl.UNSIGNED_INT_SAMPLER_2D_ARRAY, gl.TEXTURE_BINDING_2D_ARRAY]].filter(([type]) => typeof type === 'number'));
  const samplerBinding = (info, value) => {
    const binding = samplerTargets.get(info.type);
    if (!binding) return null;
    const units = typeof value === 'number' ? [value] : Array.from(value ?? []), active = gl.getParameter(gl.ACTIVE_TEXTURE), rows = [];
    if (units.length !== info.size) throw new Error('native sampler数组实际unit数量不符');
    try { for (const unit of units) { if (!Number.isInteger(unit)) throw new Error('native sampler unit无效'); gl.activeTexture(gl.TEXTURE0 + unit);
      const actual = gl.getParameter(binding), internal = engine._internalTexturesCache.find(texture => texture._hardwareTexture?.underlyingResource === actual);
      rows.push({ unit, bound: Boolean(actual), internalId: internal?.uniqueId ?? null, width: internal?.width ?? null, height: internal?.height ?? null }); } }
    finally { gl.activeTexture(active); }
    if (rows.some(row => !row.bound || row.internalId === null)) throw new Error('native实际sampler缺可核对的InternalTexture逻辑绑定');
    return rows;
  };
  for (const mesh of targets) { const owner = drawOwners.get(mesh); subscriptions.push([owner, owner.onAfterRenderObservable.add(() => {
    if (disposed || gl.isContextLost()) return;
    let operation = { stage: 'draw.preexisting', meshId: mesh.uniqueId, ownerId: owner.uniqueId, shaderStages: [] };
    const read = (stage, action) => { operation.stage = stage; const value = action(); check(stage, operation); return value; };
    try { check('draw.preexisting'); const program = gl.getParameter(gl.CURRENT_PROGRAM);
      const subMesh = owner.subMeshes.find(sub => sub.effect?.getPipelineContext()?.program === program), effect = subMesh?.effect; if (!effect || !program) return;
      const instance = owner !== mesh, storage = owner._instanceDataStorage, pass = storage?.useMonoDataStorageRenderPass ? storage.dataStorageRenderPass : storage?.renderPasses[engine.currentRenderPassId];
      const batch = pass?.previousBatch ?? pass?.batchCache;
      if (instance && !batch?.visibleInstances[subMesh._id]?.includes(mesh)) return;
      const shaders = gl.getAttachedShaders(program) ?? [], source = shaders.map(shader => ({ type: gl.getShaderParameter(shader, gl.SHADER_TYPE), source: gl.getShaderSource(shader) }));
      operation.shaderStages = source.map(row => row.type);
      if (source.some(row => typeof row.source !== 'string' || row.source.length > 1048576)) throw new Error('native实际shader source缺失或超1MiB诊断上限');
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); if (!Number.isSafeInteger(count) || count > 256) throw new Error('native shader uniform数量超诊断边界');
      const blockIndices = count ? read('draw.uniform-block-indices', () => Array.from(gl.getActiveUniforms(program, Array.from({ length: count }, (_value, index) => index), gl.UNIFORM_BLOCK_INDEX))) : [];
      if (blockIndices.length !== count) throw new Error('native active uniform block索引数量不符');
      const uniforms = [];
      for (let index = 0; index < count; index++) { operation = { ...operation, uniformIndex: index, uniformName: null, uniformType: null, blockIndex: blockIndices[index], locationType: null };
        const info = read('draw.active-uniform', () => gl.getActiveUniform(program, index)); if (!info) throw new Error('native active uniform info缺失');
        operation.uniformName = info.name; operation.uniformType = info.type;
        const location = read('draw.uniform-location', () => gl.getUniformLocation(program, info.name)); operation.locationType = location === null ? 'null' : Object.prototype.toString.call(location);
        const blockIndex = blockIndices[index], isBlock = Number.isInteger(blockIndex) && blockIndex >= 0 && blockIndex !== gl.INVALID_INDEX;
        if (isBlock) { const blockName = read('draw.uniform-block-name', () => gl.getActiveUniformBlockName(program, blockIndex)), binding = read('draw.uniform-block-binding', () => gl.getActiveUniformBlockParameter(program, blockIndex, gl.UNIFORM_BLOCK_BINDING));
          uniforms.push({ name: info.name, type: info.type, size: info.size, storage: 'uniform-block', blockIndex, blockName, binding, value: null, samplers: null }); continue; }
        if (location === null) { if (samplerTargets.has(info.type)) throw new Error('native active sampler location缺失，不能确认实际绑定');
          uniforms.push({ name: info.name, type: info.type, size: info.size, storage: 'inactive-null-location', blockIndex: null, value: null, samplers: null }); continue; }
        if (operation.locationType !== '[object WebGLUniformLocation]') throw new TypeError('native getUniformLocation返回非WebGLUniformLocation对象');
        const value = plain(read('draw.uniform-value', () => gl.getUniform(program, location)));
        if (Array.isArray(value) && value.length > 512) throw new Error('native uniform值超诊断边界');
        const samplers = read('draw.uniform-sampler-binding', () => samplerBinding(info, value));
        uniforms.push({ name: info.name, type: info.type, size: info.size, storage: 'standalone', blockIndex: null, value, samplers }); }
      check('draw.shader-uniform-sampler-read'); receipts.set(mesh, { frameId: current.getFrameId(), defines: effect.defines, source, uniforms,
        drawOwnerId: owner.uniqueId, drawOwnerClass: owner.getClassName(), instanceSourceId: instance ? owner.uniqueId : null, instanceBatchContainsTarget: instance ? true : null });
    } catch (error) { if (errors.length < 32) errors.push({ ...operation, error: String(error), errorName: error.name, errorCode: error.code ?? null, frameId: current.getFrameId() }); }
  })]); }
  const listMeshes = () => current.meshes.filter(mesh => mesh.getTotalIndices() > 0);
  const rawArray = value => { if (!ArrayBuffer.isView(value)) return { type: 'Array', values: Array.from(value) };
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength); let encoded = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { type: value.constructor.name, byteLength: bytes.length, base64: window.btoa(encoded) };
  };
  window.__phase2NativeRestoreControl = {
    frame() { const camera = current.activeCamera, boxes = targets.map(mesh => mesh.getBoundingInfo().boundingBox);
      if (!camera?.setTarget) throw new Error('native对照缺相同ArcRotate取景入口');
      const low = ['x', 'y', 'z'].map(axis => Math.min(...boxes.map(box => box.minimumWorld[axis]))), high = ['x', 'y', 'z'].map(axis => Math.max(...boxes.map(box => box.maximumWorld[axis])));
      const center = low.map((value, index) => (value + high[index]) / 2), radius = Math.max(2, Math.hypot(...low.map((value, index) => high[index] - value)) * 1.25);
      camera.setTarget(camera.position.clone().copyFromFloats(...center));
      if (typeof camera.radius === 'number') { camera.radius = radius; camera.alpha = -.85; camera.beta = 1.05; }
      camera.minZ = .01; camera.maxZ = Math.max(camera.maxZ, radius * 10);
      return { low, high, center, radius, alpha: -.85, beta: 1.05, source: 'Exact native runtime source plane references and already-maintained world bounds; same formula, historical resume5 actual camera values unavailable' };
    },
    state() { const value = window.phase2Mips.store.getState().scene.sceneSettings.lighting;
      return { frameId: current.getFrameId(), ready: current.isReady(), bakeEnabled: value.bake.enabled, hasResult: value.result !== null,
        contextLost: gl.isContextLost(), runtimeError: runtime.getLightingBakeRuntimeError(),
        hudErrors: [...document.querySelectorAll('.player-status p')].map(node => node.textContent).filter(value => /混合光照|重新烘焙/.test(value)),
        derivedCount: current.meshes.filter(mesh => mesh.metadata?.lightingDerived).length,
        pluginCount: current.materials.filter(material => material.pluginManager?.getPlugin('BakedIndirectLighting')).length, errors: [...errors],
        targets: targets.map(mesh => { const receipt = receipts.get(mesh); return { id: mesh.uniqueId, name: mesh.name, materialClass: mesh.material?.getClassName(),
          ready: mesh.isReady(true), indices: mesh.getTotalIndices(), plugin: Boolean(mesh.material?.pluginManager?.getPlugin('BakedIndirectLighting')),
          receipt: receipt ? { frameId: receipt.frameId, drawOwnerId: receipt.drawOwnerId, drawOwnerClass: receipt.drawOwnerClass, instanceSourceId: receipt.instanceSourceId,
            instanceBatchContainsTarget: receipt.instanceBatchContainsTarget, uniforms: receipt.uniforms,
            hasBakedDefine: /(?:^|\n)#define BAKED_INDIRECT_(?:MAP|MIPS|GAMMA)(?:\s|$)/.test(receipt.defines) } : null }; }) };
    },
    snapshot() { check('snapshot.preexisting'); const camera = current.activeCamera;
      if (!camera._computedViewMatrix || !camera._projectionMatrix) throw new Error('native相机缺实际已计算view/projection缓存');
      const invariant = { camera: { position: camera.position.asArray(), target: camera.getTarget().asArray(), alpha: camera.alpha, beta: camera.beta, radius: camera.radius,
        minZ: camera.minZ, maxZ: camera.maxZ, view: camera._computedViewMatrix?.asArray(), projection: camera._projectionMatrix?.asArray() },
      geometry: listMeshes().map(mesh => ({ id: mesh.uniqueId, geometryId: mesh.geometry?.uniqueId, instanceSourceId: mesh.getClassName() === 'InstancedMesh' ? mesh.sourceMesh.uniqueId : null, name: mesh.name, materialId: mesh.material?.uniqueId,
        world: mesh._worldMatrix.asArray(), local: mesh._localMatrix.asArray(), indices: rawArray(mesh.getIndices() ?? []),
        vertices: Object.fromEntries(mesh.geometry.getVerticesDataKinds().sort().map(kind => { const data = mesh.geometry.getVerticesData(kind); if (!data) throw new Error('native几何CPU读取不可用：' + kind); return [kind, rawArray(data)]; })) })),
      shaders: targets.map(mesh => { const receipt = receipts.get(mesh); if (!receipt) throw new Error('native缺真实draw shader收据'); return { meshId: mesh.uniqueId,
        materialId: mesh.material.uniqueId, materialClass: mesh.material.getClassName(), defines: receipt.defines, source: receipt.source, uniforms: receipt.uniforms }; }) };
      check('snapshot.complete'); return { state: this.state(), invariant };
    },
    dispose() { if (disposed) return; disposed = true; for (const [mesh, observer] of subscriptions) mesh.onAfterRenderObservable.remove(observer); receipts.clear(); },
  };
}

export function assertNativeRestoreControlState(state, restoredFrame = null) {
  assert.equal(state.ready, true); assert.equal(state.bakeEnabled, false); assert.equal(state.hasResult, false); assert.equal(state.contextLost, false);
  assert.equal(state.runtimeError, null); assert.deepEqual(state.hudErrors, []); assert.deepEqual(state.errors, []);
  assert.equal(state.derivedCount, 0); assert.equal(state.pluginCount, 0); assert.equal(state.targets.length, 2);
  assert.deepEqual(state.targets.map(row => row.materialClass).sort(), ['PBRMaterial', 'StandardMaterial']);
  assert.equal(state.targets.reduce((sum, row) => sum + row.indices, 0), 12);
  for (const row of state.targets) { assert.equal(row.plugin, false); assert.equal(row.ready, true); assert.ok(row.receipt && !row.receipt.hasBakedDefine);
    assert.ok(row.receipt.frameId >= state.frameId - 2 && row.receipt.frameId <= state.frameId);
    if (restoredFrame !== null) assert.ok(row.receipt.frameId > restoredFrame, 'native必须是真实restore之后的新绘制收据'); }
}

export async function verifyNativeRestoreControl(target, { output, checkpoint = async () => {} }) {
  const realOutput = await fs.realpath(output), realRoot = await fs.realpath(path.resolve('output')), relative = path.relative(realRoot, realOutput);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const capture = async (label, screenshot = false) => { const { base64, ...meta } = await target.evaluate(() => window.__phase2MipsProbe.pixels()), rgba = Buffer.from(base64, 'base64');
    assert.equal(rgba.length, meta.width * meta.height * 4); assert.equal(mipsSha(rgba), meta.sha256); assert.ok(meta.colors > 16);
    const file = path.join(realOutput, 'native-' + label + '.rgba'); await fs.writeFile(file, rgba, { flag: 'wx' }); const saved = await fs.readFile(file);
    assert.equal(saved.length, rgba.length); assert.equal(mipsSha(saved), meta.sha256);
    const evidence = { ...meta, file, bytes: saved.length };
    if (screenshot) { evidence.screenshot = path.join(realOutput, 'native-' + label + '.png'); await target.screenshot({ path: evidence.screenshot }); }
    return { width: meta.width, height: meta.height, rgba: saved, evidence };
  };
  const framing = await target.evaluate(() => window.__phase2NativeRestoreControl.frame()); await target.evaluate(() => window.__phase2MipsProbe.waitFrames());
  await target.waitForFunction(() => { const state = window.__phase2NativeRestoreControl.state(); if (state.errors.length) throw new Error(JSON.stringify(state.errors));
    return state.ready && state.targets.every(row => row.ready && row.receipt); }, null, { timeout: 30000 });
  const before = await target.evaluate(() => window.__phase2NativeRestoreControl.snapshot()); assertNativeRestoreControlState(before.state);
  const gpuState = await target.evaluate(() => window.__phase2MipsProbe.snapshot()); assert.deepEqual(gpuState.auditErrors, []); assert.equal(gpuState.gpu.version, 2);
  assert.doesNotMatch(JSON.stringify(gpuState.gpu.info), /swiftshader|llvmpipe|warp|software|basic render driver/i);
  const report = { status: 'DIAGNOSTIC_NATIVE_CONTROL_NOT_B9_PASS', functionalPass: false, framing, before, gpu: gpuState.gpu,
    historicalCameraMatch: 'NOT_VERIFIABLE_NO_HISTORICAL_ACTUAL_CAMERA_VALUES', sameFixtureAndFramingFormula: true };
  await checkpoint('native-before-state', report);
  const before0 = await capture('AA0'); await target.evaluate(() => window.__phase2MipsProbe.waitFrames()); const before1 = await capture('AA1', true);
  report.beforeAA = { first: before0.evidence, second: before1.evidence, stable: before0.rgba.equals(before1.rgba) }; await checkpoint('native-before-AA', report);
  await target.evaluate(() => window.__phase2MipsProbe.restore()); await target.waitForFunction(() => window.__phase2NativeRestoreControl.state().ready, null, { timeout: 30000 });
  await target.evaluate(() => window.__phase2MipsProbe.waitFrames());
  report.restore = await target.evaluate(() => window.__phase2MipsProbe.snapshot()); assert.deepEqual(report.restore.auditErrors, []); assert.equal(report.restore.lastExpectedLoss.phase, 'restored');
  report.stable = [];
  for (let index = 0; index < 10; index++) { const value = await target.evaluate(() => window.__phase2NativeRestoreControl.state()); assertNativeRestoreControlState(value, report.restore.lastExpectedLoss.restoredFrame); report.stable.push(value); await pause(200); }
  const after = await target.evaluate(() => window.__phase2NativeRestoreControl.snapshot()); report.after = after; await checkpoint('native-after-state', report);
  const pixels = await capture('after-restore', true); report.afterRestorePixels = pixels.evidence;
  report.pixelComparison = summarizeNativeRestoreRgba({ before0, before1, after: pixels });
  report.invariantSha256 = { before: mipsSha(Buffer.from(JSON.stringify(before.invariant))), after: mipsSha(Buffer.from(JSON.stringify(after.invariant))) };
  await checkpoint('native-complete-rgba-comparison', report);
  assert.ok(JSON.stringify(after.invariant) === JSON.stringify(before.invariant), 'native相机/视图/几何/真实shader关键量及sampler绑定恢复前后必须完全一致；完整before/after已保留');
  return report;
}

/** Viewer当前GI状态按250ms刷新；只等UI追上已恢复的runtime，真实错误仍立即拒绝。 */
export async function waitForMipsViewerStatusUi(target) {
  await target.waitForFunction(()=>{const state=window.__phase2MipsProbe?.snapshot();return state?.ready&&state.maps.length>0&&state.maps.every(row=>row.ready);},null,{timeout:180000});
  await target.waitForFunction(()=>{const state=window.__phase2MipsProbe?.snapshot();
    if(state?.runtimeError)throw new Error('Viewer当前GI仍失败：'+state.runtimeError);
    return Boolean(state?.runtimeFound&&state.ready&&state.maps.length&&state.maps.every(row=>row.ready)&&state.hudErrors.length===0);
  },null,{timeout:2000});
}

export async function verifyMipsViewers({ root, snapshot, expectedScene, expected, output, projectId, levels, encoding, checkpoint = async () => {} }) {
  const artifact = await inspectBusinessGiDist(root, snapshot, expectedScene), requests = [], hosted = await createBusinessGiViewerServer(root, projectId, requests);
  const geometry = { triangles: artifact.expectedTriangles, keys: snapshot.surfaces.map(surface => surface.key.replace(/\/primitive:\d+(?:\/tile:[^/]+)?$/, '')) };
  const report = { requests, cases: [], externalRequests: [], errors: [], consoleErrors: [] }; let browser;
  try { browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (['http:', 'https:'].includes(url.protocol) && url.origin !== hosted.origin) { report.externalRequests.push(url.origin); return route.abort(); } return route.continue(); });
    const chunk = (await artifact.reader.list('assets')).find(name => /^engineStore-.*\.js$/.test(name)); assert.ok(chunk);
    for (const iframe of [false, true]) { const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
      const row = { iframe }; report.cases.push(row);
      await checkpoint(iframe ? 'iframe-starting' : 'viewer-starting');
      await page.goto(hosted.origin + (iframe ? '/phase2-gamma-host.html' : '/'), { waitUntil: 'domcontentloaded' });
      if (iframe) await page.waitForFunction(() => Boolean(document.querySelector('iframe')?.contentDocument?.querySelector('canvas')), null, { timeout: 180000 });
      const target = iframe ? page.frames().find(frame => frame !== page.mainFrame() && frame.url().startsWith(hosted.origin)) : page;
      assert.ok(target); await target.locator('canvas').waitFor({ state: 'visible', timeout: 180000 });
      await target.evaluate(installMipsProbe, { moduleUrl: hosted.origin + '/assets/' + chunk, expectedLevels: levels });
      await waitForMipsViewerStatusUi(target);
      try { row.proof = await verifyMipsProbe(target, expected, { expectedEncoding: encoding, geometry, artifacts: { output, prefix: iframe ? 'mips-iframe' : 'mips-viewer' }, checkpoint: async (phase, evidence) => {
        if (evidence) (row.partialEvidence ??= {})[phase] = evidence; await fs.writeFile(path.join(output, 'mips-viewer-report.json'), JSON.stringify(report, null, 2) + '\n'); await checkpoint((iframe ? 'iframe-' : 'viewer-') + phase, evidence);
      } }); row.screenshot = path.join(output, iframe ? 'mips-iframe.png' : 'mips-viewer.png'); await page.screenshot({ path: row.screenshot }); }
      catch (error) { row.failure = await target.evaluate(() => ({ state: window.__phase2MipsProbe?.snapshot(), diagnostics: window.__phase2MipsProbe?.diagnostics() })).catch(failure => ({ readbackError: String(failure) })); throw error; }
      await page.close();
    }
    assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []);
    assert.ok(requests.some(row => row.readOnlyRuntimeQuery && row.status === 200)); report.functionalPass = report.cases.every(row => row.proof.functionalPass); report.status = report.functionalPass ? 'PASS' : 'INCONCLUSIVE_NATURAL_AA_UNSTABLE'; return report;
  } catch (error) { report.status = 'FAIL'; report.error = String(error.stack ?? error); throw error; }
  finally { await browser?.close(); await new Promise(resolve => hosted.server.close(resolve)); report.resourcesClosed = true; await fs.writeFile(path.join(output, 'mips-viewer-report.json'), JSON.stringify(report, null, 2) + '\n'); }
}
