import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDigitalTwinForceOverwrite } from '../../src/editor/deployment/digitalTwinForceOverwrite.ts';

test('版本冲突未确认强制覆盖时返回校验错误', () => {
  assert.equal(
    validateDigitalTwinForceOverwrite(true, false),
    '远端已经产生新版本，请确认强制使用本地版本覆盖后再发布。',
  );
});

test('版本冲突已确认或没有冲突时允许继续', () => {
  assert.equal(validateDigitalTwinForceOverwrite(true, true), null);
  assert.equal(validateDigitalTwinForceOverwrite(false, false), null);
});
