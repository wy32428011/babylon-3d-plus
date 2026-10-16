import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { calibrateFootCycle } from '../../scripts/manual-roam-assets/contactCalibration.mjs';

async function fixture(name) {
  const bytes=await fs.readFile('public/manual-roam/locomotion-v2.glb'),size=bytes.readUInt32LE(12),json=JSON.parse(bytes.subarray(20,20+size)),binary=bytes.subarray(28+size);
  const read=id=>{const a=json.accessors[id],v=json.bufferViews[a.bufferView],width={SCALAR:1,VEC3:3,VEC4:4}[a.type];return Array.from({length:a.count*width},(_,i)=>binary.readFloatLE((v.byteOffset??0)+(a.byteOffset??0)+Math.floor(i/width)*(v.byteStride??width*4)+i%width*4));};
  const animation=json.animations.find(a=>a.name===name),times=read(animation.samplers[0].input);
  const result={name,times,direction:{x:0,y:0,z:1},leftFoot:[],rightFoot:[],leftToe:[],rightToe:[]};
  for(let frame=0;frame<times.length;frame++){
    const nodes=structuredClone(json.nodes),world=[];
    for(const channel of animation.channels){const width=channel.target.path==='rotation'?4:3;nodes[channel.target.node][channel.target.path]=read(animation.samplers[channel.sampler].output).slice(frame*width,frame*width+width);}
    const visit=(i,parent)=>{const n=nodes[i];world[i]=Matrix.Compose(Vector3.One(),Quaternion.FromArray(n.rotation??[0,0,0,1]),Vector3.FromArray(n.translation??[0,0,0])).multiply(parent);for(const child of n.children??[])visit(child,world[i]);};
    for(const root of json.scenes[json.scene??0].nodes)visit(root,Matrix.Identity());
    for(const side of ['left','right'])for(const [kind,bone]of [['Foot','Foot'],['Toe','ToeBase']])result[side+kind].push(world[nodes.findIndex(n=>n.name===side[0].toUpperCase()+side.slice(1)+bone)].getTranslation());
  }
  return result;
}

test('真实前向步行没有假腾空，具有轨迹产生的双支撑，且接触跨周期连续',async()=>{
  const input=await fixture('WalkForward'),output=calibrateFootCycle(input);
  const {left,right}=output.contacts;
  assert.ok(left.every((w,i)=>Math.max(w,right[i])>=.5),'每帧必须至少有一脚承重');
  assert.ok(left.some((w,i)=>Math.min(w,right[i])>=.75),'真实步行应保留承重交接');
  assert.equal(left[0],left.at(-1));assert.equal(right[0],right.at(-1));
  assert.ok(right[0]>.5,'循环边界的右脚承重不能被人为切断');
  for(const curve of [left,right])assert.ok(curve.every(w=>Number.isFinite(w)&&w>=0&&w<=1));
  assert.ok(output.referenceSpeed>0&&output.cycleDistanceMeters>0);
  assert.ok(left[Math.round(output.phaseOffset*(left.length-1))]>=.5);
});

test('完整承重段的世界脚滑预测与独立踝趾轨迹一致，改变整体尺度保留相位与contacts',async()=>{
  for(const name of ['WalkForward','RunForward']) {
    const input=await fixture(name),output=calibrateFootCycle(input),n=input.times.length-1,dt=input.times[1]-input.times[0];
    for(const side of ['left','right']){
      const curve=output.contacts[side];
      for(let start=0;start<n;start++)if(curve[start]>=.75&&curve[(start+n-1)%n]<.75){
        let length=1;while(length<n&&curve[(start+length)%n]>=.75)length++;
        for(const kind of ['Foot','Toe']){const points=input[side+kind],end=(start+length-1)%n;
          const worldDrift=Math.abs(points[end].z-points[start].z+output.referenceSpeed*dt*(length-1));
          assert.ok(worldDrift<output.cycleDistanceMeters*.15,`${name}/${side}${kind}承重脚滑预测${worldDrift.toFixed(3)}m`);
        }
      }
    }
    const scaled={...input};for(const key of ['leftFoot','rightFoot','leftToe','rightToe'])scaled[key]=input[key].map(p=>({x:p.x*1.5,y:p.y*1.5,z:p.z*1.5}));
    const other=calibrateFootCycle(scaled);assert.deepEqual(other.contacts,output.contacts);
    assert.ok(Math.abs(other.referenceSpeed/output.referenceSpeed-1.5)<1e-8);
  }
});

test('不完整或静止周期明确拒绝，不伪造支撑速度',async()=>{
  const input=await fixture('WalkForward');assert.throws(()=>calibrateFootCycle({...input,leftToe:[]}),/轨迹/);
  const still={...input};for(const key of ['leftFoot','rightFoot','leftToe','rightToe'])still[key]=input[key].map(()=>({x:0,y:0,z:0}));
  assert.throws(()=>calibrateFootCycle(still),/承重/);
});
