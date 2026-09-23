import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conveyorSurfaceArrowSession } from '../../src/runtime/conveyorSurfaceArrowSession.ts';

test('编辑临时预览按实体隔离，停止和关闭不同，不重复通知', () => {
  conveyorSurfaceArrowSession.clear();
  let changes = 0;
  const unsubscribe = conveyorSurfaceArrowSession.subscribe(() => { changes += 1; });
  assert.equal(conveyorSurfaceArrowSession.getPreview('a'), null);
  conveyorSurfaceArrowSession.setPreview('a', 1);
  conveyorSurfaceArrowSession.setPreview('a', 1);
  assert.equal(changes, 1);
  conveyorSurfaceArrowSession.setPreview('b', -1);
  conveyorSurfaceArrowSession.setPreview('a', 0);
  assert.equal(conveyorSurfaceArrowSession.getPreview('a'), 0);
  assert.equal(conveyorSurfaceArrowSession.getPreview('b'), -1);
  conveyorSurfaceArrowSession.setPreview('a', null);
  assert.equal(conveyorSurfaceArrowSession.getPreview('a'), null);
  assert.equal(changes, 4);
  unsubscribe();
  conveyorSurfaceArrowSession.clear();
  assert.equal(changes, 4);
  assert.equal(conveyorSurfaceArrowSession.getPreview('b'), null);
});

test('诊断仅保存字符串，重复状态去重，清理后恢复缺省值', () => {
  conveyorSurfaceArrowSession.clear();
  let changes = 0;
  const unsubscribe = conveyorSurfaceArrowSession.subscribe(() => { changes += 1; });
  assert.equal(conveyorSurfaceArrowSession.getDiagnostic('a'), '');
  conveyorSurfaceArrowSession.setDiagnostic('a', '等待 MQTT 数据');
  conveyorSurfaceArrowSession.setDiagnostic('a', '等待 MQTT 数据');
  assert.equal(changes, 1);
  assert.equal(conveyorSurfaceArrowSession.getDiagnostic('a'), '等待 MQTT 数据');
  conveyorSurfaceArrowSession.clear();
  conveyorSurfaceArrowSession.clear();
  assert.equal(changes, 2);
  assert.equal(conveyorSurfaceArrowSession.getDiagnostic('a'), '');
  unsubscribe();
});

test('运行时只删除自己的实体状态，不影响另一个模型的预览或诊断', () => {
  conveyorSurfaceArrowSession.clear();
  conveyorSurfaceArrowSession.setPreview('a', 1);
  conveyorSurfaceArrowSession.setDiagnostic('a', '正向');
  conveyorSurfaceArrowSession.setPreview('b', -1);
  conveyorSurfaceArrowSession.setDiagnostic('b', '反向');
  let changes = 0;
  const unsubscribe = conveyorSurfaceArrowSession.subscribe(() => { changes += 1; });
  conveyorSurfaceArrowSession.remove('a');
  conveyorSurfaceArrowSession.remove('a');
  assert.equal(changes, 1);
  assert.equal(conveyorSurfaceArrowSession.getPreview('a'), null);
  assert.equal(conveyorSurfaceArrowSession.getDiagnostic('a'), '');
  assert.equal(conveyorSurfaceArrowSession.getPreview('b'), -1);
  assert.equal(conveyorSurfaceArrowSession.getDiagnostic('b'), '反向');
  unsubscribe();
  conveyorSurfaceArrowSession.clear();
});
