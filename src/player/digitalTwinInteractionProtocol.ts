import { parseDigitalTwinRegionViewMessage, type DigitalTwinRegionViewMessage } from './digitalTwinRegionViewProtocol.ts';
export const DIGITAL_TWIN_BRIDGE_CHANNEL = 'zending.digital-twin.bridge' as const;
export const DIGITAL_TWIN_BRIDGE_VERSION = 1 as const;
export const DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY = 'hardwareGpu' as const;
export const DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY = 'focusAsset' as const;
export const DIGITAL_TWIN_CLEAR_SELECTION_CAPABILITY = 'clearSelection' as const;
export const DIGITAL_TWIN_GLOBAL_OVERVIEW_CAPABILITY = 'globalOverview' as const;
export const DIGITAL_TWIN_START_AUTO_PATROL_CAPABILITY = 'startAutoPatrol' as const;
export const DIGITAL_TWIN_START_MANUAL_ROAM_CAPABILITY = 'startManualRoam' as const;
export const DIGITAL_TWIN_INITIAL_LOAD_PHASES = ['loading', 'complete'] as const;

export const DIGITAL_TWIN_RUNTIME_ACTIONS = [
  DIGITAL_TWIN_GLOBAL_OVERVIEW_CAPABILITY,
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
  | typeof DIGITAL_TWIN_CLEAR_SELECTION_CAPABILITY
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

/** 主题内容由数据中台宿主加载，Viewer 只发送项目和大屏标识。 */
export type DigitalTwinShowScreenMessage = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'viewer.showScreen';
  payload: { projectId: string; screenId: string; selectionToken?: string };
};

export type DigitalTwinNavigateSceneRequest = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'viewer.navigateScene';
  requestId: string;
  payload: { url: string };
};

export type DigitalTwinNavigateSceneResult = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'host.navigateSceneResult';
  requestId: string;
} & ({ ok: true } | { ok: false; error: { code: 'NAVIGATION_DENIED'; message: string } });

export type DigitalTwinClearSelectionCommand = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'command.clearSelection';
  requestId: string;
  payload: { selectionToken: string };
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

export type DigitalTwinGlobalOverviewCommand = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'command.globalOverview';
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
  | DigitalTwinGlobalOverviewCommand
  | DigitalTwinStartAutoPatrolCommand
  | DigitalTwinStartManualRoamCommand;

export type DigitalTwinCommandSuccessPayload =
  | { action: typeof DIGITAL_TWIN_CLEAR_SELECTION_CAPABILITY; cleared: boolean }
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

export type DigitalTwinClickValue = string | number | boolean | null | DigitalTwinClickValue[] | { [key: string]: DigitalTwinClickValue | undefined };

/** Viewer 内部点击命中 show-chart 效果时发送给宿主页面的点击事件。 */
export type DigitalTwinAssetClickedEvent = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
  type: 'event.assetClicked';
  payload: {
    assetCode?: string;
    entityId?: string;
    deviceType?: string;
    namespace?: string;
    deviceNo?: string;
    slot?: DigitalTwinAssetClickedSlot;
    chartId?: string;
    unit?: { kind: 'cargo' | 'spawned-device'; containerCode?: string; assetCode?: string };
    host?: { entityId: string; assetCode?: string; name?: string };
    [key: string]: DigitalTwinClickValue | undefined;
  };
};

/** 编辑器运行预览发送事件时使用的固定会话标识；编辑器无握手流程，仅供宿主页面识别来源。 */
export const DIGITAL_TWIN_EDITOR_PREVIEW_SESSION_ID = 'editor-preview' as const;

export type DigitalTwinBridgeMessage =
  | DigitalTwinRegionViewMessage
  | DigitalTwinHostHelloMessage
  | DigitalTwinBridgeReadyMessage
  | DigitalTwinViewerReadyMessage
  | DigitalTwinViewerInitialLoadStateMessage
  | DigitalTwinShowScreenMessage
  | DigitalTwinNavigateSceneRequest
  | DigitalTwinNavigateSceneResult
  | DigitalTwinClearSelectionCommand
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
const MAX_SCENE_URL_LENGTH = 4096;
const MAX_CHART_ID_LENGTH = 256;
const MAX_SLOT_COORDINATE = 100_000;
const VIEWER_ERROR_CODE_SET = new Set<string>(DIGITAL_TWIN_VIEWER_ERROR_CODES);
const CAPABILITY_SET = new Set<string>([
  DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY,
  DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY,
  DIGITAL_TWIN_CLEAR_SELECTION_CAPABILITY,
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

function hasAsciiControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isSceneNavigationUrl(value: unknown): value is string {
  if (!isBoundedString(value, MAX_SCENE_URL_LENGTH) || hasAsciiControlChar(value)
    || !/^https?:\/\//i.test(value.trim()) || value.includes(String.fromCharCode(92))) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
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
  if (value.action === DIGITAL_TWIN_CLEAR_SELECTION_CAPABILITY) {
    return hasOnlyKeys(value, ['action', 'cleared']) && typeof value.cleared === 'boolean';
  }
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

// 扩展参数仅允许有界 JSON；保持来源、会话和已知字段校验，不因新增业务字段丢弃整条点击消息。
export function isDigitalTwinClickPayload(value: unknown): value is DigitalTwinAssetClickedEvent['payload'] {
  let remainingNodes = 512;
  let remainingCharacters = 65_536;
  const isSafeValue = (entry: unknown, depth: number): boolean => {
    if (--remainingNodes < 0 || depth > 8) return false;
    if (entry === undefined || entry === null || typeof entry === 'boolean') return true;
    if (typeof entry === 'number') return Number.isFinite(entry);
    if (typeof entry === 'string') {
      remainingCharacters -= entry.length;
      return entry.length <= 16_384 && remainingCharacters >= 0;
    }
    if (Array.isArray(entry)) return entry.length <= 256 && entry.every((item) => isSafeValue(item, depth + 1));
    if (!isRecord(entry) || ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) return false;
    const entries = Object.entries(entry);
    return entries.length <= 256 && entries.every(([key, item]) => {
      remainingCharacters -= key.length;
      return key.length > 0 && key.length <= 128 && remainingCharacters >= 0
        && !['__proto__', 'prototype', 'constructor'].includes(key)
        && isSafeValue(item, depth + 1);
    });
  };
  if (!isRecord(value) || !isSafeValue(value, 0)) return false;
  if (value.assetCode !== undefined && !isBoundedString(value.assetCode, MAX_ASSET_CODE_LENGTH)) return false;
  if (['entityId', 'deviceType', 'namespace', 'deviceNo'].some(key => value[key] !== undefined
    && (!isBoundedString(value[key], 256) || hasAsciiControlChar(value[key] as string)))) return false;
  if (value.parameterValues !== undefined && !isRecord(value.parameterValues)) return false;
  if (value.parametersUnavailable !== undefined && value.parametersUnavailable !== true) return false;
  if (value.chartId !== undefined && !isBoundedString(value.chartId, MAX_CHART_ID_LENGTH)) return false;
  if (value.slot !== undefined && !isAssetClickedSlot(value.slot)) return false;
  if (value.unit !== undefined) {
    if (!isRecord(value.unit) || (value.unit.kind !== 'cargo' && value.unit.kind !== 'spawned-device')) return false;
    if (value.unit.containerCode !== undefined && !isBoundedString(value.unit.containerCode, 16_384)) return false;
    if (value.unit.assetCode !== undefined && !isBoundedString(value.unit.assetCode, MAX_ASSET_CODE_LENGTH)) return false;
  }
  if (value.host !== undefined) {
    if (!isRecord(value.host) || !isBoundedString(value.host.entityId, MAX_ENTITY_ID_LENGTH)) return false;
    if (value.host.assetCode !== undefined && !isBoundedString(value.host.assetCode, MAX_ASSET_CODE_LENGTH)) return false;
    if (value.host.name !== undefined && !isBoundedString(value.host.name, 16_384, false)) return false;
  }
  return true;
}

/** 严格解析宿主与发布 Viewer 的 v1 交互消息；非法或未知消息返回 null。 */
export function parseDigitalTwinBridgeMessage(value: unknown): DigitalTwinBridgeMessage | null {
  if (!isRecord(value) || !isBaseEnvelope(value) || typeof value.type !== 'string') return null;

  switch (value.type) {
    case 'host.regionViews':
    case 'viewer.regionViews':
    case 'command.regionView':
    case 'command.cancelRegionView':
    case 'viewer.regionViewResult':
    case 'viewer.regionViewCleared':
      return parseDigitalTwinRegionViewMessage(value);
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
    case 'viewer.navigateScene':
      return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type', 'requestId', 'payload'])
        && isBoundedString(value.requestId, MAX_IDENTIFIER_LENGTH)
        && isRecord(value.payload) && hasOnlyKeys(value.payload, ['url']) && isSceneNavigationUrl(value.payload.url)
        ? value as DigitalTwinNavigateSceneRequest : null;
    case 'host.navigateSceneResult':
      if (!isBoundedString(value.requestId, MAX_IDENTIFIER_LENGTH) || typeof value.ok !== 'boolean') return null;
      if (value.ok) {
        return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type', 'requestId', 'ok'])
          ? value as DigitalTwinNavigateSceneResult : null;
      }
      return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type', 'requestId', 'ok', 'error'])
        && isRecord(value.error) && hasOnlyKeys(value.error, ['code', 'message'])
        && value.error.code === 'NAVIGATION_DENIED' && isBoundedString(value.error.message, MAX_ERROR_MESSAGE_LENGTH)
        ? value as DigitalTwinNavigateSceneResult : null;
    case 'viewer.showScreen':
      return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type', 'payload'])
        && isRecord(value.payload)
        && hasAllowedKeys(value.payload, ['projectId', 'screenId', 'selectionToken'])
        && (value.payload.selectionToken === undefined || isBoundedString(value.payload.selectionToken, MAX_IDENTIFIER_LENGTH))
        && isBoundedString(value.payload.projectId, MAX_PROJECT_ID_LENGTH)
        && isBoundedString(value.payload.screenId, 128)
        ? value as DigitalTwinShowScreenMessage
        : null;
    case 'command.clearSelection':
      return hasOnlyKeys(value, ['channel', 'version', 'sessionId', 'type', 'requestId', 'payload'])
        && isBoundedString(value.requestId, MAX_IDENTIFIER_LENGTH)
        && isRecord(value.payload)
        && hasOnlyKeys(value.payload, ['selectionToken'])
        && isBoundedString(value.payload.selectionToken, MAX_IDENTIFIER_LENGTH)
        ? value as DigitalTwinClearSelectionCommand
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
    case 'command.globalOverview':
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
        && isDigitalTwinClickPayload(value.payload)
        ? value as DigitalTwinAssetClickedEvent
        : null;
    default:
      return null;
  }
}

/** 巡检扩展在原 v1 ready 之后单独探测，绝不添加到 viewer.ready.capabilities。 */
export const DIGITAL_TWIN_INSPECTION_CAPABILITIES = [
  'openInspection', 'focusCause', 'openAssetInspection', 'inspectionLoad', 'selectPart', 'selectionCause', 'cancelSelect', 'setProgress', 'reset', 'deviceContext', 'modelVersionLoad',
] as const;
export type DigitalTwinInspectionCapability = (typeof DIGITAL_TWIN_INSPECTION_CAPABILITIES)[number];
export type DigitalTwinInspectionRole = 'scene' | 'detail';
export type DigitalTwinInspectionDevice = { namespace: string; deviceType: string; deviceNo: string };
export type DigitalTwinInspectionBinding = {
  schemaVersion: 1;
  device?: DigitalTwinInspectionDevice;
  model: {
    dataPlatformModel: { sourceKey: string; kind: 'model'; resourceId: string; modelPath: string };
    versionId: string;
    contentSha256: string;
    sourcePath: string;
    sourceUrl: string;
    metaPath: string;
    metaUrl: string;
    unitScaleToMeters: number;
  };
  configuration: { id: string; parameters: Record<string, unknown> };
  parts: Array<{ partKey: string; name: string; nodePath: string; parentPartKey?: string; axis: { x: number; y: number; z: number }; distanceMeters: number; fixed: boolean }>;
};
export type DigitalTwinInspectionLoad = {
  loadId: string;
  assetCode: string;
  entityId: string;
  inspection: DigitalTwinInspectionBinding & { device: DigitalTwinInspectionDevice };
};
export type DigitalTwinInspectionIdentity = { loadId: string; assetCode: string };

/** 场景提供真实设备上下文；设备数据键可缺省，不能由 assetCode 推导。 */
export type DigitalTwinDeviceContext = {
  assetCode: string;
  entityId: string;
  deviceType?: string;
  namespace?: string;
  deviceNo?: string;
  parameterValues?: Record<string, unknown>;
  parametersUnavailable?: true;
};

/** 中台版本资源与场景包资源分开表达，不伪造本地路径或完整包摘要。 */
export type DigitalTwinModelVersionInspectionLoad = {
  loadId: string;
  assetCode: string;
  entityId: string;
  inspection: {
    schemaVersion: 2;
    source: 'model-version';
    device: { deviceType: string; namespace?: string; deviceNo?: string };
    model: {
      modelId: string;
      versionId: string;
      fileUrl: string;
      fileExtension: '.glb' | '.gltf';
      unitScaleToMeters: number;
    };
    configuration?: DigitalTwinInspectionBinding['configuration'];
    parts: DigitalTwinInspectionBinding['parts'];
  };
};
export type DigitalTwinInspectionAnyLoad = DigitalTwinInspectionLoad | DigitalTwinModelVersionInspectionLoad;

type InspectionEnvelope = {
  channel: typeof DIGITAL_TWIN_BRIDGE_CHANNEL;
  version: typeof DIGITAL_TWIN_BRIDGE_VERSION;
  sessionId: string;
};
export type DigitalTwinInspectionMessage = InspectionEnvelope & (
  | { type: 'host.inspectionHello'; requestId: string; payload: { role: DigitalTwinInspectionRole } }
  | { type: 'viewer.inspectionReady'; requestId: string; payload: { role: DigitalTwinInspectionRole; capabilities: DigitalTwinInspectionCapability[] } }
  | { type: 'event.openInspection'; payload: Omit<DigitalTwinInspectionLoad, 'loadId'> & { causeRequestId?: string } }
  | { type: 'command.openInspectionAsset'; requestId: string; payload: { assetCode: string; entityId: string } }
  | { type: 'viewer.openInspectionAssetFailed'; requestId: string; error: string }
  | { type: 'event.inspectionDeviceSelected'; payload: { assetCode: string; entityId: string; device: DigitalTwinInspectionDevice; causeRequestId?: string } }
  | { type: 'event.deviceContext'; payload: { context: DigitalTwinDeviceContext | null; causeRequestId?: string } }
  | { type: 'command.inspectionLoadModelVersion'; requestId: string; payload: DigitalTwinModelVersionInspectionLoad }
  | { type: 'command.inspectionLoad'; requestId: string; payload: DigitalTwinInspectionLoad }
  | { type: 'command.inspectionSelectPart'; requestId: string; payload: DigitalTwinInspectionIdentity & { partKey: string | null } }
  | { type: 'command.inspectionCancelSelect'; payload: DigitalTwinInspectionIdentity }
  | { type: 'command.inspectionSetProgress'; requestId: string; payload: DigitalTwinInspectionIdentity & { progress: number } }
  | { type: 'command.inspectionReset'; requestId: string; payload: DigitalTwinInspectionIdentity }
  | { type: 'event.inspectionPartSelected'; payload: DigitalTwinInspectionIdentity & { partKey: string | null; causeRequestId?: string } }
  | { type: 'event.inspectionClosed'; payload: DigitalTwinInspectionIdentity }
  | { type: 'viewer.inspectionResult'; requestId: string; payload: DigitalTwinInspectionIdentity; ok: boolean; error?: string }
);

/** 限制跨窗口数据规模，同时区分超出预算和无效结构，供入口给出明确提示。 */
export function getInspectionDataIssue(value: unknown): 'budget' | 'invalid' | null {
  let nodes = 160_000;
  let characters = 16 * 1_048_576;
  let issue: 'budget' | 'invalid' = 'invalid';
  const budgetExceeded = (): false => { issue = 'budget'; return false; };
  const visit = (entry: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > 12) return budgetExceeded();
    if (entry === null || typeof entry === 'boolean') return true;
    if (typeof entry === 'number') return Number.isFinite(entry);
    if (typeof entry === 'string') {
      if (entry.length > 16_384 || (characters -= entry.length) < 0) return budgetExceeded();
      return true;
    }
    if (Array.isArray(entry)) return entry.length > 10_000 ? budgetExceeded() : entry.every(item => visit(item, depth + 1));
    if (!isRecord(entry) || ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) return false;
    return Object.entries(entry).every(([key, item]) => {
      if (!key.length || ['__proto__', 'prototype', 'constructor'].includes(key)) return false;
      if (key.length > 128 || (characters -= key.length) < 0) return budgetExceeded();
      return visit(item, depth + 1);
    });
  };
  return visit(value, 0) ? null : issue;
}

function isSafeInspectionValue(value: unknown): boolean {
  return getInspectionDataIssue(value) === null;
}

export function isDigitalTwinInspectionBinding(value: unknown): value is DigitalTwinInspectionBinding & { device: DigitalTwinInspectionDevice } {
  if (!isRecord(value) || !isSafeInspectionValue(value) || value.schemaVersion !== 1
    || !isRecord(value.device) || !isRecord(value.model) || !isRecord(value.model.dataPlatformModel)
    || !isRecord(value.configuration) || !isRecord(value.configuration.parameters) || !Array.isArray(value.parts)) return false;
  const device = value.device;
  const model = value.model;
  const source = model.dataPlatformModel as Record<string, unknown>;
  return [device.namespace, device.deviceType, device.deviceNo, value.configuration.id,
    source.sourceKey, source.modelPath, model.sourcePath, model.sourceUrl, model.metaPath, model.metaUrl]
    .every(item => isBoundedString(item, 4096))
    && source.kind === 'model'
    && typeof source.resourceId === 'string' && /^[1-9]\d*$/.test(source.resourceId)
    && typeof model.versionId === 'string' && /^[1-9]\d*$/.test(model.versionId)
    && typeof model.contentSha256 === 'string' && /^[a-f\d]{64}$/i.test(model.contentSha256)
    && typeof model.unitScaleToMeters === 'number' && model.unitScaleToMeters > 0 && Number.isFinite(model.unitScaleToMeters)
    && value.parts.every(part => isRecord(part) && isBoundedString(part.partKey, 256)
      && isBoundedString(part.name, 4096) && isBoundedString(part.nodePath, 4096)
      && (part.parentPartKey === undefined || isBoundedString(part.parentPartKey, 256))
      && isRecord(part.axis) && [part.axis.x, part.axis.y, part.axis.z].every(v => typeof v === 'number' && Number.isFinite(v))
      && typeof part.distanceMeters === 'number' && Number.isFinite(part.distanceMeters) && typeof part.fixed === 'boolean');
}

export function isDigitalTwinDeviceContext(value: unknown): value is DigitalTwinDeviceContext {
  return isRecord(value)
    && hasAllowedKeys(value, ['assetCode', 'entityId', 'deviceType', 'namespace', 'deviceNo', 'parameterValues', 'parametersUnavailable'])
    && isDigitalTwinClickPayload(value)
    && isBoundedString(value.assetCode, MAX_ASSET_CODE_LENGTH)
    && isBoundedString(value.entityId, MAX_ENTITY_ID_LENGTH)
    && ['deviceType', 'namespace', 'deviceNo'].every(key => value[key] === undefined || isInspectionText(value[key], 256))
    && (value.parameterValues === undefined || isRecord(value.parameterValues))
    && (value.parametersUnavailable === undefined || value.parametersUnavailable === true)
    && !(value.parametersUnavailable && value.parameterValues !== undefined);
}

function isInspectionText(value: unknown, max: number): value is string {
  return isBoundedString(value, max) && value === value.trim() && !hasAsciiControlChar(value);
}

export function isDigitalTwinModelVersionInspection(value: unknown): value is DigitalTwinModelVersionInspectionLoad['inspection'] {
  if (!isRecord(value) || !isSafeInspectionValue(value) || value.schemaVersion !== 2 || value.source !== 'model-version'
    || !hasAllowedKeys(value, ['schemaVersion', 'source', 'device', 'model', 'configuration', 'parts'])
    || !isRecord(value.device) || !isRecord(value.model) || !Array.isArray(value.parts)
    || value.parts.length < 1 || value.parts.length > 10_000) return false;
  const { device, model } = value;
  if (!hasAllowedKeys(device, ['deviceType', 'namespace', 'deviceNo']) || !isInspectionText(device.deviceType, 256)
    || !['namespace', 'deviceNo'].every(key => device[key] === undefined || isInspectionText(device[key], 256))
    || !hasOnlyKeys(model, ['modelId', 'versionId', 'fileUrl', 'fileExtension', 'unitScaleToMeters'])
    || ![model.modelId, model.versionId].every(id => typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) && (id.length < 19 || id <= '9223372036854775807'))
    || !isInspectionText(model.fileUrl, 4096) || model.fileUrl.includes('\\')
    || (model.fileExtension !== '.glb' && model.fileExtension !== '.gltf')
    || typeof model.unitScaleToMeters !== 'number' || !Number.isFinite(model.unitScaleToMeters) || model.unitScaleToMeters <= 0) return false;
  try {
    const url = new URL(model.fileUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
      || !url.pathname.startsWith('/api/v1/files/') || /%(?:2f|5c|2e|00)/i.test(url.pathname)) return false;
  } catch { return false; }
  if (value.configuration !== undefined) {
    if (!isRecord(value.configuration) || !hasOnlyKeys(value.configuration, ['id', 'parameters'])
      || !isInspectionText(value.configuration.id, 256) || !isRecord(value.configuration.parameters)) return false;
  }
  const parents = new Map<string, string | undefined>();
  const paths = new Set<string>();
  for (const part of value.parts) {
    if (!isRecord(part) || !hasAllowedKeys(part, ['partKey', 'name', 'nodePath', 'parentPartKey', 'axis', 'distanceMeters', 'fixed'])
      || !isInspectionText(part.partKey, 256) || !isInspectionText(part.name, 256) || !isInspectionText(part.nodePath, 2048)
      || (part.parentPartKey !== undefined && !isInspectionText(part.parentPartKey, 256))
      || parents.has(part.partKey) || paths.has(part.nodePath) || !isRecord(part.axis)
      || !hasOnlyKeys(part.axis, ['x', 'y', 'z'])
      || ![part.axis.x, part.axis.y, part.axis.z].every(v => typeof v === 'number' && Number.isFinite(v))
      || [part.axis.x, part.axis.y, part.axis.z].every(v => v === 0)
      || typeof part.distanceMeters !== 'number' || !Number.isFinite(part.distanceMeters) || part.distanceMeters < 0
      || typeof part.fixed !== 'boolean') return false;
    if (part.nodePath !== '.' && (/[;,]/.test(part.nodePath)
      || part.nodePath.split('/').some(segment => !segment || segment === '.' || segment === '..'))) return false;
    parents.set(part.partKey, part.parentPartKey as string | undefined);
    paths.add(part.nodePath);
  }
  const checked = new Set<string>();
  for (const key of parents.keys()) {
    const chain = new Set<string>();
    let current: string | undefined = key;
    while (current !== undefined && !checked.has(current)) {
      if (!parents.has(current) || chain.has(current)) return false;
      chain.add(current);
      current = parents.get(current);
    }
    for (const item of chain) checked.add(item);
  }
  return true;
}

/** 单独解析新扩展；旧版严格 v1 解析及能力白名单保持原样。 */
export function parseDigitalTwinInspectionMessage(value: unknown): DigitalTwinInspectionMessage | null {
  if (!isRecord(value) || !isBaseEnvelope(value) || typeof value.type !== 'string') return null;
  const envelope = ['channel', 'version', 'sessionId', 'type'];
  const payload = value.payload;
  const request = isBoundedString(value.requestId, MAX_IDENTIFIER_LENGTH);
  const identity = isRecord(payload) && isBoundedString(payload.loadId, MAX_IDENTIFIER_LENGTH)
    && isBoundedString(payload.assetCode, MAX_ASSET_CODE_LENGTH);
  const part = isRecord(payload) && (payload.partKey === null || isBoundedString(payload.partKey, 256));
  const exact = (keys: string[]) => hasOnlyKeys(value, [...envelope, ...keys]);
  switch (value.type) {
    case 'host.inspectionHello':
      return exact(['requestId', 'payload']) && request && isRecord(payload) && hasOnlyKeys(payload, ['role'])
        && (payload.role === 'scene' || payload.role === 'detail') ? value as DigitalTwinInspectionMessage : null;
    case 'viewer.inspectionReady':
      return exact(['requestId', 'payload']) && request && isRecord(payload) && hasOnlyKeys(payload, ['role', 'capabilities'])
        && (payload.role === 'scene' || payload.role === 'detail') && Array.isArray(payload.capabilities)
        && payload.capabilities.length <= DIGITAL_TWIN_INSPECTION_CAPABILITIES.length
        && new Set(payload.capabilities).size === payload.capabilities.length
        && payload.capabilities.every(item => typeof item === 'string' && DIGITAL_TWIN_INSPECTION_CAPABILITIES.includes(item as DigitalTwinInspectionCapability))
        ? value as DigitalTwinInspectionMessage : null;
    case 'event.openInspection':
      return exact(['payload']) && isRecord(payload) && hasAllowedKeys(payload, ['assetCode', 'entityId', 'inspection', 'causeRequestId'])
        && isBoundedString(payload.assetCode, MAX_ASSET_CODE_LENGTH) && isBoundedString(payload.entityId, MAX_ENTITY_ID_LENGTH)
        && (payload.causeRequestId === undefined || isBoundedString(payload.causeRequestId, MAX_IDENTIFIER_LENGTH))
        && isDigitalTwinInspectionBinding(payload.inspection) ? value as DigitalTwinInspectionMessage : null;
    case 'command.openInspectionAsset':
      return exact(['requestId', 'payload']) && request && isRecord(payload) && hasOnlyKeys(payload, ['assetCode', 'entityId'])
        && isBoundedString(payload.assetCode, MAX_ASSET_CODE_LENGTH) && isBoundedString(payload.entityId, MAX_ENTITY_ID_LENGTH)
        ? value as DigitalTwinInspectionMessage : null;
    case 'viewer.openInspectionAssetFailed':
      return exact(['requestId', 'error']) && request && isBoundedString(value.error, MAX_ERROR_MESSAGE_LENGTH)
        ? value as DigitalTwinInspectionMessage : null;
    case 'event.inspectionDeviceSelected':
      return exact(['payload']) && isRecord(payload) && hasAllowedKeys(payload, ['assetCode', 'entityId', 'device', 'causeRequestId'])
        && isBoundedString(payload.assetCode, MAX_ASSET_CODE_LENGTH) && isBoundedString(payload.entityId, MAX_ENTITY_ID_LENGTH)
        && (payload.causeRequestId === undefined || isBoundedString(payload.causeRequestId, MAX_IDENTIFIER_LENGTH))
        && isRecord(payload.device) && hasOnlyKeys(payload.device, ['namespace', 'deviceType', 'deviceNo'])
        && [payload.device.namespace, payload.device.deviceType, payload.device.deviceNo].every(item => isBoundedString(item, 256))
        ? value as DigitalTwinInspectionMessage : null;
    case 'event.deviceContext':
      return exact(['payload']) && isRecord(payload) && hasAllowedKeys(payload, ['context', 'causeRequestId'])
        && (payload.context === null || isDigitalTwinDeviceContext(payload.context))
        && (payload.causeRequestId === undefined || isBoundedString(payload.causeRequestId, MAX_IDENTIFIER_LENGTH))
        ? value as DigitalTwinInspectionMessage : null;
    case 'command.inspectionLoadModelVersion':
      return exact(['requestId', 'payload']) && request && identity && isRecord(payload)
        && hasOnlyKeys(payload, ['loadId', 'assetCode', 'entityId', 'inspection'])
        && isBoundedString(payload.entityId, MAX_ENTITY_ID_LENGTH) && isDigitalTwinModelVersionInspection(payload.inspection)
        ? value as DigitalTwinInspectionMessage : null;
    case 'command.inspectionLoad':
      return exact(['requestId', 'payload']) && request && identity && isRecord(payload)
        && hasOnlyKeys(payload, ['loadId', 'assetCode', 'entityId', 'inspection'])
        && isBoundedString(payload.entityId, MAX_ENTITY_ID_LENGTH) && isDigitalTwinInspectionBinding(payload.inspection)
        ? value as DigitalTwinInspectionMessage : null;
    case 'command.inspectionSelectPart':
      return exact(['requestId', 'payload']) && request && identity && part && isRecord(payload)
        && hasOnlyKeys(payload, ['loadId', 'assetCode', 'partKey']) ? value as DigitalTwinInspectionMessage : null;
    case 'event.inspectionPartSelected':
      return exact(['payload']) && identity && part && isRecord(payload)
        && hasAllowedKeys(payload, ['loadId', 'assetCode', 'partKey', 'causeRequestId'])
        && (payload.causeRequestId === undefined || isBoundedString(payload.causeRequestId, MAX_IDENTIFIER_LENGTH))
        ? value as DigitalTwinInspectionMessage : null;
    case 'command.inspectionSetProgress':
      return exact(['requestId', 'payload']) && request && identity && isRecord(payload)
        && hasOnlyKeys(payload, ['loadId', 'assetCode', 'progress']) && typeof payload.progress === 'number'
        && Number.isFinite(payload.progress) && payload.progress >= 0 && payload.progress <= 1 ? value as DigitalTwinInspectionMessage : null;
    case 'command.inspectionCancelSelect':
    case 'command.inspectionReset':
    case 'event.inspectionClosed':
      return exact(value.type === 'command.inspectionReset' ? ['requestId', 'payload'] : ['payload'])
        && (value.type !== 'command.inspectionReset' || request) && identity && isRecord(payload)
        && hasOnlyKeys(payload, ['loadId', 'assetCode']) ? value as DigitalTwinInspectionMessage : null;
    case 'viewer.inspectionResult':
      return request && identity && isRecord(payload) && hasOnlyKeys(payload, ['loadId', 'assetCode'])
        && typeof value.ok === 'boolean' && (value.ok
          ? exact(['requestId', 'payload', 'ok'])
          : exact(['requestId', 'payload', 'ok', 'error']) && isBoundedString(value.error, MAX_ERROR_MESSAGE_LENGTH))
        ? value as DigitalTwinInspectionMessage : null;
    default:
      return null;
  }
}
