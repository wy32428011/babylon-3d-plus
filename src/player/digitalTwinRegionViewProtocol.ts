/** 可选扩展通过查询协商，不向旧版 viewer.ready 的能力白名单追加字段。两端保持此文件一致。 */
export type DigitalTwinRegionViewItem = { id: string; name: string };
type Envelope = { channel: 'zending.digital-twin.bridge'; version: 1; sessionId: string; requestId: string };
export type DigitalTwinRegionViewError = 'REGION_VIEW_NOT_FOUND' | 'COMMAND_CANCELLED' | 'INTERNAL_ERROR' | 'UNSUPPORTED_COMMAND';
export type DigitalTwinRegionViewMessage = Envelope & (
  | { type: 'host.regionViews' }
  | { type: 'viewer.regionViews'; payload: { views: DigitalTwinRegionViewItem[] } }
  | { type: 'command.regionView'; payload: { viewId: string; animate: boolean } }
  | { type: 'command.cancelRegionView' }
  | { type: 'viewer.regionViewCleared' }
  | { type: 'viewer.regionViewResult'; ok: true; payload: { viewId: string } }
  | { type: 'viewer.regionViewResult'; ok: false; error: { code: DigitalTwinRegionViewError; message: string } }
);

export type DigitalTwinRegionViewsState =
  | { phase: 'loading' }
  | { phase: 'unsupported'; message: string }
  | { phase: 'ready'; views: DigitalTwinRegionViewItem[]; selectedViewId?: string; pendingViewId?: string; error?: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && Object.keys(value).every(key => names.includes(key));
}
function text(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function parseDigitalTwinRegionViewMessage(value: unknown): DigitalTwinRegionViewMessage | null {
  if (!record(value) || value.channel !== 'zending.digital-twin.bridge' || value.version !== 1
    || !text(value.sessionId) || !text(value.requestId)) return null;
  const envelope = ['channel', 'version', 'sessionId', 'requestId', 'type'];
  const payload = record(value.payload) ? value.payload : null;
  let valid = false;
  switch (value.type) {
    case 'host.regionViews':
    case 'viewer.regionViewCleared':
    case 'command.cancelRegionView': valid = keys(value, envelope); break;
    case 'viewer.regionViews': {
      if (!keys(value, [...envelope, 'payload']) || !payload || !keys(payload, ['views'])
        || !Array.isArray(payload.views) || payload.views.length > 256) return null;
      const ids = new Set<string>();
      valid = payload.views.every(item => {
        if (!record(item) || !keys(item, ['id', 'name']) || !text(item.id) || !text(item.name, 80) || ids.has(item.id)) return false;
        ids.add(item.id);
        return true;
      });
      break;
    }
    case 'command.regionView':
      valid = keys(value, [...envelope, 'payload']) && Boolean(payload && keys(payload, ['viewId', 'animate'])
        && text(payload.viewId) && typeof payload.animate === 'boolean');
      break;
    case 'viewer.regionViewResult':
      if (value.ok === true) valid = keys(value, [...envelope, 'ok', 'payload'])
        && Boolean(payload && keys(payload, ['viewId']) && text(payload.viewId));
      else if (value.ok === false) valid = keys(value, [...envelope, 'ok', 'error']) && record(value.error)
        && keys(value.error, ['code', 'message']) && text(value.error.message, 1024)
        && ['REGION_VIEW_NOT_FOUND', 'COMMAND_CANCELLED', 'INTERNAL_ERROR', 'UNSUPPORTED_COMMAND'].includes(value.error.code as string);
      break;
  }
  return valid ? value as DigitalTwinRegionViewMessage : null;
}
