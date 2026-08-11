import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertUniqueSkyboxRecords,
  normalizePositiveIdentifier,
  normalizeSkyboxQueryResponse,
  parseBoundedDecimalString,
  type DataPlatformSkyboxRecord,
} from '../../electron/ipc/dataPlatformSkyboxContract.ts';

const MAX_SKYBOX_BYTES = 512 * 1024 * 1024;
const LONG_ID = '2052912068767571969';
const LONG_REVISION = '2052912068767571970';
const VALID_SHA = 'a'.repeat(64);

function createRawRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: LONG_ID,
    skyboxName: '  工厂穹顶  ',
    fileName: ' factory.hdr ',
    fileUrl: ' https://cdn.example.com/skyboxes/factory.hdr ',
    fileFormat: 'HDR',
    fileSize: String(MAX_SKYBOX_BYTES),
    sha256: VALID_SHA,
    revision: LONG_REVISION,
    updatedAt: '2026-08-11 10:20:30',
    untrusted: 'must-not-leak',
    ...overrides,
  };
}

function createSuccessResponse(
  records: unknown[] = [createRawRecord()],
  dataOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    success: true,
    message: 'ok',
    data: {
      records,
      total: '100000',
      pageNum: '1000',
      pageSize: '100',
      ignored: 'must-not-leak',
      ...dataOverrides,
    },
    ignored: 'must-not-leak',
  };
}

function createNormalizedRecord(overrides: Partial<DataPlatformSkyboxRecord> = {}): DataPlatformSkyboxRecord {
  return {
    id: '1',
    displayName: '主天空盒',
    fileName: 'main.hdr',
    fileUrl: 'https://cdn.example.com/main.hdr',
    format: 'hdr',
    fileSizeBytes: 1,
    sha256: VALID_SHA,
    revision: '1',
    updatedAt: '2026-08-11T10:20:30Z',
    ...overrides,
  };
}

function assertRecordRejected(overrides: Record<string, unknown>, expected: RegExp): void {
  assert.throws(
    () => normalizeSkyboxQueryResponse(createSuccessResponse([createRawRecord(overrides)])),
    expected,
  );
}

test('归一化合法天空盒分页并保留超出安全整数的 Long 字符串', () => {
  const page = normalizeSkyboxQueryResponse(createSuccessResponse());

  assert.deepEqual(page, {
    records: [{
      id: LONG_ID,
      displayName: '工厂穹顶',
      fileName: 'factory.hdr',
      fileUrl: 'https://cdn.example.com/skyboxes/factory.hdr',
      format: 'hdr',
      fileSizeBytes: MAX_SKYBOX_BYTES,
      sha256: VALID_SHA,
      revision: LONG_REVISION,
      updatedAt: '2026-08-11 10:20:30',
    }],
    total: 100000,
    pageNum: 1000,
    pageSize: 100,
  });
  assert.equal('untrusted' in page.records[0], false);
  assert.equal('ignored' in page, false);
});

test('分页与文件大小的下限和上限恰好通过', () => {
  const minimum = normalizeSkyboxQueryResponse(createSuccessResponse(
    [createRawRecord({ fileSize: '1' })],
    { total: '0', pageNum: '1', pageSize: '1' },
  ));
  assert.equal(minimum.records[0].fileSizeBytes, 1);
  assert.deepEqual(
    { total: minimum.total, pageNum: minimum.pageNum, pageSize: minimum.pageSize },
    { total: 0, pageNum: 1, pageSize: 1 },
  );

  const maximum = normalizeSkyboxQueryResponse(createSuccessResponse());
  assert.equal(maximum.records[0].fileSizeBytes, MAX_SKYBOX_BYTES);
  assert.deepEqual(
    { total: maximum.total, pageNum: maximum.pageNum, pageSize: maximum.pageSize },
    { total: 100000, pageNum: 1000, pageSize: 100 },
  );
});

test('parseBoundedDecimalString 仅接受范围内且可安全转换的十进制字符串', () => {
  assert.equal(parseBoundedDecimalString(' 42 ', { label: '数量', min: 0, max: 100 }), 42);
  assert.equal(parseBoundedDecimalString('0007', { label: '数量', min: 0n, max: 100n }), 7);

  for (const value of [42, null, undefined, '', ' ', '1.5', '1e2', '0x10', '+1']) {
    assert.throws(
      () => parseBoundedDecimalString(value, { label: '数量', min: 0, max: 100 }),
      /数量/,
    );
  }
  assert.throws(() => parseBoundedDecimalString('-1', { label: '数量', min: 0, max: 100 }), /数量/);
  assert.throws(() => parseBoundedDecimalString('101', { label: '数量', min: 0, max: 100 }), /数量/);
  assert.throws(
    () => parseBoundedDecimalString('9007199254740992', {
      label: '数量',
      min: 0n,
      max: 9007199254740992n,
    }),
    /数量/,
  );
});

test('normalizePositiveIdentifier 只接受最多 64 位的正十进制字符串', () => {
  assert.equal(normalizePositiveIdentifier(` ${LONG_ID} `), LONG_ID);
  const sixtyFourDigits = '9'.repeat(64);
  assert.equal(normalizePositiveIdentifier(sixtyFourDigits), sixtyFourDigits);

  for (const value of [LONG_ID.length, 0, '0', '0000', '-1', '+1', '1.0', '1e2', '', '9'.repeat(65)]) {
    assert.throws(() => normalizePositiveIdentifier(value), /标识符/);
  }
});

test('失败 envelope 使用非空 message，否则使用默认错误', () => {
  assert.throws(
    () => normalizeSkyboxQueryResponse({ success: false, message: '  服务拒绝查询  ' }),
    { message: '服务拒绝查询' },
  );
  assert.throws(
    () => normalizeSkyboxQueryResponse({ success: false, message: '   ' }),
    { message: '查询天空盒失败' },
  );
  assert.throws(
    () => normalizeSkyboxQueryResponse({ success: 'true', message: null }),
    { message: '查询天空盒失败' },
  );
});

test('拒绝非 plain object、数组和自定义原型 envelope', () => {
  for (const value of [null, [], new Date('2026-08-11T00:00:00Z')]) {
    assert.throws(() => normalizeSkyboxQueryResponse(value), /响应|结构/);
  }

  const pollutedEnvelope = Object.assign(Object.create({ polluted: true }), createSuccessResponse());
  assert.throws(() => normalizeSkyboxQueryResponse(pollutedEnvelope), /响应|结构/);
});

test('严格校验 data、records 和每条记录均为可信结构', () => {
  assert.throws(() => normalizeSkyboxQueryResponse({ success: true, data: [] }), /data|records/);
  assert.throws(
    () => normalizeSkyboxQueryResponse({ success: true, data: { records: {} } }),
    /data|records/,
  );
  assert.throws(() => normalizeSkyboxQueryResponse(createSuccessResponse([[]])), /第 1 项|对象/);

  const pollutedRecord = Object.assign(Object.create({ polluted: true }), createRawRecord());
  assert.throws(
    () => normalizeSkyboxQueryResponse(createSuccessResponse([pollutedRecord])),
    /第 1 项|对象/,
  );
});

test('拒绝分页字段的非法类型、越界值和不安全整数', () => {
  const invalidCases: Array<[Record<string, unknown>, RegExp]> = [
    [{ total: '-1' }, /total/],
    [{ total: '100001' }, /total/],
    [{ total: 1 }, /total/],
    [{ pageNum: '0' }, /pageNum/],
    [{ pageNum: '1001' }, /pageNum/],
    [{ pageSize: '0' }, /pageSize/],
    [{ pageSize: '101' }, /pageSize/],
    [{ pageSize: null }, /pageSize/],
    [{ total: '9007199254740992' }, /total/],
  ];

  for (const [overrides, expected] of invalidCases) {
    assert.throws(
      () => normalizeSkyboxQueryResponse(createSuccessResponse([createRawRecord()], overrides)),
      expected,
    );
  }
});

test('拒绝数值型 Long、零 ID 和超长 ID', () => {
  assertRecordRejected({ id: Number(LONG_ID) }, /id/);
  assertRecordRejected({ id: '0' }, /id/);
  assertRecordRejected({ id: '9'.repeat(65) }, /id/);
});

test('revision 独立按正十进制字符串规范化且不转换为 number', () => {
  const page = normalizeSkyboxQueryResponse(createSuccessResponse([
    createRawRecord({ revision: ` ${LONG_REVISION} ` }),
  ]));
  assert.equal(page.records[0].revision, LONG_REVISION);
  assert.equal(typeof page.records[0].revision, 'string');

  assertRecordRejected({ revision: '0' }, /revision/);
  assertRecordRejected({ revision: '-1' }, /revision/);
  assertRecordRejected({ revision: Number(LONG_REVISION) }, /revision/);
  assertRecordRejected({ revision: '1.0' }, /revision/);
});

test('拒绝零字节、超过 512MiB 和数值型 fileSize', () => {
  assertRecordRejected({ fileSize: '0' }, /fileSize/);
  assertRecordRejected({ fileSize: String(MAX_SKYBOX_BYTES + 1) }, /fileSize/);
  assertRecordRejected({ fileSize: 1024 }, /fileSize/);
});

test('SHA-256 必须是 64 位小写十六进制', () => {
  assertRecordRejected({ sha256: 'A'.repeat(64) }, /SHA-256|sha256/);
  assertRecordRejected({ sha256: 'a'.repeat(63) }, /SHA-256|sha256/);
  assertRecordRejected({ sha256: `${'a'.repeat(63)}g` }, /SHA-256|sha256/);
  assertRecordRejected({ sha256: 123 }, /SHA-256|sha256/);
});

test('fileFormat 仅接受 HDR/EXR 且文件扩展名必须一致', () => {
  const exr = normalizeSkyboxQueryResponse(createSuccessResponse([
    createRawRecord({ fileName: 'lighting.EXR', fileFormat: 'EXR' }),
  ]));
  assert.equal(exr.records[0].format, 'exr');

  assertRecordRejected({ fileFormat: 'hdr' }, /fileFormat|格式/);
  assertRecordRejected({ fileFormat: 'PNG' }, /fileFormat|格式/);
  assertRecordRejected({ fileName: 'factory.exr', fileFormat: 'HDR' }, /扩展名|format|格式/);
  assertRecordRejected({ fileName: 'factory', fileFormat: 'HDR' }, /扩展名|format|格式/);
});

test('display name、fileName 和 fileUrl 均不能为空', () => {
  assertRecordRejected({ skyboxName: '   ' }, /skyboxName|displayName|名称/);
  assertRecordRejected({ fileName: '' }, /fileName/);
  assertRecordRejected({ fileUrl: '   ' }, /fileUrl/);
  assertRecordRejected({ fileUrl: null }, /fileUrl/);
});

test('updatedAt 可为 null，非空时必须是有效约定时间字符串', () => {
  const nullable = normalizeSkyboxQueryResponse(createSuccessResponse([
    createRawRecord({ updatedAt: null }),
  ]));
  assert.equal(nullable.records[0].updatedAt, null);

  const iso = normalizeSkyboxQueryResponse(createSuccessResponse([
    createRawRecord({ updatedAt: '2026-08-11T10:20:30.123+08:00' }),
  ]));
  assert.equal(iso.records[0].updatedAt, '2026-08-11T10:20:30.123+08:00');

  assertRecordRejected({ updatedAt: '' }, /updatedAt/);
  assertRecordRejected({ updatedAt: '2026-02-30 10:20:30' }, /updatedAt/);
  assertRecordRejected({ updatedAt: 'not-a-date' }, /updatedAt/);
  assertRecordRejected({ updatedAt: 1786414830000 }, /updatedAt/);
  assertRecordRejected({ updatedAt: undefined }, /updatedAt/);
});

test('assertUniqueSkyboxRecords 拒绝重复 ID', () => {
  assert.throws(
    () => assertUniqueSkyboxRecords([
      createNormalizedRecord(),
      createNormalizedRecord({ displayName: '其他名称', sha256: 'b'.repeat(64) }),
    ]),
    /重复 ID/,
  );
});

test('assertUniqueSkyboxRecords 按 NFKC、trim 和 lowercase 拒绝重复名称', () => {
  assert.throws(
    () => assertUniqueSkyboxRecords([
      createNormalizedRecord({ displayName: ' ＡＢＣ ' }),
      createNormalizedRecord({ id: '2', displayName: 'abc', sha256: 'b'.repeat(64) }),
    ]),
    /重复名称/,
  );
});

test('assertUniqueSkyboxRecords 拒绝重复 SHA-256', () => {
  assert.throws(
    () => assertUniqueSkyboxRecords([
      createNormalizedRecord(),
      createNormalizedRecord({ id: '2', displayName: '其他名称' }),
    ]),
    /重复 SHA-256/,
  );
});
