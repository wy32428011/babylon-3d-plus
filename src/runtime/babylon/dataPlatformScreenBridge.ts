export const DATA_PLATFORM_SCREEN_BRIDGE_CHANNEL = 'zending.data-platform-screen.bridge' as const;
export const DATA_PLATFORM_SCREEN_BRIDGE_VERSION = 1 as const;
export const DATA_PLATFORM_SCREEN_EMBED_CHANNEL = 'zending.data-platform-screen.embed' as const;
export const DATA_PLATFORM_SCREEN_EMBED_VERSION = 1 as const;

type ViewportSceneWindow = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 给数据中台页面增加嵌入标记；页面据此自行挖空中央区域，避免宿主裁剪 iframe 导致文字栅格化。 */
export function createDataPlatformScreenEmbedUrl(
  screenUrl: string,
  sceneWindow: ViewportSceneWindow,
): string {
  const url = new URL(screenUrl, typeof window === 'undefined' ? 'http://localhost/' : window.location.href);
  url.searchParams.set('zending3dEmbed', '1');
  url.searchParams.set(
    'zending3dSceneWindow',
    [sceneWindow.x, sceneWindow.y, sceneWindow.width, sceneWindow.height]
      .map((value) => value.toFixed(6))
      .join(','),
  );
  return url.toString();
}

/** 只接受页面主动声明的嵌入能力，普通外部页面继续走兼容裁剪路径。 */
export function isDataPlatformScreenEmbedReady(value: unknown): boolean {
  return isRecord(value)
    && value.channel === DATA_PLATFORM_SCREEN_EMBED_CHANNEL
    && value.version === DATA_PLATFORM_SCREEN_EMBED_VERSION
    && value.type === 'embed.ready';
}

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_ENTITY_COUNT = 64;

type DataPlatformScreenBridgeEnvelope = {
  channel: typeof DATA_PLATFORM_SCREEN_BRIDGE_CHANNEL;
  version: typeof DATA_PLATFORM_SCREEN_BRIDGE_VERSION;
};

export type DataPlatformScreenTarget = {
  entityId?: string;
  assetCode?: string;
};

export type DataPlatformScreenCommand = DataPlatformScreenBridgeEnvelope & (
  | {
      type: 'screen.selectEntity' | 'screen.focusEntity';
      payload: DataPlatformScreenTarget;
    }
  | {
      type: 'screen.clearSelection';
      payload: Record<string, never>;
    }
);

export type DataPlatformScreenSelectionMessage = DataPlatformScreenBridgeEnvelope & {
  type: 'viewer.selectionChanged';
  payload: {
    entityIds: string[];
    primaryEntityId: string | null;
    source: '3d';
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH;
}

function parseTarget(value: unknown): DataPlatformScreenTarget | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.keys(value).every((key) => ['entityId', 'assetCode'].includes(key))) return null;
  const entityId = value.entityId;
  const assetCode = value.assetCode;
  const hasEntityId = isIdentifier(entityId);
  const hasAssetCode = isIdentifier(assetCode);
  if (hasEntityId === hasAssetCode) return null;
  if (hasEntityId) return { entityId: entityId.trim() };
  if (hasAssetCode) return { assetCode: assetCode.trim() };
  return null;
}

/** 严格解析可信 iframe 发来的大屏联动指令；未知字段和多重目标直接丢弃。 */
export function parseDataPlatformScreenCommand(value: unknown): DataPlatformScreenCommand | null {
  if (!isRecord(value)
    || value.channel !== DATA_PLATFORM_SCREEN_BRIDGE_CHANNEL
    || value.version !== DATA_PLATFORM_SCREEN_BRIDGE_VERSION
    || typeof value.type !== 'string') {
    return null;
  }

  if (value.type === 'screen.clearSelection') {
    return hasOnlyKeys(value, ['channel', 'version', 'type', 'payload'])
      && isRecord(value.payload)
      && hasOnlyKeys(value.payload, [])
      ? value as DataPlatformScreenCommand
      : null;
  }

  if (value.type !== 'screen.selectEntity' && value.type !== 'screen.focusEntity') return null;
  const payload = parseTarget(value.payload);
  return hasOnlyKeys(value, ['channel', 'version', 'type', 'payload']) && payload
    ? { ...value, payload } as DataPlatformScreenCommand
    : null;
}

/** 构造 Viewer → 大屏的当前三维选中状态消息。 */
export function createDataPlatformScreenSelectionMessage(
  rawEntityIds: readonly string[],
  rawPrimaryEntityId: string | null,
): DataPlatformScreenSelectionMessage {
  const entityIds: string[] = [];
  for (const entityId of rawEntityIds) {
    if (!isIdentifier(entityId) || entityIds.includes(entityId.trim())) continue;
    entityIds.push(entityId.trim());
    if (entityIds.length >= MAX_ENTITY_COUNT) break;
  }
  const primaryEntityId = rawPrimaryEntityId && entityIds.includes(rawPrimaryEntityId.trim())
    ? rawPrimaryEntityId.trim()
    : null;
  return {
    channel: DATA_PLATFORM_SCREEN_BRIDGE_CHANNEL,
    version: DATA_PLATFORM_SCREEN_BRIDGE_VERSION,
    type: 'viewer.selectionChanged',
    payload: { entityIds, primaryEntityId, source: '3d' },
  };
}
