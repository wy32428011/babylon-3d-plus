export type ConveyorSurfaceArrowPreview = 1 | -1 | 0 | null;

const previews = new Map<string, Exclude<ConveyorSurfaceArrowPreview, null>>();
const diagnostics = new Map<string, string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** 编辑预览和运行诊断只存在于当前会话，不进入场景、命令历史或发布配置。 */
export const conveyorSurfaceArrowSession = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  setPreview(entityId: string, direction: ConveyorSurfaceArrowPreview): void {
    if ((previews.get(entityId) ?? null) === direction) return;
    if (direction === null) previews.delete(entityId);
    else previews.set(entityId, direction);
    notify();
  },
  getPreview(entityId: string): ConveyorSurfaceArrowPreview {
    return previews.get(entityId) ?? null;
  },
  setDiagnostic(entityId: string, message: string): void {
    if ((diagnostics.get(entityId) ?? '') === message) return;
    if (message) diagnostics.set(entityId, message);
    else diagnostics.delete(entityId);
    notify();
  },
  getDiagnostic(entityId: string): string {
    return diagnostics.get(entityId) ?? '';
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
