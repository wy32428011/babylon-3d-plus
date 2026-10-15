import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

async function asset() {
  const bytes = await readFile('public/manual-roam/EQ_People_rigged_v2.glb');
  const size = bytes.readUInt32LE(12), json = JSON.parse(bytes.subarray(20,20+size).toString()), binary = bytes.subarray(28+size);
  const read = (id: number): number[] => {
    const a = json.accessors[id], v = json.bufferViews[a.bufferView], width = ({SCALAR:1,VEC3:3,VEC4:4,MAT4:16} as Record<string,number>)[a.type], size = a.componentType === 5123 ? 2 : 4;
    return Array.from({length:a.count*width},(_,i) => { const at = (v.byteOffset??0)+(a.byteOffset??0)+Math.floor(i/width)*(v.byteStride??width*size)+i%width*size; return a.componentType===5126 ? binary.readFloatLE(at) : binary.readUIntLE(at,size); });
  };
  const worlds = (nodes = json.nodes): Matrix[] => {
    const result: Matrix[] = [];
    const visit = (id: number, parent: Matrix) => { const n=nodes[id]; result[id]=Matrix.Compose(Vector3.FromArray(n.scale??[1,1,1]),Quaternion.FromArray(n.rotation??[0,0,0,1]),Vector3.FromArray(n.translation??[0,0,0])).multiply(parent); for(const child of n.children??[])visit(child,result[id]); };
    visit(json.scenes[0].nodes[0],Matrix.Identity()); return result;
  };
  const bindWorld = worlds(), names: string[] = json.skins[0].joints.map((id:number)=>json.nodes[id].name);
  const points: Vector3[] = json.skins[0].joints.map((id:number)=>bindWorld[id].getTranslation());
  const attrs=json.meshes[0].primitives[0].attributes;
  return {json,read,worlds,names,points,positions:read(attrs.POSITION),joints:read(attrs.JOINTS_0),weights:read(attrs.WEIGHTS_0)};
}

function shoeHeight(a:Awaited<ReturnType<typeof asset>>,i:number) {
  const p=Vector3.FromArray(a.positions,i*3),side=p.x>=a.points[a.names.indexOf('Hips')].x?'Left':'Right';
  const foot=a.points[a.names.indexOf(side+'Foot')],toe=a.points[a.names.indexOf(side+'ToeBase')],forward=toe.subtract(foot).normalize();
  const up=Vector3.Up().subtract(forward.scale(forward.y)).normalize();
  return {p,side,height:Vector3.Dot(p.subtract(foot),up),length:Vector3.Distance(foot,toe)};
}

test('真实鞋底低区不受小腿父骨牵拉',async()=>{
  const a=await asset();let count=0,max=0;
  for(const i of new Set(a.read(a.json.meshes[0].primitives[6].indices))){
    const s=shoeHeight(a,i);if(s.height>-.3*s.length)continue;count++;
    for(let k=0;k<4;k++)if(![s.side+'Foot',s.side+'ToeBase'].includes(a.names[a.joints[i*4+k]]))max=Math.max(max,a.weights[i*4+k]);
  }
  assert.ok(count>50,'须覆盖真实鞋底顶点');assert.ok(max<1e-6,`鞋底父腿或无关骨权重 ${max}`);
});

test('鞋底分类器只限制低区，鞋口恢复原候选且过渡连续',async()=>{
  const a=await asset(),{getManualRoamSkinCandidates:get}=await import('../../scripts/manual-roam-assets/skinWeights.mjs');
  let lower=0,collar=0;
  for(const i of new Set(a.read(a.json.meshes[0].primitives[6].indices))){const s=shoeHeight(a,i),cs=get(s.p,6,a.names,a.points);
    if(s.height<=-.3*s.length){lower++;assert.ok(cs.every((c:{index:number})=>[s.side+'Foot',s.side+'ToeBase'].includes(a.names[c.index])));}
    if(s.height>=-.09*s.length){collar++;assert.equal(cs.length,a.names.length);assert.ok(cs.every((c:{factor:number})=>c.factor===1));}
  }
  assert.ok(lower>50&&collar>50);
  for(const side of ['Left','Right']){const foot=a.points[a.names.indexOf(side+'Foot')],toe=a.points[a.names.indexOf(side+'ToeBase')],length=Vector3.Distance(foot,toe),forward=toe.subtract(foot).normalize(),up=Vector3.Up().subtract(forward.scale(forward.y)).normalize();let previous=0;
    for(let i=0;i<=20;i++){const p=foot.add(up.scale(length*(-.3+.21*i/20))),factor=get(p,6,a.names,a.points).find((c:{index:number})=>a.names[c.index]===side+'Leg')?.factor??0;assert.ok(factor>=previous-1e-8&&factor-previous<.08);previous=factor;}
  }
});

test('真实人物胸背核心不受前臂手掌牵引，单独弯肘不能拉动衣身', async () => {
  const a=await asset(), hip=a.points[a.names.indexOf('Hips')], arm=a.points[a.names.indexOf('LeftArm')];
  const indices=[...new Set(a.read(a.json.meshes[0].primitives[3].indices))];
  const core=indices.filter(i=>Math.abs(a.positions[i*3])<Math.abs(arm.x)*0.65&&a.positions[i*3+1]>hip.y+0.1&&a.positions[i*3+1]<arm.y-0.06);
  assert.ok(core.length>50,'必须覆盖真实衣身区域');
  let maximumForbiddenWeight=0;
  for(const i of core){let sum=0;for(let k=0;k<4;k++)if(/ForeArm|Hand/.test(a.names[a.joints[i*4+k]]))sum+=a.weights[i*4+k];maximumForbiddenWeight=Math.max(maximumForbiddenWeight,sum);}
  assert.ok(maximumForbiddenWeight<1e-6,`胸背核心前臂/手掌权重 ${maximumForbiddenWeight}`);
  const posed=structuredClone(a.json.nodes);
  for(const node of posed)if(/ForeArm$/.test(node.name))node.rotation=Quaternion.RotationAxis(Vector3.Forward(),0.65).multiply(Quaternion.FromArray(node.rotation)).asArray();
  const worlds=a.worlds(posed),ibm=a.read(a.json.skins[0].inverseBindMatrices);
  const matrices=a.json.skins[0].joints.map((id:number,i:number)=>Matrix.FromArray(ibm.slice(i*16,i*16+16)).multiply(worlds[id]));
  let maxMovement=0;
  for(const i of core){const point=Vector3.FromArray(a.positions.slice(i*3,i*3+3)),moved=Vector3.Zero();for(let k=0;k<4;k++)moved.addInPlace(Vector3.TransformCoordinates(point,matrices[a.joints[i*4+k]]).scale(a.weights[i*4+k]));maxMovement=Math.max(maxMovement,Vector3.Distance(point,moved));}
  assert.ok(maxMovement<0.002,`只弯肘导致衣身移动 ${maxMovement}m`);
});

test('真实袖子外侧不接受对侧手臂或腿部权重', async () => {
  const a=await asset();let checked=0;
  for(const i of new Set(a.read(a.json.meshes[0].primitives[3].indices))){
    const p=Vector3.FromArray(a.positions.slice(i*3,i*3+3)),side=p.x>=0?'Left':'Right',other=side==='Left'?'Right':'Left';
    const arm=a.points[a.names.indexOf(side+'Arm')],hand=a.points[a.names.indexOf(side+'Hand')];
    if(Math.abs(p.x)<Math.abs(arm.x)+0.02||p.y<hand.y-0.05||p.y>arm.y+0.05)continue;
    checked++;
    for(let k=0;k<4;k++){const name=a.names[a.joints[i*4+k]];assert.ok(a.weights[i*4+k]<1e-6||!name.startsWith(other)&&!/UpLeg|Leg|Foot|ToeBase/.test(name),`${i} sleeve influenced by ${name}`);}
  }
  assert.ok(checked>100);
});

test('分类器保持胸背核心、对应袖链与肩腋的解剖边界', async () => {
  const a=await asset();
  const {getManualRoamSkinCandidates}=await import('../../scripts/manual-roam-assets/skinWeights.mjs');
  const allowed=(point:Vector3,material:number)=>getManualRoamSkinCandidates(point,material,a.names,a.points).map(({index}:{index:number})=>a.names[index]);
  assert.ok(allowed(new Vector3(0.10,1.19,-0.10),3).every((name:string)=>!(/Arm|Hand|Leg|Foot/.test(name))));
  for(const side of ['Left','Right']){
    const elbow=a.points[a.names.indexOf(side+'ForeArm')],wrist=a.points[a.names.indexOf(side+'Hand')];
    assert.ok(allowed(Vector3.Lerp(elbow,wrist,0.5),3).every((name:string)=>name.startsWith(side)));
    assert.deepEqual(allowed(wrist,4),[side+'ForeArm',side+'Hand']);
  }
  const arm=a.points[a.names.indexOf('LeftArm')];
  let previous=0;
  for(let i=0;i<=20;i++) {
    const point=new Vector3(arm.x*(0.65+0.40*i/20),arm.y-0.04,0);
    const candidates=getManualRoamSkinCandidates(point,3,a.names,a.points);
    const factor=candidates.find(({index}:{index:number})=>a.names[index]==='LeftArm')?.factor??0;
    assert.ok(factor>=previous&&factor-previous<0.08,'肩腋过渡应连续且单调');previous=factor;
    assert.ok(candidates.every(({index}:{index:number})=>!a.names[index].startsWith('Right')&&!/Leg|Foot/.test(a.names[index])));
  }
});
