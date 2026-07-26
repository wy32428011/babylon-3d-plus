import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  FreeCamera,
  LoadAssetContainerAsync,
  Matrix,
  NullEngine,
  Quaternion,
  Scene,
  SceneLoader,
  Vector3,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';
import { createServer } from 'vite';

if (typeof globalThis.OffscreenCanvas === 'undefined') {
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      const canvas = this;
      const gradient = { addColorStop() {} };
      return {
        canvas, fillStyle: '#000', strokeStyle: '#000', font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
        lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
        clearRect() {}, fillRect() {}, strokeRect() {}, rect() {}, clip() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, arcTo() {}, ellipse() {}, quadraticCurveTo() {}, bezierCurveTo() {}, fill() {}, stroke() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, transform() {}, setTransform() {}, resetTransform() {}, drawImage() {}, fillText() {}, strokeText() {}, setLineDash() {},
        measureText(text) { return { width: String(text).length * 10 }; },
        getImageData() { return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4), width: canvas.width, height: canvas.height }; },
        putImageData() {}, createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4), width, height }; },
        createLinearGradient() { return gradient; }, createRadialGradient() { return gradient; }, createPattern() { return null; },
      };
    }
  };
}

const workspace = process.cwd();
const modelRoot = path.resolve(process.env.BABYLON_MODEL_ROOT ?? process.argv[2] ?? path.join(workspace, '..', '3d-models', 'models'));
const scenePath = path.resolve(process.env.BABYLON_SCENE_PATH ?? process.argv[3] ?? String.raw`F:\3d-projects\Untitled Scene.scene(1).json`);
const configuredReportPath = process.env.BABYLON_MODEL_ARRAY_REPORT?.trim();
const assetModelRoot = path.join(modelRoot, 'Assets', 'Models');
const assetIndexPath = path.join(modelRoot, '.babylon-editor', 'asset-index.json');
const SSR_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 120_000;
const EXPECTED_PACKAGE_COUNT = 16;

let server;
let SceneRuntime;

const sceneFile = JSON.parse(await fs.readFile(scenePath, 'utf8'));
const sceneDocument = sceneFile.scene ?? sceneFile;
const sceneValuesByPackage = collectSceneValuesByPackage(sceneDocument);
const assetIndex = JSON.parse(await fs.readFile(assetIndexPath, 'utf8'));
assert.equal(assetIndex.version, 2, '模型资产索引版本必须为 2');
assert.ok(Array.isArray(assetIndex.assets), '模型资产索引缺少 assets 数组');

function collectSceneValuesByPackage(scene) {
  const result = new Map();
  for (const entity of Object.values(scene.entities ?? {})) {
    const modelAsset = entity?.components?.modelAsset;
    if (!modelAsset || entity.components?.modelArrayInstance || !modelAsset.parameterValues) continue;
    const sourcePath = String(modelAsset.sourcePath ?? modelAsset.sourceUrl ?? '').replace(/\\/g, '/').split('?')[0];
    const packageName = path.basename(path.dirname(sourcePath));
    if (!packageName) continue;
    const current = result.get(packageName);
    if (!current || parameterComplexity(modelAsset.parameterValues) > parameterComplexity(current)) {
      result.set(packageName, modelAsset.parameterValues);
    }
  }
  return result;
}

function parameterComplexity(values) {
  const factors = ['layerCount', 'columnCount', 'slotCountHeight', 'slotCountLength']
    .map((key) => Number(values?.[key]))
    .filter((value) => Number.isFinite(value) && value > 0);
  return factors.reduce((total, value) => total * value, 1) * (values?.doubleDeepEnabled ? 2 : 1);
}

function defaultValues(meta) {
  return Object.fromEntries((meta.modelParameters?.parameters ?? []).map((item) => [item.key, item.defaultValue]));
}

function createChangedValue(definition, defaults) {
  const current = Number(defaults[definition.key]);
  const config = definition.configuration ?? definition;
  const min = Number.isFinite(Number(config.min)) ? Number(config.min) : Number.NEGATIVE_INFINITY;
  const max = Number.isFinite(Number(config.max)) ? Number(config.max) : Number.POSITIVE_INFINITY;
  const isCount = /count|density/i.test(definition.key) && Number.isInteger(current);
  let next = isCount ? current + 1 : current * 1.2;
  if (!Number.isFinite(next) || Math.abs(next - current) < 1e-6) next = current + (Number(config.step) || 0.1);
  next = Math.min(max, Math.max(min, next));
  if (Math.abs(next - current) < 1e-6) next = Math.min(max, Math.max(min, current - (Number(config.step) || 0.1)));
  return Math.abs(next - current) < 1e-9 ? null : { ...defaults, [definition.key]: next };
}

function chooseChangedCandidates(meta, defaults, sceneValues) {
  const definitions = meta.modelParameters?.parameters ?? [];
  const candidates = [];
  const sceneCandidate = sceneValues ? { ...defaults, ...sceneValues } : null;
  const sceneChangedKeys = sceneCandidate
    ? definitions
      .filter((definition) => definition.type === 'number' && sceneCandidate[definition.key] !== defaults[definition.key])
      .map((definition) => definition.key)
    : [];
  if (sceneCandidate && sceneChangedKeys.length > 0) {
    candidates.push({ key: `scene-parameters:${sceneChangedKeys.join(',')}`, values: sceneCandidate });
  }

  const priorities = [
    'length', 'width', 'height', 'layerCount', 'columnCount', 'trackLength', 'bodyLength', 'bodyHeight',
    'platformLength', 'vehicleLength', 'vehicleWidth', 'carLength', 'carWidth', 'depth', 'slotLength',
    'slotWidth', 'slotHeight', 'rollerDensity',
  ];
  const numericDefinitions = definitions.filter((definition) => definition.type === 'number');
  const orderedDefinitions = [
    ...priorities.map((key) => numericDefinitions.find((definition) => definition.key === key)).filter(Boolean),
    ...numericDefinitions.filter((definition) => !priorities.includes(definition.key)),
  ];
  for (const definition of orderedDefinitions) {
    const values = createChangedValue(definition, defaults);
    if (values) candidates.push({ key: definition.key, values });
  }
  return candidates.filter((candidate, index) => (
    candidates.findIndex((item) => JSON.stringify(item.values) === JSON.stringify(candidate.values)) === index
  ));
}

function unitScaleToMeters(lengthUnit) {
  if (lengthUnit === 'millimeter') return 0.001;
  if (lengthUnit === 'centimeter') return 0.01;
  return 1;
}


function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePath(value) {
  return path.resolve(value).replace(/\\/g, '/').toLowerCase();
}

function modelScriptNames(meta) {
  return [...new Set([
    ...(meta.parameterScripts ?? []),
    ...(meta.animationScripts ?? []),
  ].map((item) => item?.scriptFilename).filter(Boolean))];
}

const VISUAL_FIXTURE_MIRRORS = {
  Shelf: ['output/playwright/shelf-assets/shelf.model.ts', 'output/playwright/shelf-assets/shelf.model.txt'],
  Stacker: ['output/playwright/stacker-assets/stacker.model.ts', 'output/playwright/stacker-assets/stacker.model.txt'],
  YZJ: ['output/playwright/yzj-assets/yzj.model.ts', 'output/playwright/yzj-assets/yzj.model.txt'],
};

async function verifyPackageSynchronization(packageName, meta, modelName) {
  const sourceRoot = path.join(modelRoot, packageName);
  const mirrorRoot = path.join(assetModelRoot, packageName);
  const files = ['meta.json', ...modelScriptNames(meta)];
  const fileResults = [];
  for (const file of files) {
    const sourcePath = path.join(sourceRoot, file);
    const mirrorPath = path.join(mirrorRoot, file);
    const [sourceBytes, mirrorBytes] = await Promise.all([fs.readFile(sourcePath), fs.readFile(mirrorPath)]);
    const sourceSha256 = sha256(sourceBytes);
    const mirrorSha256 = sha256(mirrorBytes);
    assert.equal(mirrorSha256, sourceSha256, `${packageName} 源包与 Assets/Models 的 ${file} 不一致`);
    fileResults.push({ file, sourceSha256, mirrorSha256 });
  }

  const asset = assetIndex.assets.find((item) => (
    item?.libraryKind === 'model' && normalizePath(item.packagePath) === normalizePath(mirrorRoot)
  ));
  assert.ok(asset, `${packageName} 缺少 Assets/Models 资产索引条目`);
  assert.ok(typeof asset.assetRevision === 'string' && asset.assetRevision.length > 0, `${packageName} 资产索引缺少 assetRevision`);
  assert.equal(normalizePath(asset.path), normalizePath(path.join(mirrorRoot, modelName)), `${packageName} 资产索引主模型路径不一致`);
  assert.equal(normalizePath(asset.metadataPath), normalizePath(path.join(mirrorRoot, 'meta.json')), `${packageName} 资产索引 meta 路径不一致`);
  assert.deepEqual(asset.parameterScriptMetadata ?? [], meta.parameterScripts ?? [], `${packageName} 资产索引参数脚本快照过期`);
  assert.deepEqual(asset.animationScriptMetadata ?? [], meta.animationScripts ?? [], `${packageName} 资产索引动画脚本快照过期`);
  assert.deepEqual(asset.parameterConfig ?? null, meta.modelParameters ?? null, `${packageName} 资产索引参数配置快照过期`);
  assert.deepEqual(asset.dataDrivenConfig ?? null, meta.dataDriven ?? null, `${packageName} 资产索引数据驱动快照过期`);
  assert.equal(asset.lengthUnit ?? 'meter', meta.lengthUnit ?? 'meter', `${packageName} 资产索引长度单位不一致`);
  assert.equal(Number(asset.unitScaleToMeters ?? 1), unitScaleToMeters(meta.lengthUnit), `${packageName} 资产索引单位缩放不一致`);

  const indexedScriptPaths = new Set((asset.scriptPaths ?? []).map(normalizePath));
  for (const scriptName of modelScriptNames(meta)) {
    assert.ok(indexedScriptPaths.has(normalizePath(path.join(mirrorRoot, scriptName))), `${packageName} 资产索引缺少脚本 ${scriptName}`);
  }

  const fixtureResults = [];
  for (const fixtureRelativePath of VISUAL_FIXTURE_MIRRORS[packageName] ?? []) {
    const sourceScriptName = modelScriptNames(meta)[0];
    assert.ok(sourceScriptName, `${packageName} 缺少可同步到视觉夹具的脚本`);
    const sourceBytes = await fs.readFile(path.join(sourceRoot, sourceScriptName));
    const fixturePath = path.join(workspace, fixtureRelativePath);
    const fixtureBytes = await fs.readFile(fixturePath);
    const sourceSha256 = sha256(sourceBytes);
    const fixtureSha256 = sha256(fixtureBytes);
    assert.equal(fixtureSha256, sourceSha256, `${packageName} 视觉夹具 ${fixtureRelativePath} 未同步`);
    fixtureResults.push({ path: fixturePath, sourceSha256, fixtureSha256 });
  }

  return {
    status: 'PASS',
    mirrorRoot,
    assetRevision: asset.assetRevision,
    files: fileResults,
    visualFixtures: fixtureResults,
  };
}

function createTransform(position = {}, rotation = {}, scale = {}) {
  return {
    position: { x: position.x ?? 0, y: position.y ?? 0, z: position.z ?? 0 },
    rotation: { x: rotation.x ?? 0, y: rotation.y ?? 0, z: rotation.z ?? 0 },
    scale: { x: scale.x ?? 1, y: scale.y ?? 1, z: scale.z ?? 1 },
  };
}

function createEntity(id, modelAsset, options = {}) {
  return {
    id,
    name: id,
    visible: options.visible !== false,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: options.transform ?? createTransform(),
      modelAsset: { ...modelAsset, parameterValues: { ...(options.values ?? modelAsset.parameterValues) }, assetCode: id },
      ...(options.telemetryBinding ? { telemetryBinding: { ...options.telemetryBinding } } : {}),
      ...(options.sourceEntityId ? { modelArrayInstance: { sourceEntityId: options.sourceEntityId } } : {}),
    },
  };
}

function documentFor(entities) {
  return {
    id: 'parametric-array-smoke',
    name: 'parametric-array-smoke',
    entityIds: entities.map((item) => item.id),
    entities: Object.fromEntries(entities.map((item) => [item.id, item])),
    selectedEntityId: null,
    mqttConfig: {},
    sceneSettings: {},
  };
}

function isGeometryMesh(mesh, ignoreAncestorDisable = false) {
  return !mesh.isDisposed()
    && mesh.getTotalVertices() > 0
    && mesh.isVisible
    && mesh.visibility > 0
    && mesh.isEnabled(!ignoreAncestorDisable);
}

function isEnabledWithinModelHost(mesh, modelRoot) {
  let current = mesh;
  while (current && current !== modelRoot) {
    if (current.isEnabled?.(false) === false) return false;
    current = current.parent;
  }
  return current === modelRoot ? true : mesh.isEnabled(true);
}

function isFinalModelHostMesh(mesh, model, scene) {
  if (!mesh || !model || !isGeometryMesh(mesh, true)) return false;
  if (!isEnabledWithinModelHost(mesh, model.root)) return false;
  return model.modelArrayBatch
    ? model.modelArraySuspendedMeshes.has(mesh)
    : scene.meshes.includes(mesh);
}

function matrixCount(mesh) {
  return Number(mesh.thinInstanceCount) > 0 ? Number(mesh.thinInstanceCount) : 1;
}

function emptyBounds() {
  return { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
}

function expandBounds(bounds, box, matrix) {
  for (const x of [box.minimum.x, box.maximum.x]) for (const y of [box.minimum.y, box.maximum.y]) for (const z of [box.minimum.z, box.maximum.z]) {
    const point = Vector3.TransformCoordinates(new Vector3(x, y, z), matrix);
    bounds.min.x = Math.min(bounds.min.x, point.x); bounds.min.y = Math.min(bounds.min.y, point.y); bounds.min.z = Math.min(bounds.min.z, point.z);
    bounds.max.x = Math.max(bounds.max.x, point.x); bounds.max.y = Math.max(bounds.max.y, point.y); bounds.max.z = Math.max(bounds.max.z, point.z);
  }
}

function expandMeshGeometryBounds(bounds, mesh, matrix) {
  const positions = mesh.getVerticesData?.('position');
  if (!positions || positions.length < 3) {
    expandBounds(bounds, (mesh.rawBoundingInfo ?? mesh.getBoundingInfo()).boundingBox, matrix);
    return;
  }
  const point = new Vector3();
  for (let offset = 0; offset + 2 < positions.length; offset += 3) {
    Vector3.TransformCoordinatesFromFloatsToRef(
      positions[offset],
      positions[offset + 1],
      positions[offset + 2],
      matrix,
      point,
    );
    bounds.min.x = Math.min(bounds.min.x, point.x);
    bounds.min.y = Math.min(bounds.min.y, point.y);
    bounds.min.z = Math.min(bounds.min.z, point.z);
    bounds.max.x = Math.max(bounds.max.x, point.x);
    bounds.max.y = Math.max(bounds.max.y, point.y);
    bounds.max.z = Math.max(bounds.max.z, point.z);
  }
}

function finishBounds(bounds) {
  if (!Number.isFinite(bounds.min.x)) return null;
  return {
    min: bounds.min,
    max: bounds.max,
    size: { x: bounds.max.x - bounds.min.x, y: bounds.max.y - bounds.min.y, z: bounds.max.z - bounds.min.z },
  };
}

function directBounds(meshes, relativeRoot = null) {
  const bounds = emptyBounds();
  let inverseRoot = null;
  if (relativeRoot) {
    relativeRoot.computeWorldMatrix(true);
    inverseRoot = relativeRoot.getWorldMatrix().clone();
    inverseRoot.invert();
  }
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    const meshWorld = mesh.getWorldMatrix().clone();
    if (Number(mesh.thinInstanceCount) > 0) {
      const matrices = mesh.thinInstanceGetWorldMatrices().slice(0, mesh.thinInstanceCount);
      for (const instance of matrices) {
        const world = instance.multiply(meshWorld);
        expandMeshGeometryBounds(bounds, mesh, inverseRoot ? world.multiply(inverseRoot) : world);
      }
    } else {
      expandMeshGeometryBounds(bounds, mesh, inverseRoot ? meshWorld.multiply(inverseRoot) : meshWorld);
    }
  }
  return finishBounds(bounds);
}

function batchEntityBounds(batch, entityId) {
  const entityIndex = batch?.getEntityIds().indexOf(entityId) ?? -1;
  if (entityIndex < 0) return null;
  const bounds = emptyBounds();
  for (const source of batch.sources ?? []) for (const internal of source.batches ?? []) {
    const matrices = internal.sourceMatrixBuffer ?? internal.matrixBuffer;
    const indexes = internal.sourceEntityIndexBuffer ?? internal.entityIndexBuffer;
    if (!matrices || !indexes) continue;
    internal.mesh.computeWorldMatrix(true);
    const meshWorld = internal.mesh.getWorldMatrix();
    for (let index = 0; index < indexes.length; index += 1) {
      if (indexes[index] === entityIndex) {
        expandMeshGeometryBounds(bounds, internal.mesh, Matrix.FromArray(matrices, index * 16).multiply(meshWorld));
      }
    }
  }
  return finishBounds(bounds);
}

function transformMatrix(transform) {
  return Matrix.Compose(
    new Vector3(transform.scale.x, transform.scale.y, transform.scale.z),
    Quaternion.RotationYawPitchRoll(transform.rotation.y, transform.rotation.x, transform.rotation.z),
    new Vector3(transform.position.x, transform.position.y, transform.position.z),
  );
}

function transformedHostBounds(model, scene, entityTransform) {
  const meshes = (model?.meshes ?? []).filter((mesh) => isFinalModelHostMesh(mesh, model, scene));
  const bounds = emptyBounds();
  model.root.computeWorldMatrix(true);
  const inverseRoot = model.root.getWorldMatrix().clone();
  inverseRoot.invert();
  const targetWorld = transformMatrix(entityTransform);
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    const meshWorld = mesh.getWorldMatrix().clone();
    const sourceWorldMatrices = Number(mesh.thinInstanceCount) > 0
      ? mesh.thinInstanceGetWorldMatrices().slice(0, mesh.thinInstanceCount).map((matrix) => matrix.multiply(meshWorld))
      : [meshWorld];
    for (const sourceWorld of sourceWorldMatrices) {
      expandMeshGeometryBounds(bounds, mesh, sourceWorld.multiply(inverseRoot).multiply(targetWorld));
    }
  }
  return finishBounds(bounds);
}

function colorSignature(color) {
  if (!color) return null;
  const values = ['r', 'g', 'b', 'a']
    .filter((key) => Number.isFinite(Number(color[key])))
    .map((key) => Number(color[key]).toFixed(6));
  return values.length > 0 ? values.join(',') : null;
}

function textureSignature(texture) {
  const rawUrl = String(texture?.url ?? '').split('?')[0];
  const url = rawUrl.replace(/^data:[^#]+(#image\d+)$/u, 'data:$1');
  const name = String(texture?.name ?? '').replace(/_\d{10,}$/u, '_runtime');
  return JSON.stringify({
    className: texture?.getClassName?.() ?? texture?.constructor?.name ?? 'Texture',
    source: url || name,
    hasAlpha: texture?.hasAlpha === true,
    getAlphaFromRGB: texture?.getAlphaFromRGB === true,
    coordinatesIndex: Number(texture?.coordinatesIndex ?? 0),
    coordinatesMode: Number(texture?.coordinatesMode ?? 0),
    level: Number(texture?.level ?? 1),
    uOffset: Number(texture?.uOffset ?? 0),
    vOffset: Number(texture?.vOffset ?? 0),
    uScale: Number(texture?.uScale ?? 1),
    vScale: Number(texture?.vScale ?? 1),
    uAng: Number(texture?.uAng ?? 0),
    vAng: Number(texture?.vAng ?? 0),
    wAng: Number(texture?.wAng ?? 0),
    wrapU: Number(texture?.wrapU ?? 1),
    wrapV: Number(texture?.wrapV ?? 1),
    wrapR: Number(texture?.wrapR ?? 1),
    gammaSpace: texture?.gammaSpace !== false,
    samplingMode: Number(texture?.samplingMode ?? 0),
    anisotropicFilteringLevel: Number(texture?.anisotropicFilteringLevel ?? 0),
    invertY: texture?.invertY === true,
    noMipmap: texture?.noMipmap === true,
  });
}

function materialSignature(material) {
  if (!material) return 'none';
  const textures = typeof material.getActiveTextures === 'function'
    ? material.getActiveTextures().map(textureSignature).sort()
    : [];
  return JSON.stringify({
    className: material.getClassName?.() ?? material.constructor?.name ?? 'Material',
    alphaMode: material.alphaMode ?? null,
    backFaceCulling: material.backFaceCulling !== false,
    cullBackFaces: material.cullBackFaces !== false,
    sideOrientation: material.sideOrientation ?? null,
    transparencyMode: material.transparencyMode ?? null,
    disableDepthWrite: material.disableDepthWrite === true,
    forceDepthWrite: material.forceDepthWrite === true,
    separateCullingPass: material.separateCullingPass === true,
    fillMode: material.fillMode ?? null,
    diffuseColor: colorSignature(material.diffuseColor),
    albedoColor: colorSignature(material.albedoColor),
    ambientColor: colorSignature(material.ambientColor),
    reflectivityColor: colorSignature(material.reflectivityColor),
    reflectionColor: colorSignature(material.reflectionColor),
    emissiveColor: colorSignature(material.emissiveColor),
    metallicReflectanceColor: colorSignature(material.metallicReflectanceColor),
    metallic: material.metallic ?? null,
    roughness: material.roughness ?? null,
    microSurface: material.microSurface ?? null,
    indexOfRefraction: material.indexOfRefraction ?? null,
    directIntensity: material.directIntensity ?? null,
    emissiveIntensity: material.emissiveIntensity ?? null,
    environmentIntensity: material.environmentIntensity ?? null,
    specularIntensity: material.specularIntensity ?? null,
    textureCount: textures.length,
    textures,
  });
}

function scriptInstanceCount(model) {
  return model?.externalScriptRuntime?.instances?.length ?? 0;
}

function hostMetrics(model, scene) {
  const meshes = (model?.meshes ?? []).filter((mesh) => isFinalModelHostMesh(mesh, model, scene));
  const materials = new Set();
  let vertices = 0;
  let indices = 0;
  for (const mesh of meshes) {
    const count = matrixCount(mesh);
    vertices += mesh.getTotalVertices() * count;
    indices += mesh.getTotalIndices() * count;
    materials.add(materialSignature(mesh.material));
  }
  return {
    meshCount: meshes.length,
    vertices,
    indices,
    materials: [...materials].sort(),
    bounds: directBounds(meshes),
    localBounds: directBounds(meshes, model?.root ?? null),
    meshUniqueIds: meshes.map((mesh) => mesh.uniqueId).sort((a, b) => a - b),
  };
}

function batchMetrics(batch, entityId, model, scene) {
  let vertices = 0;
  let indices = 0;
  let carryingBatchCount = 0;
  const materials = new Set();
  const coveredMeshIds = new Set();
  const materialIdentityFailures = [];
  const materialReferenceFailures = [];
  const drawFailures = [];
  const details = [];
  const entityIndex = batch?.getEntityIds().indexOf(entityId) ?? -1;
  for (const source of batch?.sources ?? []) {
    const renderableSourceMeshes = (source.sourceMeshes ?? []).filter((mesh) => (
      isFinalModelHostMesh(mesh, model, scene)
    ));
    if (renderableSourceMeshes.length === 0) continue;

    let entityMatrixCount = 0;
    let outputVertices = 0;
    let outputIndices = 0;
    const internalDetails = [];
    for (const internal of source.batches ?? []) {
      const indexes = internal.sourceEntityIndexBuffer ?? internal.entityIndexBuffer;
      if (!indexes || entityIndex < 0) continue;
      let internalEntityMatrixCount = 0;
      for (const index of indexes) if (index === entityIndex) internalEntityMatrixCount += 1;
      if (internalEntityMatrixCount === 0) continue;

      const output = internal.mesh;
      carryingBatchCount += 1;
      entityMatrixCount += internalEntityMatrixCount;
      const outputMaterialSignature = materialSignature(output?.material);
      if (output?.material !== source.sourceMesh?.material) {
        materialReferenceFailures.push({
          sourceMeshId: source.sourceMesh?.uniqueId ?? -1,
          batchMeshId: output?.uniqueId ?? -1,
        });
      }
      const totalVertices = Number(output?.getTotalVertices?.() ?? 0);
      const totalIndices = Number(output?.getTotalIndices?.() ?? 0);
      const matrixBuffer = internal.sourceMatrixBuffer ?? internal.matrixBuffer;
      const drawableSubMesh = (output?.subMeshes ?? []).some((subMesh) => (
        totalIndices > 0 ? Number(subMesh.indexCount) > 0 : Number(subMesh.verticesCount) > 0
      ));
      if (
        !output
        || totalVertices <= 0
        || !matrixBuffer
        || matrixBuffer.length < indexes.length * 16
        || !drawableSubMesh
        || (totalIndices === 0 && output.isUnIndexed !== true)
        || (totalIndices > 0 && output.isUnIndexed === true)
      ) {
        drawFailures.push({
          batchMeshId: Number(output?.uniqueId ?? -1),
          orientation: internal.orientation ?? null,
          partitionIndex: internal.partitionIndex ?? null,
          totalVertices,
          totalIndices,
          subMeshCount: output?.subMeshes?.length ?? 0,
          isUnIndexed: output?.isUnIndexed === true,
          matrixCount: internalEntityMatrixCount,
          matrixBufferLength: matrixBuffer?.length ?? 0,
          expectedMatrixBufferLength: indexes.length * 16,
        });
      }
      for (const mesh of renderableSourceMeshes) {
        if (materialSignature(mesh.material) !== outputMaterialSignature) {
          materialIdentityFailures.push({ sourceMeshId: mesh.uniqueId, batchMeshId: output?.uniqueId ?? -1 });
        }
      }

      const internalVertices = totalVertices * internalEntityMatrixCount;
      const internalIndices = totalIndices * internalEntityMatrixCount;
      vertices += internalVertices;
      indices += internalIndices;
      outputVertices += internalVertices;
      outputIndices += internalIndices;
      materials.add(outputMaterialSignature);
      internalDetails.push({
        batchMeshId: output?.uniqueId ?? -1,
        orientation: internal.orientation ?? null,
        partitionIndex: internal.partitionIndex ?? null,
        sourceCount: internalEntityMatrixCount,
        outputVertices: internalVertices,
        outputIndices: internalIndices,
        subMeshCount: output?.subMeshes?.length ?? 0,
        isUnIndexed: output?.isUnIndexed === true,
      });
    }

    if (entityMatrixCount === 0) continue;
    for (const mesh of renderableSourceMeshes) coveredMeshIds.add(mesh.uniqueId);
    details.push({
      sourceMeshIds: renderableSourceMeshes.map((mesh) => mesh.uniqueId),
      rootLocalGeometryBaked: source.rootLocalGeometryBaked,
      sourceCount: entityMatrixCount,
      directVertices: renderableSourceMeshes.reduce((sum, mesh) => sum + mesh.getTotalVertices() * matrixCount(mesh), 0),
      outputVertices,
      directIndices: renderableSourceMeshes.reduce((sum, mesh) => sum + mesh.getTotalIndices() * matrixCount(mesh), 0),
      outputIndices,
      internalBatches: internalDetails,
    });
  }
  return {
    sourceCount: batch?.sources?.length ?? 0,
    batchMeshCount: batch?.meshes?.length ?? 0,
    carryingBatchCount,
    vertices,
    indices,
    materials: [...materials].sort(),
    coveredMeshIds: [...coveredMeshIds].sort((a, b) => a - b),
    materialIdentityFailures,
    materialReferenceFailures,
    drawFailures,
    details,
    bounds: batchEntityBounds(batch, entityId),
    failure: '',
  };
}

function boundsTolerance(bounds) {
  if (!bounds) return 0.0001;
  const maximumSize = Math.max(bounds.size.x, bounds.size.y, bounds.size.z);
  return Math.max(0.0001, maximumSize * 0.00001);
}

function boundsDelta(left, right) {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  return Math.max(...['x', 'y', 'z'].flatMap((axis) => [
    Math.abs(left.min[axis] - right.min[axis]),
    Math.abs(left.max[axis] - right.max[axis]),
  ]));
}

function stableMetrics(metrics) {
  return {
    meshCount: metrics.meshCount,
    vertices: metrics.vertices,
    indices: metrics.indices,
    materials: metrics.materials,
    bounds: metrics.bounds,
  };
}

function localStableMetrics(metrics) {
  return {
    meshCount: metrics.meshCount,
    vertices: metrics.vertices,
    indices: metrics.indices,
    materials: metrics.materials,
    bounds: metrics.localBounds,
  };
}

function assertHostEquivalent(label, left, right, options = {}) {
  const boundsKey = options.boundsKey ?? 'localBounds';
  assert.equal(left.meshCount, right.meshCount, `${label} Mesh 数量不一致`);
  assert.equal(left.vertices, right.vertices, `${label} 顶点贡献不一致`);
  assert.equal(left.indices, right.indices, `${label} 索引贡献不一致`);
  assert.deepEqual(left.materials, right.materials, `${label} 材质/贴图覆盖不一致`);
  const leftBounds = left[boundsKey];
  const rightBounds = right[boundsKey];
  const delta = options.compareOrigin === false
    ? Math.max(...['x', 'y', 'z'].map((axis) => Math.abs(leftBounds.size[axis] - rightBounds.size[axis])))
    : boundsDelta(leftBounds, rightBounds);
  assert.ok(
    delta <= boundsTolerance(rightBounds),
    `${label} 包围盒误差 ${delta} 超过容差 ${boundsTolerance(rightBounds)}`,
  );
}

function hasMeaningfulMetricChange(left, right) {
  return left.vertices !== right.vertices
    || left.indices !== right.indices
    || JSON.stringify(left.materials) !== JSON.stringify(right.materials)
    || boundsDelta(left.localBounds, right.localBounds) > boundsTolerance(left.localBounds);
}

function assertEquivalent(label, direct, batched, options = {}) {
  const diagnostics = JSON.stringify(batched.details?.filter((item) => (
    item.directVertices !== item.outputVertices || item.directIndices !== item.outputIndices
  )) ?? []);
  assert.equal(batched.vertices, direct.vertices, `${label} 顶点贡献不一致；批次差异=${diagnostics}`);
  assert.equal(batched.indices, direct.indices, `${label} 索引贡献不一致；批次差异=${diagnostics}`);
  assert.deepEqual(batched.materials, direct.materials, `${label} 材质/贴图覆盖不一致`);
  assert.deepEqual(batched.materialReferenceFailures, [], `${label} 阵列批次未引用当前脚本宿主的最终材质对象`);
  assert.deepEqual(batched.materialIdentityFailures, [], `${label} 阵列批次材质/贴图完整属性与脚本宿主不一致`);
  assert.deepEqual(batched.drawFailures, [], `${label} 阵列批次缺少可绘制 SubMesh 或无索引绘制标记`);
  assert.deepEqual(batched.coveredMeshIds, direct.meshUniqueIds, `${label} 存在未进入阵列批次的 Mesh`);
  if (options.compareBounds !== false) {
    const delta = boundsDelta(direct.bounds, batched.bounds);
    assert.ok(delta <= boundsTolerance(direct.bounds), `${label} 包围盒误差 ${delta} 超过容差 ${boundsTolerance(direct.bounds)}`);
  }
}


function assertEntityBatchEquivalent(label, direct, batched, model, scene, entityTransform) {
  assertEquivalent(label, direct, batched, { compareBounds: false });
  const expectedBounds = transformedHostBounds(model, scene, entityTransform);
  const delta = boundsDelta(expectedBounds, batched.bounds);
  assert.ok(
    delta <= boundsTolerance(expectedBounds),
    `${label} 实例包围盒误差 ${delta} 超过容差 ${boundsTolerance(expectedBounds)}；expected=${JSON.stringify(expectedBounds)}；batched=${JSON.stringify(batched.bounds)}`,
  );
}

async function waitReady(runtime, sourceId, instanceIds = [], timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const source = runtime.models.get(sourceId);
    const sourceReady = source?.measurementReady && source.externalScriptStarting === false;
    const batchesReady = instanceIds.every((entityId) => runtime.resolveModelArrayBatchForEntityId(entityId));
    const variantsReady = [...runtime.modelArrayParameterVariants.values()].every((variant) => (
      variant.model.measurementReady && variant.model.externalScriptStarting === false && variant.model.modelArrayBatch
    ));
    if (sourceReady && batchesReady && variantsReady) return source;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${sourceId} 等待模型/阵列/参数宿主就绪超时`);
}

async function runPackageLifecycle(spec, defaults, changedCandidates) {
  const engine = new NullEngine({ renderWidth: 1024, renderHeight: 768, textureSize: 512 });
  const scene = new Scene(engine);
  const camera = new FreeCamera('camera', new Vector3(5, 5, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  const originalLoad = SceneLoader.LoadAssetContainerAsync;
  SceneLoader.LoadAssetContainerAsync = async () => LoadAssetContainerAsync(spec.glbBytes, scene, { pluginExtension: '.glb', name: spec.modelName });
  const logs = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((value) => value instanceof Error ? value.stack ?? value.message : String(value)).join(' '));
    originalWarn(...args);
  };
  const runtime = new SceneRuntime(scene, (message) => logs.push(message));
  const sourceId = `${spec.packageName}-source`;
  const instanceIds = [`${spec.packageName}-array-a`, `${spec.packageName}-array-b`, `${spec.packageName}-array-c`];
  const makeAsset = (values) => ({
    sourcePath: spec.glbPath,
    sourceUrl: `audit://${encodeURIComponent(spec.packageName)}/${encodeURIComponent(spec.modelName)}`,
    // data: URL 不能再追加 assetRevision 查询串，否则 Node fetch 会把查询串当成 base64 内容。
    assetCode: `${spec.packageName}-source`,
    lengthUnit: spec.meta.lengthUnit ?? 'meter',
    unitScaleToMeters: unitScaleToMeters(spec.meta.lengthUnit),
    scriptAssets: [{ path: spec.scriptPath, sourceUrl: `data:text/plain;base64,${Buffer.from(spec.scriptText).toString('base64')}`, name: spec.scriptName }],
    parameterScriptMetadata: spec.meta.parameterScripts,
    animationScriptMetadata: spec.meta.animationScripts,
    parameterConfig: spec.meta.modelParameters,
    parameterValues: values,
    dataDrivenConfig: spec.meta.dataDriven,
  });
  const sourceEntity = (values, visible = true) => createEntity(sourceId, makeAsset(values), { values, visible });
  const arrayEntities = (sourceValues, variantValues = sourceValues, variantTelemetryBinding = null) => [
    createEntity(instanceIds[0], makeAsset(sourceValues), {
      values: sourceValues,
      sourceEntityId: sourceId,
      transform: createTransform({ x: 5, y: 0, z: 0 }),
    }),
    createEntity(instanceIds[1], makeAsset(variantValues), {
      values: variantValues,
      sourceEntityId: sourceId,
      telemetryBinding: variantTelemetryBinding,
      transform: createTransform({ x: -4, y: 0.5, z: 3 }, { y: Math.PI / 2 }, { x: 1.2, y: 0.8, z: 1.1 }),
    }),
    createEntity(instanceIds[2], makeAsset(sourceValues), {
      values: sourceValues,
      sourceEntityId: sourceId,
      transform: createTransform({ x: 0, y: 0, z: -5 }, { y: Math.PI / 6 }, { x: -1, y: 1, z: 1 }),
    }),
  ];

  try {
    runtime.sync(documentFor([sourceEntity(defaults)]));
    await waitReady(runtime, sourceId);
    scene.render();
    const defaultModel = runtime.models.get(sourceId);
    const directDefault = hostMetrics(defaultModel, scene);
    assert.ok(directDefault.meshCount > 0 && directDefault.vertices > 0 && directDefault.bounds, `${spec.packageName} 默认参数没有可渲染几何`);
    assert.ok(scriptInstanceCount(defaultModel) > 0, `${spec.packageName} 参数化脚本没有成功启动`);

    let changedSelection = null;
    let directChanged = null;
    for (const candidate of changedCandidates) {
      runtime.sync(documentFor([sourceEntity(candidate.values)]));
      await waitReady(runtime, sourceId);
      scene.render();
      const changedModel = runtime.models.get(sourceId);
      const candidateMetrics = hostMetrics(changedModel, scene);
      assert.ok(candidateMetrics.meshCount > 0 && candidateMetrics.vertices > 0 && candidateMetrics.bounds, `${spec.packageName} 参数 ${candidate.key} 修改后没有可渲染几何`);
      assert.ok(scriptInstanceCount(changedModel) > 0, `${spec.packageName} 参数 ${candidate.key} 修改后脚本未保持运行`);
      if (hasMeaningfulMetricChange(directDefault, candidateMetrics)) {
        changedSelection = candidate;
        directChanged = candidateMetrics;
        break;
      }
    }
    assert.ok(changedSelection && directChanged, `${spec.packageName} 所有数值参数修改后都没有可检测的几何或材质变化`);
    const changedValues = changedSelection.values;

    runtime.sync(documentFor([sourceEntity(changedValues)]));
    await waitReady(runtime, sourceId);
    scene.render();
    const repeatedDirectChanged = hostMetrics(runtime.models.get(sourceId), scene);
    assertHostEquivalent(`${spec.packageName} 相同参数重复同步`, repeatedDirectChanged, directChanged);

    const defaultArrayEntityList = arrayEntities(defaults);
    runtime.sync(documentFor([sourceEntity(defaults), ...defaultArrayEntityList]));
    await waitReady(runtime, sourceId, instanceIds);
    scene.render();
    const arrayHostDefault = hostMetrics(runtime.models.get(sourceId), scene);
    assertHostEquivalent(`${spec.packageName} 创建阵列前默认宿主`, arrayHostDefault, directDefault);
    const baseBatchDefault = batchMetrics(runtime.resolveModelArrayBatchForEntityId(sourceId), sourceId, runtime.models.get(sourceId), scene);
    assertEquivalent(`${spec.packageName} 默认参数阵列`, arrayHostDefault, baseBatchDefault);
    for (const instanceEntity of defaultArrayEntityList) {
      const batch = runtime.resolveModelArrayBatchForEntityId(instanceEntity.id);
      const renderModel = runtime.models.get(sourceId);
      const metrics = batchMetrics(batch, instanceEntity.id, renderModel, scene);
      assertEntityBatchEquivalent(
        `${spec.packageName} ${instanceEntity.id} 默认阵列`,
        arrayHostDefault,
        metrics,
        renderModel,
        scene,
        instanceEntity.components.transform,
      );
    }

    runtime.beginTelemetryPreview();
    scene.render();
    const runtimePreviewHost = hostMetrics(runtime.models.get(sourceId), scene);
    assertEquivalent(
      `${spec.packageName} 运行预览脚本更新后阵列`,
      runtimePreviewHost,
      batchMetrics(runtime.resolveModelArrayBatchForEntityId(sourceId), sourceId, runtime.models.get(sourceId), scene),
    );
    runtime.endTelemetryPreview();
    scene.render();
    const editRestoredHost = hostMetrics(runtime.models.get(sourceId), scene);
    assertEquivalent(
      `${spec.packageName} 结束运行预览后阵列`,
      editRestoredHost,
      batchMetrics(runtime.resolveModelArrayBatchForEntityId(sourceId), sourceId, runtime.models.get(sourceId), scene),
    );

    // 相同参数默认继续共享宿主；只有显式启用的遥测绑定才按设备身份隔离，
    // 避免不同 assetCode 的运行态状态错误复用，同时不把普通大阵列拆成逐实例宿主。
    const telemetryBinding = {
      enabled: true,
      sourceId: 'model-array-smoke',
      deviceType: 'model-array-smoke',
      assetCode: instanceIds[1],
      expectedIntervalMs: 500,
      staleAfterMs: 2_000,
      channelOverrides: {},
    };
    const telemetryArrayEntityList = arrayEntities(defaults, defaults, telemetryBinding);
    runtime.sync(documentFor([sourceEntity(defaults), ...telemetryArrayEntityList]));
    await waitReady(runtime, sourceId, instanceIds);
    scene.render();
    const telemetryVariant = runtime.modelArrayParameterVariantByEntityId.get(instanceIds[1]);
    assert.ok(telemetryVariant, `${spec.packageName} 显式遥测绑定未创建独立参数宿主`);
    assert.equal(telemetryVariant.representativeEntityId, instanceIds[1], `${spec.packageName} 遥测宿主代表实体错误`);
    assert.equal(telemetryVariant.entities.length, 1, `${spec.packageName} 遥测宿主不得合并未绑定实例`);
    assert.deepEqual(telemetryVariant.model.telemetryBinding, telemetryBinding, `${spec.packageName} 遥测宿主未保留实体绑定`);
    assert.equal(runtime.modelArrayParameterVariantByEntityId.has(instanceIds[0]), false, `${spec.packageName} 未绑定实例 A 被错误拆分`);
    assert.equal(runtime.modelArrayParameterVariantByEntityId.has(instanceIds[2]), false, `${spec.packageName} 未绑定实例 C 被错误拆分`);
    const telemetryBaseBatch = runtime.resolveModelArrayBatchForEntityId(sourceId);
    assert.ok(telemetryBaseBatch && !telemetryBaseBatch.getEntityIds().includes(instanceIds[1]), `${spec.packageName} 遥测实例仍错误进入共享基础批次`);
    const telemetryVariantHost = hostMetrics(telemetryVariant.model, scene);
    assertHostEquivalent(`${spec.packageName} 显式遥测独立宿主`, telemetryVariantHost, directDefault, { compareOrigin: false });
    assertEquivalent(
      `${spec.packageName} 显式遥测独立宿主阵列`,
      telemetryVariantHost,
      batchMetrics(runtime.resolveModelArrayBatchForEntityId(instanceIds[1]), instanceIds[1], telemetryVariant.model, scene),
    );

    const changedArrayEntityList = arrayEntities(changedValues, defaults);
    runtime.sync(documentFor([sourceEntity(changedValues), ...changedArrayEntityList]));
    await waitReady(runtime, sourceId, instanceIds);
    scene.render();
    const arrayHostChanged = hostMetrics(runtime.models.get(sourceId), scene);
    assertHostEquivalent(`${spec.packageName} 阵列后参数修改宿主`, arrayHostChanged, directChanged);
    const baseBatchChanged = batchMetrics(runtime.resolveModelArrayBatchForEntityId(sourceId), sourceId, runtime.models.get(sourceId), scene);
    assertEquivalent(`${spec.packageName} 阵列后参数修改`, arrayHostChanged, baseBatchChanged);
    const variant = runtime.modelArrayParameterVariantByEntityId.get(instanceIds[1]);
    const variantHostMetrics = hostMetrics(variant?.model, scene);
    const variantBatch = runtime.resolveModelArrayBatchForEntityId(instanceIds[1]);
    const variantMetrics = batchMetrics(variantBatch, instanceIds[1], variant?.model, scene);
    // 参数变体由独立 GLB 容器加载，归一化中心可能有亚毫米浮点漂移；此处比较局部尺寸，
    // 真实实例的完整 min/max 仍由下一行宿主与批次的同实体断言严格校验。
    assertHostEquivalent(`${spec.packageName} 独立参数宿主`, variantHostMetrics, directDefault, { compareOrigin: false });
    assertEquivalent(`${spec.packageName} 独立参数宿主阵列`, variantHostMetrics, variantMetrics);
    assert.ok(runtime.modelArrayParameterVariants.size >= 1, `${spec.packageName} 不同参数未创建独立宿主`);
    for (const instanceEntity of changedArrayEntityList) {
      const activeVariant = runtime.modelArrayParameterVariantByEntityId.get(instanceEntity.id);
      const renderModel = activeVariant?.model ?? runtime.models.get(sourceId);
      const renderHostMetrics = activeVariant ? hostMetrics(activeVariant.model, scene) : arrayHostChanged;
      const metrics = batchMetrics(runtime.resolveModelArrayBatchForEntityId(instanceEntity.id), instanceEntity.id, renderModel, scene);
      assertEntityBatchEquivalent(
        `${spec.packageName} ${instanceEntity.id} 阵列后参数修改`,
        renderHostMetrics,
        metrics,
        renderModel,
        scene,
        instanceEntity.components.transform,
      );
    }

    runtime.sync(documentFor([sourceEntity(changedValues), ...changedArrayEntityList]));
    await waitReady(runtime, sourceId, instanceIds);
    scene.render();
    const repeatedArrayHostChanged = hostMetrics(runtime.models.get(sourceId), scene);
    assertHostEquivalent(`${spec.packageName} 阵列后相同参数重复同步宿主`, repeatedArrayHostChanged, arrayHostChanged);
    assertEquivalent(
      `${spec.packageName} 阵列后相同参数重复同步批次`,
      repeatedArrayHostChanged,
      batchMetrics(runtime.resolveModelArrayBatchForEntityId(sourceId), sourceId, runtime.models.get(sourceId), scene),
    );
    const repeatedVariant = runtime.modelArrayParameterVariantByEntityId.get(instanceIds[1]);
    const repeatedVariantHost = hostMetrics(repeatedVariant?.model, scene);
    assertHostEquivalent(`${spec.packageName} 独立参数宿主重复同步`, repeatedVariantHost, variantHostMetrics, { compareOrigin: false });
    assertEquivalent(
      `${spec.packageName} 独立参数宿主阵列重复同步`,
      repeatedVariantHost,
      batchMetrics(runtime.resolveModelArrayBatchForEntityId(instanceIds[1]), instanceIds[1], repeatedVariant?.model, scene),
    );

    const remainingArrayEntities = arrayEntities(changedValues, changedValues).slice(0, 2);
    const removedInstanceId = instanceIds[2];
    runtime.sync(documentFor([sourceEntity(changedValues), ...remainingArrayEntities]));
    await waitReady(runtime, sourceId, instanceIds.slice(0, 2));
    scene.render();
    assert.equal(runtime.modelArrayParameterVariants.size, 0, `${spec.packageName} 参数恢复后未合并批次`);
    assert.equal(runtime.modelArrayInstanceEntities.has(removedInstanceId), false, `${spec.packageName} 已移除阵列实例仍保留在运行时实体表`);
    assert.equal(runtime.resolveModelArrayBatchForEntityId(removedInstanceId), null, `${spec.packageName} 已移除阵列实例仍可解析到旧批次`);
    const remainingBatch = runtime.resolveModelArrayBatchForEntityId(sourceId);
    assert.ok(remainingBatch, `${spec.packageName} 移除单个实例后剩余阵列批次丢失`);
    assert.deepEqual(
      [...remainingBatch.getEntityIds()].sort(),
      [sourceId, ...instanceIds.slice(0, 2)].sort(),
      `${spec.packageName} 移除单个实例后批次逻辑实体集合不准确`,
    );
    for (const remainingEntityId of [sourceId, ...instanceIds.slice(0, 2)]) {
      assert.equal(runtime.resolveModelArrayBatchForEntityId(remainingEntityId), remainingBatch, `${spec.packageName} 剩余实体未映射到同一批次`);
    }

    runtime.sync(documentFor([sourceEntity(defaults)]));
    await waitReady(runtime, sourceId);
    scene.render();
    const restored = hostMetrics(runtime.models.get(sourceId), scene);
    assert.equal(runtime.models.get(sourceId)?.modelArrayBatch, null, `${spec.packageName} 取消阵列后仍残留批次`);
    assert.equal(runtime.models.get(sourceId)?.modelArraySuspendedMeshes.size, 0, `${spec.packageName} 取消阵列后宿主 Mesh 未恢复`);
    assertHostEquivalent(`${spec.packageName} 取消阵列后默认模型`, restored, directDefault);
    assert.ok(scriptInstanceCount(runtime.models.get(sourceId)) > 0, `${spec.packageName} 取消阵列后参数化脚本未恢复`);

    const failureLogs = [...logs, ...warnings].filter((message) => (
      /模型(?:加载|脚本|参数|矩阵阵列).*失败/i.test(message)
      || /创建模型阵列矩阵批次失败/i.test(message)
    ));
    assert.deepEqual(failureLogs, [], `${spec.packageName} 生命周期存在失败日志`);

    return {
      status: 'PASS',
      changedKey: changedSelection.key,
      direct: { default: directDefault, changed: directChanged },
      array: {
        default: baseBatchDefault,
        changed: baseBatchChanged,
        parameterVariant: variantMetrics,
      },
      lifecycle: {
        direct: true,
        parameter: true,
        array: true,
        parameterAfterArray: true,
        runtimeScript: true,
        telemetryBindingIsolation: true,
        restore: true,
      },
      logs,
      warnings,
    };
  } finally {
    console.warn = originalWarn;
    runtime.dispose();
    SceneLoader.LoadAssetContainerAsync = originalLoad;
    scene.dispose();
    engine.dispose();
  }
}

const allPackageNames = (await fs.readdir(modelRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !['Assets', '.babylon-editor'].includes(entry.name))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
assert.equal(allPackageNames.length, EXPECTED_PACKAGE_COUNT, `模型包数量必须为 ${EXPECTED_PACKAGE_COUNT}`);
const focusedPackageName = process.env.BABYLON_MODEL_ARRAY_PACKAGE?.trim();
const packageNames = focusedPackageName
  ? allPackageNames.filter((packageName) => packageName === focusedPackageName)
  : allPackageNames;
assert.ok(packageNames.length > 0, `未找到指定模型包：${focusedPackageName}`);
const fullRun = packageNames.length === allPackageNames.length;
const focusedReportSuffix = focusedPackageName
  ? `-${focusedPackageName.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'model'}`
  : '';
const reportPath = path.resolve(configuredReportPath ?? path.join(
  workspace,
  'output',
  'model-array-validation',
  `structural-report${focusedReportSuffix}.json`,
));

const results = [];
try {
  server = await createServer({
    configFile: false,
    root: workspace,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  let timeoutId;
  ({ SceneRuntime } = await Promise.race([
    server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts'),
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`SceneRuntime SSR 加载超时（${SSR_TIMEOUT_MS}ms）`)), SSR_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timeoutId)));

  for (const packageName of packageNames) {
    console.log(`[model-array-package:start] ${packageName}`);
    const startedAt = Date.now();
    try {
      const packageRoot = path.join(modelRoot, packageName);
      const meta = JSON.parse(await fs.readFile(path.join(packageRoot, 'meta.json'), 'utf8'));
      const scriptName = meta.parameterScripts?.[0]?.scriptFilename ?? meta.animationScripts?.[0]?.scriptFilename;
      const declaredModelName = meta.parameterScripts?.[0]?.modelFilename ?? meta.animationScripts?.[0]?.modelFilename;
      const files = await fs.readdir(packageRoot);
      const modelName = files.includes(declaredModelName)
        ? declaredModelName
        : files.find((file) => /\.(?:glb|gltf)$/i.test(file) && !/\.bak/i.test(file));
      assert.ok(scriptName && files.includes(scriptName), `${packageName} 缺少参数化脚本`);
      assert.ok(modelName, `${packageName} 缺少 GLB/GLTF`);
      const glbPath = path.join(packageRoot, modelName);
      const scriptPath = path.join(packageRoot, scriptName);
      const [glbBytes, scriptText] = await Promise.all([fs.readFile(glbPath), fs.readFile(scriptPath, 'utf8')]);
      const assetSync = await verifyPackageSynchronization(packageName, meta, modelName);
      const defaults = defaultValues(meta);
      const changedCandidates = chooseChangedCandidates(meta, defaults, sceneValuesByPackage.get(packageName));
      assert.ok(changedCandidates.length > 0, `${packageName} 缺少可用于阵列验证的数值参数`);
      const result = await runPackageLifecycle({
        packageName, meta, modelName, scriptName, glbPath, scriptPath, glbBytes, scriptText,
      }, defaults, changedCandidates);
      results.push({ packageName, scriptName, durationMs: Date.now() - startedAt, assetSync, ...result });
      console.log(`[model-array-package:pass] ${packageName} ${Date.now() - startedAt}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      results.push({ packageName, status: 'FAIL', durationMs: Date.now() - startedAt, error: message });
      console.error(`[model-array-package:fail] ${packageName}\n${message}`);
    }
  }

  const failures = results.filter((result) => result.status !== 'PASS');
  const report = {
    status: failures.length > 0 ? 'FAIL' : fullRun ? 'PASS' : 'PARTIAL',
    mode: fullRun ? 'full' : 'focused',
    generatedAt: new Date().toISOString(),
    modelRoot,
    assetModelRoot,
    assetIndexPath,
    scenePath,
    packageCount: allPackageNames.length,
    executedPackageCount: packageNames.length,
    passCount: results.length - failures.length,
    failCount: failures.length,
    results,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...report, results: results.map(({ packageName, status, durationMs, error }) => ({ packageName, status, durationMs, error })) }, null, 2));
  assert.equal(failures.length, 0, `存在 ${failures.length} 个模型包未通过，详见 ${reportPath}`);
  if (fullRun) assert.equal(report.executedPackageCount, report.packageCount, '全量结构报告必须执行全部 16 个模型包');
} finally {
  await server?.close();
}
