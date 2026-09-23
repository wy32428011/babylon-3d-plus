import type { RgvMotionArrowChannel } from '../editor/model/rgvMotionArrows.ts';

export type RgvMotionArrowPreview = 1 | -1 | 0 | null;

const previews = new Map<string, Map<RgvMotionArrowChannel, Exclude<RgvMotionArrowPreview, null>>>();
const diagnostics = new Map<string, Map<RgvMotionArrowChannel, string>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function setChannelValue<T>(map: Map<string, Map<RgvMotionArrowChannel, T>>, entityId: string, channel: RgvMotionArrowChannel, value: T | null): void {
  if (value === null) {
    const channels = map.get(entityId);
    channels?.delete(channel);
    if (channels?.size === 0) map.delete(entityId);
  } else {
    let channels = map.get(entityId);
    if (!channels) { channels = new Map(); map.set(entityId, channels); }
    channels.set(channel, value);
  }
  notify();
}

/** 临时预览和诊断按实体、运动通道隔离，不进入场景、命令历史及发布包。 */
export const rgvMotionArrowSession = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  setPreview(entityId: string, channel: RgvMotionArrowChannel, direction: RgvMotionArrowPreview): void {
    if ((previews.get(entityId)?.get(channel) ?? null) === direction) return;
    setChannelValue(previews, entityId, channel, direction);
  },
  getPreview(entityId: string, channel: RgvMotionArrowChannel): RgvMotionArrowPreview {
    return previews.get(entityId)?.get(channel) ?? null;
  },
  setDiagnostic(entityId: string, channel: RgvMotionArrowChannel, message: string): void {
    if ((diagnostics.get(entityId)?.get(channel) ?? '') === message) return;
    setChannelValue(diagnostics, entityId, channel, message || null);
  },
  getDiagnostic(entityId: string, channel: RgvMotionArrowChannel): string {
    return diagnostics.get(entityId)?.get(channel) ?? '';
  },
  remove(entityId: string): void {
    const previewRemoved = previews.delete(entityId);
    const diagnosticRemoved = diagnostics.delete(entityId);
    if (previewRemoved || diagnosticRemoved) notify();
  },
  clear(): void {
    if (previews.size === 0 && diagnostics.size === 0) return;
    previews.clear();
    diagnostics.clear();
    notify();
  },
};

