import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelAssetTemplate } from '../../src/editor/model/components.ts';
import {
  createImportedAssetIndexes,
  findImportedAssetForModelAsset,
  findImportedAssetForPackagePath,
} from '../../src/editor/assets/modelAssetRelink.ts';

function encodeAssetUrl(filePath: string): string {
  return `editor-asset://local/${encodeURIComponent(filePath)}`;
}

function createModelAsset(path: string, packagePath: string, libraryKind: 'model' | 'environment' = 'model') {
  return {
    id: path,
    name: path.split(/[\\/]/).at(-1) ?? path,
    path,
    sourceUrl: encodeAssetUrl(path),
    kind: 'model' as const,
    libraryKind,
    packagePath,
  };
}

test('不同数据中台中同名模型即使业务 ID 不同也能重新关联场景实例', () => {
  const oldPackagePath = 'C:\\workspace\\SharedResources\\Assets\\Models\\Model-10001-堆垛机';
  const oldModelPath = `${oldPackagePath}\\stacker.glb`;
  const newPackagePath = 'C:\\workspace\\SharedResources\\Assets\\Models\\Model-90001-堆垛机';
  const newModelPath = `${newPackagePath}\\stacker.glb`;
  const importedAsset = createModelAsset(newModelPath, newPackagePath);
  const indexes = createImportedAssetIndexes([importedAsset]);

  const matched = findImportedAssetForModelAsset({
    sourcePath: oldModelPath,
    sourceUrl: encodeAssetUrl(oldModelPath),
  } as ModelAssetTemplate, indexes);

  assert.equal(matched, importedAsset);
});

test('不同数据中台中同名环境模型即使业务 ID 不同也能重新关联', () => {
  const oldPackagePath = 'C:\\workspace\\SharedResources\\Assets\\Environments\\Env-10002-园区环境';
  const newPackagePath = 'C:\\workspace\\SharedResources\\Assets\\Environments\\Env-90002-园区环境';
  const newModelPath = `${newPackagePath}\\campus.glb`;
  const importedAsset = createModelAsset(newModelPath, newPackagePath, 'environment');
  const indexes = createImportedAssetIndexes([importedAsset]);

  assert.equal(findImportedAssetForPackagePath(oldPackagePath, indexes), importedAsset);
});

test('跨中台逻辑名称存在歧义时不进行错误重关联', () => {
  const oldPackagePath = 'C:\\workspace\\SharedResources\\Assets\\Models\\Model-10001-重复模型';
  const oldModelPath = `${oldPackagePath}\\model.glb`;
  const firstPackagePath = 'C:\\workspace\\SharedResources\\Assets\\Models\\Model-90001-重复模型';
  const secondPackagePath = 'C:\\workspace\\SharedResources\\Assets\\Models\\Model-90002-重复模型';
  const indexes = createImportedAssetIndexes([
    createModelAsset(`${firstPackagePath}\\first.glb`, firstPackagePath),
    createModelAsset(`${secondPackagePath}\\second.glb`, secondPackagePath),
  ]);

  const matched = findImportedAssetForModelAsset({
    sourcePath: oldModelPath,
    sourceUrl: encodeAssetUrl(oldModelPath),
  } as ModelAssetTemplate, indexes);

  assert.equal(matched, null);
});

test('同一数据中台业务 ID 仍优先于逻辑名称匹配', () => {
  const oldPackagePath = 'C:\\workspace\\SharedResources\\Assets\\Models\\Model-10001-旧名称';
  const oldModelPath = `${oldPackagePath}\\old.glb`;
  const renamedPackagePath = 'C:\\workspace\\SharedResources\\Assets\\Models\\Model-10001-新名称';
  const renamedAsset = createModelAsset(`${renamedPackagePath}\\new.glb`, renamedPackagePath);
  const sameNameOtherPackagePath = 'C:\\workspace\\SharedResources\\Assets\\Models\\Model-90001-旧名称';
  const sameNameOtherAsset = createModelAsset(`${sameNameOtherPackagePath}\\other.glb`, sameNameOtherPackagePath);
  const indexes = createImportedAssetIndexes([renamedAsset, sameNameOtherAsset]);

  const matched = findImportedAssetForModelAsset({
    sourcePath: oldModelPath,
    sourceUrl: encodeAssetUrl(oldModelPath),
  } as ModelAssetTemplate, indexes);

  assert.equal(matched, renamedAsset);
});


test('新版数据中台环境模型只按 sourceKey + resourceId 精确关联', () => {
  const sourceKeyA = 'a'.repeat(64);
  const sourceKeyB = 'b'.repeat(64);
  const packageA = 'C:\\workspace\\cache\\a\\1\\2';
  const packageB = 'C:\\workspace\\cache\\b\\1\\2';
  const assetA = {
    ...createModelAsset(`${packageA}\\model.glb`, packageA, 'environment'),
    source: 'data-platform' as const,
    dataPlatformResourceId: '1',
    dataPlatformSourceKey: sourceKeyA,
  };
  const assetB = {
    ...createModelAsset(`${packageB}\\model.glb`, packageB, 'environment'),
    source: 'data-platform' as const,
    dataPlatformResourceId: '1',
    dataPlatformSourceKey: sourceKeyB,
  };
  const indexes = createImportedAssetIndexes([assetA, assetB]);

  assert.equal(findImportedAssetForPackagePath('C:\\old\\same-name', indexes, { sourceKey: sourceKeyA, resourceId: '1' }), assetA);
  assert.equal(findImportedAssetForPackagePath(packageA, indexes, { sourceKey: sourceKeyA, resourceId: '999' }), null);
});

test('旧 sourceKey 可按当前资源库中唯一 resourceId 重新关联环境', () => {
  const oldSourceKey = 'c'.repeat(64);
  const currentSourceKey = 'd'.repeat(64);
  const packagePath = 'D:\\workspace\\cache\\environments\\current\\2088100088037199873\\revision';
  const currentAsset = {
    ...createModelAsset(`${packagePath}\\model.glb`, packagePath, 'environment'),
    source: 'data-platform' as const,
    dataPlatformResourceId: '2088100088037199873',
    dataPlatformSourceKey: currentSourceKey,
    dataPlatformRevision: '7645194092844337573',
  };
  const indexes = createImportedAssetIndexes([currentAsset]);

  assert.equal(
    findImportedAssetForPackagePath('D:\\old-cache\\environment', indexes, {
      sourceKey: oldSourceKey,
      resourceId: '2088100088037199873',
      revision: '7645194092844337573',
    }),
    currentAsset,
  );
});

test('跨 sourceKey 的 resourceId 存在多个候选时拒绝自动关联', () => {
  const resourceId = '2088100088037199873';
  const firstSourceKey = 'e'.repeat(64);
  const secondSourceKey = 'f'.repeat(64);
  const oldSourceKey = '0'.repeat(64);
  const firstPackage = 'D:\\workspace\\cache\\environments\\first\\resource\\revision';
  const secondPackage = 'D:\\workspace\\cache\\environments\\second\\resource\\revision';
  const indexes = createImportedAssetIndexes([
    {
      ...createModelAsset(`${firstPackage}\\model.glb`, firstPackage, 'environment'),
      source: 'data-platform' as const,
      dataPlatformResourceId: resourceId,
      dataPlatformSourceKey: firstSourceKey,
      dataPlatformRevision: '7645194092844337573',
    },
    {
      ...createModelAsset(`${secondPackage}\\model.glb`, secondPackage, 'environment'),
      source: 'data-platform' as const,
      dataPlatformResourceId: resourceId,
      dataPlatformSourceKey: secondSourceKey,
      dataPlatformRevision: '7645194092844337573',
    },
  ]);

  assert.equal(
    findImportedAssetForPackagePath('D:\\old-cache\\environment', indexes, {
      sourceKey: oldSourceKey,
      resourceId,
      revision: '7645194092844337573',
    }),
    null,
  );
});

test('缺少稳定身份的旧环境缓存路径也可按唯一 resourceId 重新关联', () => {
  const resourceId = '2088100088037199873';
  const oldPackage = `D:\\DT\\ZD\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\${'1'.repeat(64)}\\${resourceId}\\2092171410874761217`;
  const currentPackage = `D:\\zd-babylon-projects\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\${'2'.repeat(64)}\\${resourceId}\\2092171410874761217`;
  const currentAsset = {
    ...createModelAsset(`${currentPackage}\\model.glb`, currentPackage, 'environment'),
    source: 'data-platform' as const,
    dataPlatformResourceId: resourceId,
    dataPlatformSourceKey: '2'.repeat(64),
  };
  const indexes = createImportedAssetIndexes([currentAsset]);

  assert.equal(findImportedAssetForPackagePath(oldPackage, indexes), currentAsset);
});

test('跨 sourceKey 的 resourceId 相同但 revision 不同时拒绝自动关联', () => {
  const resourceId = '2088100088037199873';
  const currentSourceKey = '9'.repeat(64);
  const packagePath = 'D:\\workspace\\cache\\environments\\current\\resource\\revision';
  const currentAsset = {
    ...createModelAsset(`${packagePath}\\model.glb`, packagePath, 'environment'),
    source: 'data-platform' as const,
    dataPlatformResourceId: resourceId,
    dataPlatformSourceKey: currentSourceKey,
    dataPlatformRevision: '7645194092844337574',
  };
  const indexes = createImportedAssetIndexes([currentAsset]);

  assert.equal(
    findImportedAssetForPackagePath('D:\\old-cache\\environment', indexes, {
      sourceKey: '8'.repeat(64),
      resourceId,
      revision: '7645194092844337573',
    }),
    null,
  );
});
