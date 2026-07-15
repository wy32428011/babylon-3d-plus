import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';


/** 生成只含 JSON 块的最小 GLB，scanner 只读取 accessor min/max 即可验证单位解析边界。 */
function createMinimalGlbJson({ maxSize = 1 } = {}) {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ min: [0, 0, 0], max: [maxSize, maxSize, maxSize] }],
  };
}

/** 按 GLB 2.0 对齐规则写入 JSON chunk，避免依赖外部模型包或二进制资源。 */
function createMinimalGlbBuffer(options = {}) {
  const jsonBuffer = Buffer.from(JSON.stringify(createMinimalGlbJson(options)), 'utf-8');
  const paddedJsonLength = Math.ceil(jsonBuffer.length / 4) * 4;
  const paddedJson = Buffer.alloc(paddedJsonLength, 0x20);
  jsonBuffer.copy(paddedJson);

  const totalLength = 12 + 8 + paddedJsonLength;
  const buffer = Buffer.alloc(totalLength);
  buffer.write('glTF', 0, 4, 'utf-8');
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(totalLength, 8);
  buffer.writeUInt32LE(paddedJsonLength, 12);
  buffer.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(buffer, 20);
  return buffer;
}

/** 构造临时模型包，确保 smoke 不触碰任何外部模型资产。 */
async function createTemporaryModelPackage(rootPath, name, { meta, maxSize = 1, scriptText } = {}) {
  const packagePath = path.join(rootPath, name);
  await fs.mkdir(packagePath, { recursive: true });
  await fs.writeFile(path.join(packagePath, `${name}.glb`), createMinimalGlbBuffer({ maxSize }));
  if (meta !== undefined) {
    await fs.writeFile(path.join(packagePath, 'meta.json'), JSON.stringify(meta, null, 2));
  }
  if (scriptText !== undefined) {
    await fs.writeFile(path.join(packagePath, `${name}.model.ts`), scriptText);
  }
  return packagePath;
}

/** 生成只包含一条 1 单位 LINE 的最小 DXF，用于验证单位换算而非图元复杂度。 */
function createUnitDxf({ insUnits, measurement } = {}) {
  const headerVariables = [];
  if (insUnits !== undefined) headerVariables.push('9', '$INSUNITS', '70', String(insUnits));
  if (measurement !== undefined) headerVariables.push('9', '$MEASUREMENT', '70', String(measurement));

  return [
    '0', 'SECTION', '2', 'HEADER',
    ...headerVariables,
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '1', '21', '0',
    '0', 'ENDSEC',
    '0', 'EOF',
    '',
  ].join('\n');
}

/** 比较浮点换算系数，避免不同 JS 运算路径的末位误差干扰 smoke。 */
function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-12), `${message}: ${actual} !== ${expected}`);
}

let server;
let tempModelRoot;

try {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });

  const cadReference = await server.ssrLoadModule('/src/editor/cad/cadReference.ts');
  const largeCadReference = await server.ssrLoadModule('/src/editor/cad/cadReferenceLargeDxf.ts');
  const environmentAssets = await server.ssrLoadModule('/src/editor/assets/environmentAssets.ts');
  const sceneDocumentModule = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
  const sceneSerializer = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
  const builtInGeometry = await server.ssrLoadModule('/src/editor/model/builtInMeshGeometry.ts');
  const sceneUnits = await server.ssrLoadModule('/src/editor/model/sceneUnits.ts');
  const modelPackageScanner = await server.ssrLoadModule('/electron/ipc/modelPackageScanner.ts');

  const expectedInsUnits = new Map([
    [1, 0.0254], [2, 0.3048], [3, 1609.344], [4, 0.001], [5, 0.01], [6, 1],
    [7, 1000], [8, 0.0000000254], [9, 0.0000254], [10, 0.9144], [11, 1e-10], [12, 1e-9],
    [13, 1e-6], [14, 0.1], [15, 10], [16, 100], [17, 1e9], [18, 149_597_870_700],
    [19, 9_460_730_472_580_800], [20, 30_856_775_814_913_673], [21, 1200 / 3937],
    [22, 100 / 3937], [23, 3600 / 3937], [24, 6_336_000 / 3937],
  ]);
  const parsedInsUnits = new Map();
  for (const [code, expectedScale] of expectedInsUnits) {
    const result = cadReference.parseCadReferenceDxf(createUnitDxf({ insUnits: code }));
    assertClose(result.unitScaleToMeters, expectedScale, `INSUNITS=${code} 必须换算为米`);
    assert.equal(result.unitDetection, 'insunits');
    parsedInsUnits.set(code, result);
  }
  const yardResult = parsedInsUnits.get(10);

  const measurementResult = cadReference.parseCadReferenceDxf(createUnitDxf({ insUnits: 0, measurement: 0 }));
  assertClose(measurementResult.unitScaleToMeters, 0.0254, '无单位英制图纸必须按 inch 换算为米');

  const fallbackResult = cadReference.parseCadReferenceDxf(createUnitDxf());
  assert.equal(fallbackResult.unitDetection, 'fallback');
  assertClose(fallbackResult.unitScaleToMeters, 0.001, '无任何单位元数据时必须明确按 millimeter 兜底');

  const largeResult = largeCadReference.parseLargeCadReferenceDxf(createUnitDxf({ insUnits: 10 }), { maxPolylines: 10, maxPoints: 20 });
  assertClose(largeResult.unitScaleToMeters, yardResult.unitScaleToMeters, '普通与大文件 CAD 单位结果必须一致');
  assert.equal(largeResult.sourceUnitName, yardResult.sourceUnitName);

  const environmentAsset = {
    id: 'environment-centimeter',
    name: 'environment.glb',
    path: 'F:/project/Assets/Environments/environment/environment.glb',
    sourceUrl: 'editor-asset://local/environment.glb',
    kind: 'model',
    libraryKind: 'environment',
    lengthUnit: 'centimeter',
    unitScaleToMeters: 999,
  };
  const environment = environmentAssets.createEnvironmentFromAsset(environmentAsset, [{
    name: '默认环境',
    sourcePath: environmentAsset.path,
    sourceUrl: environmentAsset.sourceUrl,
  }]);
  assert.ok(environment);
  assert.equal(environment.lengthUnit, 'centimeter');
  assertClose(environment.unitScaleToMeters, 0.01, '环境模型必须按 lengthUnit 重建标准米制换算');
  assert.deepEqual(sceneUnits.createModelLengthUnitInfo('millimeter'), { lengthUnit: 'millimeter', unitScaleToMeters: 0.001 });

  tempModelRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'babylon-unit-smoke-'));
  const noMetaPackagePath = await createTemporaryModelPackage(tempModelRoot, 'no-meta-default-meter');
  const noMetaPackage = await modelPackageScanner.scanModelPackage(noMetaPackagePath);
  assert.equal(noMetaPackage.asset.lengthUnit, 'meter');
  assertClose(noMetaPackage.asset.unitScaleToMeters, 1, '无 meta 且无脚本的模型包必须默认 meter/1');

  const parameterOnlyPackagePath = await createTemporaryModelPackage(tempModelRoot, 'parameter-only-default-meter', {
    maxSize: 1000,
    meta: {
      parameterScripts: [{
        fields: [{ key: 'width', label: '宽度', type: 'number', defaultValue: 1 }],
      }],
    },
    scriptText: 'export const model = { parameters: { width: 1 } };\n',
  });
  const parameterOnlyPackage = await modelPackageScanner.scanModelPackage(parameterOnlyPackagePath);
  assert.equal(parameterOnlyPackage.asset.lengthUnit, 'meter');
  assertClose(parameterOnlyPackage.asset.unitScaleToMeters, 1, 'meta 只有 parameterScripts 尺寸信息时不得再由包围盒反推单位');
  assert.ok(parameterOnlyPackage.asset.parameterScriptMetadata, 'parameterScripts 仍必须作为脚本元数据保留');
  assert.ok(parameterOnlyPackage.asset.parameterConfig, 'parameterScripts 仍必须可生成参数配置');

  const centimeterPackagePath = await createTemporaryModelPackage(tempModelRoot, 'explicit-centimeter', {
    meta: { lengthUnit: 'centimeter' },
  });
  const centimeterPackage = await modelPackageScanner.scanModelPackage(centimeterPackagePath);
  assert.equal(centimeterPackage.asset.lengthUnit, 'centimeter');
  assertClose(centimeterPackage.asset.unitScaleToMeters, 0.01, '无脚本显式 centimeter 必须换算为 0.01 米');

  const millimeterPackagePath = await createTemporaryModelPackage(tempModelRoot, 'explicit-millimeter', {
    meta: { lengthUnit: 'mm' },
  });
  const millimeterPackage = await modelPackageScanner.scanModelPackage(millimeterPackagePath);
  assert.equal(millimeterPackage.asset.lengthUnit, 'millimeter');
  assertClose(millimeterPackage.asset.unitScaleToMeters, 0.001, '无脚本显式 millimeter/mm 必须换算为 0.001 米');

  const invalidUnitPackagePath = await createTemporaryModelPackage(tempModelRoot, 'invalid-unit', {
    meta: { lengthUnit: 'yard' },
  });
  await assert.rejects(
    () => modelPackageScanner.scanModelPackage(invalidUnitPackagePath),
    /模型单位不受支持：yard/,
    '显式非法 lengthUnit 必须拒绝，不能静默回退 meter',
  );

  const legacyScene = sceneDocumentModule.createEmptySceneDocument('旧场景');
  legacyScene.sceneSettings.environment = {
    packagePath: 'F:/project/Assets/Environments/legacy',
    activeVariantUrl: 'editor-asset://local/legacy.glb',
    variants: [{
      name: '旧环境',
      sourcePath: 'F:/project/Assets/Environments/legacy/legacy.glb',
      sourceUrl: 'editor-asset://local/legacy.glb',
    }],
  };
  const legacyContent = JSON.stringify({ version: 1, units: { length: 'meter' }, scene: legacyScene });
  const normalizedLegacyScene = sceneSerializer.deserializeScene(legacyContent);
  assert.equal(normalizedLegacyScene.sceneSettings.environment.lengthUnit, 'meter');
  assertClose(normalizedLegacyScene.sceneSettings.environment.unitScaleToMeters, 1, '旧环境场景必须按米兼容');

  const serializedEnvironment = JSON.parse(sceneSerializer.serializeScene({
    ...normalizedLegacyScene,
    sceneSettings: {
      ...normalizedLegacyScene.sceneSettings,
      environment,
    },
  }));
  assert.equal(serializedEnvironment.scene.sceneSettings.environment.lengthUnit, 'centimeter');
  assertClose(serializedEnvironment.scene.sceneSettings.environment.unitScaleToMeters, 0.01, '新场景必须保存环境单位');

  assert.deepEqual(builtInGeometry.getBuiltInMeshBaseDimensionsMeters('cube'), { x: 1, y: 1, z: 1 });
  assert.deepEqual(builtInGeometry.getBuiltInMeshBaseDimensionsMeters('sphere'), { x: 1, y: 1, z: 1 });
  assert.deepEqual(builtInGeometry.getBuiltInMeshBaseDimensionsMeters('plane'), { x: 2, y: 0, z: 2 });
  assertClose(builtInGeometry.getBuiltInMeshGroundOffsetMeters('cube'), 0.5, 'Cube 拖放必须底面落地');
  assertClose(builtInGeometry.getBuiltInMeshGroundOffsetMeters('sphere'), 0.5, 'Sphere 拖放必须底面落地');
  assertClose(builtInGeometry.getBuiltInMeshGroundOffsetMeters('plane'), 0, 'Plane 必须贴地');

  console.log(JSON.stringify({
    ok: true,
    cad: {
      yard: yardResult.unitScaleToMeters,
      measurement: measurementResult.unitScaleToMeters,
      fallback: fallbackResult.unitScaleToMeters,
      fallbackDetection: fallbackResult.unitDetection,
    },
    environment: {
      lengthUnit: environment.lengthUnit,
      unitScaleToMeters: environment.unitScaleToMeters,
      legacyLengthUnit: normalizedLegacyScene.sceneSettings.environment.lengthUnit,
    },
    builtIn: ['cube', 'sphere', 'plane'],
    modelPackages: {
      defaultUnit: noMetaPackage.asset.lengthUnit,
      parameterOnlyUnit: parameterOnlyPackage.asset.lengthUnit,
      centimeter: centimeterPackage.asset.unitScaleToMeters,
      millimeter: millimeterPackage.asset.unitScaleToMeters,
    },
  }, null, 2));
} finally {
  await server?.close();
  if (tempModelRoot) await fs.rm(tempModelRoot, { recursive: true, force: true });
}
