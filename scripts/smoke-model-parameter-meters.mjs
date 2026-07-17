import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  LoadAssetContainerAsync,
  MeshBuilder,
  NullEngine,
  Scene,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';
import ts from 'typescript';
import { createServer } from 'vite';

const MODEL_ROOT = path.resolve(
  process.env.BABYLON_MODEL_ROOT ?? path.join(process.cwd(), '..', '3d-models', 'models'),
);
const ASSET_MODEL_ROOT = path.join(MODEL_ROOT, 'Assets', 'Models');
const ASSET_INDEX_PATH = path.join(MODEL_ROOT, '.babylon-editor', 'asset-index.json');
const NON_UNIFORM_SCALE = { x: 2, y: 3, z: 4 };
const SSR_MODULE_LOAD_TIMEOUT_MS = 60_000;
const MAX_REASONABLE_MODEL_SIZE_METERS = Number(process.env.BABYLON_MAX_REASONABLE_MODEL_SIZE_METERS ?? 100);

const MODEL_SPECS = [
  {
    name: '多穿小车',
    script: 'multi-shuttle.model.ts',
    lengthUnit: 'centimeter',
    linearKeys: ['vehicleLength', 'forkGap'],
    customValues: { vehicleLength: 1.2, forkGap: 0.8, count: 2 },
  },
  {
    name: '辊道机',
    script: 'roller-conveyor.model.ts',
    lengthUnit: 'meter',
    linearKeys: ['length', 'width', 'height', 'rollerWidth'],
    customValues: { length: 1.5, width: 1, height: 0.7, rollerWidth: 0.8, rollerDensity: 12 },
  },
  {
    name: '链条机',
    script: 'chain-conveyor.model.ts',
    lengthUnit: 'meter',
    linearKeys: ['chainLength', 'chainWidth', 'chainPosition'],
    customValues: { chainLength: 2.2, chainWidth: 1.5, chainPosition: 0.3 },
  },
  {
    name: 'box',
    script: 'box.model.ts',
    lengthUnit: 'centimeter',
    linearKeys: ['length', 'width', 'height'],
    customValues: { length: 0.5, width: 0.3, height: 0.25 },
  },
  {
    name: 'GD_有电机_Optimized(1)',
    script: 'gd-motor-optimized.model.ts',
    lengthUnit: 'centimeter',
    linearKeys: ['length', 'width', 'height', 'rollerWidth'],
    customValues: { length: 4, width: 1.5, height: 1.3, rollerWidth: 4 },
  },
  {
    name: 'HCTS',
    script: 'hcts.model.ts',
    lengthUnit: 'centimeter',
    linearKeys: ['bodyLength', 'bodyWidth', 'bodyHeight'],
    customValues: { bodyLength: 2.5, bodyWidth: 1.9, bodyHeight: 6 },
  },
  {
    name: 'LED',
    script: 'led.model.ts',
    lengthUnit: 'meter',
    linearKeys: ['length', 'width', 'height'],
    customValues: { length: 1.5, width: 0.1, height: 2 },
  },
  {
    name: 'RGV',
    script: 'rgv.model.ts',
    lengthUnit: 'meter',
    linearKeys: ['trackWidth'],
    customValues: { trackWidth: 0.35, workMode: 'dual' },
  },
  {
    name: 'Shelf',
    script: 'shelf.model.ts',
    lengthUnit: 'millimeter',
    linearKeys: ['cellWidth', 'cellHeight', 'supportLegHeight', 'cellDepth', 'postWidth', 'deepSlotGap', 'deepSlotLift'],
    customValues: {
      layerCount: 2,
      columnCount: 2,
      cellWidth: 1.2,
      cellHeight: 5,
      supportLegHeight: 1,
      cellDepth: 1.5,
      postWidth: 0.1,
      doubleDeepEnabled: true,
      deepSlotGap: 0.3,
      deepSlotLift: 0.15,
    },
  },
  {
    name: 'Stacker',
    script: 'stacker.model.ts',
    lengthUnit: 'millimeter',
    linearKeys: ['bodyLength', 'bodyWidth', 'bodyHeight', 'platformLength', 'platformHeight', 'forkLength', 'forkStageOneReach', 'forkStageTwoReach', 'forkGap'],
    colorKey: 'appearanceColor',
    defaultColor: '#ffffff',
    customValues: {
      bodyLength: 25,
      bodyWidth: 0.6,
      bodyHeight: 9,
      platformLength: 1.5,
      platformHeight: 1.8,
      forkLength: 1.1,
      forkStageOneReach: 1,
      forkStageTwoReach: 1,
      forkGap: 0.8,
      appearanceColor: '#3366ff',
    },
  },
  {
    name: 'WLTS',
    script: 'wlts.model.ts',
    lengthUnit: 'centimeter',
    linearKeys: ['radius', 'height', 'width', 'frontSupportHeight', 'rearSupportHeight'],
    customValues: { radius: 1.6, height: 6, width: 1.4, frontSupportHeight: 1.2, rearSupportHeight: 1.2 },
  },
  {
    name: 'YZJ',
    script: 'yzj.model.ts',
    lengthUnit: 'centimeter',
    linearKeys: ['chainLength', 'platformLength', 'platformPosition', 'chainWidth', 'chainHeight', 'rollerWidth', 'rollerPosition'],
    customValues: {
      chainLength: 2.4,
      platformLength: 1.3,
      platformPosition: 0.25,
      chainWidth: 1.5,
      chainHeight: 1,
      rollerWidth: 0.08,
      rollerPosition: 0.15,
      rollerDensity: 4,
      showDirectionArrow: false,
    },
  },
];

const MODEL_FILTER = process.env.BABYLON_MODEL_FILTER?.trim();
const ACTIVE_MODEL_SPECS = MODEL_FILTER
  ? MODEL_SPECS.filter((spec) => spec.name === MODEL_FILTER)
  : MODEL_SPECS;
if (MODEL_FILTER) assert.equal(ACTIVE_MODEL_SPECS.length, 1, `未找到模型过滤项：${MODEL_FILTER}`);

/** 确认外部模型项目可用；清洁环境应显式设置 BABYLON_MODEL_ROOT。 */
async function assertModelRootAvailable() {
  try {
    await fs.access(MODEL_ROOT);
  } catch {
    throw new Error(`缺少外部模型根：${MODEL_ROOT}。请拉取相邻 3d-models 项目，或设置 BABYLON_MODEL_ROOT 后重试。`);
  }
}

/** 在限定时间内加载运行时模块，避免 Vite SSR 异常时 smoke 无限等待。 */
async function loadSsrModuleWithTimeout(server, modulePath) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule(modulePath),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Vite SSR 模块加载超时（${SSR_MODULE_LOAD_TIMEOUT_MS}ms）：${modulePath}`));
        }, SSR_MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 根据显式源单位返回编辑器内容根使用的标准米制缩放。 */
function getUnitScaleToMeters(lengthUnit) {
  if (lengthUnit === 'centimeter') return 0.01;
  if (lengthUnit === 'millimeter') return 0.001;
  return 1;
}

/** 读取模型参数配置中的默认值。 */
function createDefaultParameterValues(metadata) {
  return Object.fromEntries(
    (metadata.modelParameters?.parameters ?? []).map((parameter) => [parameter.key, parameter.defaultValue]),
  );
}

/** 把实例参数写入脚本 metadata，复刻 SceneRuntime 的脚本同步边界。 */
function syncScriptMetadata(contentRoot, metadata, values, assetCode) {
  const scripts = (metadata.parameterScripts ?? []).map((script) => {
    const clonedScript = JSON.parse(JSON.stringify(script));
    const scriptValues = clonedScript.values && typeof clonedScript.values === 'object'
      ? { ...clonedScript.values }
      : {};
    for (const [key, value] of Object.entries(values)) {
      const previous = scriptValues[key] && typeof scriptValues[key] === 'object' ? scriptValues[key] : {};
      scriptValues[key] = { ...previous, value };
    }
    clonedScript.values = scriptValues;
    return clonedScript;
  });

  contentRoot.metadata = {
    ...(contentRoot.metadata ?? {}),
    assetCode,
    modelAsset: { assetCode },
    scripts,
  };
}

/** 把 GLB 顶层导入节点挂到 contentRoot，保留包内层级。 */
function parentTopLevelModelNodes(container, contentRoot) {
  const importedNodes = new Set([...container.meshes, ...container.transformNodes]);
  for (const node of importedNodes) {
    if (!node.parent || !importedNodes.has(node.parent)) node.parent = contentRoot;
  }
}

/** 判断 Mesh 是否应参与模型归一化、参数基线和实际尺寸。 */
function isActiveModelGeometry(mesh) {
  return !mesh.isDisposed()
    && mesh.isEnabled(false)
    && mesh.isVisible
    && mesh.visibility > 0
    && mesh.getTotalVertices() > 0;
}

/** 收集模型当前有效 Mesh 使用的材质引用和颜色，验证实例隔离与生命周期。 */
function collectMaterialSnapshot(contentRoot) {
  const materials = new Set();
  const colors = [];
  for (const mesh of contentRoot.getChildMeshes(false)) {
    if (!isActiveModelGeometry(mesh) || !mesh.material) continue;
    const candidates = Array.isArray(mesh.material.subMaterials)
      ? mesh.material.subMaterials.filter(Boolean)
      : [mesh.material];
    for (const material of candidates) {
      materials.add(material);
      const color = material.albedoColor ?? material.diffuseColor;
      colors.push({
        meshName: mesh.name,
        materialName: material.name,
        color: color?.toHexString?.().toLowerCase() ?? null,
      });
    }
  }
  return { materials, colors };
}

/** 校验所有有效模型材质都使用指定颜色。 */
function assertMaterialColor(snapshot, expectedColor, message) {
  assert.ok(snapshot.colors.length > 0, `${message}: 未找到有效材质`);
  const normalizedExpected = expectedColor.toLowerCase();
  for (const entry of snapshot.colors) {
    assert.equal(entry.color, normalizedExpected, `${message}: ${entry.meshName}/${entry.materialName}`);
  }
}

/** 按引用比较两组材质，确保参数更新复用克隆并在停止时恢复原材质。 */
function assertMaterialSetEqual(actual, expected, message) {
  assert.equal(actual.size, expected.size, `${message}: 材质数量不同`);
  for (const material of expected) {
    assert.ok(actual.has(material), `${message}: 材质引用不一致`);
  }
}

/** 注入超大隐藏/禁用辅助几何，验证它们不会污染归一化或参数脚本基线。 */
function createIgnoredGeometryHelpers(scene, contentRoot) {
  const helperRoot = new TransformNode('__meter_smoke_auxiliary_root', scene);
  helperRoot.parent = contentRoot;

  const hiddenHelper = MeshBuilder.CreateBox('__meter_smoke_masked_geometry', { size: 1_000 }, scene);
  hiddenHelper.parent = helperRoot;
  hiddenHelper.position.copyFromFloats(10_000, 10_000, 10_000);
  hiddenHelper.isVisible = false;

  const disabledHelper = MeshBuilder.CreateBox('__meter_smoke_off_geometry', { size: 1_000 }, scene);
  disabledHelper.parent = helperRoot;
  disabledHelper.position.copyFromFloats(-10_000, -10_000, -10_000);
  disabledHelper.setEnabled(false);
}

/** 按正式运行时规则把模型底部中心归一到实体根原点。 */
function normalizeModelContentOrigin(root) {
  root.computeWorldMatrix(true);
  const childMeshes = root.getChildMeshes(false).filter(isActiveModelGeometry);
  if (childMeshes.length === 0) return;

  let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  for (const mesh of childMeshes) {
    mesh.computeWorldMatrix(true);
    mesh.refreshBoundingInfo();
    const box = mesh.getBoundingInfo().boundingBox;
    minimum = Vector3.Minimize(minimum, box.minimumWorld);
    maximum = Vector3.Maximize(maximum, box.maximumWorld);
  }

  const bottomCenter = new Vector3((minimum.x + maximum.x) / 2, minimum.y, (minimum.z + maximum.z) / 2);
  const localBottomCenter = Vector3.TransformCoordinates(bottomCenter, root.getWorldMatrix().clone().invert());
  for (const child of root.getChildren()) {
    if (child instanceof TransformNode) child.position.subtractInPlace(localBottomCenter);
  }
}

/** 读取所有有效 mesh 在实体根米空间 Z 轴上的极值来源。 */
function collectMeterZExtremes(root, contentRoot) {
  const inverseRoot = root.computeWorldMatrix(true).clone().invert();
  const rows = [];
  for (const mesh of contentRoot.getChildMeshes(false)) {
    if (mesh.getTotalVertices() <= 0 || !mesh.isEnabled(false) || !mesh.isVisible || mesh.visibility <= 0) continue;
    mesh.computeWorldMatrix(true);
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
      const meterPoint = Vector3.TransformCoordinates(corner, inverseRoot);
      minimum = Math.min(minimum, meterPoint.z);
      maximum = Math.max(maximum, meterPoint.z);
    }
    rows.push({ name: mesh.name, minimum, maximum });
  }
  return {
    minimum: rows.reduce((best, row) => row.minimum < best.minimum ? row : best, { name: '', minimum: Number.POSITIVE_INFINITY, maximum: 0 }),
    maximum: rows.reduce((best, row) => row.maximum > best.maximum ? row : best, { name: '', minimum: 0, maximum: Number.NEGATIVE_INFINITY }),
  };
}
/** 收集参数脚本生成节点在实体根米空间中的包围盒，供失败诊断使用。 */
function collectGeneratedMeterBounds(root, contentRoot) {
  const inverseRoot = root.computeWorldMatrix(true).clone().invert();
  const results = [];
  for (const mesh of contentRoot.getChildMeshes(false)) {
    let current = mesh;
    let generated = false;
    while (current && current !== contentRoot) {
      if (current.metadata?.generatedByParametricRuntime) { generated = true; break; }
      current = current.parent;
    }
    if (!generated || mesh.getTotalVertices() <= 0) continue;
    mesh.computeWorldMatrix(true);
    let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
    for (const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
      const meterPoint = Vector3.TransformCoordinates(corner, inverseRoot);
      minimum = Vector3.Minimize(minimum, meterPoint);
      maximum = Vector3.Maximize(maximum, meterPoint);
    }
    results.push({ name: mesh.name, minimum, maximum });
  }
  return results;
}
/** 更新同一脚本实例的参数，并同时刷新 metadata 与注入属性。 */
function updateRuntimeValues(runtime, contentRoot, metadata, values, assetCode) {
  syncScriptMetadata(contentRoot, metadata, values, assetCode);
  runtime.updateParameterValues(values);
  runtime.update();
}

/** 比较两个数字，允许复杂 GLB 顶点运算产生小量浮点误差。 */
function assertClose(actual, expected, message, relativeTolerance = 2e-3) {
  const tolerance = Math.max(1e-5, Math.abs(expected) * relativeTolerance);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} !== ${expected}（容差 ${tolerance}）`);
}

/** 比较三轴尺寸。 */
function assertVectorClose(actual, expected, message, relativeTolerance = 2e-3) {
  assert.ok(actual && expected, `${message}: 缺少尺寸`);
  assertClose(actual.x, expected.x, `${message} X`, relativeTolerance);
  assertClose(actual.y, expected.y, `${message} Y`, relativeTolerance);
  assertClose(actual.z, expected.z, `${message} Z`, relativeTolerance);
}

/** 校验用户非均匀缩放只作为最终实体 Transform 叠加，不被参数脚本吸收。 */
function assertTransformScalePreserved(unitSize, scaledSize, message) {
  assertVectorClose(scaledSize, {
    x: unitSize.x * NON_UNIFORM_SCALE.x,
    y: unitSize.y * NON_UNIFORM_SCALE.y,
    z: unitSize.z * NON_UNIFORM_SCALE.z,
  }, message);
}

/** 校验模型实际尺寸保持在当前工业模型包的合理量级，避免归一化偏移被根缩放放大。 */
function assertReasonableModelSize(size, transformScale, message) {
  assert.ok(size, `${message}: 缺少尺寸`);
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Number.isFinite(size[axis]) && size[axis] > 0, `${message} ${axis.toUpperCase()} 必须为正有限数`);
    const scale = Math.max(1, Math.abs(Number(transformScale?.[axis] ?? 1)));
    const maximum = MAX_REASONABLE_MODEL_SIZE_METERS * scale;
    assert.ok(size[axis] <= maximum * (1 + 1e-6), `${message} ${axis.toUpperCase()} 超出合理上限：${size[axis]}m > ${maximum}m`);
  }
}

/** 判断参数变化后至少有一个轴的实际尺寸发生变化。 */
function hasMeaningfulSizeDifference(left, right) {
  return ['x', 'y', 'z'].some((axis) => Math.abs(left[axis] - right[axis]) > 1e-4);
}

/** 读取文件 SHA-256，用于验证源包、副本和可视夹具逐字节一致。 */
async function hashFile(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

/** 校验单个脚本可以被 TypeScript 正常转译。 */
async function assertScriptTranspiles(scriptPath) {
  const sourceText = await fs.readFile(scriptPath, 'utf8');
  const result = ts.transpileModule(sourceText, {
    fileName: scriptPath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      experimentalDecorators: true,
      useDefineForClassFields: false,
    },
  });
  const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `${scriptPath} 转译失败：${errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('; ')}`);
}

/** 校验 meta 中的显式源单位与所有线性参数米制标签。 */
function assertMetadataContract(spec, metadata) {
  assert.equal(metadata.lengthUnit, spec.lengthUnit, `${spec.name} 必须显式声明正确 lengthUnit`);
  const parameterMap = new Map((metadata.modelParameters?.parameters ?? []).map((parameter) => [parameter.key, parameter]));
  const fieldMap = new Map(
    (metadata.parameterScripts ?? []).flatMap((script) => script.fields ?? []).map((field) => [field.key, field]),
  );

  for (const key of spec.linearKeys) {
    const parameter = parameterMap.get(key);
    const field = fieldMap.get(key);
    assert.ok(parameter, `${spec.name}.${key} 缺少 modelParameters 定义`);
    assert.ok(field, `${spec.name}.${key} 缺少 parameterScripts 字段`);
    assert.equal(parameter.unit, 'm', `${spec.name}.${key} modelParameters.unit 必须为 m`);
    assert.match(parameter.label, /\(m\)$/, `${spec.name}.${key} Inspector 标签必须显式标记 (m)`);
    assert.equal(field.unit, 'm', `${spec.name}.${key} parameterScripts.unit 必须为 m`);
    assert.match(field.label, /\(m\)$/, `${spec.name}.${key} 脚本字段标签必须显式标记 (m)`);
  }

  if (spec.colorKey) {
    const parameter = parameterMap.get(spec.colorKey);
    const field = fieldMap.get(spec.colorKey);
    assert.ok(parameter, `${spec.name}.${spec.colorKey} 缺少 modelParameters 定义`);
    assert.ok(field, `${spec.name}.${spec.colorKey} 缺少 parameterScripts 字段`);
    assert.equal(parameter.type, 'color', `${spec.name}.${spec.colorKey} 必须使用 color 参数类型`);
    assert.equal(parameter.defaultValue, spec.defaultColor, `${spec.name}.${spec.colorKey} modelParameters 默认值错误`);
    assert.equal(field.defaultValue, spec.defaultColor, `${spec.name}.${spec.colorKey} parameterScripts 默认值错误`);
  }
}

/** 创建并运行一个模型参数化场景，返回默认、自定义及重复自定义尺寸。 */
async function runModelScenario({ spec, metadata, glbPath, scriptPath, rootTransform, ExternalModelScriptRuntime, measureModelSizeMeters, engine }) {
  const scene = new Scene(engine);
  const root = new TransformNode(`${spec.name}_entityRoot`, scene);
  root.position.copyFromFloats(rootTransform.position.x, rootTransform.position.y, rootTransform.position.z);
  root.rotation.copyFromFloats(rootTransform.rotation.x, rootTransform.rotation.y, rootTransform.rotation.z);
  root.scaling.copyFromFloats(rootTransform.scale.x, rootTransform.scale.y, rootTransform.scale.z);
  const contentRoot = new TransformNode(`${spec.name}_contentRoot`, scene);
  contentRoot.parent = root;
  const unitScale = getUnitScaleToMeters(spec.lengthUnit);
  contentRoot.scaling.copyFromFloats(unitScale, unitScale, unitScale);

  let runtime;
  try {
    const bytes = new Uint8Array(await fs.readFile(glbPath));
    const container = await LoadAssetContainerAsync(bytes, scene, { pluginExtension: '.glb', name: glbPath });
    container.addAllToScene();
    parentTopLevelModelNodes(container, contentRoot);
    if (spec.name === '辊道机') createIgnoredGeometryHelpers(scene, contentRoot);
    normalizeModelContentOrigin(root);

    const baselineSize = measureModelSizeMeters(root, contentRoot);
    const baselineMaterialSnapshot = spec.colorKey ? collectMaterialSnapshot(contentRoot) : null;
    const scriptText = await fs.readFile(scriptPath, 'utf8');
    const defaults = {
      ...createDefaultParameterValues(metadata),
      ...(spec.name === 'YZJ' ? { showDirectionArrow: false } : {}),
    };
    const customValues = { ...defaults, ...spec.customValues };
    const assetCode = `SMOKE-${spec.name}`;
    const modelAsset = {
      sourcePath: glbPath,
      sourceUrl: 'data:application/octet-stream,',
      assetCode,
      lengthUnit: spec.lengthUnit,
      unitScaleToMeters: unitScale,
      scriptAssets: [{
        path: scriptPath,
        sourceUrl: `data:text/plain;base64,${Buffer.from(scriptText).toString('base64')}`,
        name: spec.script,
      }],
      parameterScriptMetadata: metadata.parameterScripts,
      animationScriptMetadata: metadata.animationScripts,
      parameterConfig: metadata.modelParameters,
      parameterValues: defaults,
    };

    syncScriptMetadata(contentRoot, metadata, defaults, assetCode);
    runtime = new ExternalModelScriptRuntime(contentRoot, modelAsset);
    runtime.updateAssetCode(assetCode);
    runtime.updateParameterValues(defaults);
    await runtime.start();
    runtime.update();
    const defaultSize = measureModelSizeMeters(root, contentRoot);
    const defaultMaterialSnapshot = spec.colorKey ? collectMaterialSnapshot(contentRoot) : null;

    updateRuntimeValues(runtime, contentRoot, metadata, customValues, assetCode);
    const customSizeFirst = measureModelSizeMeters(root, contentRoot);
    const customMaterialSnapshot = spec.colorKey ? collectMaterialSnapshot(contentRoot) : null;
    updateRuntimeValues(runtime, contentRoot, metadata, defaults, assetCode);
    const resetMaterialSnapshot = spec.colorKey ? collectMaterialSnapshot(contentRoot) : null;
    let invalidMaterialSnapshot = null;
    if (spec.colorKey) {
      updateRuntimeValues(runtime, contentRoot, metadata, { ...customValues, [spec.colorKey]: 'invalid-color' }, assetCode);
      invalidMaterialSnapshot = collectMaterialSnapshot(contentRoot);
    }
    updateRuntimeValues(runtime, contentRoot, metadata, customValues, assetCode);
    const customSizeSecond = measureModelSizeMeters(root, contentRoot);
    const repeatedMaterialSnapshot = spec.colorKey ? collectMaterialSnapshot(contentRoot) : null;

    assert.ok(defaultSize, `${spec.name} 默认参数后不可测量`);
    assert.ok(customSizeFirst, `${spec.name} 自定义参数后不可测量`);
    assertReasonableModelSize(defaultSize, rootTransform.scale, `${spec.name} 默认参数实际尺寸`);
    assertReasonableModelSize(customSizeFirst, rootTransform.scale, `${spec.name} 自定义参数实际尺寸`);
    if (spec.expectSizeChange !== false) {
      assert.ok(hasMeaningfulSizeDifference(defaultSize, customSizeFirst), `${spec.name} 自定义参数未产生可观察尺寸变化`);
    }
    assertVectorClose(customSizeSecond, customSizeFirst, `${spec.name} 重复参数更新不得累计漂移`, 1e-5);
    const scenarioResult = { baselineSize, defaultSize, customSize: customSizeFirst, generatedBounds: collectGeneratedMeterBounds(root, contentRoot), zExtremes: collectMeterZExtremes(root, contentRoot), contentRootScaling: { x: contentRoot.scaling.x, y: contentRoot.scaling.y, z: contentRoot.scaling.z }, contentRootPosition: { x: contentRoot.position.x, y: contentRoot.position.y, z: contentRoot.position.z } };
    if (spec.colorKey) {
      assert.ok(baselineMaterialSnapshot && defaultMaterialSnapshot && customMaterialSnapshot && resetMaterialSnapshot && invalidMaterialSnapshot && repeatedMaterialSnapshot);
      assertMaterialColor(defaultMaterialSnapshot, spec.defaultColor, `${spec.name} 默认外观颜色`);
      assertMaterialColor(customMaterialSnapshot, customValues[spec.colorKey], `${spec.name} 自定义外观颜色`);
      assertMaterialColor(resetMaterialSnapshot, spec.defaultColor, `${spec.name} 恢复默认外观颜色`);
      assertMaterialColor(invalidMaterialSnapshot, spec.defaultColor, `${spec.name} 非法颜色必须回退默认值`);
      assertMaterialColor(repeatedMaterialSnapshot, customValues[spec.colorKey], `${spec.name} 重复自定义外观颜色`);
      assertMaterialSetEqual(customMaterialSnapshot.materials, defaultMaterialSnapshot.materials, `${spec.name} 自定义颜色必须复用克隆材质`);
      assertMaterialSetEqual(resetMaterialSnapshot.materials, defaultMaterialSnapshot.materials, `${spec.name} 恢复默认颜色必须复用克隆材质`);
      assertMaterialSetEqual(invalidMaterialSnapshot.materials, defaultMaterialSnapshot.materials, `${spec.name} 非法颜色必须复用克隆材质`);
      assertMaterialSetEqual(repeatedMaterialSnapshot.materials, defaultMaterialSnapshot.materials, `${spec.name} 重复颜色必须复用克隆材质`);
      for (const material of defaultMaterialSnapshot.materials) {
        assert.ok(!baselineMaterialSnapshot.materials.has(material), `${spec.name} 必须使用实例专属克隆材质`);
      }
      const appearanceMaterials = [...defaultMaterialSnapshot.materials];
      const disposedAppearanceMaterials = new Set();
      for (const material of appearanceMaterials) {
        material.onDisposeObservable?.add(() => disposedAppearanceMaterials.add(material));
      }
      runtime.dispose();
      runtime = undefined;
      const restoredMaterialSnapshot = collectMaterialSnapshot(contentRoot);
      assertMaterialSetEqual(restoredMaterialSnapshot.materials, baselineMaterialSnapshot.materials, `${spec.name} 停止后必须恢复原材质`);
      for (const material of appearanceMaterials) {
        assert.ok(disposedAppearanceMaterials.has(material), `${spec.name} 停止后必须释放克隆材质`);
      }
    }
    return scenarioResult;
  } finally {
    runtime?.dispose();
    scene.dispose();
  }
}

/** 加载一个 Stacker 模型内容根，供同场景双实例颜色隔离验证复用。 */
async function loadColorIsolationModel(scene, spec, glbBytes, index) {
  const root = new TransformNode(`${spec.name}_color_entity_${index}`, scene);
  const contentRoot = new TransformNode(`${spec.name}_color_content_${index}`, scene);
  contentRoot.parent = root;
  const unitScale = getUnitScaleToMeters(spec.lengthUnit);
  contentRoot.scaling.copyFromFloats(unitScale, unitScale, unitScale);
  const container = await LoadAssetContainerAsync(glbBytes, scene, { pluginExtension: '.glb', name: `${spec.name}-color-${index}` });
  container.addAllToScene();
  parentTopLevelModelNodes(container, contentRoot);
  normalizeModelContentOrigin(root);
  return { root, contentRoot };
}

/** 启动一个指定颜色的 Stacker 脚本实例。 */
async function startColorIsolationRuntime({ spec, metadata, scriptPath, scriptText, contentRoot, color, index, ExternalModelScriptRuntime }) {
  const values = { ...createDefaultParameterValues(metadata), [spec.colorKey]: color };
  const assetCode = `SMOKE-${spec.name}-COLOR-${index}`;
  const modelAsset = {
    sourcePath: scriptPath,
    sourceUrl: 'data:application/octet-stream,',
    assetCode,
    lengthUnit: spec.lengthUnit,
    unitScaleToMeters: getUnitScaleToMeters(spec.lengthUnit),
    scriptAssets: [{
      path: scriptPath,
      sourceUrl: `data:text/plain;base64,${Buffer.from(scriptText).toString('base64')}`,
      name: spec.script,
    }],
    parameterScriptMetadata: metadata.parameterScripts,
    animationScriptMetadata: metadata.animationScripts,
    parameterConfig: metadata.modelParameters,
    parameterValues: values,
  };
  syncScriptMetadata(contentRoot, metadata, values, assetCode);
  const runtime = new ExternalModelScriptRuntime(contentRoot, modelAsset);
  runtime.updateAssetCode(assetCode);
  runtime.updateParameterValues(values);
  await runtime.start();
  runtime.update();
  return { runtime, values, assetCode };
}

/** 验证两个共享同一组原材质的 Stacker 实例仍使用独立颜色克隆。 */
async function assertStackerColorIsolation({ spec, metadata, glbPath, scriptPath, ExternalModelScriptRuntime, engine }) {
  const scene = new Scene(engine);
  let leftRuntime;
  let rightRuntime;
  try {
    const [glbBytes, scriptText] = await Promise.all([
      fs.readFile(glbPath).then((value) => new Uint8Array(value)),
      fs.readFile(scriptPath, 'utf8'),
    ]);
    const left = await loadColorIsolationModel(scene, spec, glbBytes, 'left');
    const right = await loadColorIsolationModel(scene, spec, glbBytes, 'right');
    const leftMeshes = left.contentRoot.getChildMeshes(false).filter(isActiveModelGeometry).sort((a, b) => a.name.localeCompare(b.name));
    const rightMeshes = right.contentRoot.getChildMeshes(false).filter(isActiveModelGeometry).sort((a, b) => a.name.localeCompare(b.name));
    assert.equal(rightMeshes.length, leftMeshes.length, `${spec.name} 双实例 Mesh 数量必须一致`);
    rightMeshes.forEach((mesh, index) => { mesh.material = leftMeshes[index].material; });

    const leftState = await startColorIsolationRuntime({ spec, metadata, scriptPath, scriptText, contentRoot: left.contentRoot, color: '#3366ff', index: 'left', ExternalModelScriptRuntime });
    leftRuntime = leftState.runtime;
    const rightState = await startColorIsolationRuntime({ spec, metadata, scriptPath, scriptText, contentRoot: right.contentRoot, color: '#ff6633', index: 'right', ExternalModelScriptRuntime });
    rightRuntime = rightState.runtime;

    const leftSnapshot = collectMaterialSnapshot(left.contentRoot);
    const rightSnapshot = collectMaterialSnapshot(right.contentRoot);
    assertMaterialColor(leftSnapshot, '#3366ff', `${spec.name} 左实例颜色`);
    assertMaterialColor(rightSnapshot, '#ff6633', `${spec.name} 右实例颜色`);
    for (const material of leftSnapshot.materials) {
      assert.ok(!rightSnapshot.materials.has(material), `${spec.name} 双实例不得共享颜色克隆材质`);
    }

    updateRuntimeValues(leftRuntime, left.contentRoot, metadata, { ...leftState.values, [spec.colorKey]: '#22cc88' }, leftState.assetCode);
    assertMaterialColor(collectMaterialSnapshot(left.contentRoot), '#22cc88', `${spec.name} 左实例二次换色`);
    const rightBeforeLeftStop = collectMaterialSnapshot(right.contentRoot);
    assertMaterialColor(rightBeforeLeftStop, '#ff6633', `${spec.name} 左实例换色不得影响右实例`);

    leftRuntime.dispose();
    leftRuntime = undefined;
    const rightAfterLeftStop = collectMaterialSnapshot(right.contentRoot);
    assertMaterialColor(rightAfterLeftStop, '#ff6633', `${spec.name} 停止左实例不得影响右实例`);
    assertMaterialSetEqual(rightAfterLeftStop.materials, rightBeforeLeftStop.materials, `${spec.name} 右实例材质必须保持稳定`);
  } finally {
    leftRuntime?.dispose();
    rightRuntime?.dispose();
    scene.dispose();
  }
}

/** 校验当前项目资产索引已刷新为新的显式单位和参数快照。 */
async function assertAssetIndexContract() {
  const index = JSON.parse(await fs.readFile(ASSET_INDEX_PATH, 'utf8'));
  const modelEntries = new Map(
    (index.assets ?? [])
      .filter((asset) => asset.libraryKind === 'model')
      .map((asset) => [path.basename(asset.packagePath), asset]),
  );
  for (const spec of ACTIVE_MODEL_SPECS) {
    const asset = modelEntries.get(spec.name);
    assert.ok(asset, `资产索引缺少 ${spec.name}`);
    assert.equal(asset.lengthUnit, spec.lengthUnit, `资产索引 ${spec.name}.lengthUnit 未刷新`);
    assert.equal(asset.unitScaleToMeters, getUnitScaleToMeters(spec.lengthUnit), `资产索引 ${spec.name}.unitScaleToMeters 未刷新`);
    assert.ok(typeof asset.assetRevision === 'string' && asset.assetRevision.length > 0, `资产索引 ${spec.name} 缺少 assetRevision`);
  }
}

let server;
const engine = new NullEngine();

try {
  await assertModelRootAvailable();
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });
  const [{ ExternalModelScriptRuntime }, { measureModelSizeMeters }] = await Promise.all([
    loadSsrModuleWithTimeout(server, '/src/runtime/babylon/ExternalModelScriptRuntime.ts'),
    loadSsrModuleWithTimeout(server, '/src/runtime/babylon/modelMeasurement.ts'),
  ]);

  const summaries = [];
  for (const spec of ACTIVE_MODEL_SPECS) {
    const sourcePackage = path.join(MODEL_ROOT, spec.name);
    const copiedPackage = path.join(ASSET_MODEL_ROOT, spec.name);
    const metadataPath = path.join(sourcePackage, 'meta.json');
    const copiedMetadataPath = path.join(copiedPackage, 'meta.json');
    const scriptPath = path.join(sourcePackage, spec.script);
    const copiedScriptPath = path.join(copiedPackage, spec.script);
    const packageFiles = await fs.readdir(sourcePackage);
    const glbName = packageFiles.find((fileName) => fileName.toLowerCase().endsWith('.glb'));
    assert.ok(glbName, `${spec.name} 缺少 GLB`);
    const glbPath = path.join(sourcePackage, glbName);

    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    assertMetadataContract(spec, metadata);
    await assertScriptTranspiles(scriptPath);
    assert.equal(await hashFile(metadataPath), await hashFile(copiedMetadataPath), `${spec.name} meta 源包/Assets 副本不一致`);
    assert.equal(await hashFile(scriptPath), await hashFile(copiedScriptPath), `${spec.name} script 源包/Assets 副本不一致`);

    if (process.env.BABYLON_PARAMETER_BISECT === '1') {
      for (const [key, value] of Object.entries(spec.customValues)) {
        if (process.env.BABYLON_PARAMETER_KEY && key !== process.env.BABYLON_PARAMETER_KEY) continue;
        if (key === 'showDirectionArrow') continue;
        const caseSpec = {
          ...spec,
          expectSizeChange: false,
          customValues: { [key]: value, ...(spec.name === 'YZJ' ? { showDirectionArrow: false } : {}) },
        };
        const caseUnit = await runModelScenario({
          spec: caseSpec,
          metadata,
          glbPath,
          scriptPath,
          rootTransform: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
          },
          ExternalModelScriptRuntime,
          measureModelSizeMeters,
          engine,
        });
        const caseRotated = await runModelScenario({
          spec: caseSpec,
          metadata,
          glbPath,
          scriptPath,
          rootTransform: {
            position: { x: 12, y: -3, z: 7 },
            rotation: { x: 0.2, y: 0.45, z: -0.15 },
            scale: { x: 1, y: 1, z: 1 },
          },
          ExternalModelScriptRuntime,
          measureModelSizeMeters,
          engine,
        });
        console.log(JSON.stringify({ key, value, unit: caseUnit.customSize, rotated: caseRotated.customSize, unitGenerated: caseUnit.generatedBounds, rotatedGenerated: caseRotated.generatedBounds, unitZ: caseUnit.zExtremes, rotatedZ: caseRotated.zExtremes }));
      }
      continue;
    }
    const unitScenario = await runModelScenario({
      spec,
      metadata,
      glbPath,
      scriptPath,
      rootTransform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      ExternalModelScriptRuntime,
      measureModelSizeMeters,
      engine,
    });
    const rotatedScenario = await runModelScenario({
      spec,
      metadata,
      glbPath,
      scriptPath,
      rootTransform: {
        position: { x: 12, y: -3, z: 7 },
        rotation: { x: 0.2, y: 0.45, z: -0.15 },
        scale: { x: 1, y: 1, z: 1 },
      },
      ExternalModelScriptRuntime,
      measureModelSizeMeters,
      engine,
    });
    const scaledScenario = await runModelScenario({
      spec,
      metadata,
      glbPath,
      scriptPath,
      rootTransform: {
        position: { x: 12, y: -3, z: 7 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: NON_UNIFORM_SCALE,
      },
      ExternalModelScriptRuntime,
      measureModelSizeMeters,
      engine,
    });
    const transformedScenario = await runModelScenario({
      spec,
      metadata,
      glbPath,
      scriptPath,
      rootTransform: {
        position: { x: 12, y: -3, z: 7 },
        rotation: { x: 0.2, y: 0.45, z: -0.15 },
        scale: NON_UNIFORM_SCALE,
      },
      ExternalModelScriptRuntime,
      measureModelSizeMeters,
      engine,
    });
    if (MODEL_FILTER) console.log(JSON.stringify({ spec: spec.name, unitScenario, rotatedScenario, scaledScenario, transformedScenario }, null, 2));
    assertVectorClose(rotatedScenario.defaultSize, unitScenario.defaultSize, `${spec.name} 默认参数不应受实体旋转影响`);
    assertVectorClose(rotatedScenario.customSize, unitScenario.customSize, `${spec.name} 自定义参数不应受实体旋转影响`);
    assertTransformScalePreserved(unitScenario.defaultSize, scaledScenario.defaultSize, `${spec.name} 默认参数必须保留用户 Transform.scale`);
    assertTransformScalePreserved(unitScenario.customSize, scaledScenario.customSize, `${spec.name} 自定义参数必须保留用户 Transform.scale`);
    assertVectorClose(transformedScenario.defaultSize, scaledScenario.defaultSize, `${spec.name} 默认参数旋转后尺寸应保持不变`);
    assertVectorClose(transformedScenario.customSize, scaledScenario.customSize, `${spec.name} 自定义参数旋转后尺寸应保持不变`);
    if (spec.colorKey) {
      await assertStackerColorIsolation({ spec, metadata, glbPath, scriptPath, ExternalModelScriptRuntime, engine });
    }
    summaries.push({ name: spec.name, lengthUnit: spec.lengthUnit, defaultSize: unitScenario.defaultSize, customSize: unitScenario.customSize });
  }

  const fixtureSpecs = [
    { name: 'Shelf', base: 'shelf' },
    { name: 'Stacker', base: 'stacker' },
    { name: 'YZJ', base: 'yzj' },
  ];
  for (const fixture of fixtureSpecs.filter((fixture) => !MODEL_FILTER || fixture.name === MODEL_FILTER)) {
    const spec = MODEL_SPECS.find((item) => item.name === fixture.name);
    const sourcePackage = path.join(MODEL_ROOT, fixture.name);
    const fixturePackage = path.join(process.cwd(), 'output', 'playwright', `${fixture.base}-assets`);
    assert.equal(await hashFile(path.join(sourcePackage, spec.script)), await hashFile(path.join(fixturePackage, `${fixture.base}.model.ts`)), `${fixture.name} 可视夹具 TS 未同步`);
    assert.equal(await hashFile(path.join(sourcePackage, spec.script)), await hashFile(path.join(fixturePackage, `${fixture.base}.model.txt`)), `${fixture.name} 可视夹具 TXT 未同步`);
    assert.equal(await hashFile(path.join(sourcePackage, 'meta.json')), await hashFile(path.join(fixturePackage, 'meta.json')), `${fixture.name} 可视夹具 meta 未同步`);
  }

  await assertAssetIndexContract();
  console.log(JSON.stringify({ ok: true, modelRoot: MODEL_ROOT, models: summaries }, null, 2));
} finally {
  engine.dispose();
  await server?.close();
}
