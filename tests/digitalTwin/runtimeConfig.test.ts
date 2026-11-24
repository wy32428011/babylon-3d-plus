import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNoSensitiveRuntimeConfig,
  isSensitiveRuntimeConfigKey,
} from '../../src/player/runtimeConfigSecurity.ts';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [runtimeConfigModule, effectDataRuntimeModule] = await importIsolatedTypeScriptModules<readonly [
  typeof import('../../src/player/runtimeConfig'),
  typeof import('../../src/runtime/effects/EffectDataRuntime'),
]>([
  'src/player/runtimeConfig.ts',
  'src/runtime/effects/EffectDataRuntime.ts',
]);

const basePlayerConfig = (runtimeConfigEndpoint?: string): any => ({
  version: runtimeConfigEndpoint ? 2 : 1,
  page: { title: 'Viewer', loadingText: 'Loading', backgroundColor: '#10141c' },
  paths: { scene: './project/scene.json', assetManifest: './project/asset-manifest.json', assetBase: './project/assets/' },
  viewer: { showGrid: false, allowCameraControl: true, showStatusOverlay: true },
  mqtt: {
    enabled: false,
    ip: '',
    address: '',
    topic: '',
    subscriptions: [],
    simulatorEnabled: false,
    simulatorAssetCode: '',
    simulatorScenario: 'idle',
    simulatorIntervalMs: 1000,
  },
  ...(runtimeConfigEndpoint ? { digitalTwin: { projectId: '1001', runtimeConfigEndpoint } } : {}),
});

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

test('特效服务根地址与 Fetch apiBaseUrl 解耦：带查询参数与业务路径的 apiBaseUrl 不再阻断启动', () => {
  const projectRuntimeConfig = runtimeConfigModule.parseDigitalTwinProjectRuntimeConfig({
    success: true,
    data: {
      projectId: '1001',
      apiBaseUrl: 'http://wms.internal:9000/api/v1/shelf/stock?warehouse=A&zone=1',
      mqttBrokerUrl: null,
      runtimeEnabled: true,
      configJson: JSON.stringify({ integration: { allowedParentOrigins: ['http://172.30.40.151:8080'] } }),
    },
  });

  assert.equal(projectRuntimeConfig.apiBaseUrl, 'http://wms.internal:9000/api/v1/shelf/stock?warehouse=A&zone=1');

  const resolved = runtimeConfigModule.resolveEffectDataServiceBaseUrl(
    basePlayerConfig('/api/v1/digital-twin/runtime-config/detail'),
    projectRuntimeConfig,
    'http://172.30.40.151:8087/',
  );
  assert.equal(resolved, 'http://172.30.40.151:8087');

  assert.doesNotThrow(() => {
    effectDataRuntimeModule.configureEffectDataTransport({ apiBaseUrl: resolved });
  });
  effectDataRuntimeModule.configureEffectDataTransport(null);
});

test('项目运行配置 apiBaseUrl 保留 GET 业务查询参数（含末尾斜杠值）且继续拦截敏感参数', () => {
  const withTrailingSlashParam = runtimeConfigModule.parseDigitalTwinProjectRuntimeConfig({
    success: true,
    data: {
      projectId: '1001',
      apiBaseUrl: 'http://wms.internal:9000/api/v1/shelf/stock?warehouse=A&path=/zone-1/',
      mqttBrokerUrl: null,
      runtimeEnabled: true,
    },
  });
  assert.equal(
    withTrailingSlashParam.apiBaseUrl,
    'http://wms.internal:9000/api/v1/shelf/stock?warehouse=A&path=/zone-1/',
  );

  const withoutQuery = runtimeConfigModule.parseDigitalTwinProjectRuntimeConfig({
    success: true,
    data: {
      projectId: '1001',
      apiBaseUrl: 'http://wms.internal:9000/api/v1/shelf/stock/',
      mqttBrokerUrl: null,
      runtimeEnabled: true,
    },
  });
  assert.equal(withoutQuery.apiBaseUrl, 'http://wms.internal:9000/api/v1/shelf/stock');

  assert.throws(
    () => runtimeConfigModule.parseDigitalTwinProjectRuntimeConfig({
      success: true,
      data: {
        projectId: '1001',
        apiBaseUrl: 'http://wms.internal:9000/api/v1/shelf/stock?apiKey=secret',
        runtimeEnabled: true,
      },
    }),
    /不能包含敏感查询参数/,
  );
});

test('特效服务根地址按 runtimeConfigEndpoint 推导子路径与跨源根地址，非数字孪生部署返回 null', () => {
  assert.equal(
    runtimeConfigModule.resolveEffectDataServiceBaseUrl(
      basePlayerConfig('/cdp/api/v1/digital-twin/runtime-config/detail'),
      null,
      'http://172.30.40.151:8087/viewer/index.html',
    ),
    'http://172.30.40.151:8087/cdp',
  );
  assert.equal(
    runtimeConfigModule.resolveEffectDataServiceBaseUrl(
      basePlayerConfig('https://cdp.example.com/platform/api/v1/digital-twin/runtime-config/detail?v=2'),
      null,
      'http://172.30.40.151:8087/',
    ),
    'https://cdp.example.com/platform',
  );
  assert.equal(
    runtimeConfigModule.resolveEffectDataServiceBaseUrl(
      basePlayerConfig('./runtime-fixture'),
      null,
      'http://172.30.40.151:8087/viewer/',
    ),
    'http://172.30.40.151:8087',
  );
  assert.equal(
    runtimeConfigModule.resolveEffectDataServiceBaseUrl(
      basePlayerConfig(),
      null,
      'http://172.30.40.151:8087/',
    ),
    null,
  );
});

test('项目扩展配置 configJson.effects.apiBaseUrl 可显式覆盖特效服务根地址并拒绝凭据和查询参数', () => {
  const projectRuntimeConfig = runtimeConfigModule.parseDigitalTwinProjectRuntimeConfig({
    success: true,
    data: {
      projectId: '1001',
      apiBaseUrl: 'https://biz.internal/fetch?warehouse=1',
      runtimeEnabled: true,
      configJson: JSON.stringify({ effects: { apiBaseUrl: 'https://effects.internal/cdp/' } }),
    },
  });

  assert.equal(
    runtimeConfigModule.resolveEffectDataServiceBaseUrl(
      basePlayerConfig('/api/v1/digital-twin/runtime-config/detail'),
      projectRuntimeConfig,
      'http://172.30.40.151:8087/',
    ),
    'https://effects.internal/cdp',
  );

  for (const invalidUrl of [
    'https://user:pass@effects.internal',
    'https://effects.internal/?foo=1',
    'https://effects.internal/#hash',
    'ftp://effects.internal',
  ]) {
    assert.throws(
      () => runtimeConfigModule.parseDigitalTwinEffectDataBaseUrl({ effects: { apiBaseUrl: invalidUrl } }),
      /无凭据、无查询参数和无片段的 HTTP\(S\) 地址/,
    );
  }
});
