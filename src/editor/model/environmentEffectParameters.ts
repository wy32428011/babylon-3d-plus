import type { EffectParameterDefinition as Definition } from './effectConfiguration';

const number = (key: string, label: string, value: number, min: number, max: number, group = '专用参数'): Definition => ({ key, label, group, type: 'number', default: value, min, max, bindable: true });
const select = (key: string, label: string, value: string, options: [string, string][]): Definition => ({ key, label, group: '专用参数', type: 'select', default: value, options: options.map(([value, label]) => ({ value, label })) });
const definitions: Record<string, readonly Definition[]> = {
  'target-follow': [
    select('cameraMode', '跟随视角', 'follow', [['follow', '追尾'], ['overhead', '俯视'], ['side', '侧视'], ['custom', '自定义偏移']]),
    select('forwardAxis', '模型前向轴', '+z', [['+x', '+X'], ['-x', '-X'], ['+z', '+Z'], ['-z', '-Z']]),
    select('heading', '镜头方位', 'keep', [['keep', '保持当前方位'], ['target', '跟随目标朝向']]),
    number('distance', '水平跟随距离 (米)', 5, .01, 100000), number('height', '跟随高度 (米)', 3, -100000, 100000), number('lateral', '横向偏移 (米)', 0, -100000, 100000),
    { key: 'targetOffset', label: '视点局部偏移 (米)', group: '镜头', type: 'vector', default: { x: 0, y: 0, z: 0 }, bindable: true },
    { key: 'cameraOffset', label: '自定义相机局部偏移 (米)', group: '镜头', type: 'vector', default: { x: 0, y: 3, z: -5 }, bindable: true },
    number('smoothTime', '平滑时间 (秒)', .125, 0, 30), number('maxCatchupSpeed', '最大追赶速度 (米/秒，0 不限制)', 0, 0, 100000),
    { key: 'manualTakeover', label: '允许鼠标接管并暂停', group: '镜头', type: 'boolean', default: true },
    select('exitBehavior', '停用时镜头', 'restore', [['restore', '恢复启用前镜头'], ['hold', '保持当前镜头']]),
  ],
  'environment-fog': [select('fogMode', '雾模式', 'linear', [['linear', '线性距离雾'], ['exp', '指数雾'], ['exp2', '平方指数雾']]), number('density', '指数雾密度', .01, 0, 1), number('start', '雾起始距离 (米)', 10, 0, 1000000), number('end', '雾结束距离 (米)', 100, .01, 1000000), number('transition', '参数平滑时间 (秒)', 0, 0, 60), { key: 'color', label: '雾颜色', group: '外观', type: 'color', default: '#00ccff', bindable: true }],
  'day-night': [select('dayMode', '昼夜驱动', 'manual', [['manual', '固定时刻'], ['loop', '循环时钟'], ['once', '单次时钟'], ['external', '外部夜间比例']]), number('hour', '当前 / 起始时刻', 12, 0, 24), number('endHour', '单次结束时刻', 0, 0, 24), number('duration', '昼夜周期 (秒)', 60, .1, 86400), number('lightFloor', '夜间最低亮度比例', .08, 0, 1), number('progress', '外部夜间比例', 0, 0, 1), select('endBehavior', '单次完成行为', 'hold', [['hold', '保持结束时刻'], ['restore', '恢复灯光基准']])],
};

export function getEnvironmentEffectParameters(kind: string): readonly Definition[] { return definitions[kind] ?? []; }
