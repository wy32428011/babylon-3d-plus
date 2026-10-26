import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import * as B from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';
import { prepareModelScriptCompilation } from '../electron/shared/modelScriptCompilation.ts';
import { createAssetRevision } from './lib/phase2AssetRevisions.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const variants = ['original', 'nodes', 'kernel', 'both'];

export function compileAsset(source) {
  const prepared = prepareModelScriptCompilation(source);
  const compiled = ts.transpileModule(prepared.sourceText, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, experimentalDecorators: true, useDefineForClassFields: false,
  }, reportDiagnostics: true });
  // 与产品编译入口一致：源码诊断才阻断；TS6的module=None选项弃用提示不等于源码错误。
  const errors = compiled.diagnostics?.filter(row => row.file && row.category === ts.DiagnosticCategory.Error) ?? [];
  assert.equal(errors.length, 0, '资产候选无法转译：' + errors.map(row => ts.flattenDiagnosticMessageText(row.messageText, '\n')).join('; '));
  return new Function('__babylon', '__decorator', compiled.outputText + '\n' + prepared.returnStatement)(B, () => () => undefined);
}

function numericBuffer(values) {
  if (!values) return null;
  if (values instanceof ArrayBuffer) return { byteLength: values.byteLength, sha256: hash(Buffer.from(values)) };
  if (ArrayBuffer.isView(values)) return { type: values.constructor.name, byteLength: values.byteLength,
    sha256: hash(Buffer.from(values.buffer, values.byteOffset, values.byteLength)) };
  const data = Float64Array.from(values);
  return { length: data.length, sha256: hash(Buffer.from(data.buffer)) };
}

/** CPU 几何/材质状态 oracle；真实图片解码和 GPU 像素须另由 Editor/Viewer 验收。 */
function captureState(scene, root, events, writes) {
  const nodes = [root, ...scene.transformNodes, ...scene.meshes]
    .filter((node, index, all) => all.indexOf(node) === index && (node === root || node.isDescendantOf(root)));
  const ordinals = new Map(nodes.map((node, index) => [node, index]));
  const normalizeMetadata = value => JSON.parse(JSON.stringify(value ?? {}, (key, data) => {
    if (['parametricOwnerNodeId'].includes(key)) return 'model-root';
    return typeof data === 'function' ? undefined : data;
  }));
  const materials = new Map();
  const materialState = material => {
    if (!material) return null;
    if (!materials.has(material)) materials.set(material, materials.size);
    return { identity: materials.get(material), class: material.getClassName(), alpha: material.alpha,
      albedo: material.albedoColor?.asArray(), diffuse: material.diffuseColor?.asArray(),
      metallic: material.metallic, roughness: material.roughness, useVertexColors: material.useVertexColors,
      backFaceCulling: material.backFaceCulling, transparencyMode: material.transparencyMode,
      subMaterials: material.subMaterials?.map(materialState) };
  };
  return { events: [...events], writes: { ...writes }, nodes: nodes.map(node => ({
    name: node.name, class: node.getClassName(), parent: node.parent === root.parent ? 'entity-root' : ordinals.get(node.parent),
    position: node.position?.asArray(), scaling: node.scaling?.asArray(), rotation: node.rotation?.asArray(), quaternion: node.rotationQuaternion?.asArray(),
    world: Array.from(node.computeWorldMatrix(true).m), enabled: node.isEnabled(), isVisible: node.isVisible,
    visibility: node.visibility, pickable: node.isPickable, metadata: normalizeMetadata(node.metadata),
    material: materialState(node.material), thinCount: node.thinInstanceCount,
    thinMatrix: numericBuffer(node._thinInstanceDataStorage?.matrixData),
    indices: typeof node.getIndices === 'function' ? numericBuffer(node.getIndices()) : null,
    // world0..3 是逐实例属性，不能用 getVerticesData 按 mesh 顶点数解读；保留原始buffer及布局更完整。
    vertices: Object.fromEntries((node.getVerticesDataKinds?.() ?? []).sort().map(kind => {
      const buffer = node.getVertexBuffer(kind);
      return [kind, { data: numericBuffer(buffer.getData()), type: buffer.type, size: buffer.getSize(),
        byteStride: buffer.byteStride, byteOffset: buffer.byteOffset, instanced: buffer.getIsInstanced(), divisor: buffer.instanceDivisor }];
    })),
  })) };
}

export async function runAssetCase(source, modelBytes, values, { noise = 3000, transform = false, update = true } = {}) {
  const engine = new B.NullEngine(), scene = new B.Scene(engine);
  let runtime;
  try {
    const container = await B.LoadAssetContainerAsync(new Uint8Array(modelBytes), scene,
      { pluginExtension: '.glb', pluginOptions: { gltf: { skipMaterials: true } } });
    container.addAllToScene();
    const entity = new B.TransformNode('entity-root', scene), root = new B.TransformNode('asset-root', scene);
    root.parent = entity;
    if (transform) { entity.scaling.set(-1.5, 0.75, 2); entity.rotation.set(0.1, -Math.PI / 2, 0.2); entity.position.set(17, 2, -9); }
    for (const imported of [...container.meshes, ...container.transformNodes]) if (!imported.parent) imported.parent = root;
    // CPU fixture保持 PBR颜色/共享关系与clone行为；原纹理像素不在此NullEngine范围内。
    const material = new B.PBRMaterial('oracle-material', scene); material.albedoColor.set(0.3, 0.5, 0.7);
    for (const mesh of container.meshes) if (mesh.getTotalVertices() > 0) mesh.material = material;
    let parent = null;
    for (let index = 0; index < noise; index++) {
      const node = new B.TransformNode('unrelated-' + index, scene);
      if (index % 5 === 0) parent = node; else node.parent = parent;
    }
    const injectedValues = { ...values };
    root.metadata = { scripts: [{ className: 'ParametricModelParamsComponent', values: { ...values }, instance: injectedValues }] };
    const exported = compileAsset(source);
    const Runtime = exported.classes.ParametricModelRuntimeComponent;
    assert.ok(Runtime, '未找到实际运行类');
    runtime = new Runtime(root);
    Object.assign(runtime, values);
    const events = [], writes = {};
    const watched = new WeakSet();
    const watch = node => {
      if (watched.has(node)) return; watched.add(node);
      for (const key of ['setVerticesData', 'refreshBoundingInfo', 'setEnabled', 'computeWorldMatrix']) {
        const original = node[key];
        if (typeof original !== 'function') continue;
        node[key] = function (...args) { writes[key] = (writes[key] ?? 0) + 1; return Reflect.apply(original, this, args); };
      }
    };
    for (const node of [...scene.transformNodes, ...scene.meshes]) watch(node);
    scene.onNewMeshAddedObservable.add(node => { events.push(['mesh+', node.name]); watch(node); });
    scene.onNewTransformNodeAddedObservable.add(node => { events.push(['node+', node.name]); watch(node); });
    scene.onMeshRemovedObservable.add(node => events.push(['mesh-', node.name]));
    scene.onTransformNodeRemovedObservable.add(node => events.push(['node-', node.name]));
    const started = performance.now(); runtime.onStart(); const onStartMs = performance.now() - started;
    const states = [captureState(scene, root, events, writes)];
    if (update) {
      runtime.onUpdate(); states.push(captureState(scene, root, events, writes));
      const changedValues = values.layerCount ? { ...values, showFeet: !values.showFeet, bodyColor: '#335577' }
        : { ...values, hasMotor: !values.hasMotor, mainColor: '#335577', width: values.width + 0.1 };
      Object.assign(injectedValues, changedValues); Object.assign(runtime, changedValues);
      runtime.onUpdate(); states.push(captureState(scene, root, events, writes));
      runtime.onStop(); states.push(captureState(scene, root, events, writes));
      runtime = null;
    }
    return { onStartMs, states };
  } finally { runtime?.onStop(); scene.dispose(); engine.dispose(); }
}

async function collectFiles(root) {
  return (await Promise.all((await readdir(root, { withFileTypes: true })).map(entry => entry.isDirectory()
    ? collectFiles(path.join(root, entry.name)) : [path.join(root, entry.name)]))).flat();
}

async function main() {
  const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
  assert.ok(args.includes('--project') && args.includes('--out'), '用法：node --experimental-transform-types scripts/phase2-asset-revisions.mjs --project <project> --out <new-output> [--bench]');
  const project = path.resolve(option('--project')), output = path.resolve(option('--out'));
  const files = await collectFiles(path.join(project, 'Assets', 'Models'));
  const sceneFile = (await collectFiles(path.join(project, 'Scenes'))).find(file => file.endsWith('.scene.json'));
  const document = JSON.parse(await readFile(sceneFile, 'utf8')).scene;
  await mkdir(output, { recursive: true });
  const report = { status: 'RUNNING', scope: 'new-revisions-only; NullEngine CPU geometry/material fixture; no GPU/texture/net claim',
    originalFilesUnchanged: true, models: [], failures: [] };
  for (const [modelKey, name] of [['motor', 'newgd-motor-optimized.model.ts'], ['shelf', 'newenergy-shelf.model.ts']]) {
    const sourcePath = files.find(file => path.basename(file) === name); assert.ok(sourcePath, name);
    const source = await readFile(sourcePath, 'utf8'), sourceSha256 = hash(source);
    const modelPath = files.find(file => path.dirname(file) === path.dirname(sourcePath) && file.endsWith('.glb'));
    const bytes = await readFile(modelPath);
    const model = { modelKey, sourcePath, sourceSha256, modelSha256: hash(bytes), variants: {}, cases: [] };
    const sources = { original: source };
    for (const variant of variants.slice(1)) {
      const revised = createAssetRevision(source, variant), folder = path.join(output, modelKey, variant);
      sources[variant] = revised; compileAsset(revised); await mkdir(folder, { recursive: true });
      const target = path.join(folder, name); await writeFile(target, revised, { flag: 'wx' });
      model.variants[variant] = { path: target, sha256: hash(revised) };
    }
    const entities = Object.values(document.entities).filter(entity => entity.components?.modelAsset?.scriptAssets?.some(script => script.name === name));
    const parameterCases = [entities[0].components.modelAsset.parameterValues,
      modelKey === 'motor' ? { ...entities[0].components.modelAsset.parameterValues, enablePlatform: true, width: 2.3, mainColor: '#000000' }
        : { ...entities[0].components.modelAsset.parameterValues, layerCount: 3, columnCount: 4, doubleDeepEnabled: true, showFeet: false }];
    for (let index = 0; index < parameterCases.length; index++) {
      const values = parameterCases[index], options = { noise: 3000, transform: index === 1 };
      const original = await runAssetCase(source, bytes, values, options);
      const result = { index, values, baselineMs: original.onStartMs, statesSha256: hash(JSON.stringify(original.states)), candidates: {} };
      for (const variant of variants.slice(1)) {
        try {
          const candidate = await runAssetCase(sources[variant], bytes, values, options);
          assert.deepEqual(candidate.states, original.states, `${modelKey}/${variant}/case-${index} 业务状态不同`);
          result.candidates[variant] = { functionalPass: true, onStartMs: candidate.onStartMs, statesSha256: hash(JSON.stringify(candidate.states)) };
        } catch (error) {
          result.candidates[variant] = { functionalPass: false, error: String(error) };
          report.failures.push({ modelKey, variant, case: index, error: String(error).slice(0, 6000) });
        }
      }
      model.cases.push(result);
      await writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, models: [...report.models, model] }, null, 2));
    }
    if (args.includes('--bench')) {
      model.benchmark = [];
      // 两次独立交错筛选，每次三对；功能oracle冻结在计时之前，所有结果保留。
      for (const variant of variants.slice(1).filter(variant => model.cases.every(row => row.candidates[variant].functionalPass))) {
        for (let block = 0; block < 2; block++) {
          const pairs = [];
          for (let pair = 0; pair < 3; pair++) {
            const order = pair % 2 ? [variant, 'original'] : ['original', variant], row = {};
            for (const arm of order) row[arm] = (await runAssetCase(sources[arm], bytes, parameterCases[0], { noise: 3000, update: false })).onStartMs;
            pairs.push(row);
          }
          const median = values => [...values].sort((a, b) => a - b)[1];
          const before = median(pairs.map(row => row.original)), after = median(pairs.map(row => row[variant]));
          model.benchmark.push({ variant, block, pairs, beforeMs: before, afterMs: after, changePercent: (after / before - 1) * 100 });
          await writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, models: [...report.models, model] }, null, 2));
        }
      }
    }
    report.originalFilesUnchanged &&= hash(await readFile(sourcePath)) === sourceSha256 && hash(await readFile(modelPath)) === model.modelSha256;
    report.models.push(model);
  }
  report.status = report.failures.length || !report.originalFilesUnchanged ? 'FAIL' : 'PASS';
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, originalFilesUnchanged: report.originalFilesUnchanged, failures: report.failures.length,
    models: report.models.map(model => ({ modelKey: model.modelKey, cases: model.cases, benchmark: model.benchmark })) }));
  if (report.failures.length || !report.originalFilesUnchanged) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
