import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rgvMotionArrowSession as session } from '../../src/runtime/rgvMotionArrowSession.ts';

test('RGV预览按实体和三路隔离，停止与结束不同，重复状态不通知', () => {
  session.clear();
  let changes = 0;
  const unsubscribe = session.subscribe(() => { changes += 1; });
  assert.equal(session.getPreview('a', 'travel'), null);
  session.setPreview('a', 'travel', 1);
  session.setPreview('a', 'travel', 1);
  session.setPreview('a', 'front', -1);
  session.setPreview('b', 'back', 1);
  session.setPreview('a', 'travel', 0);
  assert.equal(changes, 4);
  assert.equal(session.getPreview('a', 'travel'), 0);
  assert.equal(session.getPreview('a', 'front'), -1);
  assert.equal(session.getPreview('a', 'back'), null);
  assert.equal(session.getPreview('b', 'back'), 1);
  session.setPreview('a', 'travel', null);
  assert.equal(session.getPreview('a', 'travel'), null);
  unsubscribe();
  session.clear();
  assert.equal(changes, 5);
});

test('删除实体与清理会话同时移除预览和诊断，不影响其它实体且不重复通知', () => {
  session.clear();
  let changes = 0;
  const unsubscribe = session.subscribe(() => { changes += 1; });
  session.setPreview('a', 'travel', 1);
  session.setDiagnostic('a', 'travel', '正向');
  session.setDiagnostic('a', 'travel', '正向');
  session.setDiagnostic('a', 'front', '节点不存在');
  session.setPreview('b', 'back', -1);
  session.setDiagnostic('b', 'back', '反向');
  assert.equal(changes, 5);
  session.remove('a');
  session.remove('a');
  assert.equal(changes, 6);
  assert.equal(session.getPreview('a', 'travel'), null);
  assert.equal(session.getDiagnostic('a', 'front'), '');
  assert.equal(session.getPreview('b', 'back'), -1);
  session.setDiagnostic('b', 'back', '');
  assert.equal(session.getDiagnostic('b', 'back'), '');
  session.clear();
  session.clear();
  assert.equal(changes, 8);
  unsubscribe();
});

