import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { sampleTurnPose, TURN_MOTION_DEFINITIONS } from '../../scripts/manual-roam-assets/turnMotion.mjs';

const names=['Hips','Spine','Spine1','Spine2','Neck','Head',...['Left','Right'].flatMap(s=>['Shoulder','Arm','ForeArm','Hand','UpLeg','Leg','Foot','ToeBase'].map(p=>s+p))];
const parents=[null,'Hips','Spine','Spine1','Spine2','Neck',...['Left','Right'].flatMap(s=>['Spine2',s+'Shoulder',s+'Arm',s+'ForeArm','Hips',s+'UpLeg',s+'Leg',s+'Foot'])];
const rest=[new Vector3(0,.86,0),new Vector3(0,1,0),new Vector3(0,1.1,0),new Vector3(0,1.2,0),new Vector3(0,1.4,0),new Vector3(0,1.5,0),...['Left','Right'].flatMap(s=>{const x=s==='Left'?1:-1;return [[.08,1.3,0],[.18,1.3,0],[.45,1.3,0],[.7,1.3,0],[.09,.82,0],[.09,.44,0],[.09,.06,0],[.09,.06,.14]].map(p=>new Vector3(p[0]*x,p[1],p[2]));})];
function world(pose,yaw){const ws=[];names.forEach((name,i)=>{const p=parents[i]===null?-1:names.indexOf(parents[i]);const pos=p<0?rest[i].add(new Vector3(0,pose.hipY,0)):rest[i].subtract(rest[p]);const m=Matrix.Compose(Vector3.One(),pose.local[i],pos);ws[i]=m.multiply(p<0?Matrix.RotationY(yaw):ws[p]);});return ws;}
test('离线转身左右90保持支撑脚世界锚点且真实抬脚',()=>{
 for(const [name,def]of Object.entries(TURN_MOTION_DEFINITIONS))for(let i=0;i<=60;i++){
  const phase=i/60,pose=sampleTurnPose(name,phase,rest,names,parents),yaw=def.angleRadians*pose.rotationProgress,ws=world(pose,yaw);
  assert.equal(pose.local.length,22);assert.ok(pose.local.every(q=>Math.abs(q.length()-1)<1e-6));
  for(const side of ['Left','Right'])if(pose.contacts[side.toLowerCase()]){
   const lead=def.angleRadians>0?'Left':'Right';const final=side===lead?phase>=.5:phase>=1;
   const expected=Vector3.TransformCoordinates(rest[names.indexOf(side+'Foot')],Matrix.RotationY(final?def.angleRadians:0));
   assert.ok(Vector3.Distance(ws[names.indexOf(side+'Foot')].getTranslation(),expected)<1e-5,`${name} ${phase} ${side} planted foot drift`);
  }
  if(i===15){const lead=def.angleRadians>0?'Left':'Right';assert.ok(ws[names.indexOf(lead+'Foot')].getTranslation().y>rest[names.indexOf(lead+'Foot')].y+.03);}
 }
});
test('旋转进度首步完成达到1且不越界，未知动作明确失败',()=>{
 for(const name of Object.keys(TURN_MOTION_DEFINITIONS)){assert.equal(sampleTurnPose(name,0,rest,names,parents).rotationProgress,0);assert.equal(sampleTurnPose(name,.5,rest,names,parents).rotationProgress,1);assert.equal(sampleTurnPose(name,1,rest,names,parents).rotationProgress,1);}
 assert.throws(()=>sampleTurnPose('Idle',0,rest,names,parents),/转身动作/);
});
