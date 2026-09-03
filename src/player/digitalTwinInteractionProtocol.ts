export const DIGITAL_TWIN_BRIDGE_CHANNEL = 'zending.digital-twin.bridge' as const;
export const DIGITAL_TWIN_BRIDGE_VERSION = 1 as const;
export const DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY = 'hardwareGpu' as const;
export const DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY = 'focusAsset' as const;
export const DIGITAL_TWIN_START_AUTO_PATROL_CAPABILITY = 'startAutoPatrol' as const;
export const DIGITAL_TWIN_START_MANUAL_ROAM_CAPABILITY = 'startManualRoam' as const;
export const DIGITAL_TWIN_INITIAL_LOAD_PHASES = ['loading', 'complete'] as const;

export const DIGITAL_TWIN_RUNTIME_ACTIONS = [
  DIGITAL_TWIN_START_AUTO_PATROL_CAPABILITY,
  DIGITAL_TWIN_START_MANUAL_ROAM_CAPABILITY,
] as const;

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
export type DigitalTwinRuntimeAction = (typeof DIGITAL_TWIN_RUNTIME_ACTIONS)[number];
export type DigitalTwinInitialLoadPhase = (typeof DIGITAL_TWIN_INITIAL_LOAD_PHASES)[number];
export type DigitalTwinCapability =
  | typeof DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY
  | typeof DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY
  | DigitalTwinRuntimeAction;

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

export type DigitalTwinViewerInitialLoadStateMessage = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'viewer.initialLoadState';
  payload: {
    phase: DigitalTwinInitialLoadPhase;
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

export type DigitalTwinStartAutoPatrolCommand = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'command.startAutoPatrol';
  requestId: string;
};

export type DigitalTwinStartManualRoamCommand = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'command.startManualRoam';
  requestId: string;
};

export type DigitalTwinRuntimeActionCommand =
  | DigitalTwinStartAutoPatrolCommand
  | DigitalTwinStartManualRoamCommand;

export type DigitalTwinCommandSuccessPayload =
  | {
      assetCode: string;
      entityIds: string[];
    }
  | {
      action: DigitalTwinRuntimeAction;
    };

export type DigitalTwinCommandSuccessResult = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'command.result';
  requestId: string;
  ok: true;
  payload: DigitalTwinCommandSuccessPayload;
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

/** 点击单元时货格的库位坐标（排-列-层）。 */
export type DigitalTwinAssetClickedSlot = {
  row: number;
  column: number;
  layer: number;
};

/** Viewer 内部点击命中 show-chart 效果时发送给宿主页面的点击事件。 */
export type DigitalTwinAssetClickedEvent = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'event.assetClicked';
  payload: {
    assetCode?: string;
    slot?: DigitalTwinAssetClickedSlot;
    chartId?: string;
  };
};

/** 编辑器运行预览发送事件时使用的固定会话标识；编辑器无握手流程，仅供宿主页面识别来源。 */
export const DIGITAL_TWIN_EDITOR_PREVIEW_SESSION_ID = 'editor-preview' as const;

export type DigitalTwinBridgeMessage =
  | DigitalTwinHostHelloMessage
  | DigitalTwinBridgeReadyMessage
  | DigitalTwinViewerReadyMessage
  | DigitalTwinViewerInitialLoadStateMessage
  | DigitalTwinFocusAssetCommand
  | DigitalTwinCancelFocusAssetCommand
  | DigitalTwinRuntimeActionCommand
  | DigitalTwinCommandResult
  | DigitalTwinAssetClickedEvent;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_PROJECT_ID_LENGTH = 64;
const MAX_CAPABILITY_LENGTH = 64;
const MAX_CAPABILITY_COUNT = 16;
const MAX_ASSET_CODE_LENGTH = 128;
const MAX_ENTITY_ID_LENGTH = 256;
const MAX_ENTITY_COUNT = 64;
const MAX_ERROR_MESSAGE_LENGTH = 1024;
const MAX_CHART_ID_LENGTH = 256;
const MAX_SLOT_COORDINATE = 100_000;
const VIEWER_ERROR_CODE_SET = new Set<string>(DIGITAL_TWIN_VIEWER_ERROR_CODES);
const CAPABILITY_SET = new Set<string>([
  DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY,
  DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY,
  ...DIGITAL_TWIN_RUNTIME_ACTIONS,
]);
const RUNTIME_ACTION_SET = new Set<string>(DIGITAL_TWIN_RUNTIME_ACTIONS);
const INITIAL_LOAD_PHASE_SET = new Set<string>(DIGITAL_TWIN_INITIAL_LOAD_PHASES);

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
    && capabilities.every((entry) => CAPABILITY_SET.has(entry));
}

function isViewerReadyPayload(value: unknown): value is DigitalTwinViewerReadyMessage['payload'] {
  if (!isRecord(value) || !hasAllowedKeys(value, ['projectId', 'capabilities'])) return false;
  if (!Object.hasOwn(value, 'capabilities') || !isCapabilities(value.capabilities)) return false;
  return value.projectId === undefined || isBoundedString(value.projectId, MAX_PROJECT_ID_LENGTH);
}

function isViewerInitialLoadStatePayload(
  value: unknown,
): value is DigitalTwinViewerInitialLoadStateMessage['payload'] {
  return isRecord(value)
    && hasOnlyKeys(value, ['phase'])
    && typeof value.phase === 'string'
    && INITIAL_LOAD_PHASE_SET.has(value.phase);
}

function isFocusAssetPayload(value: unknown): value is DigitalTwinFocusAssetCommand['payload'] {
  return isRecord(value)
    && hasOnlyKeys(value, ['assetCode'])
    && isBoundedString(value.assetCode, MAX_ASSET_CODE_LENGTH);
}

function isSuccessPayload(value: unknown): value is DigitalTwinCommandSuccessResult['payload'] {
  if (!isRecord(value)) return false;
  if (hasOnlyKeys(value, ['action'])) {
    return typeof value.action === 'string' && RUNTIME_ACTION_SET.has(value.action);
  }
  if (!hasOnlyKeys(value, ['assetCode', 'entityIds'])) return false;
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

function isAssetClickedSlot(value: unknown): value is DigitalTwinAssetClickedSlot {
  if (!isRecord(value) || !hasOnlyKeys(value, ['row', 'column', 'layer'])) return false;
  return [value.row, value.column, value.layer].every((coordinate) => (
    typeof coordinate === 'number'
    && Number.isInteger(coordinate)
    && coordinate >= 0
    && coordinate <= MAX_SLOT_COORDINATE
  ));
}

function isAssetClickedPayload(value: unknown): value is DigitalTwinAssetClickedEvent['payload'] {
  if (!isRecord(value) || !hasAllowedKeys(value, ['assetCode', 'slot', 'chartId'])) return false;
  if (value.assetCode !== undefined && !isBoundedString(value.assetCode, MAX_ASSET_CODE_LENGTH)) return false;
  if (value.chartId !== undefined && !isBoundedString(value.chartId, MAX_CHART_ID_LENGTH)) return false;
  return value.slot === undefined || isAssetClickedSlot(value.slot);
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
    case 'viewer.initialLoadState':
      return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type', 'payload'])
        && isViewerInitialLoadStatePayload(value.payload)
        ? value as DigitalTwinViewerInitialLoadStateMessage
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
    case 'command.startAutoPatrol':
    case 'command.startManualRoam':
      return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type', 'requestId'])
        && isBoundedString(value.requestId, MAX_IDENTIFIER_LENGTH)
        ? value as DigitalTwinRuntimeActionCommand
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
    case 'event.assetClicked':
      return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type', 'payload'])
        && isAssetClickedPayload(value.payload)
        ? value as DigitalTwinAssetClickedEvent
        : null;
    default:
      return null;
  }
}
