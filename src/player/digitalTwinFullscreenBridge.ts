export const DIGITAL_TWIN_FULLSCREEN_CHANNEL = 'zending.digital-twin.fullscreen' as const;
export const DIGITAL_TWIN_FULLSCREEN_VERSION = 1 as const;

export type DigitalTwinHostFullscreenRequest = {
  channel: typeof DIGITAL_TWIN_FULLSCREEN_CHANNEL;
  version: typeof DIGITAL_TWIN_FULLSCREEN_VERSION;
  type: 'viewer.toggleHostFullscreen';
};

export type DigitalTwinHostFullscreenState = {
  channel: typeof DIGITAL_TWIN_FULLSCREEN_CHANNEL;
  version: typeof DIGITAL_TWIN_FULLSCREEN_VERSION;
  type: 'host.fullscreenChanged';
  payload: { fullscreen: boolean };
};

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
};

export function createDigitalTwinHostFullscreenRequest(): DigitalTwinHostFullscreenRequest {
  return {
    channel: DIGITAL_TWIN_FULLSCREEN_CHANNEL,
    version: DIGITAL_TWIN_FULLSCREEN_VERSION,
    type: 'viewer.toggleHostFullscreen',
  };
}

/** 只接受父窗口回传的严格布尔状态，来源窗口由调用方校验。 */
export function parseDigitalTwinHostFullscreenState(value: unknown): { fullscreen: boolean } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (!hasExactKeys(message, ['channel', 'version', 'type', 'payload'])
    || message.channel !== DIGITAL_TWIN_FULLSCREEN_CHANNEL
    || message.version !== DIGITAL_TWIN_FULLSCREEN_VERSION
    || message.type !== 'host.fullscreenChanged'
    || !message.payload
    || typeof message.payload !== 'object'
    || Array.isArray(message.payload)) return null;
  const payload = message.payload as Record<string, unknown>;
  return hasExactKeys(payload, ['fullscreen']) && typeof payload.fullscreen === 'boolean'
    ? { fullscreen: payload.fullscreen }
    : null;
}
