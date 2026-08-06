import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getLightEditorCapabilities,
  getLightTransformFieldLabel,
  resolveLightTransformTool,
} from '../../src/editor/model/lightEditor.ts';

test('三类灯光暴露与运行语义一致的编辑能力', () => {
  assert.deepEqual(getLightEditorCapabilities('hemispheric'), {
    markerKind: null,
    supportedTools: [],
    transformFields: ['position'],
  });
  assert.deepEqual(getLightEditorCapabilities('point'), {
    markerKind: 'point',
    supportedTools: ['translate'],
    transformFields: ['position'],
  });
  assert.deepEqual(getLightEditorCapabilities('directional'), {
    markerKind: 'directional',
    supportedTools: ['translate', 'rotate'],
    transformFields: ['position', 'rotation'],
  });
});

test('不支持的灯光工具统一回退移动工具', () => {
  assert.equal(resolveLightTransformTool('point', 'rotate'), 'translate');
  assert.equal(resolveLightTransformTool('point', 'scale'), 'translate');
  assert.equal(resolveLightTransformTool('directional', 'rotate'), 'rotate');
  assert.equal(resolveLightTransformTool('directional', 'scale'), 'translate');
  assert.equal(resolveLightTransformTool('hemispheric', 'rotate'), 'translate');
});

test('半球光沿用 position 数据但 Inspector 明确显示 direction', () => {
  assert.equal(getLightTransformFieldLabel('hemispheric', 'position'), 'direction');
  assert.equal(getLightTransformFieldLabel('point', 'position'), 'position');
  assert.equal(getLightTransformFieldLabel('directional', 'rotation'), 'rotation');
});
