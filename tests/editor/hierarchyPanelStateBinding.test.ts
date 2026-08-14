import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const panelSource = readFileSync(resolve(process.cwd(), 'src/editor/panels/HierarchyPanel.tsx'), 'utf8');

test('模型树图标按文件夹继承的显隐和锁定状态展示', () => {
  assert.match(panelSource, /const isVisible = isEntityEffectivelyVisible\(entities, entity\);/);
  assert.match(panelSource, /const isLocked = isEntityEffectivelyLocked\(entities, entity\);/);
});
