import {
  STACKER_SIMULATION_SCENARIOS,
  type MqttAdapterConfig,
  type MqttConfig,
  type MqttSubscriptionConfig,
  type StackerSimulationScenario,
} from '../editor/model/SceneDocument';
import { assertNoSensitiveRuntimeConfig, isSensitiveRuntimeConfigKey } from './runtimeConfigSecurity';

/** Web Viewer 启动配置。 */
export type PlayerRuntimeConfig = {
  version: 1 | 2;
  page: {
    title: string;
    loadingText: string;
    backgroundColor: string;
  };
  paths: {
    scene: string;
    assetManifest: string;
    assetBase: string;
  };
  viewer: {
    showGrid: boolean;
    allowCameraControl: boolean;
    showStatusOverlay: boolean;
  };
  mqtt: MqttConfig;
  digitalTwin?: {
    projectId: string;
    runtimeConfigEndpoint: string;
  };
};

export type DigitalTwinProjectRuntimeConfig = {
  projectId: string;
  mqttBrokerUrl: string | null;
  apiBaseUrl: string | null;
  runtimeEnabled: boolean;
  config: Record<string, unknown>;
};

type JsonObject = Record<string, unknown>;


/** 将未知值严格断言为普通 JSON 对象。 */
function assertObject(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path} 必须是普通 JSON 对象。`);
  }
  return value as JsonObject;
}

/** 限定对象键集合，避免拼写错误被静默忽略。 */
function assertKeys(value: JsonObject, keys: readonly string[], path: string): void {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${path} 字段必须严格为：${keys.join(', ')}。`);
  }
}

/** 读取长度受限字符串。 */
function assertString(value: unknown, path: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${path} 必须是字符串。`);
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > maxLength) throw new Error(`${path} 内容无效。`);
  return normalized;
}

/** 读取布尔配置。 */
function assertBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} 必须是布尔值。`);
  return value;
}

/** 校验相对部署路径或 HTTP(S) URL。 */
function assertDeployUrl(value: unknown, path: string, directory = false): string {
  const source = assertString(value, path, 2048);
  const resolved = new URL(source, document.baseURI);
  if (!['http:', 'https:'].includes(resolved.protocol) || resolved.username || resolved.password || resolved.hash) {
    throw new Error(`${path} 必须是无凭据、无片段的相对路径或 HTTP(S) URL。`);
  }
  if (directory && !resolved.pathname.endsWith('/')) throw new Error(`${path} 必须以 / 结尾。`);
  return source;
}

/** 从项目扩展配置读取允许嵌入 Viewer 的跨域父页面 Origin；同源无需配置。 */
export function parseDigitalTwinAllowedParentOrigins(config: Record<string, unknown>): string[] {
  if (!Object.hasOwn(config, 'integration')) return [];
  const integration = assertObject(config.integration, '项目运行配置 configJson.integration');
  if (!Object.hasOwn(integration, 'allowedParentOrigins')) return [];
  const rawOrigins = integration.allowedParentOrigins;
  if (!Array.isArray(rawOrigins) || rawOrigins.length > 64) {
    throw new Error('项目运行配置 configJson.integration.allowedParentOrigins 必须是最多 64 项的数组。');
  }

  const origins: string[] = [];
  const seen = new Set<string>();
  rawOrigins.forEach((value, index) => {
    const path = `项目运行配置 configJson.integration.allowedParentOrigins[${index}]`;
    const source = assertString(value, path, 2048);
    if (source === '*') {
      if (seen.has('*')) return;
      seen.add('*');
      origins.push('*');
      return;
    }

    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new Error(`${path} 不是有效 Origin。`);
    }
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
      || url.origin === 'null'
    ) {
      throw new Error(`${path} 必须是无凭据、无路径、无查询和无片段的 HTTP(S) Origin。`);
    }
    if (seen.has(url.origin)) return;
    seen.add(url.origin);
    origins.push(url.origin);
  });
  return origins;
}

/** 严格解析 MQTT 适配器配置。 */
function parseMqttAdapter(value: unknown, path: string): MqttAdapterConfig {
  const adapter = assertObject(value, path);
  if (adapter.kind === 'epv') {
    const allowed = ['kind', ...('sourceId' in adapter ? ['sourceId'] : []), ...('deviceType' in adapter ? ['deviceType'] : [])];
    assertKeys(adapter, allowed, path);
    return {
      kind: 'epv',
      ...('sourceId' in adapter ? { sourceId: assertString(adapter.sourceId, `${path}.sourceId`, 128) } : {}),
      ...('deviceType' in adapter ? { deviceType: assertString(adapter.deviceType, `${path}.deviceType`, 128) } : {}),
    };
  }

  if (adapter.kind !== 'json-path') throw new Error(`${path}.kind 不受支持。`);
  const optionalKeys = ['sourceId', 'deviceTypePath', 'assetCodePath', 'timestampPath', 'sequencePath'].filter((key) => key in adapter);
  assertKeys(adapter, ['kind', 'fields', ...optionalKeys], path);
  const fieldsObject = assertObject(adapter.fields, `${path}.fields`);
  if (Object.keys(fieldsObject).length > 128) throw new Error(`${path}.fields 数量超过限制。`);
  const fields = Object.fromEntries(Object.entries(fieldsObject).map(([key, fieldPath]) => [
    assertString(key, `${path}.fields 键`, 128),
    assertString(fieldPath, `${path}.fields.${key}`, 256),
  ]));
  return {
    kind: 'json-path',
    fields,
    ...Object.fromEntries(optionalKeys.map((key) => [key, assertString(adapter[key], `${path}.${key}`, 256)])),
  } as MqttAdapterConfig;
}

/** 严格解析单条 MQTT 订阅。 */
function parseMqttSubscription(value: unknown, index: number): MqttSubscriptionConfig {
  const path = `runtime-config.mqtt.subscriptions[${index}]`;
  const subscription = assertObject(value, path);
  assertKeys(subscription, ['topic', 'qos', 'adapter'], path);
  if (subscription.qos !== 0 && subscription.qos !== 1) throw new Error(`${path}.qos 仅支持 0 或 1。`);
  return {
    topic: assertString(subscription.topic, `${path}.topic`, 512),
    qos: subscription.qos,
    adapter: parseMqttAdapter(subscription.adapter, `${path}.adapter`),
  };
}

/** 校验浏览器 MQTT 地址不包含账号、密码或常见敏感查询参数。 */
function isSafeBrowserMqttAddress(address: string): boolean {
  try {
    const url = new URL(address);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) return false;
    return [...url.searchParams.keys()].every((key) => !isSensitiveRuntimeConfigKey(key));
  } catch {
    return false;
  }
}

/** 严格解析 Viewer MQTT 配置。 */
function parseMqttConfig(value: unknown): MqttConfig {
  const path = 'runtime-config.mqtt';
  const mqtt = assertObject(value, path);
  assertKeys(mqtt, ['enabled', 'ip', 'address', 'topic', 'subscriptions', 'simulatorEnabled', 'simulatorAssetCode', 'simulatorScenario', 'simulatorIntervalMs'], path);
  if (!Array.isArray(mqtt.subscriptions) || mqtt.subscriptions.length > 32) throw new Error(`${path}.subscriptions 必须是不超过 32 项的数组。`);
  if (!STACKER_SIMULATION_SCENARIOS.includes(mqtt.simulatorScenario as StackerSimulationScenario)) {
    throw new Error(`${path}.simulatorScenario 不受支持。`);
  }
  if (!Number.isInteger(mqtt.simulatorIntervalMs) || Number(mqtt.simulatorIntervalMs) < 100) {
    throw new Error(`${path}.simulatorIntervalMs 必须是大于等于 100 的整数。`);
  }
  const address = assertString(mqtt.address, `${path}.address`, 2048, true);
  if (address && !isSafeBrowserMqttAddress(address)) {
    throw new Error(`${path}.address 必须是无凭据、无敏感查询参数的 ws:// 或 wss:// URL。`);
  }
  return {
    enabled: assertBoolean(mqtt.enabled, `${path}.enabled`),
    ip: assertString(mqtt.ip, `${path}.ip`, 256, true),
    address,
    topic: assertString(mqtt.topic, `${path}.topic`, 2048, true),
    subscriptions: mqtt.subscriptions.map(parseMqttSubscription),
    simulatorEnabled: assertBoolean(mqtt.simulatorEnabled, `${path}.simulatorEnabled`),
    simulatorAssetCode: assertString(mqtt.simulatorAssetCode, `${path}.simulatorAssetCode`, 128, true),
    simulatorScenario: mqtt.simulatorScenario as StackerSimulationScenario,
    simulatorIntervalMs: Number(mqtt.simulatorIntervalMs),
  };
}

/** 解析数据中台项目级运行配置响应，所有 URL 均拒绝内嵌凭据。 */
export function parseDigitalTwinProjectRuntimeConfig(value: unknown): DigitalTwinProjectRuntimeConfig {
  const envelope = assertObject(value, 'digital-twin-runtime-config');
  if (envelope.success !== true) throw new Error(typeof envelope.message === 'string' ? envelope.message : '读取项目运行配置失败。');
  const data = assertObject(envelope.data, 'digital-twin-runtime-config.data');
  const projectId = typeof data.projectId === 'string'
    ? data.projectId.trim()
    : typeof data.projectId === 'number' && Number.isSafeInteger(data.projectId) ? String(data.projectId) : '';
  if (!/^[1-9]\d{0,63}$/.test(projectId)) throw new Error('项目运行配置 projectId 无效。');
  const mqttBrokerUrl = parseOptionalSafeUrl(data.mqttBrokerUrl, '项目运行配置 mqttBrokerUrl', ['ws:', 'wss:']);
  const apiBaseUrl = parseOptionalSafeUrl(data.apiBaseUrl, '项目运行配置 apiBaseUrl', ['http:', 'https:']);
  let config: Record<string, unknown> = {};
  if (typeof data.configJson === 'string' && data.configJson.trim()) {
    try {
      const parsed = JSON.parse(data.configJson) as unknown;
      config = assertObject(parsed, '项目运行配置 configJson');
      assertNoSensitiveRuntimeConfig(config, '项目运行配置 configJson');
    } catch (error) {
      throw new Error(`项目运行配置 configJson 无效：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    projectId,
    mqttBrokerUrl,
    apiBaseUrl,
    runtimeEnabled: data.runtimeEnabled !== false,
    config,
  };
}

function parseOptionalSafeUrl(value: unknown, path: string, protocols: string[]): string | null {
  if (value === null || value === undefined || value === '') return null;
  const source = assertString(value, path, 2048);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`${path} 不是有效 URL。`);
  }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash) throw new Error(`${path} 协议或凭据无效。`);
  if ([...url.searchParams.keys()].some(isSensitiveRuntimeConfigKey)) throw new Error(`${path} 不能包含敏感查询参数。`);
  return url.toString().replace(/\/+$/, '');
}
/** 严格解析 runtime-config.json，任何未知或缺失字段都会阻断启动。 */
export function parsePlayerRuntimeConfig(value: unknown): PlayerRuntimeConfig {
  const config = assertObject(value, 'runtime-config');
  const isDigitalTwin = config.version === 2;
  if (config.version !== 1 && !isDigitalTwin) throw new Error('runtime-config.version 仅支持 1 或 2。');
  assertKeys(config, isDigitalTwin ? ['version', 'page', 'paths', 'viewer', 'mqtt', 'digitalTwin'] : ['version', 'page', 'paths', 'viewer', 'mqtt'], 'runtime-config');

  const page = assertObject(config.page, 'runtime-config.page');
  const paths = assertObject(config.paths, 'runtime-config.paths');
  const viewer = assertObject(config.viewer, 'runtime-config.viewer');
  assertKeys(page, ['title', 'loadingText', 'backgroundColor'], 'runtime-config.page');
  assertKeys(paths, ['scene', 'assetManifest', 'assetBase'], 'runtime-config.paths');
  assertKeys(viewer, ['showGrid', 'allowCameraControl', 'showStatusOverlay'], 'runtime-config.viewer');
  const backgroundColor = assertString(page.backgroundColor, 'runtime-config.page.backgroundColor', 7);
  if (!/^#[0-9a-f]{6}$/i.test(backgroundColor)) throw new Error('runtime-config.page.backgroundColor 必须是 #RRGGBB。');

  let digitalTwin: PlayerRuntimeConfig['digitalTwin'];
  if (isDigitalTwin) {
    const projectConfig = assertObject(config.digitalTwin, 'runtime-config.digitalTwin');
    assertKeys(projectConfig, ['projectId', 'runtimeConfigEndpoint'], 'runtime-config.digitalTwin');
    const projectId = assertString(projectConfig.projectId, 'runtime-config.digitalTwin.projectId', 64);
    if (!/^[1-9]\d{0,63}$/.test(projectId)) throw new Error('runtime-config.digitalTwin.projectId 无效。');
    digitalTwin = {
      projectId,
      runtimeConfigEndpoint: assertDeployUrl(projectConfig.runtimeConfigEndpoint, 'runtime-config.digitalTwin.runtimeConfigEndpoint'),
    };
  }

  return {
    version: config.version as 1 | 2,
    page: {
      title: assertString(page.title, 'runtime-config.page.title', 200),
      loadingText: assertString(page.loadingText, 'runtime-config.page.loadingText', 200),
      backgroundColor,
    },
    paths: {
      scene: assertDeployUrl(paths.scene, 'runtime-config.paths.scene'),
      assetManifest: assertDeployUrl(paths.assetManifest, 'runtime-config.paths.assetManifest'),
      assetBase: assertDeployUrl(paths.assetBase, 'runtime-config.paths.assetBase', true),
    },
    viewer: {
      showGrid: assertBoolean(viewer.showGrid, 'runtime-config.viewer.showGrid'),
      allowCameraControl: assertBoolean(viewer.allowCameraControl, 'runtime-config.viewer.allowCameraControl'),
      showStatusOverlay: assertBoolean(viewer.showStatusOverlay, 'runtime-config.viewer.showStatusOverlay'),
    },
    mqtt: parseMqttConfig(config.mqtt),
    ...(digitalTwin ? { digitalTwin } : {}),
  };
}
/** 严格解析资源清单并生成虚拟 URL 到部署 URL 的映射。 */
export function parseDeploymentAssetManifest(value: unknown, assetBaseUrl: URL): Record<string, string> {
  const manifest = assertObject(value, 'asset-manifest');
  const collectionKey = 'assets' in manifest ? 'assets' : 'entries' in manifest ? 'entries' : '';
  if (!collectionKey) throw new Error('asset-manifest 缺少 assets。');
  assertKeys(manifest, ['version', collectionKey], 'asset-manifest');
  if (manifest.version !== 1) throw new Error('asset-manifest.version 仅支持 1。');

  const mappings: Record<string, string> = {};
  const collection = manifest[collectionKey];
  if (Array.isArray(collection)) {
    collection.forEach((rawEntry, index) => {
      const entry = assertObject(rawEntry, `asset-manifest.${collectionKey}[${index}]`);
      const pathKey = 'path' in entry ? 'path' : 'relativePath' in entry ? 'relativePath' : '';
      const sourceKey = 'logicalUrl' in entry ? 'logicalUrl' : 'sourceUrl' in entry ? 'sourceUrl' : 'virtualUrl' in entry ? 'virtualUrl' : '';
      if (!pathKey || !sourceKey) throw new Error(`asset-manifest.${collectionKey}[${index}] 缺少资源 URL 或路径。`);
      const sourceUrl = assertString(entry[sourceKey], `asset-manifest.${collectionKey}[${index}].${sourceKey}`, 8192);
      const relativePath = assertString(entry[pathKey], `asset-manifest.${collectionKey}[${index}].${pathKey}`, 2048);
      mappings[sourceUrl] = new URL(relativePath, assetBaseUrl).href;
    });
  } else {
    const assets = assertObject(collection, `asset-manifest.${collectionKey}`);
    for (const [sourceUrl, rawEntry] of Object.entries(assets)) {
      const entry = typeof rawEntry === 'string' ? rawEntry : assertString(assertObject(rawEntry, `asset-manifest.${collectionKey}.${sourceUrl}`).path, `asset-manifest.${collectionKey}.${sourceUrl}.path`, 2048);
      mappings[sourceUrl] = new URL(entry, assetBaseUrl).href;
    }
  }
  return mappings;
}
