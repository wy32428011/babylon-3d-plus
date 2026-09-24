import type { EffectParameterDefinition as Definition } from './effectConfiguration';

const number = (key: string, label: string, value: number, min: number, max: number): Definition => ({ key, label, default: value, min, max, group: '报警外观', type: 'number', bindable: true });
const text = (key: string, label: string, value: string): Definition => ({ key, label, default: value, group: '报警文字', type: 'string' });
const toggle = (key: string, label: string, value: boolean): Definition => ({ key, label, default: value, group: '报警外观', type: 'boolean' });
const definitions: Record<string, readonly Definition[]> = {
  'alarm-icon': [number('iconSize', '图标尺寸 (米)', 0.9, 0.1, 30), number('floatAmplitude', '悬浮幅度 (米)', 0.1, 0, 10), toggle('showStem', '显示定位引线', true)],
  'alarm-zone': [number('segments', '警戒环分段数', 24, 4, 128), number('gapRatio', '分段间隙比例', 0.24, 0, 0.8), text('warningText', '警戒文字', '禁止靠近'), toggle('showWarning', '显示警告标识', true), number('elevation', '离地高度 (米)', 0.025, 0.005, 10)],
  'alarm-label': [text('title', '设备标题（空为设备名）', ''), text('severity', '告警级别', '严重告警'), text('message', '告警内容', '检测到异常，请及时处理'), text('timeText', '时间文字（空为触发时间）', ''), number('cardWidth', '信息卡宽度 (米)', 2.8, 0.5, 30), number('cardHeight', '信息卡高度 (米)', 1.7, 0.5, 20), number('offsetX', '信息卡横向偏移 (米)', 1.6, -100, 100), number('backgroundOpacity', '卡片背景透明度', 0.78, 0, 1)],
  'alarm-route': [number('arrowSpacing', '箭头间距 (米)', 0.9, 0.1, 100), number('arrowSize', '箭头尺寸 (米)', 0.45, 0.05, 10), number('elevation', '离地高度 (米)', 0.04, 0.005, 10), toggle('showEndpoint', '显示故障终点标识', true)],
};
const fitKinds = new Set(['breathing-ring', 'ripple-ring', 'alarm-zone']);

export function getAlarmEffectParameters(kind: string): readonly Definition[] {
  return [...(definitions[kind] ?? []), ...(fitKinds.has(kind) ? [toggle('fitTarget', '报警时覆盖设备范围', false)] : [])];
}
