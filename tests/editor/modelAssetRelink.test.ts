import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssetEntry } from '../../src/editor/assets/AssetDatabase';
import type { ModelAssetTemplate } from '../../src/editor/model/components';
import {
  createImportedAssetIndexes,
  findImportedAssetForModelAsset,
} from '../../src/editor/assets/modelAssetRelink';

function createAsset(path: string, packagePath?: string): AssetEntry {
  return {
    id: path,
    name: path.replace(/\\/g, '/').split('/').at(-1) ?? path,
    path,
    sourceUrl: `editor-asset://local/${encodeURIComponent(path)}`,
    kind: 'model',
    packagePath,
  };
}

function createModelAsset(sourcePath: string): ModelAssetTemplate {
  return {
    sourcePath,
    sourceUrl: `editor-asset://local/${encodeURIComponent(sourcePath)}`,
    lengthUnit: 'meter',
    unitScaleToMeters: 1,
  };
}

test('同一电脑重导继续优先按精确路径匹配', () => {
  const asset = createAsset(String.raw`C:\Project\Assets\Models\YZJ\YZJ.glb`);
  const matched = findImportedAssetForModelAsset(createModelAsset(asset.path), createImportedAssetIndexes([asset]));
  assert.equal(matched, asset);
});

test('跨电脑重导按唯一包目录名和主模型文件名重新关联', () => {
  const asset = createAsset(
    String.raw`C:\Project\Assets\Models\链条机\链条机.glb`,
    String.raw`C:\Project\Assets\Models\链条机`,
  );
  const oldModelAsset = createModelAsset(String.raw`D:\ZDDT\Assets\Models\链条机\链条机.glb`);

  const matched = findImportedAssetForModelAsset(oldModelAsset, createImportedAssetIndexes([asset]));
  assert.equal(matched, asset);
});

test('主模型文件名相同但包目录名不同不会误关联', () => {
  const asset = createAsset(
    String.raw`C:\Project\Assets\Models\新版\Model.glb`,
    String.raw`C:\Project\Assets\Models\新版`,
  );
  const oldModelAsset = createModelAsset(String.raw`D:\Legacy\旧版\Model.glb`);

  const matched = findImportedAssetForModelAsset(oldModelAsset, createImportedAssetIndexes([asset]));
  assert.equal(matched, null);
});

test('可迁移包键存在多个候选时拒绝自动关联', () => {
  const first = createAsset(String.raw`C:\ProjectA\Assets\Models\YZJ\YZJ.glb`);
  const second = createAsset(String.raw`E:\ProjectB\Assets\Models\YZJ\YZJ.glb`);
  const oldModelAsset = createModelAsset(String.raw`D:\ZDDT\Assets\Models\YZJ\YZJ.glb`);

  const matched = findImportedAssetForModelAsset(oldModelAsset, createImportedAssetIndexes([first, second]));
  assert.equal(matched, null);
});

test('可迁移键有歧义时精确路径仍可安全命中', () => {
  const first = createAsset(String.raw`C:\ProjectA\Assets\Models\YZJ\YZJ.glb`);
  const second = createAsset(String.raw`E:\ProjectB\Assets\Models\YZJ\YZJ.glb`);

  const matched = findImportedAssetForModelAsset(createModelAsset(second.path), createImportedAssetIndexes([first, second]));
  assert.equal(matched, second);
});
