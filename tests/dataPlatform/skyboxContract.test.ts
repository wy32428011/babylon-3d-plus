import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertUniqueSkyboxRecords,
  MAX_SKYBOX_FILE_BYTES,
  normalizePositiveIdentifier,
  normalizeSkyboxQueryResponse,
  parseBoundedDecimalString,
  type DataPlatformSkyboxRecord,
} from '../../electron/ipc/dataPlatformSkyboxContract.ts';

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
    fileSize: '1048576',
    fileSha256: VALID_SHA,
    revision: LONG_REVISION,
    updatedAt: '2026-08-11T10:20:30',
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
      total: '1',
      pageNum: '1',
      pageSize: '1',
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

test('从真实响应字段 fileSha256 映射规范化 sha256', () => {
  const page = normalizeSkyboxQueryResponse(createSuccessResponse());

  assert.equal(page.records[0].sha256, VALID_SHA);
  assert.equal('fileSha256' in page.records[0], false);
});

test('归一化合法天空盒分页并保留超出安全整数的 Long 字符串', () => {
  const page = normalizeSkyboxQueryResponse(createSuccessResponse());

  assert.deepEqual(page, {
    records: [{
      id: LONG_ID,
      displayName: '工厂穹顶',
      fileName: 'factory.hdr',
      fileUrl: 'https://cdn.example.com/skyboxes/factory.hdr',
      format: 'hdr',
      fileSizeBytes: 1_048_576,
      sha256: VALID_SHA,
      revision: LONG_REVISION,
      updatedAt: '2026-08-11T10:20:30',
    }],
    total: 1,
    pageNum: 1,
    pageSize: 1,
  });
  assert.equal('untrusted' in page.records[0], false);
  assert.equal('ignored' in page, false);
});

test('分页和文件大小下限恰好通过', () => {
  const emptyPage = normalizeSkyboxQueryResponse(createSuccessResponse(
    [],
    { total: '0', pageNum: '1', pageSize: '1' },
  ));
  assert.deepEqual(emptyPage, { records: [], total: 0, pageNum: 1, pageSize: 1 });

  const minimumFile = normalizeSkyboxQueryResponse(createSuccessResponse([
    createRawRecord({ fileSize: '1' }),
  ]));
  assert.equal(minimumFile.records[0].fileSizeBytes, 1);
});

test('分页和文件大小上限恰好通过', () => {
  assert.equal(MAX_SKYBOX_FILE_BYTES, 512 * 1024 * 1024);

  const maximum = normalizeSkyboxQueryResponse(createSuccessResponse(
    [createRawRecord({ fileSize: String(MAX_SKYBOX_FILE_BYTES) })],
    { total: '100000', pageNum: '1000', pageSize: '100' },
  ));
  assert.equal(maximum.records[0].fileSizeBytes, MAX_SKYBOX_FILE_BYTES);
  assert.deepEqual(
    { total: maximum.total, pageNum: maximum.pageNum, pageSize: maximum.pageSize },
    { total: 100000, pageNum: 1000, pageSize: 100 },
  );
});

test('parseBoundedDecimalString 仅接受范围内且可安全转换的十进制字符串', () => {
  assert.equal(parseBoundedDecimalString(' 42 ', { label: '数量', min: 0, max: 100 }), 42);
  assert.equal(parseBoundedDecimalString('0007', { label: '数量', min: 0n, max: 100n }), 7);

  for (const value of [42, null, undefined, '', ' ', '1.5', '1e2', '0x10', '+1', '-0']) {
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

  for (const value of [LONG_ID.length, 0, '0', '0000', '0001', '-1', '+1', '1.0', '1e2', '', '9'.repeat(65)]) {
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

test('拒绝非普通对象、数组和自定义原型 envelope', () => {
  for (const value of [null, [], new Date('2026-08-11T00:00:00Z')]) {
    assert.throws(() => normalizeSkyboxQueryResponse(value), /响应|结构/);
  }

  const pollutedEnvelope = Object.assign(Object.create({ polluted: true }), createSuccessResponse());
  assert.throws(() => normalizeSkyboxQueryResponse(pollutedEnvelope), /响应|结构/);
});

test('所有契约字段只读取自有属性并抵御 Object.prototype 污染', () => {
  const pollution: Record<string, unknown> = {
    success: true,
    message: '原型污染消息',
    data: createSuccessResponse().data,
    records: [createRawRecord()],
    total: '1',
    pageNum: '1',
    pageSize: '1',
    id: LONG_ID,
    skyboxName: '原型天空盒',
    fileName: 'prototype.hdr',
    fileUrl: 'https://cdn.example.com/prototype.hdr',
    fileFormat: 'HDR',
    fileSize: '1',
    fileSha256: VALID_SHA,
    revision: '1',
    updatedAt: '2026-08-11T10:20:30Z',
  };
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();

  try {
    for (const [key, value] of Object.entries(pollution)) {
      originalDescriptors.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        writable: true,
        value,
      });
    }

    assert.throws(() => normalizeSkyboxQueryResponse({}), /结构不正确/);
    assert.throws(
      () => normalizeSkyboxQueryResponse({ success: false }),
      { message: '查询天空盒失败' },
    );
    assert.throws(
      () => normalizeSkyboxQueryResponse({ success: true, data: {} }),
      /结构不正确/,
    );
    assert.throws(
      () => normalizeSkyboxQueryResponse(createSuccessResponse([{}])),
      /第 1 项|结构不正确|不能为空|无效/,
    );
  } finally {
    for (const [key, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else Reflect.deleteProperty(Object.prototype, key);
    }
  }
});

test('严格校验 data、records 和每条记录均为可信结构', () => {
  assert.throws(() => normalizeSkyboxQueryResponse({ success: true, data: [] }), /data|records/);
  assert.throws(
    () => normalizeSkyboxQueryResponse({ success: true, data: { records: {} } }),
    /data|records/,
  );
  assert.throws(() => normalizeSkyboxQueryResponse(createSuccessResponse([[]])), /不是普通对象/);

  const pollutedRecord = Object.assign(Object.create({ polluted: true }), createRawRecord());
  assert.throws(
    () => normalizeSkyboxQueryResponse(createSuccessResponse([pollutedRecord])),
    /不是普通对象/,
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

test('映射记录前拒绝 records 数量超过 pageSize', () => {
  assert.throws(
    () => normalizeSkyboxQueryResponse(createSuccessResponse(
      Array.from({ length: 101 }, () => null),
      { total: '101', pageSize: '100' },
    )),
    /记录数量.*pageSize/,
  );
});

test('映射记录前拒绝 records 数量超过 total', () => {
  assert.throws(
    () => normalizeSkyboxQueryResponse(createSuccessResponse(
      [null, null],
      { total: '1', pageSize: '2' },
    )),
    /记录数量.*total/,
  );
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
  assertRecordRejected({ revision: '01' }, /revision/);
});

test('拒绝零字节、超过 512MiB 和数值型 fileSize', () => {
  assertRecordRejected({ fileSize: '0' }, /fileSize/);
  assertRecordRejected({ fileSize: String(MAX_SKYBOX_FILE_BYTES + 1) }, /fileSize/);
  assertRecordRejected({ fileSize: 1024 }, /fileSize/);
});

test('SHA-256 必须是 64 位小写十六进制', () => {
  assertRecordRejected({ fileSha256: 'A'.repeat(64) }, /SHA-256|sha256/);
  assertRecordRejected({ fileSha256: 'a'.repeat(63) }, /SHA-256|sha256/);
  assertRecordRejected({ fileSha256: `${'a'.repeat(63)}g` }, /SHA-256|sha256/);
  assertRecordRejected({ fileSha256: 123 }, /SHA-256|sha256/);
  assertRecordRejected({ fileSha256: undefined, sha256: VALID_SHA }, /SHA-256|sha256/);
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

test('updatedAt 可为 null，非空时必须是完整且有效的 date-time', () => {
  const nullable = normalizeSkyboxQueryResponse(createSuccessResponse([
    createRawRecord({ updatedAt: null }),
  ]));
  assert.equal(nullable.records[0].updatedAt, null);

  for (const updatedAt of [
    '2026-08-11T10:20:30',
    '2026-08-11T10:20:30.123+08:00',
    '2024-02-29T23:59:59Z',
    '2026-08-11T00:00:00+14:00',
    '2026-08-11T00:00:00-14:00',
  ]) {
    const page = normalizeSkyboxQueryResponse(createSuccessResponse([
      createRawRecord({ updatedAt }),
    ]));
    assert.equal(page.records[0].updatedAt, updatedAt);
  }

  for (const updatedAt of [
    '',
    '2026-08-11',
    '2026-08-11 10:20:30',
    '2026-02-29T10:20:30',
    '2024-02-30T10:20:30',
    '2026-08-11T24:00:00',
    '2026-08-11T23:60:00',
    '2026-08-11T23:59:60',
    '2026-08-11T00:00:00+14:01',
    '2026-08-11T00:00:00-14:01',
    '2026-08-11T00:00:00+15:00',
    '2026-08-11T00:00:00+08:60',
    'not-a-date',
  ]) {
    assertRecordRejected({ updatedAt }, /updatedAt/);
  }
  assertRecordRejected({ updatedAt: 1786414830000 }, /updatedAt/);
  assertRecordRejected({ updatedAt: undefined }, /updatedAt/);
});

test('完整 response 拒绝重复 ID', () => {
  assert.throws(
    () => normalizeSkyboxQueryResponse(createSuccessResponse([
      createRawRecord(),
      createRawRecord({ skyboxName: '其他名称', fileSha256: 'b'.repeat(64) }),
    ], { total: '2', pageSize: '2' })),
    /重复 ID/,
  );
});

test('完整 response 按 NFKC、trim 和 lowercase 拒绝重复名称', () => {
  assert.throws(
    () => normalizeSkyboxQueryResponse(createSuccessResponse([
      createRawRecord({ skyboxName: ' ＡＢＣ ' }),
      createRawRecord({ id: '2', skyboxName: 'abc', fileSha256: 'b'.repeat(64) }),
    ], { total: '2', pageSize: '2' })),
    /重复名称/,
  );
});

test('完整 response 拒绝重复 SHA-256', () => {
  assert.throws(
    () => normalizeSkyboxQueryResponse(createSuccessResponse([
      createRawRecord(),
      createRawRecord({ id: '2', skyboxName: '其他名称' }),
    ], { total: '2', pageSize: '2' })),
    /重复 SHA-256/,
  );
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
