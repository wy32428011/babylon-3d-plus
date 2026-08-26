import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const controlsSource = await readFile(
  new URL('../../src/shared/ui/ManualRoamControls.tsx', import.meta.url),
  'utf8',
);
const controlsStyles = await readFile(
  new URL('../../src/styles/manual-roam-controls.css', import.meta.url),
  'utf8',
);

test('移动端首次加载默认折叠手动漫游面板', () => {
  assert.match(
    controlsSource,
    /useState\(\(\) => \([\s\S]*?matchMedia\('\(hover: none\) and \(pointer: coarse\)'\)[\s\S]*?matchMedia\('\(max-width: 720px\)'\)/,
  );
});

test('触摸控件只在粗指针或窄视口显示，并在面板展开时隐藏', () => {
  assert.match(
    controlsStyles,
    /@media \(hover: none\) and \(pointer: coarse\), \(max-width: 720px\)/,
  );
  assert.match(
    controlsStyles,
    /\.manual-roam-controls:not\(\.is-collapsed\) \+ \.manual-roam-touch-controls\s*\{\s*display: none;/,
  );
});
