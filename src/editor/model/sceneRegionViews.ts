import type { SceneCameraSettings, SceneCameraPose } from './SceneDocument';

export const MAX_SCENE_REGION_VIEWS = 256;
export const MAX_REGION_VIEW_NAME_LENGTH = 80;
export type SceneRegionCamera = Omit<SceneCameraSettings, 'savedPose' | 'viewDistance'> & { savedPose: SceneCameraPose };
export type SceneRegionView = { id: string; name: string; camera: SceneRegionCamera };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 旧场景兼容空列表；坏项单独报告，不能伪造一个默认原点视角。 */
export function normalizeSceneRegionViews(value: unknown): { views: SceneRegionView[]; issues: string[] } {
  const views: SceneRegionView[] = [];
  const issues: string[] = [];
  if (value === undefined || value === null) return { views, issues };
  if (!Array.isArray(value)) return { views, issues: ['区域视角列表格式无效'] };
  if (value.length > MAX_SCENE_REGION_VIEWS) issues.push(`区域视角超过 ${MAX_SCENE_REGION_VIEWS} 项，超出部分未加载`);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, item] of value.slice(0, MAX_SCENE_REGION_VIEWS).entries()) {
    const camera = record(item) && record(item.camera) ? item.camera : null;
    const pose = camera && record(camera.savedPose) ? camera.savedPose : null;
    const target = pose && record(pose.target) ? pose.target : null;
    const name = record(item) && typeof item.name === 'string' ? item.name.trim() : '';
    if (!record(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 256
      || ids.has(item.id) || !name || name.length > MAX_REGION_VIEW_NAME_LENGTH || names.has(name)
      || !camera || !pose || !target
      || ![pose.alpha, pose.beta, pose.radius, target.x, target.y, target.z].every(v => typeof v === 'number' && Number.isFinite(v))
      || (pose.radius as number) <= 0
      || !['orbit', 'top', 'bottom', 'front', 'back', 'left', 'right'].includes(camera.savedOrientation as string)
      || !['perspective', 'orthographic'].includes(camera.savedProjection as string)) {
      issues.push(`第 ${index + 1} 个区域视角无效或名称/ID重复，已跳过`);
      continue;
    }
    ids.add(item.id);
    names.add(name);
    views.push({ id: item.id, name, camera: {
      savedPose: { alpha: pose.alpha as number, beta: pose.beta as number, radius: pose.radius as number,
        target: { x: target.x as number, y: target.y as number, z: target.z as number } },
      savedOrientation: camera.savedOrientation as SceneRegionCamera['savedOrientation'],
      savedProjection: camera.savedProjection as SceneRegionCamera['savedProjection'],
    } });
  }
  return { views, issues };
}

export function validateRegionViewName(name: string, views: readonly SceneRegionView[], exceptId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '区域视角名称不能为空';
  if (trimmed.length > MAX_REGION_VIEW_NAME_LENGTH) return `名称不能超过 ${MAX_REGION_VIEW_NAME_LENGTH} 个字符`;
  if (views.some(view => view.id !== exceptId && view.name === trimmed)) return '该区域视角名称已存在';
  return null;
}

export function updateRegionView(views: readonly SceneRegionView[], id: string, patch: Partial<Pick<SceneRegionView, 'name' | 'camera'>>): SceneRegionView[] {
  if (!views.some(view => view.id === id)) throw new Error('区域视角不存在，可能已被删除');
  const result = normalizeSceneRegionViews(views.map(view => view.id === id ? { ...view, ...patch } : view));
  if (result.issues.length) throw new Error(result.issues.join('；'));
  return result.views;
}
