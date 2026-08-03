import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNoSensitiveRuntimeConfig,
  isSensitiveRuntimeConfigKey,
} from '../../src/player/runtimeConfigSecurity.ts';

test('运行配置敏感字段识别覆盖空格、分隔符和常见令牌后缀', () => {
  for (const key of ['api key', 'api_key', 'refresh-token', 'mqttPassword', 'client.secret', 'service credentials']) {
    assert.equal(isSensitiveRuntimeConfigKey(key), true, key);
  }
  for (const key of ['telemetryInterval', 'tokenExpirySeconds', 'credentialMode']) {
    assert.equal(isSensitiveRuntimeConfigKey(key), false, key);
  }
});

test('运行配置敏感字段递归校验覆盖对象与数组', () => {
  assert.doesNotThrow(() => assertNoSensitiveRuntimeConfig({ telemetry: [{ interval: 1000 }] }, 'config'));
  assert.throws(
    () => assertNoSensitiveRuntimeConfig({ nested: [{ 'refresh-token': 'secret' }] }, 'config'),
    /不能包含密码、令牌、API Key 或凭据/,
  );
});
