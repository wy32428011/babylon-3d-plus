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
