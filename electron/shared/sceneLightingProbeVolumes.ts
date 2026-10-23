export type LightingProbeVolume = {
  id: string;
  name: string;
  enabled: boolean;
  min: [number, number, number];
  max: [number, number, number];
};
export type LightingProbeBounds = { min: [number, number, number]; max: [number, number, number] };
export type LightingProbeVolumePlan = { positions: [number, number, number][]; count: number; countExact: boolean; bounds: LightingProbeBounds };

/** 无效区域必须明确报错，不能在归一化时静默丢弃用户指定的覆盖范围。 */
export function normalizeLightingProbeVolumes(value: unknown): LightingProbeVolume[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('探针覆盖区域列表无效。');
  const ids = new Set<string>();
  return value.map(raw => {
    const v = raw as Partial<LightingProbeVolume> | null;
    if (!v || typeof v.id !== 'string' || !v.id.trim() || typeof v.name !== 'string'
      || !Array.isArray(v.min) || v.min.length !== 3 || !v.min.every(Number.isFinite)
      || !Array.isArray(v.max) || v.max.length !== 3 || !v.max.every(Number.isFinite)
      || v.min.some((low, axis) => low >= v.max![axis])) throw new Error('探针覆盖区域必须具有有效标识和有限、严格递增的世界坐标范围。');
    if (ids.has(v.id)) throw new Error('探针覆盖区域标识重复：' + v.id);
    ids.add(v.id);
    return { id: v.id, name: v.name, enabled: v.enabled !== false,
      min: [...v.min] as [number, number, number], max: [...v.max] as [number, number, number] };
  });
}

/** 与 Cycles 保持相同 cell-center 排布；区域只限定探针，遮挡和反弹仍使用完整几何。 */
export function planLightingProbeVolumes(
  volumes: readonly LightingProbeVolume[] | undefined, spacing: number, fallback: LightingProbeBounds, limit = 4096,
): LightingProbeVolumePlan {
  if (!Number.isFinite(spacing) || spacing <= 0) throw new Error('探针间距必须大于零。');
  const active = volumes?.filter(volume => volume.enabled) ?? [];
  const regions = active.length ? active : [fallback];
  const bounds: LightingProbeBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const region of regions) for (let axis = 0; axis < 3; axis++) {
    bounds.min[axis] = Math.min(bounds.min[axis], region.min[axis]); bounds.max[axis] = Math.max(bounds.max[axis], region.max[axis]);
  }
  const positions: [number, number, number][] = [], keys = new Set<string>();
  for (const region of regions) {
    const extents = region.max.map((value, axis) => Math.max(0, value - region.min[axis]));
    const counts = extents.map(extent => Math.max(1, Math.ceil(extent / spacing)));
    const count = counts.reduce((product, value) => product * value, 1);
    if (!active.length && count > limit) return { positions, count, countExact: true, bounds };
    for (let x = 0; x < counts[0]; x++) for (let y = 0; y < counts[1]; y++) for (let z = 0; z < counts[2]; z++) {
      const indices = [x, y, z];
      const position = extents.map((extent, axis) => region.min[axis] + (indices[axis] + 0.5)
        * (active.length ? extent : Math.max(extent, 0.1)) / counts[axis]) as [number, number, number];
      // 明确使用 floor，保证负坐标与 Python 一致，不依赖 round 的舍入约定。
      const key = position.map(value => Math.floor(value * 1e6 + 0.5)).join(',');
      if (keys.has(key)) continue;
      keys.add(key); positions.push(position);
      if (positions.length > limit) return { positions, count: positions.length, countExact: false, bounds };
    }
  }
  return { positions, count: positions.length, countExact: true, bounds };
}
