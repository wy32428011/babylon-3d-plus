import { resolveEffectTargets } from './effectTargets';
import type { SceneDocument } from './SceneDocument';
import { validateLightWallPoints } from './lightWallFence';

export type DigitalTwinEffectConfig = {
  targetEntityId: string | null;
  radius: number;
  height: number;
  width: number;
  opacity: number;
  duration: number;
  progress: number;
  loop: boolean;
  axis: 'x' | 'y' | 'z';
  amount: number;
  points: { x: number; y: number; z: number }[];
  values: number[];
  labels: string[];
};

/** 编辑器与导入规范化共用范围，单位为米、秒或 0–1 比例。 */
export const DIGITAL_TWIN_EFFECT_NUMBER_LIMITS = {
  radius: { min: 0.05, max: 10000 },
  height: { min: 0.05, max: 10000 },
  width: { min: 0.005, max: 10 },
  opacity: { min: 0, max: 1 },
  duration: { min: 0.1, max: 3600 },
  progress: { min: 0, max: 1 },
  amount: { min: 0, max: 1000 },
} as const;

type Field = keyof DigitalTwinEffectConfig;
const target: Field[] = ['targetEntityId'];
const area: Field[] = ['points', 'opacity', 'width'];
const ring: Field[] = ['radius', 'width', 'opacity', 'duration'];
const path: Field[] = ['points', 'width', 'opacity', 'duration', 'loop'];
const data: Field[] = ['points', 'values', 'opacity'];

/** 稳定 ID 是场景协议的一部分，名称和分类只影响编辑器展示。 */
export const DIGITAL_TWIN_EFFECT_DEFINITIONS = [
  { kind: 'model-color', name: '设备变红 / 变橙', category: '设备报警', description: '整体覆盖设备或指定部件的颜色，支持保留原材质比例。', fields: target },
  { kind: 'model-flash', name: '设备闪烁高亮', category: '设备报警', description: '在高亮与原外观之间按周期闪烁，可指定报警部件。', fields: target },
  { kind: 'alarm-icon', name: '告警图标悬浮', category: '设备报警', description: '设备上方显示面向相机的发光三角感叹号。', fields: ['height', 'opacity', 'duration'] },
  { kind: 'alarm-zone', name: '地面警戒圈', category: '设备报警', description: '分段红橙警戒圈、警告标识与禁止靠近文字。', fields: ['radius', 'width', 'opacity'] },
  { kind: 'alarm-label', name: '弹窗 / 标签告警', category: '设备报警', description: '显示设备名、告警级别、内容和触发时间的悬浮信息卡。', fields: ['height', 'opacity'] },
  { kind: 'alarm-route', name: '路径指引到故障点', category: '设备报警', description: '沿配置的设备局部路径显示流动箭头，末点固定对准设备；不自动避障寻路。', fields: ['points', 'width', 'radius', 'opacity', 'duration'] },
  { kind: 'model-outline', name: '轮廓高亮', category: '建筑与模型', description: '绑定模型显示轮廓；同一模型同时启用多个模型效果时按先绑定顺序生效。', fields: [...target, 'width'] },
  { kind: 'model-edges', name: '建筑棱线发光', category: '建筑与模型', description: '提取模型棱线，强调建筑结构。', fields: [...target, 'width'] },
  { kind: 'model-emissive', name: '自发光与光晕', category: '建筑与模型', description: '绑定灯带、标识等独立部件，保留模型原有材质。', fields: target },
  { kind: 'model-scan', name: '建筑扫光', category: '建筑与模型', description: '沿指定轴向扫描真实模型表面。', fields: [...target, 'axis', 'width', 'duration'] },
  { kind: 'height-gradient', name: '高度渐变着色', category: '建筑与模型', description: '按模型世界高度在主色与辅助色之间渐变。', fields: target },
  { kind: 'hologram', name: '全息投影 / 线框模型', category: '建筑与模型', description: '显示模型的透明全息线框。', fields: [...target, 'opacity'] },
  { kind: 'xray', name: '透明透视 / X-Ray', category: '建筑与模型', description: '绑定外壳模型降低不透明度；内部结构需由原模型提供。', fields: [...target, 'opacity'] },
  { kind: 'dissolve', name: '溶解出现 / 模型生长', category: '建筑与模型', description: '默认单次生长，完成后保持完整外观；开启循环时完成后短暂停留再重播。显示上限设为 100% 才会展示完整模型。', fields: [...target, 'axis', 'duration', 'progress', 'loop'] },
  { kind: 'boundary-flow', name: '区域边界流光', category: '区域与范围', description: '沿闭合区域轮廓流动，坐标以特效实体为局部原点。', fields: [...area, 'duration', 'amount'] },
  { kind: 'area-fill', name: '区域半透明填充', category: '区域与范围', description: '填充局部 X/Z 平面多边形，轮廓自动闭合。', fields: [...area, 'duration'] },
  { kind: 'ripple-ring', name: '扩散光圈 / 波纹扩散', category: '区域与范围', description: '从中心连续向外扩散多重光圈。', fields: ['radius', 'opacity', 'duration', 'amount'] },
  { kind: 'breathing-ring', name: '呼吸光圈', category: '区域与范围', description: '以呼吸亮度强调目标位置。', fields: ring },
  { kind: 'radar-sector', name: '雷达扫描 / 扇形扫描', category: '区域与范围', description: '绕中心旋转的扇形扫描面，范围由半径控制。', fields: ['radius', 'opacity', 'duration', 'amount'] },
  { kind: 'light-pillar', name: '定位光柱 / 光锥', category: '区域与范围', description: '垂直渐变光柱与底部定位圈。', fields: ['radius', 'height', 'width', 'opacity', 'duration'] },
  { kind: 'energy-dome', name: '半球罩 / 能量罩', category: '区域与范围', description: '半球形空间防护范围；半径控制底面，高度控制罩顶。', fields: ['radius', 'height', 'width', 'opacity', 'duration'] },
  { kind: 'flow-path', name: '流光路径', category: '路径与物流', description: '沿配置路径流动，坐标以特效 Transform 为原点。', fields: [...path, 'amount'] },
  { kind: 'flow-arrows', name: '流动箭头', category: '路径与物流', description: '沿折线路径移动的方向箭头。', fields: [...path, 'amount'] },
  { kind: 'fly-line', name: '飞线', category: '路径与物流', description: '使用路径首尾点生成弧形飞线，高度控制拱高。', fields: [...path, 'height', 'amount'] },
  { kind: 'motion-trail', name: '轨迹拖尾', category: '路径与物流', description: '绑定运动目标记录有界轨迹；未绑定时沿配置路径演示。', fields: [...target, ...path, 'amount'] },
  { kind: 'path-reveal', name: '路径逐段点亮', category: '路径与物流', description: '沿路径逐段点亮；关闭循环时完成后停留。', fields: [...path, 'progress'] },
  { kind: 'pipe-flow', name: '管道流动 / 能量流动', category: '路径与物流', description: '沿三维路径绘制管线与流动光效。', fields: [...path, 'amount'] },
  { kind: 'heatmap', name: '热力图', category: '空间数据', description: '按各采样点的配置数值显示热区；热区半径最小为显示范围的 8%，数值不是自动取得的业务遥测。', fields: [...data, 'radius', 'width'] },
  { kind: 'region-level', name: '区域分级着色', category: '空间数据', description: '按各区域中心及数值显示分级色块，半径控制区域尺寸。', fields: [...data, 'radius', 'labels'] },
  { kind: 'data-bars', name: '三维数据柱', category: '空间数据', description: '每个采样点对应一根数据柱，按数值比例显示高度，宽度控制柱体尺寸。', fields: [...data, 'height', 'width', 'labels'] },
  { kind: 'camera-frustum', name: '监控视锥 / 覆盖扇形', category: '空间数据', description: '安装高度控制锥顶，范围半宽控制矩形覆盖面；朝局部 +Z，覆盖纵向为半宽的 0.5–2 倍，使用 Transform 旋转朝向。', fields: ['radius', 'height', 'width', 'opacity'] },
  { kind: 'floor-expand', name: '楼层展开', category: '结构展示', description: '根据实际子部件的高度展开；模型必须已有可区分的楼层结构。', fields: [...target, 'amount', 'progress'] },
  { kind: 'explode', name: '零件爆炸图', category: '结构展示', description: '沿中心向外展开原有子部件；整体单网格不能凭空拆分零件。', fields: [...target, 'amount', 'progress'] },
  { kind: 'clip-section', name: '剖切 / 切片显示', category: '结构展示', description: '沿指定轴剖切，进度控制切面位置；不自动生成剖切封口。', fields: [...target, 'axis', 'progress'] },
  { kind: 'roof-fade', name: '屋顶隐藏 / 遮挡淡出', category: '结构展示', description: '优先识别命名屋顶部件，否则按最高子网格选择；可直接绑定屋顶实体。', fields: [...target, 'opacity'] },
  { kind: 'target-follow', name: '目标跟随', category: '镜头与环境', description: '仅运行预览 / Viewer 中自动跟随绑定目标；隐藏或禁用后恢复镜头。', fields: [...target, 'radius', 'height'] },
  { kind: 'environment-fog', name: '环境雾 / 距离雾', category: '镜头与环境', description: '场景级距离雾，半径为起雾距离、高度为过渡距离；同类以首个启用实例为准。', fields: ['radius', 'height', 'opacity'] },
  { kind: 'rain', name: '雨粒子', category: '镜头与环境', description: '在特效局部范围内生成下落雨丝。', fields: ['radius', 'height', 'opacity', 'duration', 'amount'] },
  { kind: 'snow', name: '雪粒子', category: '镜头与环境', description: '在特效局部范围内生成飘落雪片。', fields: ['radius', 'height', 'width', 'opacity', 'duration', 'amount'] },
  { kind: 'smoke-plume', name: '烟雾 / 蒸汽', category: '镜头与环境', description: '从局部原点向上扩散烟雾，颜色可调整为蒸汽。', fields: ['radius', 'height', 'opacity', 'duration', 'amount'] },
  { kind: 'flame', name: '火焰 / 火花', category: '镜头与环境', description: '局部火焰与上升火星，用于事故或焊接场景表现。', fields: ['radius', 'height', 'opacity', 'duration', 'amount'] },
  { kind: 'day-night', name: '昼夜切换', category: '镜头与环境', description: '平滑改变场景灯光与环境亮度；进度 0 为白天、1 为夜晚，循环启用自动往返。', fields: ['progress', 'duration', 'loop'] },
  { kind: 'water-surface', name: '水面波纹', category: '镜头与环境', description: '程序化动态水面波纹，调整范围并放到水池表面；不生成真实水体反射。', fields: ['radius', 'opacity', 'duration'] },
] as const satisfies readonly { kind: string; name: string; category: string; description: string; fields: readonly Field[] }[];

export type DigitalTwinEffectKind = (typeof DIGITAL_TWIN_EFFECT_DEFINITIONS)[number]['kind'];
const kinds = new Set<string>(DIGITAL_TWIN_EFFECT_DEFINITIONS.map(x => x.kind));
export const MODEL_EFFECT_KINDS = new Set<string>(['model-color', 'model-flash', 'model-outline', 'model-edges', 'model-emissive', 'model-scan', 'height-gradient', 'hologram', 'xray', 'dissolve', 'floor-expand', 'explode', 'clip-section', 'roof-fade']);
export const AREA_EFFECT_KINDS = new Set<string>(['boundary-flow', 'area-fill']);
export const PATH_EFFECT_KINDS = new Set<string>(['alarm-route', 'flow-path', 'flow-arrows', 'fly-line', 'motion-trail', 'path-reveal', 'pipe-flow']);
export const DATA_EFFECT_KINDS = new Set<string>(['heatmap', 'region-level', 'data-bars']);
export function isDigitalTwinEffectKind(kind: unknown): kind is DigitalTwinEffectKind { return typeof kind === 'string' && kinds.has(kind); }

export function createDefaultDigitalTwinEffectConfig(kind: string): DigitalTwinEffectConfig {
  const isArea = AREA_EFFECT_KINDS.has(kind);
  return {
    targetEntityId: null, radius: kind === 'alarm-zone' ? 2.5 : kind === 'alarm-route' ? 0.45 : kind === 'light-pillar' || kind === 'flame' || kind === 'smoke-plume' ? 1 : kind === 'environment-fog' ? 20 : 5,
    height: kind === 'alarm-icon' ? 0.9 : kind === 'alarm-label' ? 1.1 : kind === 'environment-fog' ? 80 : 6, width: kind === 'alarm-zone' ? 0.14 : kind === 'alarm-route' ? 0.12 : kind === 'heatmap' ? 2 : kind === 'data-bars' ? 0.8 : 0.15, opacity: kind.startsWith('alarm-') ? 0.9 : 0.55, duration: kind === 'day-night' ? 20 : 4,
    progress: kind === 'clip-section' ? 0.5 : kind === 'day-night' || kind === 'path-reveal' ? 0 : 1, loop: kind !== 'day-night' && kind !== 'dissolve', axis: 'y', amount: kind === 'radar-sector' ? 60 : kind === 'motion-trail' ? 64 : kind === 'rain' ? 24 : kind === 'snow' ? 16 : kind === 'flame' ? 20 : kind === 'smoke-plume' ? 12 : 3,
    points: kind === 'alarm-route' ? [{x:-7,y:0,z:0},{x:-3,y:0,z:0},{x:0,y:0,z:0}] : isArea ? [{x:-5,y:0.03,z:-4},{x:5,y:0.03,z:-4},{x:5,y:0.03,z:4},{x:-5,y:0.03,z:4}]
      : [{x:-4,y:0.05,z:0},{x:0,y:0.05,z:3},{x:4,y:0.05,z:0}],
    values: [3, 6, 4], labels: ['A区', 'B区', 'C区'],
  };
}

const finite = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** UI 草稿在确认后校验，场景导入也用同一规则，避免加载时悄悄改写路径。 */
export function validateDigitalTwinEffectConfig(value: unknown, kind: string): asserts value is DigitalTwinEffectConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('特效配置格式无效。');
  const v = value as DigitalTwinEffectConfig;
  const minimum = AREA_EFFECT_KINDS.has(kind) ? 3 : PATH_EFFECT_KINDS.has(kind) ? 2 : 1;
  if (!Array.isArray(v.points) || v.points.length < minimum || v.points.length > 128) throw new Error(`特效路径 / 轮廓需要 ${minimum}–128 个点。`);
  if (v.points.some(p => !p || [p.x,p.y,p.z].some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 100000))) throw new Error('路径坐标必须为 ±100000 米内的有限数值。');
  if (AREA_EFFECT_KINDS.has(kind) && validateLightWallPoints(v.points)) throw new Error('区域轮廓无效：不能自交、折返或共线。');
  if (PATH_EFFECT_KINDS.has(kind) && v.points.some((p,i) => i > 0 && Math.hypot(p.x-v.points[i-1].x,p.y-v.points[i-1].y,p.z-v.points[i-1].z) < 0.001)) throw new Error('路径相邻点至少间隔 0.001 米。');
  if (!Array.isArray(v.values) || !v.values.length || v.values.length > 64 || v.values.some(x => typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1000000)) throw new Error('数据需要 1–64 个 0–1000000 内的有限数值。');
  if (!Array.isArray(v.labels) || v.labels.length > 64 || v.labels.some(x => typeof x !== 'string' || x.length > 80)) throw new Error('数据标签最多 64 项，每项最多 80 字。');
  if (DATA_EFFECT_KINDS.has(kind) && (v.points.length > 64 || v.points.length !== v.values.length)) throw new Error('数据采样点与数值数量必须一致且不超过 64。');
  for (const key of ['radius','height','width','opacity','duration','progress','amount'] as const) if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) throw new Error(`特效 ${key} 必须是有限数值。`);
  if (v.targetEntityId !== null && (typeof v.targetEntityId !== 'string' || !v.targetEntityId.trim() || v.targetEntityId.length > 200)) throw new Error('特效绑定目标无效。');
  if (!['x','y','z'].includes(v.axis) || typeof v.loop !== 'boolean') throw new Error('特效轴向或循环配置无效。');
}

export function sanitizeDigitalTwinEffectConfig(value: Partial<DigitalTwinEffectConfig> | undefined, kind: string): DigitalTwinEffectConfig {
  const d = createDefaultDigitalTwinEffectConfig(kind);
  const v = value ?? {};
  let points = Array.isArray(v.points) && v.points.length <= 128 && v.points.every(p => p && [p.x,p.y,p.z].every(n => Number.isFinite(n) && Math.abs(n) <= 100000)) ? v.points.map(p => ({x:p.x,y:p.y,z:p.z})) : d.points;
  const minimum = AREA_EFFECT_KINDS.has(kind) ? 3 : PATH_EFFECT_KINDS.has(kind) ? 2 : 1;
  if (points.length < minimum || (AREA_EFFECT_KINDS.has(kind) && validateLightWallPoints(points)) || (PATH_EFFECT_KINDS.has(kind) && points.some((p,i) => i > 0 && Math.hypot(p.x-points[i-1].x,p.y-points[i-1].y,p.z-points[i-1].z) < 0.001))) points = d.points;
  let values = Array.isArray(v.values) && v.values.length ? v.values.slice(0,64).map(x => finite(x, 0, 0, 1000000)) : d.values;
  if (DATA_EFFECT_KINDS.has(kind)) { points = points.slice(0,64); values = points.map((_,i) => values[i] ?? 0); }
  return {
    targetEntityId: typeof v.targetEntityId === 'string' && v.targetEntityId.trim() ? v.targetEntityId.trim().slice(0,200) : null,
    radius: finite(v.radius,d.radius,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.radius.min,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.radius.max), height: finite(v.height,d.height,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.height.min,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.height.max), width: finite(v.width,d.width,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.width.min,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.width.max),
    opacity: finite(v.opacity,d.opacity,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.opacity.min,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.opacity.max), duration: finite(v.duration,d.duration,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.duration.min,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.duration.max), progress: finite(v.progress,d.progress,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.progress.min,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.progress.max),
    loop: typeof v.loop === 'boolean' ? v.loop : d.loop, axis: v.axis === 'x' || v.axis === 'z' ? v.axis : 'y', amount: finite(v.amount,d.amount,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.amount.min,DIGITAL_TWIN_EFFECT_NUMBER_LIMITS.amount.max),
    points, values, labels: Array.isArray(v.labels) ? v.labels.slice(0,64).map(x => typeof x === 'string' ? x.slice(0,80) : '') : d.labels,
  };
}

/** 绑定目标和既有批次伙伴保持独立，避免保存 / Viewer 中共享材质或丢失可跟随节点。 */
export function collectDigitalTwinEffectTargetIds(scene: Pick<SceneDocument, 'entityIds' | 'entities'>): Set<string> {
  const independentIds = new Set<string>();
  for (const id of scene.entityIds) {
    const effect = scene.entities[id]?.components.poiEffect;
    if (effect?.configuration) {
      if (MODEL_EFFECT_KINDS.has(effect.effectKind)) {
        const targets = resolveEffectTargets(scene, effect.configuration.target, effect.effectKind);
        if (targets.status === 'resolved') for (const target of targets.ids) independentIds.add(target);
      }
      continue;
    }
    const targetId = effect?.visual?.targetEntityId;
    // 禁用和隐藏特效仍保留独立目标，切换效果时不改变模型加载拓扑。
    if (targetId) independentIds.add(targetId);
  }
  if (independentIds.size === 0) return independentIds;

  const membersBySource = new Map<string, string[]>();
  for (const id of scene.entityIds) {
    const sourceId = scene.entities[id]?.components.modelArrayInstance?.sourceEntityId;
    if (!sourceId) continue;
    const members = membersBySource.get(sourceId) ?? [];
    members.push(id);
    membersBySource.set(sourceId, members);
  }
  // 双向遍历也兼容旧场景的链式关系；每个实体只进入队列一次。
  const pending = [...independentIds];
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index];
    const sourceId = scene.entities[id]?.components.modelArrayInstance?.sourceEntityId;
    const neighbours = membersBySource.get(id) ?? [];
    for (const neighbour of sourceId ? [sourceId, ...neighbours] : neighbours) {
      if (independentIds.has(neighbour)) continue;
      independentIds.add(neighbour);
      pending.push(neighbour);
    }
  }
  return independentIds;
}
