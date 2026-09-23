import type { EffectParameterDefinition as Definition } from './effectConfiguration';
import { spatialParticleParameters, spatialFlowParameters, spatialArrowParameters } from './spatialEffectParameters';

const number = (key:string,label:string,value:number,min:number,max:number,group:string,bindable=false):Definition => ({key,label,default:value,type:'number',min,max,group,bindable});
const boolean = (key:string,label:string,value:boolean,group:string):Definition => ({key,label,default:value,type:'boolean',group});
const vector = (key:string,label:string,value:{x:number;y:number;z:number},group:string):Definition => ({key,label,default:value,type:'vector',group,
  validate: value => {const p=value as {x?:unknown;y?:unknown;z?:unknown};return !p||[p.x,p.y,p.z].some(v=>typeof v!=='number'||!Number.isFinite(v)||v<=0||v>100000)?'定位框尺寸必须是 0–100000 米内的正数。':null;}});
const routePoints:Definition={key:'routePoints',label:'疏散路线点 (米)',type:'rows',group:'路线',
  default:[{x:-2,y:0.05,z:0},{x:2,y:0.05,z:0}],description:'每行 { x, y, z }，2–64 个局部坐标点。',validate:value=>{
    if(!Array.isArray(value)||value.length<2||value.length>64)return '疏散路线需要 2–64 个坐标点。';
    if(value.some(p=>!p||[p.x,p.y,p.z].some(v=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>100000)))return '路线坐标必须为 ±100000 米内的有限数值。';
    if(value.some((p,i)=>i>0&&Math.hypot(p.x-value[i-1].x,p.y-value[i-1].y,p.z-value[i-1].z)<0.001))return '路线相邻点至少间隔 0.001 米。';return null;
  }};
const registry:Record<string,Definition[]> = {
  'alarm-pulse': [number('radius','最大半径 (米)',1.1,0.01,10000,'光圈'),number('ringWidth','光圈宽度 (米)',0.03,0.001,100,'光圈'),number('ringCount','光圈数量',2,1,32,'光圈'),number('period','脉冲周期 (秒)',2,0.05,3600,'脉冲'),number('fadeExponent','扩散衰减',1,0.1,8,'脉冲'),number('opacity','透明度',0.7,0,1,'外观',true)],
  'warning-beacon': [number('baseRadius','底座半径 (米)',0.175,0.01,100,'警示灯'),number('domeRadius','灯罩半径 (米)',0.225,0.01,100,'警示灯'),number('beaconHeight','安装高度 (米)',0.25,0,100,'警示灯'),number('beamLength','扫光长度 (米)',1.35,0.01,1000,'扫光'),number('revolutionsPerMinute','旋转速度 (转/分)',30,-600,600,'扫光',true),boolean('showBase','显示底座',true,'警示灯'),number('opacity','透明度',0.65,0,1,'外观',true)],
  sparks: spatialParticleParameters.map(p=>p.key==='gravity'?{...p,default:{x:0,y:-1.4,z:0}}:p.key==='particleLifetime'?{...p,default:0.55}:p.key==='particleSize'?{...p,default:0.08}:p),
  'steam-leak': spatialParticleParameters.map(p=>p.key==='emissionDirection'?{...p,default:{x:1,y:0.2,z:0}}:p),
  'gas-leak': spatialParticleParameters,
  'water-jet': spatialParticleParameters.map(p=>p.key==='emissionDirection'?{...p,default:{x:1,y:0,z:0}}:p.key==='gravity'?{...p,default:{x:0,y:-0.35,z:0}}:p),
  'cargo-target-frame': [boolean('autoBounds','使用目标包围盒',true,'定位框'),vector('frameSize','固定尺寸 (米)',{x:1.25,y:1,z:1.25},'定位框'),number('padding','外扩边距 (米)',0.1,0,100,'定位框'),number('edgeWidth','边线宽度',3,0.1,20,'定位框'),number('cornerRatio','边角占比',0.25,0.01,0.5,'定位框'),boolean('followTarget','跟随目标',true,'定位框'),number('opacity','表面透明度',0.18,0,1,'外观',true)],
  'evacuation-route': [routePoints,number('routeWidth','路线宽度 (米)',0.22,0.005,100,'路线'),number('opacity','透明度',0.7,0,1,'外观',true),...spatialFlowParameters,...spatialArrowParameters,boolean('showExit','显示出口标记',true,'出口'),number('exitSize','出口标记半径 (米)',0.22,0.01,100,'出口'),{key:'exitLabel',label:'出口名称',type:'string',default:'安全出口',group:'出口'}],
};
export function getLegacyEffectParameters(kind:string):readonly Definition[] { return registry[kind]??[]; }
