export const DIGITAL_TWIN_BRIDGE_CHANNEL = 'zending.digital-twin.bridge' as const;
export const DIGITAL_TWIN_BRIDGE_VERSION = 1 as const;
export const DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY = 'focusAsset' as const;

export const DIGITAL_TWIN_VIEWER_ERROR_CODES = [
  'INVALID_ASSET_CODE',
  'ASSET_NOT_FOUND',
  'ASSET_CODE_AMBIGUOUS',
  'ASSET_NOT_VISIBLE',
  'ASSET_GEOMETRY_NOT_READY',
  'COMMAND_CANCELLED',
  'UNSUPPORTED_COMMAND',
  'INTERNAL_ERROR',
] as const;

export type DigitalTwinViewerErrorCode = (typeof DIGITAL_TWIN_VIEWER_ERROR_CODES)[number];
export type DigitalTwinCapability = typeof DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY;

export type DigitalTwinHostHelloMessage = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'host.hello';
};

export type DigitalTwinBridgeReadyMessage = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'bridge.ready';
};

export type DigitalTwinViewerReadyMessage = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'viewer.ready';
  payload: {
    projectId?: string;
    capabilities: DigitalTwinCapability[];
  };
};

export type DigitalTwinFocusAssetCommand = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'command.focusAsset';
  requestId: string;
  payload: {
    assetCode: string;
  };
};

export type DigitalTwinCancelFocusAssetCommand = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'command.cancelFocusAsset';
  requestId: string;
};

export type DigitalTwinCommandSuccessResult = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'command.result';
  requestId: string;
  ok: true;
  payload: {
    assetCode: string;
    entityIds: string[];
  };
};

export type DigitalTwinCommandFailureResult = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'command.result';
  requestId: string;
  ok: false;
  error: {
    code: DigitalTwinViewerErrorCode;
    message: string;
  };
};

export type DigitalTwinCommandResult = DigitalTwinCommandSuccessResult | DigitalTwinCommandFailureResult;

export type DigitalTwinBridgeMessage =
  | DigitalTwinHostHelloMessage
  | DigitalTwinBridgeReadyMessage
  | DigitalTwinViewerReadyMessage
  | DigitalTwinFocusAssetCommand
  | DigitalTwinCancelFocusAssetCommand
  | DigitalTwinCommandResult;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_PROJECT_ID_LENGTH = 64;
const MAX_CAPABILITY_LENGTH = 64;
const MAX_CAPABILITY_COUNT = 16;
const MAX_ASSET_CODE_LENGTH = 128;
const MAX_ENTITY_ID_LENGTH = 256;
const MAX_ENTITY_COUNT = 64;
const MAX_ERROR_MESSAGE_LENGTH = 1024;
const VIEWER_ERROR_CODE_SET = new Set<string>(DIGITAL_TWIN_VIEWER_ERROR_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowedKeys.length && keys.every((key) => allowedKeys.includes(key));
}

function hasAllowedKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isBoundedString(value: unknown, maxLength: number, trim = true): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return false;
  return !trim || value.trim().length > 0;
}

function isBaseEnvelope(value: Record<string, unknown>): boolean {
  return value.channel === DIGITAL_TWIN_BRIDGE_CHANNEL
    && value.version === DIGITAL_TWIN_BRIDGE_VERSION
    && isBoundedString(value.sessionId, MAX_IDENTIFIER_LENGTH);
}

function isCapabilities(value: unknown): value is DigitalTwinCapability[] {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITY_COUNT) return false;
  const capabilities = value.filter((entry): entry is string => isBoundedString(entry, MAX_CAPABILITY_LENGTH));
  return capabilities.length === value.length
    && new Set(capabilities).size === capabilities.length
    && capabilities.every((entry) => entry === DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY);
}

function isViewerReadyPayload(value: unknown): value is DigitalTwinViewerReadyMessage['payload'] {
  if (!isRecord(value) || !hasAllowedKeys(value, ['projectId', 'capabilities'])) return false;
  if (!Object.hasOwn(value, 'capabilities') || !isCapabilities(value.capabilities)) return false;
  return value.projectId === undefined || isBoundedString(value.projectId, MAX_PROJECT_ID_LENGTH);
}

function isFocusAssetPayload(value: unknown): value is DigitalTwinFocusAssetCommand['payload'] {
  return isRecord(value)
    && hasOnlyKeys(value, ['assetCode'])
    && isBoundedString(value.assetCode, MAX_ASSET_CODE_LENGTH);
}

function isSuccessPayload(value: unknown): value is DigitalTwinCommandSuccessResult['payload'] {
  if (!isRecord(value) || !hasOnlyKeys(value, ['assetCode', 'entityIds'])) return false;
  if (!isBoundedString(value.assetCode, MAX_ASSET_CODE_LENGTH)) return false;
  if (!Array.isArray(value.entityIds) || value.entityIds.length === 0 || value.entityIds.length > MAX_ENTITY_COUNT) return false;
  const entityIds = value.entityIds.filter((entry): entry is string => isBoundedString(entry, MAX_ENTITY_ID_LENGTH));
  return entityIds.length === value.entityIds.length && new Set(entityIds).size === entityIds.length;
}

function isFailureError(value: unknown): value is DigitalTwinCommandFailureResult['error'] {
  return isRecord(value)
    && hasOnlyKeys(value, ['code', 'message'])
    && typeof value.code === 'string'
    && VIEWER_ERROR_CODE_SET.has(value.code)
    && isBoundedString(value.message, MAX_ERROR_MESSAGE_LENGTH);
}

/** 严格解析宿主与发布 Viewer 的 v1 交互消息；非法或未知消息返回 null。 */
export function parseDigitalTwinBridgeMessage(value: unknown): DigitalTwinBridgeMessage | null {
  if (!isRecord(value) || !isBaseEnvelope(value) || typeof value.type !== 'string') return null;

  switch (value.type) {
    case 'host.hello':
    case 'bridge.ready':
      return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type'])
        ? value as DigitalTwinHostHelloMessage | DigitalTwinBridgeReadyMessage
        : null;
    case 'viewer.ready':
      return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type', 'payload'])
        && isViewerReadyPayload(value.payload)
        ? value as DigitalTwinViewerReadyMessage
        : null;
    case 'command.focusAsset':
      return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type', 'requestId', 'payload'])
        && isBoundedString(value.requestId, MAX_IDENTIFIER_LENGTH)
        && isFocusAssetPayload(value.payload)
        ? value as DigitalTwinFocusAssetCommand
        : null;
    case 'command.cancelFocusAsset':
      return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type', 'requestId'])
        && isBoundedString(value.requestId, MAX_IDENTIFIER_LENGTH)
        ? value as DigitalTwinCancelFocusAssetCommand
        : null;
    case 'command.result': {
      if (!isBoundedString(value.requestId, MAX_IDENTIFIER_LENGTH) || typeof value.ok !== 'boolean') return null;
      if (value.ok) {
        return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type', 'requestId', 'ok', 'payload'])
          && isSuccessPayload(value.payload)
          ? value as DigitalTwinCommandSuccessResult
          : null;
      }
      return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type', 'requestId', 'ok', 'error'])
        && isFailureError(value.error)
        ? value as DigitalTwinCommandFailureResult
        : null;
    }
    default:
      return null;
  }
}
