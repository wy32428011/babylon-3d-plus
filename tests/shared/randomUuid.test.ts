import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRandomUuid,
  installRandomUuidFallback,
  type RandomUuidCrypto,
} from '../../src/shared/randomUuid.ts';

test('优先使用浏览器原生 randomUUID', () => {
  let getRandomValuesCalled = false;
  const uuid = createRandomUuid({
    randomUUID: () => '11111111-2222-4333-8444-555555555555',
    getRandomValues: (array) => {
      getRandomValuesCalled = true;
      return array;
    },
  });

  assert.equal(uuid, '11111111-2222-4333-8444-555555555555');
  assert.equal(getRandomValuesCalled, false);
});

test('非安全上下文缺少 randomUUID 时使用 getRandomValues 生成 UUID v4', () => {
  const uuid = createRandomUuid({
    getRandomValues: (array) => {
      const bytes = array as Uint8Array;
      bytes.set(Array.from({ length: bytes.length }, (_, index) => index));
      return array;
    },
  });

  assert.equal(uuid, '00010203-0405-4607-8809-0a0b0c0d0e0f');
});

test('Viewer 启动时可为 crypto 安装 randomUUID 兼容方法', () => {
  const cryptoApi: RandomUuidCrypto = {
    getRandomValues: (array) => {
      (array as Uint8Array).fill(0xab);
      return array;
    },
  };

  installRandomUuidFallback(cryptoApi);

  assert.equal(typeof cryptoApi.randomUUID, 'function');
  assert.equal(cryptoApi.randomUUID?.(), 'abababab-abab-4bab-abab-abababababab');
});

test('Viewer 启动时不覆盖浏览器原生 randomUUID', () => {
  const nativeRandomUuid = () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const cryptoApi: RandomUuidCrypto = {
    randomUUID: nativeRandomUuid,
    getRandomValues: (array) => array,
  };

  installRandomUuidFallback(cryptoApi);

  assert.equal(cryptoApi.randomUUID, nativeRandomUuid);
});

test('Web Crypto 完全不可用时给出明确错误', () => {
  assert.throws(
    () => createRandomUuid({} as Parameters<typeof createRandomUuid>[0]),
    /当前浏览器不支持 Web Crypto 随机数生成/,
  );
});
