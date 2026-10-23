import type { LightingProbeData } from '../../../electron/shared/sceneLightingBakeContract.ts';

type Position = readonly [number, number, number];
type Probe = LightingProbeData['probes'][number];
/** 空间桶限制查询成本；遮挡回调负责阻止跨楼板或墙体的间接光插值。 */
export class LightingProbeSampler {
  private readonly cells = new Map<string, Probe[]>();
  readonly spacing: number;

  constructor(data: LightingProbeData) {
    if (data.version !== 1 || data.encoding !== 'ambient-cube' || !Number.isFinite(data.spacing) || data.spacing <= 0 || !Array.isArray(data.probes)) {
      throw new Error('间接光探针资源格式无效。');
    }
    this.spacing = data.spacing;
    for (const probe of data.probes) {
      if (!Array.isArray(probe.position) || probe.position.length !== 3 || !probe.position.every(Number.isFinite)
        || !Array.isArray(probe.irradiance) || probe.irradiance.length !== 18
        || !probe.irradiance.every(value => Number.isFinite(value) && value >= 0)) throw new Error('间接光探针包含无效方向或像素值。');
      const key = this.cell(probe.position);
      const list = this.cells.get(key) ?? []; list.push(probe); this.cells.set(key, list);
    }
  }

  private cell(position: Position): string {
    return position.map(v => Math.floor(v / this.spacing)).join(',');
  }

  sample(position: Position, visible: (point: Position) => boolean = () => true): number[] | null {
    const center = position.map(v => Math.floor(v / this.spacing));
    const nearby: Array<{ probe: Probe; distance: number }> = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      const probes = this.cells.get(`${center[0] + x},${center[1] + y},${center[2] + z}`) ?? [];
      for (const probe of probes) {
        const distance = Math.hypot(...probe.position.map((v, i) => v - position[i]));
        if (distance <= this.spacing * 1.75) nearby.push({ probe, distance });
      }
    }
    nearby.sort((a, b) => a.distance - b.distance);
    const selected = nearby.filter(({ probe }) => visible(probe.position)).slice(0, 8);
    if (!selected.length) return null;
    const result = Array(18).fill(0) as number[];
    let total = 0;
    for (const { probe, distance } of selected) {
      const weight = 1 / Math.max(0.001, distance * distance);
      total += weight;
      for (let i = 0; i < 18; i++) result[i] += probe.irradiance[i] * weight;
    }
    return result.map(value => value / total);
  }
}
