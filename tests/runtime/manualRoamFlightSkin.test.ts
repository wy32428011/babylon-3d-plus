import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

async function load(path: string) {
  const bytes=await readFile(path),length=bytes.readUInt32LE(12),json=JSON.parse(bytes.subarray(20,20+length).toString()),binary=bytes.subarray(28+length);
  const read=(id:number):number[]=>{
    const a=json.accessors[id],view=json.bufferViews[a.bufferView],width=({SCALAR:1,VEC3:3,VEC4:4,MAT4:16} as Record<string,number>)[a.type],size=a.componentType===5123?2:4;
    return Array.from({length:a.count*width},(_,i)=>{const offset=(view.byteOffset??0)+(a.byteOffset??0)+Math.floor(i/width)*(view.byteStride??width*size)+i%width*size;return a.componentType===5126?binary.readFloatLE(offset):binary.readUIntLE(offset,size);});
  };
  return {json,read};
}

test('真实飞行动作及进出过渡不能把胸背腋下撑成伞状', async () => {
  const avatar=await load('public/manual-roam/EQ_People_rigged_v2.glb'),motion=await load('public/manual-roam/locomotion-v2.glb');
  const attrs=avatar.json.meshes[0].primitives[0].attributes,positions=avatar.read(attrs.POSITION),joints=avatar.read(attrs.JOINTS_0),weights=avatar.read(attrs.WEIGHTS_0),ibm=avatar.read(avatar.json.skins[0].inverseBindMatrices);
  const pose=(name:string,phase:number)=>{
    const nodes=structuredClone(avatar.json.nodes);nodes.forEach((node:any)=>Object.assign(node,node.extras?.manualRoamReferencePose??{}));
    const clip=motion.json.animations.find((clip:any)=>clip.name===name);
    for(const channel of clip.channels){const sampler=clip.samplers[channel.sampler],data=motion.read(sampler.output),width=channel.target.path==='rotation'?4:3,frame=Math.round((data.length/width-1)*phase);nodes[channel.target.node][channel.target.path]=data.slice(frame*width,(frame+1)*width);}
    return nodes;
  };
  const skin=(nodes:any[])=>{
    const worlds:Matrix[]=[];
    const visit=(i:number,parent:Matrix)=>{const n=nodes[i];worlds[i]=Matrix.Compose(Vector3.FromArray(n.scale??[1,1,1]),Quaternion.FromArray(n.rotation??[0,0,0,1]),Vector3.FromArray(n.translation??[0,0,0])).multiply(parent);for(const child of n.children??[])visit(child,worlds[i]);};visit(0,Matrix.Identity());
    const matrices=avatar.json.skins[0].joints.map((id:number,i:number)=>Matrix.FromArray(ibm.slice(i*16,i*16+16)).multiply(worlds[id]));
    return Array.from({length:positions.length/3},(_,i)=>{const point=Vector3.FromArray(positions,i*3),value=Vector3.Zero();for(let k=0;k<4;k++)value.addInPlace(Vector3.TransformCoordinates(point,matrices[joints[i*4+k]]).scale(weights[i*4+k]));return value;});
  };
  const area=(points:Vector3[],ids:number[])=>Vector3.Cross(points[ids[1]].subtract(points[ids[0]]),points[ids[2]].subtract(points[ids[0]])).length()/2;
  const indices=avatar.read(avatar.json.meshes[0].primitives[3].indices),idle=pose('Idle',0),reference=skin(idle),triangles:number[][]=[];
  // 按真实衣身几何选择胸背/腋下区域，排除袖口和手掌，不特判当前失败的顶点编号。
  for(let i=0;i<indices.length;i+=3){const ids=indices.slice(i,i+3);if(ids.every(id=>Math.abs(positions[id*3])<0.16&&positions[id*3+1]>0.95&&positions[id*3+1]<1.30)&&area(reference,ids)>1e-8)triangles.push(ids);}
  assert.ok(triangles.length>50);
  const failures:string[]=[];
  for(const name of ['FlyIdle','FlyMove'])for(const phase of [0,.25,.5,.75])for(const blend of [.25,.5,.75,1]){
    const nodes=pose(name,phase);
    nodes.forEach((node:any,i:number)=>{node.rotation=Quaternion.Slerp(Quaternion.FromArray(idle[i].rotation??[0,0,0,1]),Quaternion.FromArray(node.rotation??[0,0,0,1]),blend).asArray();node.translation=Vector3.Lerp(Vector3.FromArray(idle[i].translation??[0,0,0]),Vector3.FromArray(node.translation??[0,0,0]),blend).asArray();});
    const points=skin(nodes),ratios=triangles.map(ids=>area(points,ids)/area(reference,ids)),maximum=Math.max(...ratios);
    // 允许少量自然衣褶变化，但飞行不能在现有Idle之上再额外撑大衣身超过25%。
    if(maximum>1.25)failures.push(`${name} phase=${phase} blend=${blend} torso triangle area / Idle=${maximum.toFixed(6)}`);
  }
  assert.deepEqual(failures,[],'飞行及过渡衣身局部额外拉伸超限');
});
