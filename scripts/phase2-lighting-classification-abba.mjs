/* global window, document */
import assert from 'node:assert/strict';
import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual, promisify } from 'node:util';
import { _electron } from 'playwright';
import { assertSceneOpenReady } from './lib/sceneOpenAcceptance.mjs';
import { installClassificationAudit, measureClassificationWindow, captureClassificationFunction, readClassificationReadyReceipt } from './lib/phase2LightingClassificationAudit.mjs';
import { installPhase2ShadowCacheAudit } from './lib/phase2ShadowCacheAudit.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url)), outputRoot = path.join(repo, 'output');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
const SCREEN_ID = 'entity_f379ecee-d30a-4f7a-a52b-8f826bec7c3a';
const SOURCE_SHA = '0e5379583e46511b8c780d9fd3e0225a294a219a0ce3d5f249d0061c5af75015';
const ownNewDirectory = async directory => {
  assert.ok(directory !== outputRoot && inside(outputRoot, directory), '只允许output内全新专属目录');
  await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory);
};
const strictJson = value => {
  if (typeof value === 'number') { assert.ok(Number.isFinite(value)); return Object.is(value, -0) ? '-0' : JSON.stringify(value); }
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return Array.isArray(value) ? '[' + value.map(strictJson).join(',') + ']'
    : '{' + Object.entries(value).map(([key, item]) => JSON.stringify(key) + ':' + strictJson(item)).join(',') + '}';
};
const protocol = {
  version: 1, inputEntityCount: 383, sequence: ['A1', 'B1', 'B2', 'A2'], seconds: 60, warmupSeconds: 30,
  width: 1920, height: 1080, minFrameIntervals: 300, maxElapsedMs: 63000,
  conditions: 'new current-383 Editor EDIT mode static/no-MQTT local condition; NOT preview/motion or historical370/Intel/1334 messages or E1 2560x1440',
  armA: 'own runtime options.classificationCoalesceMinMs=0 and hasClassificationConsumer()=>true only',
  armB: 'original method and original absent/default250 coalesce; no forced invalidation',
  exclusions: 'owned copy only: mqtt enabled/simulatorEnabled=false; remove exact known screen component, retain entity/all other components',
  fetchPolicy: 'original fetch configuration retained exactly; never click Run/Performance Run; telemetryPreviewActive=false/fetch snapshot and timer null/in-flight0 before and during window; any invoke/network is invalid and blocked without probing',
  performanceWindow: 'same Reflect.apply counters/duration, native LongTask and engine frame cadence only; no readPixels/full geometry/world matrices',
  functionalWindow: 'pre-AA0, one-second natural interval, pre-AA1; separate post60s point; full rawRGBA and all geometry/world/thin matrices outside performance',
  nonstaticRule: 'natural AA animation or any point mismatch => INCONCLUSIVE, never pause scripts/freeze time/force zero or mark performancePass true',
  n1Applicability: 'source shadows.enabled=true => consumer exists; N1 noConsumer is not independently exercised here',
  pairGate: 'both A1/B1 and A2/B2 lower getSources time/s and no higher calls/s, B p95<=1.05*A p95; observed only, not robust FPS superiority',
  n3ShadowInvestmentOnly: { minGetSourcesMsPerFrame: 1, minFrameIntervalShare: .10, alternativeTickShare: .20 },
  functionalArrayBudgetBytes: 128 * 1024 ** 2, expectedOutputBudgetBytes: 2 * 1024 ** 3,
};

export const shadowCacheProtocol = {
  version: 1, mode: 'shadow-cache', inputEntityCount: 383, sequence: ['A1', 'B1', 'B2', 'A2'], seconds: 60, warmupSeconds: 30,
  width: 1920, height: 1080, minFrameIntervals: 300, maxElapsedMs: 63000,
  conditions: 'independent current-383 S2 EDIT/static/no-MQTT; all classification arms original B/default; no N1/N2/N3 conclusion',
  armA: 'owned document lighting.bake.cacheStaticShadows=false only', armB: 'owned document lighting.bake.cacheStaticShadows=true only',
  exclusions: protocol.exclusions, fetchPolicy: protocol.fetchPolicy, functionalWindow: protocol.functionalWindow, nonstaticRule: protocol.nonstaticRule,
  performanceWindow: 'original measureClassificationWindow.active exactly; getHybridMetrics at active boundaries only; actual ObjectRenderer face/layer draw intervals',
  maxFaceRecords: 65536, metadataBudgetBytesPerArm: 128 * 1024 ** 2,
  recordBudgetBasis: '60Hz*60s*(3 CSM + 6 cube)=32400; preregistered 65536 covers twice this estimate, never expanded after observation',
  pixelContract: { naturalAA: 'full RGBA exact0', withinTreatment: 'all full RGBA points exact0', geometryMatricesCamera: 'exact0',
    crossTreatmentRgbMaxDelta: 1, crossTreatmentAlphaMaxDelta: 0, source: 'scripts/smoke-hybrid-shadows.mjs:107-110 existing RGB<=1 shadow contract; alpha exact is an additional preregistered S2 guard; fixed before any S2 measurement' },
  unknownRule: 'unknown/reset/drop/no-face/missing cache proof => INCONCLUSIVE; natural rawRGBA AA mismatch => INCONCLUSIVE; no masking/time pause/LED disabling/rawdepth substitute',
  pairGate: 'both A1/B1 and A2/B2: B cacheHits>0; A cacheHits=0; lower B staticRenders and drawCalls per original performance.frameIntervalsMs.length; B frame p95 <= 1.05*A',
  unitCorrection: 'before any S2 data: cached throughput may increase drawCalls/s while reducing drawCalls/frame; seconds are descriptive throughput only, never the reduction gate. Denominator is original measurement frameIntervalsMs.length, not another sampler. Original unrun plan1 preserved.',
  functionalArrayBudgetBytes: protocol.functionalArrayBudgetBytes, expectedOutputBudgetBytes: protocol.expectedOutputBudgetBytes,
};

export function shadowCacheClassificationArm(arm) { assert.ok(['A', 'B'].includes(arm)); return 'B'; }

export function applyShadowCacheTreatment(document, arm) {
  assert.ok(['A1', 'B1', 'B2', 'A2'].includes(arm));
  const bake = document.scene?.sceneSettings?.lighting?.bake; assert.ok(bake && typeof bake === 'object');
  bake.cacheStaticShadows = arm[0] === 'B'; return document;
}

export function evaluateShadowCacheCases(cases, functionalPass, measurementValid) {
  const known = cases.length === 4 && shadowCacheProtocol.sequence.every(name => cases.filter(row => row.name === name).length === 1)
    && cases.every(row => row.shadowConditionValid === true && row.shadowAudit?.status === 'OBSERVED' && row.shadowAudit.measurementScoped
    && row.shadowAudit.disposed && Number.isSafeInteger(row.shadowMetadataBytes) && row.shadowMetadataBytes >= 0 && row.shadowMetadataBytes <= shadowCacheProtocol.metadataBudgetBytesPerArm && row.shadowAudit.droppedFaceRecords === 0
    && row.shadowAudit.samples.length === 2 && row.shadowAudit.samples[0].label === 'measurement-start' && row.shadowAudit.samples[1].label === 'measurement-end'
    && row.shadowAudit.initial?.raw.unsupportedCacheReason === null && row.shadowAudit.initial?.raw.validationErrors?.length === 0
    && ['staticRenders', 'dynamicRenders', 'cacheHits', 'cacheInvalidations'].every(key => Number.isSafeInteger(row.shadowAudit.samples[1].deltaFromInstall[key]) && row.shadowAudit.samples[1].deltaFromInstall[key] >= 0)
    && row.shadowAudit.targets.every(target => Number.isSafeInteger(target.observedDrawCalls) && target.observedDrawCalls >= 0 && target.unavailableDrawIntervals === 0)
    && Array.isArray(row.performance?.frameIntervalsMs) && row.performance.frameIntervalsMs.length > 0 && Number.isFinite(row.performance.elapsedMs) && row.performance.elapsedMs > 0
    && row.shadowAudit.configuration.cacheStaticShadows === (row.arm === 'B'));
  const pairs = [];
  if (known) for (const [a, b] of [['A1', 'B1'], ['A2', 'B2']]) {
    const read = name => { const row = cases.find(row => row.name === name), seconds = row.performance.elapsedMs / 1000, frames = row.performance.frameIntervalsMs.length, delta = row.shadowAudit.samples[1].deltaFromInstall;
      const draws = row.shadowAudit.targets.reduce((sum, target) => sum + target.observedDrawCalls, 0);
      return { staticRendersPerSecond: delta.staticRenders / seconds, cacheHits: delta.cacheHits,
        measuredFrames: frames, staticRendersPerMeasuredFrame: delta.staticRenders / frames, drawCallsPerMeasuredFrame: draws / frames,
        drawCallsPerSecond: draws / seconds, p95FrameMs: row.performance.frameQuantiles.p95Ms }; };
    const A = read(a), B = read(b); pairs.push({ a, b, A, B, directionalCostReduction: A.cacheHits === 0 && B.cacheHits > 0 && B.staticRendersPerMeasuredFrame < A.staticRendersPerMeasuredFrame && B.drawCallsPerMeasuredFrame < A.drawCallsPerMeasuredFrame && B.p95FrameMs <= A.p95FrameMs * 1.05 });
  }
  const performancePass = Boolean(functionalPass && measurementValid && known && pairs.every(pair => pair.directionalCostReduction));
  return { status: performancePass ? 'PASS_OBSERVED_S2_ABBA_ONLY' : 'INCONCLUSIVE_OR_NO_DIRECTIONAL_BENEFIT', performancePass, shadowEvidenceKnown: known, pairs,
    performancePassScope: 'observed actual cached-shadow draw/static-pass direction in this single protocol; no robust FPS superiority or N1/N2/N3 claim' };
}

export function compareShadowCachePixels(left, right, crossTreatment) {
  assert.ok(Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && left.length > 0 && left.length % 4 === 0);
  let maxRgbDelta = 0, rgbOverOnePixels = 0, alphaDifferentPixels = 0, differentPixels = 0;
  for (let index = 0; index < left.length; index += 4) {
    let rgb = 0; for (let channel = 0; channel < 3; channel++) rgb = Math.max(rgb, Math.abs(left[index + channel] - right[index + channel]));
    const alpha = left[index + 3] !== right[index + 3]; maxRgbDelta = Math.max(maxRgbDelta, rgb);
    if (rgb > 1) rgbOverOnePixels++; if (alpha) alphaDifferentPixels++; if (rgb || alpha) differentPixels++;
  }
  return { maxRgbDelta, rgbOverOnePixels, alphaDifferentPixels, differentPixels, pixels: left.length / 4,
    pass: crossTreatment ? rgbOverOnePixels === 0 && alphaDifferentPixels === 0 : differentPixels === 0 };
}

async function compareShadowCacheFunctionalFiles(cases, output) {
  const references = new Map(), rows = []; let geometryExact = true, matricesExact = true, dimensionsExact = true, pixelsPass = true;
  const baseline = cases[0].functions[0];
  const read = async (row, point, extension, expectedSha) => { assert.ok(['pre-AA0', 'pre-AA1', 'post60s'].includes(point.label));
    const root = path.join(output, row.name), file = path.join(root, point.label + extension), stat = await fs.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= protocol.functionalArrayBudgetBytes);
    assert.ok(inside(await fs.realpath(root), await fs.realpath(file))); const bytes = await fs.readFile(file); assert.equal(sha(bytes), expectedSha); return bytes;
  };
  let baselineMatrices;
  for (const row of cases) for (const point of row.functions) {
    const rgba = await read(row, point, '.rgba', point.rgbaSha256); assert.equal(rgba.length, point.width * point.height * 4);
    const matrices = await read(row, point, '.matrices.bin', point.matrixSha256); baselineMatrices ??= matrices;
    const geometry = point.geometrySha256 === baseline.geometrySha256 && isDeepStrictEqual(point.camera, baseline.camera);
    geometryExact &&= geometry; matricesExact &&= matrices.equals(baselineMatrices); dimensionsExact &&= point.width === baseline.width && point.height === baseline.height;
    if (!references.has(row.arm)) references.set(row.arm, rgba);
    const within = compareShadowCachePixels(references.get(row.arm), rgba, false);
    const cross = row.arm === 'B' ? compareShadowCachePixels(references.get('A'), rgba, true) : null;
    pixelsPass &&= within.pass && (cross?.pass ?? true); rows.push({ case: row.name, point: point.label, withinTreatment: within, crossTreatmentToA1: cross, geometryExact: geometry, matricesExact: matrices.equals(baselineMatrices) });
  }
  return { source: shadowCacheProtocol.pixelContract, rows, geometryExact, matricesExact, dimensionsExact, pixelsPass,
    pass: geometryExact && matricesExact && dimensionsExact && pixelsPass };
}

async function prepareShadowCachePlan(source, output) {
  const base = await preparePlan(source, output), baseBytes = await fs.readFile(path.join(output, 'plan.json'));
  const document = JSON.parse(await fs.readFile(source, 'utf8'));
  const plan = { ...base, protocol: shadowCacheProtocol, sourceShadowSettings: document.scene.sceneSettings.lighting.shadows,
    sourceDynamicShadows: document.scene.sceneSettings.lighting.bake.dynamicShadows ?? true,
    baseReadinessPlan: { file: path.join(output, 'plan.json'), sha256: sha(baseBytes) },
    execution: 'node scripts/phase2-lighting-classification-abba.mjs --mode shadow-cache --execute --plan <shadow-cache-plan.json> --output <new-run>; requires separately scheduled GPU window',
    inputMutationChecklist: [...base.inputMutationChecklist, 'S2 only: owned lighting.bake.cacheStaticShadows A=false/B=true; original classification B/default in all four'],
    acceptanceChecklist: ['original four 60s/focus/size/loading/network gates', 'all natural fullRGBA AA/before-after/cross-case/geometry/matrices equal',
      'actual getHybridMetrics + real RTT face/layer draw evidence exactly inside original active', 'unknown/drop/reset/no-face/metadata budget excess => INCONCLUSIVE', 'no N1/N2/N3 conclusion'] };
  await fs.writeFile(path.join(output, 'shadow-cache-plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' }); return plan;
}

export function deriveClassificationReadinessResources(scene) {
  const modelIds=scene.entityIds.filter(id=>scene.entities[id]?.components.modelAsset&&!scene.entities[id]?.components.modelArrayInstance).sort();
  const instanceIds=scene.entityIds.filter(id=>scene.entities[id]?.components.modelArrayInstance).sort(),sources=new Set();
  for(const id of instanceIds){const source=scene.entities[id].components.modelArrayInstance.sourceEntityId;if(modelIds.includes(source))sources.add(source);}
  const visible=id=>{const seen=new Set();let entity=scene.entities[id];while(entity){if(seen.has(entity.id))throw new Error('CLASSIFICATION_SOURCE_HIERARCHY_CYCLE');seen.add(entity.id);if(entity.visible===false)return false;entity=entity.parentId?scene.entities[entity.parentId]:null;}return true;};
  const batchedEntities=scene.entityIds.filter(id=>{const entity=scene.entities[id];if(!entity?.components.modelAsset||!visible(id))return false;
    const source=entity.components.modelArrayInstance?.sourceEntityId;return sources.has(source??id);}).length;
  return {version:1,modelIds,instanceIds,batchedEntities};
}

/** 只读GLB JSON统计声明，不读bin推测几何；完整文件SHA另用流式读取锁定。当前输入仅标准三角拓扑。 */
async function inspectClassificationEnvironment(scene,project) {
  const environment=scene.sceneSettings.environment;assert.ok(environment&&scene.sceneSettings.skybox===null,'冻结输入环境/天空盒条件漂移');
  const variant=environment.variants.find(item=>item.sourceUrl===environment.activeVariantUrl);assert.ok(variant&&path.isAbsolute(variant.sourcePath)&&inside(project,variant.sourcePath));
  const file=variant.sourcePath,handle=await fs.open(file,'r');let gltf,jsonSha256,jsonBytes,fileBytes;
  try{
    const header=Buffer.alloc(20);assert.equal((await handle.read(header,0,20,0)).bytesRead,20);assert.equal(header.readUInt32LE(0),0x46546c67);assert.equal(header.readUInt32LE(4),2);assert.equal(header.readUInt32LE(16),0x4e4f534a);
    jsonBytes=header.readUInt32LE(12);assert.ok(jsonBytes>0&&jsonBytes<=16*1024**2);const bytes=Buffer.alloc(jsonBytes);assert.equal((await handle.read(bytes,0,jsonBytes,20)).bytesRead,jsonBytes);
    gltf=JSON.parse(bytes.toString('utf8'));jsonSha256=sha(bytes);fileBytes=(await handle.stat()).size;assert.equal(header.readUInt32LE(8),fileBytes);
  }finally{await handle.close();}
  const seen=new Set();let meshCount=0,vertexCount=0,triangleCount=0;
  const visit=index=>{assert.ok(Number.isSafeInteger(index)&&gltf.nodes[index]&&!seen.has(index),'环境GLB节点重复/循环/缺失');seen.add(index);const node=gltf.nodes[index];
    assert.ok(!node.extensions||Object.keys(node.extensions).length===0,'未知环境node扩展不能猜计数');
    if(node.mesh!==undefined)for(const primitive of gltf.meshes[node.mesh].primitives){assert.equal(primitive.mode??4,4,'未知环境拓扑不能猜计数');
      const vertices=gltf.accessors[primitive.attributes.POSITION].count,indices=primitive.indices===undefined?vertices:gltf.accessors[primitive.indices].count;
      assert.ok(Number.isSafeInteger(vertices)&&vertices>=0&&Number.isSafeInteger(indices)&&indices>=0&&indices%3===0);
      if(vertices>0){meshCount++;vertexCount+=vertices;triangleCount+=indices/3;}}
    for(const child of node.children??[])visit(child);};
  for(const node of gltf.scenes[gltf.scene??0].nodes)visit(node);assert.ok(meshCount>0&&vertexCount>0&&triangleCount>0);
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
  return {sourceUrl:environment.activeVariantUrl,sourceFileAssetsRelative:path.relative(path.join(project,'Assets'),file).replaceAll('\\','/'),sourceFileSha256:hash.digest('hex'),sourceFileBytes:fileBytes,
    jsonBytes,jsonSha256,meshCount,vertexCount,triangleCount,basis:'default GLB scene reachable triangle primitives; no bin decoded; actual runtime must match independently'};
}

/** 当前冻结工厂从实体组件选择天空盒，不能把旧sceneSettings.skybox空值当成没有天空盒。 */
export async function inspectClassificationSkybox(scene, project) {
  const entries=scene.entityIds.map(id=>scene.entities[id]).filter(entity=>entity?.components?.skybox);
  assert.equal(entries.length,1,'当前冻结输入必须精确包含一个实体天空盒');
  const entity=entries[0],skybox=entity.components.skybox,seen=new Set();let ancestor=entity;
  while(ancestor){assert.ok(!seen.has(ancestor.id),'天空盒祖先循环');seen.add(ancestor.id);assert.notEqual(ancestor.visible,false,'当前天空盒必须实际可见');ancestor=ancestor.parentId?scene.entities[ancestor.parentId]:null;}
  assert.ok(path.isAbsolute(skybox.sourcePath)&&inside(project,skybox.sourcePath),'天空盒必须来自当前原工程');
  assert.equal(skybox.sourceUrl,'editor-asset://local/'+encodeURIComponent(skybox.sourcePath),'天空盒URL与文件必须精确对应');
  const stat=await fs.lstat(skybox.sourcePath);assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'天空盒必须为普通文件');
  assert.ok(inside(await fs.realpath(project),await fs.realpath(skybox.sourcePath)),'天空盒路径不能通过链接越界');
  const hash=createHash('sha256');for await(const chunk of createReadStream(skybox.sourcePath))hash.update(chunk);
  return {entityId:entity.id,sourceUrl:skybox.sourceUrl,sourcePath:skybox.sourcePath,assetRevision:skybox.assetRevision,
    sourceFileBytes:stat.size,sourceSha256:hash.digest('hex'),basis:'exact entity component and visible ancestry; complete original file SHA; actual runtime must use same rebased URL'};
}

/** 计划阶段只读Scene与已明确的环境/天空盒文件，不扫描Assets、不启动Editor。 */
async function preparePlan(source, output) {
  const bytes = await fs.readFile(source), document = JSON.parse(bytes.toString('utf8'));
  assert.equal(sha(bytes), SOURCE_SHA, '当前383来源SHA漂移，必须重新审查准入');
  assert.equal(document.scene.entityIds.length, 383); assert.equal(Object.keys(document.scene.entities).length, 383);
  assert.equal(document.scene.sceneSettings.lighting.shadows.enabled, true); assert.equal(document.scene.sceneSettings.lighting.result, null);
  const screen = document.scene.entities[SCREEN_ID]?.components?.dataPlatformScreen; assert.ok(screen);
  const originalProject = path.dirname(path.dirname(source)), external = [];
  const visit = (value, field) => {
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, field + '.' + index));
    if (value && typeof value === 'object') return Object.entries(value).forEach(([key, item]) => visit(item, field + '.' + key));
    if (typeof value === 'string' && path.isAbsolute(value) && !inside(originalProject, value)) external.push({ field, value });
  };
  visit(document, 'document');
  const readinessAcceptance={...deriveClassificationReadinessResources(document.scene),version:2,
    environment:await inspectClassificationEnvironment(document.scene,originalProject),skybox:await inspectClassificationSkybox(document.scene,originalProject),
    implementation:'strict existing preparation timings/current session + zero runtime/cargo/stage failures + actual model IDs/counts/environment topology; UI copy outside 60s, HUD closed before original warmup'};
  await ownNewDirectory(output);
  const plan = { status: 'PREREGISTERED_NOT_RUN', createdAt: new Date().toISOString(), source, sourceSha256: sha(bytes),
    protocol,readinessAcceptance, exactScreenExclusion: { entityId: SCREEN_ID, component: screen, sha256: sha(Buffer.from(strictJson(screen))) },
    fetchConfigSha256: sha(Buffer.from(strictJson(document.scene.fetchConfig))), externalLocalIdentifiers: external,
    externalIdentifierPolicy: 'preserve all opaque identifiers; existing production recovery may use exact source/revision index; no guessed filename mapping or parameter edits. Actual ready failure remains failure.',
    inputMutationChecklist: ['only owned copy MQTT enabled/simulatorEnabled flags', 'only exact screen component removal',
      'project absolute asset/file/editor-asset paths rebased to owned full copy', 'all entity IDs/tree/parameters/scripts/geometry/light/render/opening cadence retained'],
    sourceAndBuildBinding: 'tool/source and compiled dist+dist-electron hashes captured before first process and required stable through all four; fresh case userData/project copies',
    execution: 'separate explicit --execute --plan <this plan> --output <new run directory>; current plan creation does not authorize a GPU window',
    acceptanceChecklist: ['all four 60s windows meet sample/focus/size/no-new-loading/error gates', 'raw AA and all before/after functional points agree',
      'same actual GPU/driver/camera/source/build in all cases', 'no MQTT connection/message or unexpected network', 'N1 applicability separate; N2 must have natural exercised invalidations',
      'N3 based on B residual measured getSources cost only; no N3 implementation'],
  };
  await fs.writeFile(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' }); return plan;
}

async function fileManifest(root) {
  const pending = [root], result = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, '输入/构建不得跟随链接'); const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) { const bytes = await fs.readFile(file); result.push({ path: path.relative(root, file), bytes: bytes.length, sha256: sha(bytes) }); }
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
async function bindings(shadowCacheMode = false) {
  const sources = ['src/runtime/babylon/SceneLightingRuntime.ts', 'src/runtime/babylon/scene-runtime/EnvironmentAndSkyboxController.ts',
    'src/runtime/babylon/lightingInvalidation.ts', 'scripts/phase2-lighting-classification-abba.mjs', 'scripts/lib/phase2LightingClassificationAudit.mjs','scripts/lib/sceneOpenAcceptance.mjs'];
  if (shadowCacheMode) sources.push('src/runtime/babylon/HybridShadowCache.ts', 'src/runtime/babylon/SceneShadowRuntime.ts', 'scripts/lib/phase2ShadowCacheAudit.mjs', 'tests/runtime/phase2ShadowCacheAudit.test.mjs');
  return { sources: await Promise.all(sources.map(async file => ({ path: file, sha256: sha(await fs.readFile(path.join(repo, file))) }))),
    editor: await fileManifest(path.join(repo, 'dist')), electron: await fileManifest(path.join(repo, 'dist-electron')) };
}
function rebase(value, originalProject, project) {
  if (Array.isArray(value)) return value.map(item => rebase(item, originalProject, project));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item, originalProject, project)]));
  if (typeof value !== 'string') return value;
  let file = value, kind = 'path';
  if (value.startsWith('editor-asset://local/')) { file = decodeURIComponent(new URL(value).pathname.slice(1)); kind = 'editor'; }
  else if (value.startsWith('file:')) { file = fileURLToPath(value); kind = 'file'; }
  if (!path.isAbsolute(file) || !inside(originalProject, file)) return value;
  const mapped = path.join(project, path.relative(originalProject, file));
  return kind === 'editor' ? 'editor-asset://local/' + encodeURIComponent(mapped) : kind === 'file' ? pathToFileURL(mapped).href : mapped;
}
const quantiles = values => { const sorted = [...values].sort((a, b) => a - b), at = p => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return { count: values.length, totalMs: values.reduce((a, b) => a + b, 0), p50Ms: at(.5), p95Ms: at(.95), p99Ms: at(.99) }; };
const equivalent = (left, right) => left.rgbaSha256 === right.rgbaSha256 && left.geometrySha256 === right.geometrySha256
  && left.matrixSha256 === right.matrixSha256 && isDeepStrictEqual(left.camera, right.camera);

/** 复用原零失败合同，再要求明确准备证据、当前会话和完整源资源数量；未知绝不能当false/0。 */
export function assertClassificationSceneReady(receipt,expected) {
  const preparation=receipt?.preparationTimings,state=receipt?.preparationState,metrics=receipt?.metrics,loading=metrics?.loading;
  for(const field of ['completed','settled','runtimeStable'])assert.equal(preparation?.[field],true,'缺少自然准备证据:'+field);
  assert.equal(preparation?.forcedSettled,false,'准备被强制收束或证据缺失');
  assert.ok(Number.isFinite(preparation.totalMs)&&preparation.totalMs>=0,'准备墙钟证据缺失');
  assert.ok(preparation.phases&&typeof preparation.phases==='object'&&!Array.isArray(preparation.phases),'准备阶段证据缺失');
  assert.ok(!Object.hasOwn(preparation.phases,'partial'),'准备经历partial，不能作为零失败正式样本');
  assert.ok(loading?.stages&&typeof loading.stages==='object'&&Object.keys(loading.stages).length>0,'加载阶段证据缺失');
  assertSceneOpenReady(preparation,loading);
  for(const [name,stage]of Object.entries(loading.stages)){assert.equal(stage.activeCount,0,'加载阶段仍在途:'+name);assert.equal(stage.failedCount,0,'加载阶段失败:'+name);}
  assert.equal(loading.cargoPreload?.pendingCount,0,'cargo尚未就绪或无证据');assert.equal(loading.cargoPreload?.failedCount,0,'cargo预取失败或无证据');
  assert.equal(state?.phase,'completed','准备处于partial或未完成');assert.equal(state?.completed,true);
  assert.ok(typeof state.sceneSessionId==='string'&&state.sceneSessionId.length>0,'准备会话证据缺失');
  assert.equal(state.runtime?.generation,state.sceneSessionId,'准备代次漂移');assert.equal(state.runtime?.stable,true);assert.equal(state.runtime?.forcedSettled,false);
  assert.ok(['settled','skipped'].includes(state.modelSyncStatus));assert.equal(state.assetRefreshStatus,'settled');assert.deepEqual(state.warnings,[],'准备包含未豁免warning');
  if(state.modelSyncProgress){assert.notEqual(state.modelSyncProgress.phase,'failed');assert.equal(state.modelSyncProgress.error,null);}
  assert.equal(state.runtime.totalModels,expected.modelIds.length+(expected.environment?1:0));assert.equal(state.runtime.settledModels,state.runtime.totalModels);
  assert.equal(state.runtime.expectedBatchedEntities,expected.batchedEntities);assert.equal(state.runtime.batchedEntities,expected.batchedEntities);
  assert.equal(receipt.sceneId,expected.sceneId);assert.equal(receipt.initial?.error,null,'初始加载失败或证据缺失');assert.deepEqual(receipt.modelErrors,[]);
  assert.deepEqual(receipt.modelIds,[...expected.modelIds].sort(),'源模型ID集合不完整');assert.deepEqual(receipt.readyModelIds,[...expected.modelIds].sort(),'源模型未全部实际ready');
  assert.deepEqual(receipt.instanceIds,[...expected.instanceIds].sort(),'阵列实例ID集合不完整');
  assert.equal(metrics.modelRuntimeCount,expected.modelIds.length);assert.equal(metrics.modelArrayInstanceEntityCount,expected.instanceIds.length);
  assert.ok(metrics.modelArrayBatchEntityCount>=expected.batchedEntities,'实际批次资源不足');
  assert.equal(receipt.resourceIssue,null,'存在场景资源问题');assert.equal(receipt.hudVisible,false,'正式warmup/采样前必须隐藏HUD');
  if(expected.environment){
    assert.equal(loading.environmentPhase,'ready');
    assert.equal(receipt.environment?.phase,'ready');assert.equal(receipt.environment.sourceUrl,expected.environment.sourceUrl);assert.equal(receipt.environment.message,null);
    assert.deepEqual(receipt.actualEnvironment?.invalidMeshes,[],'环境网格缺失/失效');
    for(const field of ['meshCount','vertexCount','triangleCount']){
      assert.equal(receipt.environment.statistics?.[field],expected.environment[field],'环境声明统计不符合:'+field);
      assert.equal(receipt.actualEnvironment?.[field],expected.environment[field],'环境实际数量不符合:'+field);
    }
    assert.equal(receipt.environment.statistics.fileSizeBytes,expected.environment.sourceFileBytes);
  }else assert.equal(receipt.environment?.phase,'idle');
  if(expected.skybox){assert.equal(receipt.skybox?.phase,'ready','实体天空盒必须完成真实准备');
    assert.equal(receipt.skybox.sourceUrl,expected.skybox.sourceUrl,'天空盒来源不能漂移');assert.equal(receipt.skybox.message,null,'天空盒不能有解码/加载错误');}
  else {assert.equal(receipt.skybox?.phase,'idle');assert.equal(receipt.skybox.sourceUrl,null,'无天空盒夹具不得出现未知天空盒');}
  return true;
}

/** 调现有UI复制处理器，只有它会附当前getScenePreparationTimings；结束必隐藏HUD，再进入原30s warmup。 */
async function copyClassificationPreparationTimings(page,cleanupErrors) {
  const toggle=page.getByRole('checkbox',{name:'性能监控',exact:true});assert.equal(await toggle.count(),1,'准备报告UI入口不可用');
  await page.evaluate(()=>{
    window.__classificationClipboardDescriptor=Object.getOwnPropertyDescriptor(navigator,'clipboard');window.__classificationPreparationReport=null;
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__classificationPreparationReport=value;}}});
  });
  let result,primaryError;const previousCleanupCount=cleanupErrors.length;
  try {
    await toggle.check();await page.locator('.scene-performance-summary').waitFor({state:'visible'});
    const summary=page.locator('.scene-performance-summary');if(await summary.getAttribute('aria-expanded')!=='true')await summary.click();
    await page.locator('.scene-performance-copy:not(.scene-performance-retained-report)').click();
    await page.waitForFunction(()=>typeof window.__classificationPreparationReport==='string',null,{timeout:10000});
    result=JSON.parse(await page.evaluate(()=>window.__classificationPreparationReport));
  } catch(error){primaryError=error;
  } finally {
    try{await page.evaluate(()=>{const descriptor=window.__classificationClipboardDescriptor;if(descriptor)Object.defineProperty(navigator,'clipboard',descriptor);else delete navigator.clipboard;delete window.__classificationClipboardDescriptor;delete window.__classificationPreparationReport;});}
    catch(error){cleanupErrors.push({kind:'preparation-clipboard-restore',message:String(error)});}
    try{const summary=page.locator('.scene-performance-summary');if(await summary.count()&&await summary.getAttribute('aria-expanded')==='true')await summary.click();}
    catch(error){cleanupErrors.push({kind:'preparation-hud-collapse',message:String(error)});}
    try{await toggle.uncheck();await page.locator('.scene-performance-hud').waitFor({state:'hidden'});}
    catch(error){cleanupErrors.push({kind:'preparation-hud-hide',message:String(error)});}
  }
  if(primaryError)throw primaryError;if(cleanupErrors.length!==previousCleanupCount)throw new Error('CLASSIFICATION_PREPARATION_UI_CLEANUP_FAILED');return result;
}

async function readOwnedClassificationProcesses(mainPid, previous = []) {
  assert.equal(process.platform,'win32');assert.ok(Number.isSafeInteger(mainPid)&&mainPid>0);
  assert.ok(previous.every(row=>Number.isSafeInteger(row.pid)&&row.pid>0));
  const command=`$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process); $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${mainPid});
do { $changed=$false; foreach($row in $rows) { if($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $changed=$true } } } while($changed);
foreach($knownId in @(${previous.map(row=>row.pid).join(',')})) { [void]$ids.Add([int]$knownId) };
$result=@($rows | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;creationDate=$_.CreationDate.ToUniversalTime().ToString('o')} }); ConvertTo-Json -InputObject $result -Compress`;
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:20000,maxBuffer:1024*1024});
  const result=JSON.parse(stdout.trim());assert.ok(Array.isArray(result));return result;
}

/** 先持有ChildProcess/PID/CreationDate；close后不再读取Playwright已销毁的handle，不强制终止未知进程。 */
export async function observeClassificationOwnedApplication(application) {
  const childProcess=application.process(), owned={application,childProcess,mainPid:childProcess.pid,observedProcesses:[]};
  owned.observedProcesses=await readOwnedClassificationProcesses(owned.mainPid);
  assert.ok(owned.observedProcesses.some(row=>row.pid===owned.mainPid),'CLASSIFICATION_OWNED_IDENTITY_UNKNOWN');return owned;
}

export async function closeClassificationOwnedApplication(owned, readProcesses = readOwnedClassificationProcesses) {
  const closure={status:'UNKNOWN',mainPid:owned.mainPid,observed:owned.observedProcesses??[],noForcedTermination:true};
  try {
    const before=await readProcesses(owned.mainPid), root=closure.observed.find(row=>row.pid===owned.mainPid), current=before.find(row=>row.pid===owned.mainPid);
    const known=new Map(closure.observed.map(row=>[row.pid+':'+row.creationDate,row]));
    if(root&&root.creationDate===current?.creationDate)for(const row of before)known.set(row.pid+':'+row.creationDate,row);
    closure.observed=[...known.values()];
  }catch(error){closure.preCloseReadError=String(error);}
  try{await owned.application.close();}catch(error){closure.closeError=String(error);}
  closure.mainExitCode=owned.childProcess.exitCode;
  try {
    const deadline=Date.now()+10000;
    do {
      const after=await readProcesses(owned.mainPid,closure.observed);
      closure.stillAlive=closure.observed.filter(row=>after.some(current=>current.pid===row.pid&&current.creationDate===row.creationDate));
      closure.pidReplacements=after.filter(row=>closure.observed.some(previous=>previous.pid===row.pid&&previous.creationDate!==row.creationDate));
      if(!closure.stillAlive.length)break;await new Promise(resolve=>setTimeout(resolve,500));
    }while(Date.now()<deadline);
    closure.status=closure.observed.length&&!closure.preCloseReadError&&!closure.stillAlive.length?'OBSERVED_OWNED_PROCESSES_CLOSED':'FAIL_OWNED_PROCESS_REMAINS_OR_UNKNOWN';
  }catch(error){closure.postCloseReadError=String(error);}
  return closure;
}

/** 原始异常先落盘；诊断/截图失败只追加次错，不能覆盖真正的失败原因。 */
export async function preserveClassificationFailure(report,error,{save,readRuntime,captureScreenshot}) {
  report.status='FAIL';report.error=String(error.stack??error);await save();
  try{report.failureRuntimeReceipt=await readRuntime();}catch(secondary){report.failureRuntimeReadError=String(secondary);}
  try{await captureScreenshot();report.failureScreenshotWritten=true;}catch(secondary){report.failureScreenshotError=String(secondary);}
  await save();
}

async function boundedClassificationRead(action,timeoutMs=5000) {
  let timer;try{return await Promise.race([action(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('CLASSIFICATION_DIAGNOSTIC_TIMEOUT')),timeoutMs);})]);}
  finally{clearTimeout(timer);}
}

/** 失败后只取有界只读字段；不点同步、不触发isReady、不读取几何或GPU。 */
function readClassificationFailureRuntime() {
  const runtime=window.__phase2ClassificationAudit?.runtime, loading=runtime?.getPerformanceMetrics?.()?.loading, initial=runtime?.getInitialLoadSnapshot?.();
  return {atMs:performance.now(),visible:document.visibilityState,focused:document.hasFocus(),
    preparationText:document.querySelector('[data-scene-preparation-phase]')?.textContent?.slice(0,4096)??null,
    resourceIssueText:document.querySelector('aside[aria-label="场景资源状态"]')?.textContent?.slice(0,4096)??null,
    loading:loading?{pendingModelCount:loading.pendingModelCount,environmentPhase:loading.environmentPhase,failedModelAcquisitions:loading.failedModelAcquisitions,
      active:loading.active?.slice(0,20).map(item=>({key:item.key??null,phase:item.phase??null})),cargoPreload:loading.cargoPreload??null,
      stages:loading.stages?Object.fromEntries(Object.entries(loading.stages).slice(0,32).map(([key,stage])=>[key,{count:stage.count,failedCount:stage.failedCount,activeCount:stage.activeCount}])):null}:null,
    initial:initial?{phase:initial.phase??null,error:initial.error?String(initial.error).slice(0,4096):null}:null,
    meshCount:runtime?.scene?.meshes?.length??null,frameId:runtime?.scene?.getFrameId?.()??null};
}

async function runCase(name, prepared, plan, output, onStage, shadowCacheMode = false) {
  const root = path.join(output, name), userData = path.join(root, 'user-data'); await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(path.join(userData, 'recent-workspaces.json'), JSON.stringify({ version: 1, projects: [], scenes: [{ filePath: prepared.scene, lastOpenedAt: new Date().toISOString() }] }));
    await fs.writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({ version: 2, baseUrl: '', workspaceRoot: repo }));
  const report = { name, arm: name[0], status: 'RUNNING', errors: [], excludedErrors: [], requestsDuringPerformance: [], webSockets: [], functions: [] };
  const save = () => fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  const known = new Set([plan.exactScreenExclusion.component.screenUrl, plan.exactScreenExclusion.component.thumbnailUrl]
    .filter(Boolean).map(text => { const url = new URL(text); url.hash = ''; return url.href; }));
  const redact = text => { try { const url = new URL(text); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; } catch { return text; } };
  const classify = (kind, message, url = '') => {
    const row = { kind, message, url: redact(url) };
    if (known.has(url)) report.excludedErrors.push({ ...row, basis: 'exact-authorized-screen-URL' }); else report.errors.push(row);
  };
  let app, owned, page, phase = 'startup'; const bootstrap = path.join(root, 'bootstrap.mjs');
  try {
    const url = file => pathToFileURL(path.join(repo, 'dist-electron', file)).href;
    await fs.writeFile(bootstrap, "import {app} from 'electron';\napp.setPath('userData'," + JSON.stringify(userData) + ');\napp.getAppPath=()=>'+JSON.stringify(repo)+';\n'
      + 'const assets=await import('+JSON.stringify(url('ipc/projectAssetStore.js'))+');\nconst registry=await import('+JSON.stringify(url('ipc/assetRegistry.js'))+');\n'
      + 'await assets.activateProjectRoot('+JSON.stringify(prepared.project)+');registry.authorizeAssetRoot('+JSON.stringify(prepared.project)+');\n'
      + 'await import('+JSON.stringify(url('main.js'))+');\n', { flag: 'wx' });
    const env = { ...process.env, OPEN_DEVTOOLS: 'false', VITE_DEV_SERVER_URL: '' }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ args: [bootstrap, '--user-data-dir=' + userData], cwd: repo, env, timeout: 120000 });
    owned=await observeClassificationOwnedApplication(app);report.ownedPid=owned.mainPid;
    await fs.writeFile(path.join(root,'process-identity.json'),JSON.stringify({mainPid:owned.mainPid,observedProcesses:owned.observedProcesses},null,2),{flag:'wx'});
    report.native = await app.evaluate(({ app }) => ({ versions: process.versions, appPath: app.getAppPath(), appVersion: app.getVersion(), userData: app.getPath('userData') }));
    page = await app.firstWindow(); page.setDefaultTimeout(45000);
    page.on('pageerror', error => classify('page', error.message));
    page.on('console', message => { if (message.type() === 'error') classify('console', message.text(), message.location().url); });
    page.on('requestfailed', request => classify('requestfailed', request.failure()?.errorText, request.url()));
    page.on('request', request => { if (phase === 'performance') report.requestsDuringPerformance.push({ url: redact(request.url()), resourceType: request.resourceType() }); });
    page.on('websocket', socket => { const row = { url: redact(socket.url()), receivedMessages: 0, sentMessages: 0 }; report.webSockets.push(row);
      socket.on('framereceived', () => row.receivedMessages++); socket.on('framesent', () => row.sentMessages++); });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (/^https?:/i.test(url)) { classify('external-network-blocked', 'Local static case refuses external HTTP', url); await route.abort(); }
      else await route.continue();
    });
    const card = page.locator('.home-recent-card').filter({ hasText: path.basename(prepared.scene) });
    await card.getByRole('button', { name: '打开', exact: true }).waitFor({ state: 'visible', timeout: 120000 });
    await card.getByRole('button', { name: '打开', exact: true }).click();
    await page.locator('canvas.scene-canvas').waitFor({ state: 'visible', timeout: 120000 });
    if (shadowCacheMode) { report.classificationArm = shadowCacheClassificationArm(report.arm); report.objectProof = await page.evaluate(installClassificationAudit, { arm: report.classificationArm }); }
    else report.objectProof = await page.evaluate(installClassificationAudit, { arm: report.arm });
    await page.waitForFunction(() => {
      const runtime = window.__phase2ClassificationAudit.runtime, loading = runtime.getPerformanceMetrics().loading, initial = runtime.getInitialLoadSnapshot();
      if (initial.error) throw new Error(String(initial.error));
      if(loading.failedModelAcquisitions>0||loading.cargoPreload?.failedCount>0||Object.values(loading.stages??{}).some(stage=>stage.failedCount>0))throw new Error('CLASSIFICATION_LOADING_FAILED; no timeout/replacement');
      if(document.querySelector('[data-scene-preparation-phase]')?.getAttribute('data-scene-preparation-phase')==='partial')throw new Error('CLASSIFICATION_PARTIAL_PREPARATION');
      return loading.pendingModelCount === 0 && loading.active.length === 0 && ['idle', 'ready'].includes(loading.environmentPhase)
        && !document.querySelector('[data-scene-preparation-phase]');
    }, null, { timeout: 600000, polling: 1000 });
    await page.setViewportSize({ width: 1920, height: 1080 }); await page.bringToFront();
    phase='ready-gate';await onStage(name+':strict-natural-ready-evidence');
    const copiedBefore=await copyClassificationPreparationTimings(page,report.errors);await fs.writeFile(path.join(root,'preparation-report-before.json'),JSON.stringify(copiedBefore,null,2),{flag:'wx'});
    report.readyBefore=await page.evaluate(readClassificationReadyReceipt,prepared.expectedReady);report.readyBefore.preparationTimings=copiedBefore.scenePreparation;
    await save();assertClassificationSceneReady(report.readyBefore,prepared.expectedReady);
    await onStage(name + ':ready-natural-warmup'); await page.waitForTimeout(30000);
    await page.evaluate(() => window.__phase2ClassificationAudit.runtime.scene.getEngine().setSize(1920, 1080)); await page.waitForTimeout(500);
    report.before = await page.evaluate(() => window.__phase2ClassificationAudit.describe());
    report.editingBefore = await page.evaluate(() => window.__phase2ClassificationAudit.describeEditing());
    assert.deepEqual(report.editingBefore, { telemetryPreviewActive: false, fetchConfigSnapshotSet: false, fetchSyncTimerActive: false, fetchInFlightOperations: 0 }, '必须保持编辑态而非偷偷进入运行预览');
    assert.equal(await page.getByRole('button', { name: '运行', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '停止', exact: true }).isEnabled(), false);
    assert.equal(report.before.originalConsumer, true, '本输入必须如实保留shadows consumer，不把N1追成可测');
    const capture = async label => {
      phase = 'functional'; await onStage(name + ':' + label);
      const result = await page.evaluate(captureClassificationFunction);
      for (const [field, file] of [['rgbaBase64', label + '.rgba'], ['matrixBase64', label + '.matrices.bin']]) {
        await fs.writeFile(path.join(root, file), Buffer.from(result[field], 'base64'), { flag: 'wx' }); delete result[field];
      }
      result.label = label; report.functions.push(result); await save(); return result;
    };
    const aa0 = await capture('pre-AA0'); await page.waitForTimeout(1000); const aa1 = await capture('pre-AA1');
    report.staticAA = equivalent(aa0, aa1);
    report.readyAtMeasurementStart=await page.evaluate(readClassificationReadyReceipt,prepared.expectedReady);
    report.readyAtMeasurementStart.preparationTimings=report.readyBefore.preparationTimings;
    assert.equal(report.readyAtMeasurementStart.preparationState.sceneSessionId,report.readyBefore.preparationState.sceneSessionId,'warmup/功能窗口准备代次变化');
    assert.equal(report.errors.length,0,'正式采样前已有未豁免错误');assert.equal(report.webSockets.length,0,'无MQTT条件出现WebSocket');
    await save();assertClassificationSceneReady(report.readyAtMeasurementStart,prepared.expectedReady);
    if (shadowCacheMode) {
      try { report.shadowAuditInstallation = await page.evaluate(installPhase2ShadowCacheAudit, { measurementScoped: true, exposeGlobal: true, maxRecords: shadowCacheProtocol.maxFaceRecords }); }
      catch (error) { report.shadowAuditInstallationError = String(error); }
    }
    phase = 'performance'; await onStage(name + ':60s-performance-no-readPixels-or-geometry');
    report.performance = await page.evaluate(measureClassificationWindow, { durationMs: 60000 }); phase = 'functional';
    if (shadowCacheMode) {
      try { report.shadowAudit = await page.evaluate(() => globalThis.__phase2ShadowCacheAudit?.dispose()); report.shadowMetadataBytes = Buffer.byteLength(JSON.stringify(report.shadowAudit ?? null)); }
      catch (error) { report.shadowAuditReadError = String(error); }
      await save();
    }
    report.performance.frameQuantiles = quantiles(report.performance.frameIntervalsMs);
    report.performance.longTaskQuantiles = quantiles(report.performance.longtasks.map(value => value.duration));
    report.readyAfterEvidence=await page.evaluate(readClassificationReadyReceipt,prepared.expectedReady);
    report.readyAfterEvidence.preparationTimings=report.readyBefore.preparationTimings;await save();assertClassificationSceneReady(report.readyAfterEvidence,prepared.expectedReady);
    const copiedAfter=await copyClassificationPreparationTimings(page,report.errors);await fs.writeFile(path.join(root,'preparation-report-after.json'),JSON.stringify(copiedAfter,null,2),{flag:'wx'});
    report.readyAfterEvidence=await page.evaluate(readClassificationReadyReceipt,prepared.expectedReady);report.readyAfterEvidence.preparationTimings=copiedAfter.scenePreparation;
    assert.equal(report.readyAfterEvidence.preparationState.sceneSessionId,report.readyBefore.preparationState.sceneSessionId,'性能窗口准备代次变化');
    await save();assertClassificationSceneReady(report.readyAfterEvidence,prepared.expectedReady);
    const post = await capture('post60s'); report.beforeAfterEquivalent = equivalent(aa1, post);
    report.after = await page.evaluate(() => window.__phase2ClassificationAudit.describe());
    report.editingAfter = await page.evaluate(() => window.__phase2ClassificationAudit.describeEditing());
    const current = report.after.runtime.loading;
    report.readyAfter = current.pendingModelCount === 0 && current.active.length === 0 && ['idle', 'ready'].includes(current.environmentPhase)
      && report.readyAfterEvidence.preparationTimings.completed===true&&report.readyAfterEvidence.preparationTimings.forcedSettled===false;
    report.functionalPass = report.staticAA && report.beforeAfterEquivalent && report.readyAfter && report.errors.length === 0 && report.webSockets.length === 0
      && isDeepStrictEqual(report.editingAfter, report.editingBefore)
      && report.functions.every(point => point.width === 1920 && point.height === 1080 && point.nonblankColorsAtLeast > 32 && point.actualGeometryMeshes > 0);
    report.measurementValid = report.performance.measurementValid && report.requestsDuringPerformance.length === 0;
    report.status = report.functionalPass && report.measurementValid ? 'PASS_CASE' : 'INCONCLUSIVE_OR_INVALID';
    if (shadowCacheMode) {
      const config = report.shadowAudit?.configuration;
      report.shadowConditionValid = config?.quality === plan.sourceShadowSettings.quality && config?.mode === 'hybrid' && config?.dynamicShadows === plan.sourceDynamicShadows && config?.cacheStaticShadows === (report.arm === 'B');
      if (!report.shadowConditionValid || report.shadowAudit?.status !== 'OBSERVED' || report.shadowMetadataBytes > shadowCacheProtocol.metadataBudgetBytesPerArm) report.status = 'INCONCLUSIVE_OR_INVALID';
    }
    await page.screenshot({ path: path.join(root, 'editor.png') });
  } catch (error) {
    report.failedPhase=phase;
    await preserveClassificationFailure(report,error,{save,
      readRuntime:()=>boundedClassificationRead(()=>page.evaluate(readClassificationFailureRuntime)),
      captureScreenshot:()=>page.screenshot({path:path.join(root,'failure.png'),timeout:5000})});
  }
  finally {
    phase = 'cleanup';
    if (shadowCacheMode) {
      try { if (page && !page.isClosed()) { const cleanup = await boundedClassificationRead(() => page.evaluate(() => globalThis.__phase2ShadowCacheAudit?.dispose())); if (cleanup) report.shadowCleanup = cleanup; } }
      catch (error) { report.shadowAuditCleanupError = String(error); }
    }
    try { if(page&&!page.isClosed())await boundedClassificationRead(()=>page.evaluate(()=>window.__phase2ClassificationAudit?.restore())); }
    catch(error){report.errors.push({kind:'restore',message:String(error)});report.status='FAIL';}
    try {
      if(owned){report.processClosure=await closeClassificationOwnedApplication(owned);report.ownedProcessExitCode=report.processClosure.mainExitCode;
        await fs.writeFile(path.join(root,'process-closure.json'),JSON.stringify(report.processClosure,null,2),{flag:'wx'});
        if(report.processClosure.closeError)report.errors.push({kind:'owned-close',message:report.processClosure.closeError});
        if(report.processClosure.status!=='OBSERVED_OWNED_PROCESSES_CLOSED'||report.processClosure.closeError)report.status='FAIL';}
      else if(app){await app.close();report.status='FAIL';report.errors.push({kind:'owned-identity',message:'main identity unavailable; close attempted, no PID identity claim'});}
    }catch(error){report.status='FAIL';report.errors.push({kind:'owned-close',message:String(error)});}
    await save();
  }
  return report;
}

async function execute(planFile, output, shadowCacheMode = false) {
  const planBytes = await fs.readFile(planFile), plan = JSON.parse(planBytes.toString('utf8'));
  if (shadowCacheMode) assert.deepEqual(plan.protocol, shadowCacheProtocol, '已冻结S2协议不符，不静默扩门槛');
  else assert.deepEqual(plan.protocol, protocol, '已冻结协议不符，不静默扩门槛');
  assert.equal(plan.status, 'PREREGISTERED_NOT_RUN');
  const original = await fs.readFile(plan.source); assert.equal(sha(original), plan.sourceSha256); assert.equal(plan.sourceSha256, SOURCE_SHA);
  const sourceDocument = JSON.parse(original.toString('utf8')), originalProject = path.dirname(path.dirname(plan.source));
  assert.equal(plan.readinessAcceptance?.version,2,'需要明确实体天空盒与严格就绪/资源预期，旧计划不能隐式放宽');
  const sourceScene=sourceDocument.scene,expectedModelIds=sourceScene.entityIds.filter(id=>sourceScene.entities[id]?.components.modelAsset&&!sourceScene.entities[id]?.components.modelArrayInstance).sort();
  if (shadowCacheMode) { assert.deepEqual(sourceScene.sceneSettings.lighting.shadows, plan.sourceShadowSettings); assert.equal(sourceScene.sceneSettings.lighting.bake.dynamicShadows ?? true, plan.sourceDynamicShadows); }
  const expectedInstanceIds=sourceScene.entityIds.filter(id=>sourceScene.entities[id]?.components.modelArrayInstance).sort();
  assert.deepEqual(expectedModelIds,plan.readinessAcceptance.modelIds);assert.deepEqual(expectedInstanceIds,plan.readinessAcceptance.instanceIds);
  assert.equal(path.basename(path.dirname(plan.source)).toLowerCase(), 'scenes');
  assert.equal(sha(Buffer.from(strictJson(sourceDocument.scene.entities[SCREEN_ID].components.dataPlatformScreen))), plan.exactScreenExclusion.sha256);
  assert.equal(sha(Buffer.from(strictJson(sourceDocument.scene.fetchConfig))), plan.fetchConfigSha256, 'Fetch配置不能删改');
  await ownNewDirectory(output);
  const report = { status: 'RUNNING', conditions: protocol.conditions, plan: path.resolve(planFile), planSha256: sha(planBytes), sourceSha256: sha(original),
    noMqttCondition: true, mqttReplay: 'NONE; no invented messages; NOT historical recording', n1: 'NOT_APPLICABLE_WITH_EXISTING_SHADOW_CONSUMER', cases: [], stages: [],
    repositoryPackageVersion: JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8')).version,
    nativeVersionCaveat: 'bootstrap app.getVersion may report Electron; repositoryPackageVersion and frozen build hashes bind the actual product code' };
  if (shadowCacheMode) { report.conditions = shadowCacheProtocol.conditions; delete report.n1; report.mode = 'shadow-cache'; }
  const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const stage = async text => { report.stages.push({ text, at: new Date().toISOString() }); console.log('[classification-abba]', text); await save(); };
  try {
    report.bindingBefore = await bindings(shadowCacheMode); report.originalAssetsBefore = await fileManifest(path.join(originalProject, 'Assets'));
    const environmentExpected=plan.readinessAcceptance.environment;
    assert.ok(environmentExpected&&Number.isSafeInteger(plan.readinessAcceptance.batchedEntities),'当前冻结输入必须有环境/批次数量预期');
    const environmentFile=report.originalAssetsBefore.find(row=>row.path.replaceAll('\\','/')===environmentExpected.sourceFileAssetsRelative);
    assert.equal(environmentFile?.sha256,environmentExpected.sourceFileSha256,'冻结环境实际文件SHA变化');
    assert.equal(environmentFile.bytes,environmentExpected.sourceFileBytes);
    const skyboxExpected=plan.readinessAcceptance.skybox;
    assert.ok(skyboxExpected&&inside(originalProject,skyboxExpected.sourcePath),'当前冻结输入必须有原工程实体天空盒');
    const skyboxFile=report.originalAssetsBefore.find(row=>row.path===path.relative(originalProject,skyboxExpected.sourcePath).slice('Assets'.length+1));
    assert.equal(skyboxFile?.sha256,skyboxExpected.sourceSha256,'冻结实体天空盒实际文件SHA变化');
    assert.equal(skyboxFile.bytes,skyboxExpected.sourceFileBytes);
    const assetBytes = report.originalAssetsBefore.reduce((sum, row) => sum + row.bytes, 0);
    assert.ok(assetBytes * 4 + 4 * 3 * 1920 * 1080 * 4 + 512 * 1024 ** 2 <= protocol.expectedOutputBudgetBytes, '完整四副本与功能产物静态预算超2GiB，不能少复制几何追通过');
    if (shadowCacheMode) assert.ok(assetBytes * 4 + 4 * 3 * 1920 * 1080 * 4 + 4 * shadowCacheProtocol.metadataBudgetBytesPerArm + 512 * 1024 ** 2 <= shadowCacheProtocol.expectedOutputBudgetBytes, 'S2完整四臂/元数据静态预算超2GiB，不改预算或删资源');
    const prepared = new Map();
    for (const name of protocol.sequence) {
      const project = path.join(output, name, 'project'); await fs.mkdir(project, { recursive: true });
      await fs.cp(path.join(originalProject, 'Assets'), path.join(project, 'Assets'), { recursive: true, force: false, errorOnExist: true,
        filter: async file => { assert.equal((await fs.lstat(file)).isSymbolicLink(), false); return true; } });
      assert.deepEqual(await fileManifest(path.join(project, 'Assets')), report.originalAssetsBefore);
      const document = rebase(structuredClone(sourceDocument), originalProject, project);
      document.scene.mqttConfig = { ...document.scene.mqttConfig, enabled: false, simulatorEnabled: false };
      delete document.scene.entities[SCREEN_ID].components.dataPlatformScreen;
      if (shadowCacheMode) applyShadowCacheTreatment(document, name);
      assert.equal(document.scene.entityIds.length, 383); assert.equal(Object.keys(document.scene.entities).length, 383);
      const scene = path.join(project, 'Scenes', 'classification-383.scene.json'); await fs.mkdir(path.dirname(scene));
      await fs.writeFile(scene, strictJson(document) + '\n', { flag: 'wx' });
      prepared.set(name,{project,scene,sceneSha256:sha(await fs.readFile(scene)),expectedReady:{sceneId:sourceScene.id,entityIds:[...sourceScene.entityIds],
        modelIds:expectedModelIds,instanceIds:expectedInstanceIds,batchedEntities:plan.readinessAcceptance.batchedEntities,
        environment:{...environmentExpected,sourceUrl:document.scene.sceneSettings.environment.activeVariantUrl},
        skybox:{...skyboxExpected,sourceUrl:document.scene.entities[skyboxExpected.entityId].components.skybox.sourceUrl}}});
    }
    for (const name of protocol.sequence) {
      await stage(name + ':starting-fresh-owned-process'); const result = await runCase(name, prepared.get(name), plan, output, stage, shadowCacheMode); report.cases.push(result); await save();
      assert.deepEqual(await bindings(shadowCacheMode), report.bindingBefore, '实际四窗口期间产品/构建/工具版本漂移');
      assert.equal(sha(await fs.readFile(prepared.get(name).scene)), prepared.get(name).sceneSha256, 'Owned场景被写入');
      if (result.status === 'FAIL') throw new Error(name + ' failed; no automatic replacement run');
    }
    const baseline = report.cases[0].functions[0];
    if (shadowCacheMode) {
      report.shadowFunctional = await compareShadowCacheFunctionalFiles(report.cases, output);
      report.functionalPass = report.shadowFunctional.pass && report.cases.every(row => row.functionalPass && isDeepStrictEqual(row.functions[0].renderer, baseline.renderer));
    } else report.functionalPass = report.cases.every(row => row.functionalPass && row.functions.every(point => equivalent(baseline, point))
      && isDeepStrictEqual(row.functions[0].renderer, baseline.renderer));
    report.measurementValid = report.cases.every(row => row.measurementValid);
    if (shadowCacheMode) {
      Object.assign(report, evaluateShadowCacheCases(report.cases, report.functionalPass, report.measurementValid));
    } else {
    report.n2Exercised = report.cases.filter(row => row.arm === 'B').some(row => row.performance.diagnostics.skipped.coalesced > 0)
      && report.cases.filter(row => row.arm === 'A').some(row => row.performance.calls.getSources.count > 0);
    const find = name => report.cases.find(row => row.name === name), pairs = [['A1', 'B1'], ['A2', 'B2']];
    report.pairs = pairs.map(([a, b]) => {
      const left = find(a).performance, right = find(b).performance;
      const normalized = value => ({ callsPerSecond: value.calls.getSources.count * 1000 / value.elapsedMs, sourceMsPerSecond: value.calls.getSources.totalMs * 1000 / value.elapsedMs, p95FrameMs: value.frameQuantiles.p95Ms });
      const A = normalized(left), B = normalized(right);
      return { a, b, A, B, directionalCostReduction: B.callsPerSecond <= A.callsPerSecond && B.sourceMsPerSecond < A.sourceMsPerSecond && B.p95FrameMs <= A.p95FrameMs * 1.05 };
    });
    report.performancePass = report.functionalPass && report.measurementValid && report.n2Exercised && report.pairs.every(pair => pair.directionalCostReduction);
    report.performancePassScope = 'observed N2 collection-cost direction under this one ABBA protocol; not robust FPS superiority or N1 proof';
    report.n3 = report.cases.filter(row => row.arm === 'B').map(row => {
      const perf = row.performance, source = perf.calls.getSources.totalMs, frame = perf.frameQuantiles.totalMs, tick = perf.calls.tick.totalMs;
      const msPerFrame = source / perf.frameIntervalsMs.length, frameShare = frame > 0 ? source / frame : null,
        tickShare = tick > 0 ? perf.calls.getSources.withinTickMs / tick : null;
      return { name: row.name, getSourcesMsPerFrame: msPerFrame, frameShare, tickShare,
        considerShadowImplementationOnly: report.functionalPass && report.measurementValid && ((msPerFrame >= 1 && frameShare >= .1) || tickShare >= .2), implemented: false };
    });
    report.status = report.performancePass ? 'PASS_OBSERVED_N2_ABBA_ONLY' : 'INCONCLUSIVE_OR_NO_DIRECTIONAL_BENEFIT';
    }
  } catch (error) { report.status = 'FAIL'; report.error = String(error.stack ?? error); }
  finally {
    report.originalSceneUnchanged = sha(await fs.readFile(plan.source)) === plan.sourceSha256;
    if (report.originalAssetsBefore) report.originalAssetsUnchanged = isDeepStrictEqual(await fileManifest(path.join(originalProject, 'Assets')), report.originalAssetsBefore);
    if (!report.originalSceneUnchanged || report.originalAssetsUnchanged === false) report.status = 'FAIL';
    report.finishedAt = new Date().toISOString(); await save(); console.log(JSON.stringify({ status: report.status, output, performancePass: report.performancePass, error: report.error }));
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { scene: { type: 'string' }, output: { type: 'string' }, plan: { type: 'string' }, execute: { type: 'boolean', default: false }, mode: { type: 'string', default: 'classification' } } });
  (async () => {
    assert.ok(values.output, '--output 必填且必须为全新目录');
    const output = path.resolve(values.output);
    assert.ok(['classification', 'shadow-cache'].includes(values.mode), '--mode只允许classification或shadow-cache');
    if (values.execute) { assert.ok(values.plan && !values.scene, '--execute 使用冻结--plan，不能换--scene'); const report = await execute(path.resolve(values.plan), output, values.mode === 'shadow-cache'); if (report.status === 'FAIL') process.exitCode = 1; }
    else { assert.ok(values.scene && !values.plan, '准备阶段提供--scene；不启动任何Editor');
      if (values.mode === 'shadow-cache') { await prepareShadowCachePlan(path.resolve(values.scene), output); console.log(JSON.stringify({ status: 'PREREGISTERED_NOT_RUN', mode: 'shadow-cache', plan: path.join(output, 'shadow-cache-plan.json') })); }
      else { await preparePlan(path.resolve(values.scene), output); console.log(JSON.stringify({ status: 'PREREGISTERED_NOT_RUN', plan: path.join(output, 'plan.json') })); }
    }
  })().catch(error => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
}
