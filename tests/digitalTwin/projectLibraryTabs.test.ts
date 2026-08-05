import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PROJECT_PANEL_PATH = 'src/editor/panels/ProjectPanel.tsx';

function readLibraryBranch(source: string, libraryKey: 'model' | 'skybox'): string {
  const branchStart = `if (activeLibrary.key === '${libraryKey}') {`;
  const startIndex = source.indexOf(branchStart);
  assert.notEqual(startIndex, -1, `未找到 ${libraryKey} 资源库分支`);

  const nextBranchIndex = source.indexOf("\n    if (activeLibrary.key === '", startIndex + branchStart.length);
  return source.slice(startIndex, nextBranchIndex === -1 ? source.length : nextBranchIndex);
}

test('天空盒资源只出现在天空盒 Tab，不混入模型库', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');
  const modelBranch = readLibraryBranch(source, 'model');
  const skyboxBranch = readLibraryBranch(source, 'skybox');

  assert.match(modelBranch, /createModelLibraryItems\(modelAssets\)/);
  assert.doesNotMatch(modelBranch, /createSkyboxLibraryItems\(skyboxAssets\)/);
  assert.match(skyboxBranch, /createSkyboxLibraryItems\(skyboxAssets\)/);
});

test('模型库空状态只由普通模型资产决定', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');

  assert.match(source, /activeLibrary\.key === 'model' && modelAssets\.length === 0/);
  assert.doesNotMatch(
    source,
    /activeLibrary\.key === 'model' && modelAssets\.length === 0 && skyboxAssets\.length === 0/,
  );
});
