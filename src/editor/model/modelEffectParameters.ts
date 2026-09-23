import type { EffectParameterDefinition as Definition } from './effectConfiguration';

const number = (key: string, label: string, value: number, min: number, max: number, group = '专用参数', bindable = true): Definition => ({ key, label, group, type: 'number', default: value, min, max, bindable });
const select = (key: string, label: string, value: string, options: [string, string][], group = '专用参数'): Definition => ({ key, label, group, type: 'select', default: value, options: options.map(([value, label]) => ({ value, label })) });
const paths: Definition = { key: 'nodePaths', label: '作用部件路径', group: '部件选择', type: 'string', default: '', description: '每行一个相对目标根节点的路径或节点名；空白作用于全部部件。节点名重复时请填写完整路径。' };
const tint: Definition = { key: 'color', label: '效果颜色', group: '外观', type: 'color', default: '#00ccff', bindable: true };
const axis = select('axis', '作用轴', 'y', [['x', 'X'], ['y', 'Y'], ['z', 'Z']]);
const direction = select('direction', '播放方向', 'forward', [['forward', '正向'], ['reverse', '反向']]);
const coordinate = select('coordinateSpace', '坐标空间', 'world', [['world', '世界坐标'], ['local', '目标局部坐标']]);
const progress = number('progress', '完成比例 (0～1)', 1, 0, 1, '播放', true);
const progressMode = select('progressMode', '进度来源', 'time', [['time', '时间播放'], ['external', '外部进度']], '播放');
const opacity = number('opacity', '透明度', .3, 0, 1, '外观');
const duration = number('duration', '播放时长 (秒)', 5, .1, 3600, '播放');
const edge = [
  { key: 'edgeEnabled', label: '显示边线', group: '边线', type: 'boolean', default: true } as Definition,
  { key: 'edgeColor', label: '边线颜色', group: '边线', type: 'color', default: '#00ccff', bindable: true } as Definition,
  number('edgeWidth', '边线宽度', 1.5, .1, 20, '边线'),
  number('edgeThreshold', '棱角余弦阈值', .95, 0, 1, '边线', false),
];
function validateGroups(value: unknown): string | null {
  if (!Array.isArray(value) || value.length > 128) return '结构分组须为最多 128 行的数组。';
  const used = new Set<string>();
  for (const [index, row] of value.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.nodePath !== 'string' || !row.nodePath.trim() || row.nodePath.length > 1000) return `第 ${index + 1} 行需要有效的 nodePath。`;
    if (used.has(row.nodePath.trim())) return `第 ${index + 1} 行重复指定了同一部件。`;
    used.add(row.nodePath.trim());
    for (const key of ['order', 'distance']) if (row[key] !== undefined && (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || Math.abs(row[key]) > 100000)) return `第 ${index + 1} 行 ${key} 必须为有限数值（绝对值不超过 100000）。`;
    if (row.axis !== undefined && !['x', 'y', 'z'].includes(row.axis)) return `第 ${index + 1} 行 axis 只能是 x、y 或 z。`;
    if (row.fixed !== undefined && typeof row.fixed !== 'boolean') return `第 ${index + 1} 行 fixed 必须为布尔值。`;
    if (row.offset !== undefined && (!row.offset || typeof row.offset !== 'object' || ['x', 'y', 'z'].some(key => typeof row.offset[key] !== 'number' || !Number.isFinite(row.offset[key]) || Math.abs(row.offset[key]) > 100000))) return `第 ${index + 1} 行 offset 需要有限的 x、y、z 米坐标。`;
  }
  return null;
}
function validateStops(value: unknown): string | null {
  if (!Array.isArray(value) || value.length > 8) return '渐变最多支持 8 个颜色断点。';
  const positions = new Set<number>();
  for (const [index, row] of value.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.position !== 'number' || !Number.isFinite(row.position) || row.position < 0 || row.position > 1 || typeof row.color !== 'string' || !/^#[\da-f]{6}$/i.test(row.color)) return `第 ${index + 1} 个断点需要 position:0～1 和 color:#rrggbb。`;
    if (positions.has(row.position)) return `第 ${index + 1} 个断点位置重复。`;
    positions.add(row.position);
  }
  return null;
}
const groups: Definition = { key: 'structureGroups', label: '结构分组', group: '结构', type: 'rows', default: [], description: '每行 {nodePath, order, distance, axis, fixed}，可用 offset:{x,y,z} 指定世界米偏移。父子组只移动父组，避免重复位移；fixed 组不移动。', validate: validateGroups };
const definitions: Record<string, readonly Definition[]> = {
  'model-outline': [paths, tint, number('lineWidth', '轮廓宽度 (米)', .05, .001, 5)],
  'model-edges': [paths, tint, opacity, number('edgeWidth', '棱线宽度', 1.5, .1, 20), number('edgeThreshold', '棱角余弦阈值', .95, 0, 1, '专用参数', false)],
  'model-emissive': [paths, tint, { key: 'materialNames', label: '发光材质名称', group: '部件选择', type: 'string', default: '', description: '每行一个精确材质名称；留空作用于选中部件全部受支持材质。' }, number('emissiveIntensity', '发光强度', 1, 0, 10), number('glowIntensity', '光晕强度', 1, 0, 5), number('glowRadius', '光晕模糊半径', 32, 1, 128)],
  'model-scan': [paths, tint, axis, coordinate, direction, number('scanStart', '扫描起点比例', 0, 0, 1), number('scanEnd', '扫描终点比例', 1, 0, 1), number('bandWidth', '光带宽度 (米)', .15, .001, 1000), number('delay', '开始延迟 (秒)', 0, 0, 3600, '播放'), duration, number('interval', '每轮间隔 (秒)', 0, 0, 3600, '播放')],
  'height-gradient': [paths, axis, coordinate, select('rangeMode', '高度范围', 'automatic', [['automatic', '目标包围盒'], ['manual', '手动范围']]), number('rangeMin', '范围起点 (米)', 0, -1000000, 1000000), number('rangeMax', '范围终点 (米)', 10, -1000000, 1000000), { key: 'gradientStops', label: '颜色断点', group: '渐变', type: 'rows', default: [], description: '最多 8 个 {position:0～1, color:"#rrggbb"}；留空使用主色与辅助色。', validate: validateStops }, number('originalMix', '保留原始材质比例', 0, 0, 1)],
  hologram: [paths, tint, number('surfaceOpacity', '表面透明度', .3, 0, 1), { key: 'wireframe', label: '仅显示三角线框', group: '外观', type: 'boolean', default: true }, ...edge, number('scanLines', '扫描线数量', 14.3, 0, 256), number('scanLineSpeed', '扫描线速度', 1, -20, 20)],
  xray: [paths, tint, opacity, ...edge, { key: 'depthWrite', label: '写入深度', group: '外观', type: 'boolean', default: false }, { key: 'backFaceCulling', label: '剔除背面', group: '外观', type: 'boolean', default: false }],
  dissolve: [paths, tint, axis, coordinate, direction, progressMode, progress, duration, number('delay', '开始延迟 (秒)', 0, 0, 3600, '播放'), number('completedHold', '完成停留 (秒)', 1, 0, 3600, '播放'), number('noiseStrength', '溶解噪声比例', .04, 0, .5), number('edgeWidth', '溶解边缘比例', .035, .001, .5)],
  'floor-expand': [paths, groups, axis, progress, number('amount', '默认展开间距 (米)', 3, 0, 10000)],
  explode: [paths, groups, progress, number('amount', '默认爆炸距离 (米)', 3, 0, 10000)],
  'clip-section': [paths, tint, axis, coordinate, progress, select('clipSide', '保留部分', 'below', [['below', '平面以下'], ['above', '平面以上'], ['slice', '切片']]), number('sliceThickness', '切片厚度比例', .1, .001, 1), number('edgeWidth', '切片边缘比例', .035, .001, .5)],
  'roof-fade': [paths, { key: 'roofPaths', label: '屋顶部件路径', group: '部件选择', type: 'string', default: '', description: '每行一个节点路径或唯一节点名。显式指定后不再根据名称与高度猜测。' }, opacity, number('fadeDuration', '淡出过渡 (秒)', 0, 0, 3600)],
};

export function getModelEffectParameters(kind: string): readonly Definition[] { return definitions[kind] ?? []; }
