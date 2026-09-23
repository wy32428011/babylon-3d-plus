import type { EffectParameterDefinition as Definition } from './effectConfiguration';
import { validateLightWallPoints } from './lightWallFence';

function validateRows(value: unknown, key: string): string | null {
  if (!Array.isArray(value) || value.length > 64) return '配置最多允许 64 行。';
  const ids = new Set<string>();
  for (const [index, row] of value.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return `第 ${index + 1} 行需要对象。`;
    if (key === 'regions') {
      if (typeof row.id !== 'string' || !row.id.trim() || row.id.length > 120 || ids.has(row.id)) return `第 ${index + 1} 行区域 ID 必须唯一且不为空。`;
      ids.add(row.id);
      if (row.name !== undefined && (typeof row.name !== 'string' || row.name.length > 80)) return `第 ${index + 1} 行区域名称最多 80 字。`;
      if (typeof row.value !== 'number' || !Number.isFinite(row.value) || Math.abs(row.value) > 1000000) return `第 ${index + 1} 行区域数值必须为 ±1000000 内有限数值。`;
      if (!Array.isArray(row.points) || row.points.some((p: Record<string,unknown>) => !p || typeof p.y !== 'number' || !Number.isFinite(p.y) || Math.abs(p.y) > 100000)) return `第 ${index + 1} 行顶点需要有限的 x、y、z 坐标。`;
      const error = validateLightWallPoints(row.points); if (error) return `第 ${index + 1} 行区域：${error}`;
    } else if (key === 'colorStops' || key === 'levels') {
      if (typeof row.value !== 'number' || !Number.isFinite(row.value) || Math.abs(row.value) > 1000000 || typeof row.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(row.color)) return `第 ${index + 1} 行需要有限 value 和 #RRGGBB color。`;
      const identity=String(row.value);if(ids.has(identity))return `第 ${index + 1} 行阈值重复。`;ids.add(identity);
    } else if (key === 'segments') {
      if (typeof row.label !== 'string' || row.label.length > 80 || typeof row.threshold !== 'number' || !Number.isFinite(row.threshold) || row.threshold < 0 || row.threshold > 1) return `第 ${index + 1} 行需要 label 和 0–1 的 threshold。`;
    }
  }
  return null;
}

const number = (key: string, label: string, value: number, min: number, max: number, group: string, bindable = false): Definition => ({ key, label, default: value, type: 'number', min, max, group, bindable });
const select = (key: string, label: string, value: string, options: string[][], group: string): Definition => ({ key, label, default: value, type: 'select', options: options.map(([value, label]) => ({ value, label })), group });
const boolean = (key: string, label: string, value: boolean, group: string): Definition => ({ key, label, default: value, type: 'boolean', group });
const rows = (key: string, label: string, description: string, group: string): Definition => ({ key, label, default: [], type: 'rows', description, group, validate: value=>validateRows(value,key) });
const vector = (key: string, label: string, value: {x:number;y:number;z:number}, group: string): Definition => ({ key, label, default: value, type: 'vector', group });
const flow: Definition[] = [
  {...select('flowDirection', '流动方向', 'forward', [['forward','沿点序'],['reverse','逆点序']], '流动'),bindable:true},
  number('speedMetersPerSecond', '实际流速 (米/秒)', 2, 0, 1000, '流动', true),
  boolean('closed', '闭合路径', false, '路径'), number('elevation', '离地偏移 (米)', 0, -10000, 10000, '路径'),
  number('bandSpacing', '流光间距 (米)', 2, 0.01, 10000, '流动'),
];
const arrows: Definition[] = [number('arrowSpacing','箭头间距 (米)',2,0.05,10000,'箭头'),number('arrowLength','箭头长度 (米)',0.8,0.01,100,'箭头'),number('arrowWidth','箭头宽度 (米)',0.5,0.01,100,'箭头'),number('maxMovers','移动单元上限',64,1,256,'箭头')];
const domain: Definition[] = [select('domainMode','数值范围','auto',[['auto','当前数据自动'],['fixed','固定范围']],'数值'),number('domainMin','数值下限',0,-1000000,1000000,'数值'),number('domainMax','数值上限',100,-1000000,1000000,'数值'),rows('colorStops','数值色带','每行 { value: 数值, color: "#RRGGBB" }，按 value 升序线性插值。','数值')];
const labels: Definition[] = [boolean('showLabels','显示数值标签',true,'标签'),{key:'valueUnit',label:'数值单位',default:'',type:'string',group:'标签'},number('decimalPlaces','小数位数',0,0,6,'标签')];
const particles: Definition[] = [
  vector('emissionDirection','发射方向 (局部)',{x:0,y:1,z:0},'发射器'),vector('gravity','重力 (米/秒²)',{x:0,y:0,z:0},'发射器'),vector('wind','风速 (米/秒)',{x:0,y:0,z:0},'发射器'),
  number('particleSpeed','初速度 (米/秒)',2,0,1000,'发射器',true),number('emitterRadius','喷口半径 (米)',0.2,0,100,'发射器'),
  number('particleLifetime','粒子寿命 (秒)',3,0.05,120,'粒子'),number('particleSize','粒径 (米)',0.2,0.001,100,'粒子',true),
  number('emissionRate','发射率 (个/秒)',40,0,10000,'粒子',true),number('particleBudget','粒子上限',256,1,1024,'粒子'),
  select('stopBehavior','停止发射时','drain',[['drain','已有粒子自然消散'],['clear','立即清空']],'粒子'),
];

const registry: Record<string, Definition[]> = {
  'boundary-flow': flow.filter(x => x.key !== 'closed'),
  'area-fill': [number('gridSpacing','网格间距 (米)',4,0.01,10000,'区域'),boolean('showBoundary','显示边界',true,'区域'),number('elevation','离地偏移 (米)',0,-10000,10000,'区域')],
  'ripple-ring': [number('ringCount','扩散圈数',3,1,32,'光圈'),number('fadeExponent','外缘衰减',1,0.1,8,'光圈')],
  'breathing-ring': [number('brightnessMin','最低亮度',0.2,0,1,'呼吸'),number('brightnessMax','最高亮度',1,0,3,'呼吸'),number('tickCount','刻度数量',36,0,256,'呼吸')],
  'radar-sector': [number('sectorDegrees','扫描扇角 (度)',60,1,360,'扫描'),number('startAngleDegrees','起始朝向 (度)',0,-360,360,'扫描'),select('rotationDirection','旋转方向','forward',[['forward','正向'],['reverse','反向']],'扫描'),number('rangeRings','距离刻度圈',4,0,32,'扫描')],
  'light-pillar': [number('bottomRadius','底部半径 (米)',0.175,0.005,10000,'光柱'),number('topRadius','顶部半径 (米)',0.06,0,10000,'光柱'),boolean('showBase','显示底圈',true,'光柱')],
  'energy-dome': [number('gridColumns','网格列数',36,3,256,'罩体'),number('gridRows','网格行数',14,2,128,'罩体'),number('gridLineWidth','网格线宽',0.028,0.001,0.2,'罩体'),boolean('showBase','显示底圈',true,'罩体')],
  'flow-path': flow,
  'flow-arrows': [...flow,...arrows],
  'fly-line': [...flow,number('arcSegments','弧线精度',64,8,128,'飞线')],
  'motion-trail': [number('sampleInterval','轨迹采样间隔 (秒)',0.1,0.016,10,'轨迹'),number('minSampleDistance','最小采样距离 (米)',0.01,0,100,'轨迹'),number('retentionSeconds','轨迹保留时长 (秒)',4,0.1,3600,'轨迹'),number('maxTrailLength','轨迹最大长度 (米)',100,0.01,100000,'轨迹'),number('fadeExponent','尾迹衰减',1.6,0.1,8,'轨迹')],
  'path-reveal': [...flow,select('progressMode','点亮进度来源','time',[['time','时间播放'],['data','外部数据 / 手动进度']],'进度'),rows('segments','分段节点说明','每行 { label: "阶段名", threshold: 0到1 }，对应路径节点。','进度')],
  'pipe-flow': [...flow,number('shellOpacity','管壁透明度',0.35,0,1,'管道',true),number('fluidSize','介质光点直径 (米)',0.1,0.005,100,'管道'),...arrows.filter(x=>x.key==='maxMovers'||x.key==='arrowSpacing')],
  'heatmap': [...domain,number('influenceRadius','采样影响半径 (米)',2,0.001,10000,'热区'),number('gridResolution','采样网格精度',40,8,96,'热区')],
  'region-level': [...domain,...labels,rows('regions','区域多边形','每行 { id, name, value, points: [{x,y,z}, ...] }。最多64个区域，每区3到128点。','区域'),rows('levels','等级阈值','每行 { value: 等级下限, color: "#RRGGBB" }，按数值命中最高下限。','数值')],
  'data-bars': [...domain,...labels,number('heightScale','单位值高度 (米)',0.1,0.000001,1000,'柱体'),select('heightMode','高度换算','range',[['range','按数值范围与配置高度'],['scale','数值乘单位高度']],'柱体'),number('transitionSeconds','数值过渡 (秒)',0,0,10,'柱体')],
  'camera-frustum': [number('horizontalFov','水平视场角 (度)',90,1,175,'镜头'),number('verticalFov','垂直视场角 (度)',60,1,175,'镜头'),number('nearDistance','最近距离 (米)',0.1,0.001,10000,'镜头'),number('farDistance','最远距离 (米)',50,0.01,100000,'镜头'),number('yawDegrees','方位角 (度)',0,-360,360,'姿态',true),number('pitchDegrees','俯仰角 (度)',0,-90,90,'姿态',true),boolean('showEdges','显示边线',true,'覆盖'),boolean('showCoverage','显示覆盖体',true,'覆盖')],
  rain: particles.map(p => p.key === 'emissionDirection' ? {...p,default:{x:0,y:-1,z:0}} : p), snow: particles.map(p => p.key === 'emissionDirection' ? {...p,default:{x:0,y:-1,z:0}} : p), 'smoke-plume': particles, flame: particles,
  'water-surface': [number('waveLength','波长 (米)',3,0.01,10000,'波纹'),number('waveAmplitude','波纹强度',1,0,10,'波纹',true),number('waveDirectionDegrees','传播方向 (度)',0,-360,360,'波纹'),boolean('usePolygon','按轮廓裁出水域',false,'水域')],
  'light-wall-fence': [number('elevation','底部标高 (米)',0,-10000,10000,'光墙'),number('bandCount','光带数量',3,1,32,'光墙'),number('fadeExponent','顶部渐隐',1.5,0.1,8,'光墙'),select('flowDirection','光带方向','forward',[['forward','向上'],['reverse','向下']],'光墙')],
};

export function getSpatialEffectParameters(kind: string): readonly Definition[] { return registry[kind] ?? []; }
export { particles as spatialParticleParameters, flow as spatialFlowParameters, arrows as spatialArrowParameters };
