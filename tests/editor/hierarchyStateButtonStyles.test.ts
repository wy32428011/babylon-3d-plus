import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const cssSource = readFileSync(new URL('../../src/styles/global.css', import.meta.url), 'utf8');

function getRuleDeclarations(selector: string): string {
  const ruleStart = cssSource.indexOf(`${selector} {`);
  assert.notEqual(ruleStart, -1, `缺少样式规则：${selector}`);

  const declarationsStart = ruleStart + selector.length + 2;
  const ruleEnd = cssSource.indexOf('}', declarationsStart);
  assert.notEqual(ruleEnd, -1, `样式规则未闭合：${selector}`);

  return cssSource.slice(declarationsStart, ruleEnd);
}

test('模型树显隐和锁定按钮仅在所在行选中时使用蓝色高亮', () => {
  const defaultDeclarations = getRuleDeclarations('.panel .entity-state-button');

  assert.match(defaultDeclarations, /background:\s*transparent;/);
  assert.match(defaultDeclarations, /color:\s*#a9a9a9;/);

  const selectedDeclarations = getRuleDeclarations('.entity-tree-row.selected .entity-state-button');
  assert.match(selectedDeclarations, /background:\s*#2f8cff;/);
  assert.match(selectedDeclarations, /color:\s*#ffffff;/);
});
