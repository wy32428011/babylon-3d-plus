import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { formatDigitalTwinPublishErrorMessage } from '../../electron/shared/digitalTwinPublishErrorMessage.ts';

test('缺失资源按三类显示字符串ID，不输出额外数据或不规范值', () => {
  const text = formatDigitalTwinPublishErrorMessage('DIGITAL_TWIN_RESOURCES_NOT_FOUND', '资源不存在', {
    missingModels: ['123', '123', 456, '0', '-9', '1e3', '<script>', '7'.repeat(65), '789'],
    missingEnvModels: ['300'], missingComboModels: ['400'], token: 'private-secret',
  });
  assert.equal(text, '资源不存在；普通模型 ID：123、789；环境模型 ID：300；组合模型 ID：400');
});

test('每类最多列出20项，其余只显示数量', () => {
  const ids = Array.from({ length: 23 }, (_, index) => String(index + 1));
  const text = formatDigitalTwinPublishErrorMessage('DIGITAL_TWIN_RESOURCES_NOT_FOUND', '缺失', { missingModels: ids });
  assert.ok(text.includes('19、20（另有 3 个）'));
  assert.ok(!text.includes('、21'));
});

test('旧错误码和无可用缺失ID保持原消息', () => {
  for (const data of [null, [], {}, { missingModels: [2, false, {}] }]) {
    assert.equal(formatDigitalTwinPublishErrorMessage('DIGITAL_TWIN_RESOURCES_NOT_FOUND', '原消息', data), '原消息');
  }
  assert.equal(formatDigitalTwinPublishErrorMessage('OTHER_ERROR', '原消息', { missingModels: ['1'] }), '原消息');
});

test('实际DigitalTwinApiError构造器保留code/data/httpStatus，只增强message', async () => {
  const source = await readFile(new URL('../../electron/ipc/digitalTwinUploadClient.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export class DigitalTwinApiError');
  const end = source.indexOf('\n/**', start);
  const constructor = stripTypeScriptTypes(source.slice(start, end)).replace('export class', 'class');
  const ErrorClass = runInNewContext(`${constructor}; DigitalTwinApiError`, { Error, formatDigitalTwinPublishErrorMessage });
  const data = { missingModels: ['123'] };
  const error = new ErrorClass('DIGITAL_TWIN_RESOURCES_NOT_FOUND', '资源缺失', data, 400);
  assert.equal(error.message, '资源缺失；普通模型 ID：123');
  assert.equal(error.code, 'DIGITAL_TWIN_RESOURCES_NOT_FOUND');
  assert.equal(error.data, data);
  assert.equal(error.httpStatus, 400);
  assert.equal(new ErrorClass('OTHER', '原始消息', data, 409).message, '原始消息');
});
