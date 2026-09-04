export const DIGITAL_TWIN_DISPLAY_CHANNEL = 'zending.digital-twin.display' as const;
export const DIGITAL_TWIN_DISPLAY_VERSION = 1 as const;
export const MAX_DIGITAL_TWIN_RENDER_PIXEL_RATIO = 2;
export const MIN_DIGITAL_TWIN_RENDER_PIXEL_RATIO = 0.25;

export type DigitalTwinHostRenderPixelRatioState = {
  channel: typeof DIGITAL_TWIN_DISPLAY_CHANNEL;
  version: typeof DIGITAL_TWIN_DISPLAY_VERSION;
  type: 'host.renderPixelRatioChanged';
  payload: { renderPixelRatio: number };
};

type DigitalTwinViewerRenderSizeTarget = {
  engine: {
    getHardwareScalingLevel: () => number;
    setHardwareScalingLevel: (value: number) => void;
  };
  resize: () => void;
};

type DigitalTwinViewerRenderResolution = {
  devicePixelRatio?: number;
  hostRenderPixelRatio?: number;
};

const HARDWARE_SCALING_LEVEL_EPSILON = 0.001;

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
};

const normalizeRenderPixelRatio = (value: unknown): number | null => {
  const ratio = Number(value);
  if (!Number.isFinite(ratio)
    || ratio < MIN_DIGITAL_TWIN_RENDER_PIXEL_RATIO
    || ratio > MAX_DIGITAL_TWIN_RENDER_PIXEL_RATIO) return null;
  return ratio;
};

/** 只接受父窗口发送的有界渲染像素比，来源窗口由调用方校验。 */
export function parseDigitalTwinHostRenderPixelRatioState(
  value: unknown,
): { renderPixelRatio: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (!hasExactKeys(message, ['channel', 'version', 'type', 'payload'])
    || message.channel !== DIGITAL_TWIN_DISPLAY_CHANNEL
    || message.version !== DIGITAL_TWIN_DISPLAY_VERSION
    || message.type !== 'host.renderPixelRatioChanged'
    || !message.payload
    || typeof message.payload !== 'object'
    || Array.isArray(message.payload)) return null;
  const payload = message.payload as Record<string, unknown>;
  if (!hasExactKeys(payload, ['renderPixelRatio'])) return null;
  const renderPixelRatio = normalizeRenderPixelRatio(payload.renderPixelRatio);
  return renderPixelRatio === null ? null : { renderPixelRatio };
}

/** Babylon hardware scaling level 是目标渲染像素比的倒数。 */
export function getDigitalTwinViewerHardwareScalingLevel(
  resolution: DigitalTwinViewerRenderResolution,
): number {
  const hostRenderPixelRatio = normalizeRenderPixelRatio(resolution.hostRenderPixelRatio);
  const devicePixelRatio = Number(resolution.devicePixelRatio);
  const fallbackRenderPixelRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? Math.min(Math.max(devicePixelRatio, MIN_DIGITAL_TWIN_RENDER_PIXEL_RATIO), MAX_DIGITAL_TWIN_RENDER_PIXEL_RATIO)
    : 1;
  return 1 / (hostRenderPixelRatio ?? fallbackRenderPixelRatio);
}

/** 同步发布 Viewer 的 WebGL 缓冲尺寸；独立打开和嵌入大屏共用该入口。 */
export function syncDigitalTwinViewerRenderSize(
  target: DigitalTwinViewerRenderSizeTarget,
  resolution: DigitalTwinViewerRenderResolution,
): void {
  const hardwareScalingLevel = getDigitalTwinViewerHardwareScalingLevel(resolution);
  if (Math.abs(target.engine.getHardwareScalingLevel() - hardwareScalingLevel) > HARDWARE_SCALING_LEVEL_EPSILON) {
    target.engine.setHardwareScalingLevel(hardwareScalingLevel);
  }
  target.resize();
}
