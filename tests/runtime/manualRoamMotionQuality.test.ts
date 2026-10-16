import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

const version = process.env.ROAM_MOTION_VERSION ?? 'v2';
const bytes = await readFile(new URL(`../../public/manual-roam/locomotion-${version}.glb`, import.meta.url));
const size = bytes.readUInt32LE(12);
const json = JSON.parse(bytes.subarray(20, 20 + size).toString());
const binary = bytes.subarray(28 + size);
function read(id: number): number[] {
  const a = json.accessors[id], view = json.bufferViews[a.bufferView];
  const width = a.type === 'VEC4' ? 4 : a.type === 'VEC3' ? 3 : 1;
  return Array.from({length:a.count*width},(_,i)=>binary.readFloatLE((view.byteOffset??0)+(a.byteOffset??0)+Math.floor(i/width)*(view.byteStride??width*4)+i%width*4));
}

function sampledPoses(name: string) {
  const clip = json.animations.find((clip: {name: string})=>clip.name===name);
  const tracks = clip.channels.map((channel: {sampler: number;target:{node:number;path:string}})=>({ ...channel, values:read(clip.samplers[channel.sampler].output) }));
  const count = json.accessors[clip.samplers[0].input].count;
  return Array.from({length:count-1},(_,frame)=>{
    const nodes=structuredClone(json.nodes),world:Matrix[]=[];
    for(const track of tracks) {const width=track.target.path==='rotation'?4:3;nodes[track.target.node][track.target.path]=track.values.slice(frame*width,(frame+1)*width);}
    const visit=(index:number,parent:Matrix)=>{const n=nodes[index];world[index]=Matrix.Compose(Vector3.FromArray(n.scale??[1,1,1]),Quaternion.FromArray(n.rotation??[0,0,0,1]),Vector3.FromArray(n.translation??[0,0,0])).multiply(parent);for(const child of n.children??[])visit(child,world[index]);};
    for(const index of json.scenes[json.scene??0].nodes)visit(index,Matrix.Identity());
    return {position:(name:string)=>world[nodes.findIndex((n:{name:string})=>n.name===name)].getTranslation(),rotation:(name:string)=>Quaternion.FromArray(nodes.find((n:{name:string})=>n.name===name).rotation)};
  });
}

test('巡检待机双脚保持适度站距，手腕不随呼吸折弯',()=>{
  for(const pose of sampledPoses('Idle')) {
    const width=Vector3.Distance(pose.position('LeftFoot'),pose.position('RightFoot'));
    const hips=Vector3.Distance(pose.position('LeftUpLeg'),pose.position('RightUpLeg'));
    assert.ok(width<hips*1.8,`待机脚距${width.toFixed(3)}m超过髋宽${hips.toFixed(3)}m的1.8倍`);
    for(const side of ['Left','Right'])assert.ok(2*Math.acos(Math.min(1,Math.abs(pose.rotation(side+'Hand').w)))<.18,'待机手腕应接近前臂延伸方向');
  }
});

test('每个方向的走跑都有相互交替的摆臂，不能使用待机上身替代',()=>{
  for(const name of ['WalkForward','WalkBackward','WalkLeft','WalkRight','RunForward','RunBackward','RunLeft','RunRight']) {
    const poses=sampledPoses(name),left=poses.map(p=>p.position('LeftHand').z-p.position('LeftArm').z),right=poses.map(p=>p.position('RightHand').z-p.position('RightArm').z);
    const mean=(values:number[])=>values.reduce((sum,value)=>sum+value,0)/values.length;
    const a=left.map(x=>x-mean(left)),b=right.map(x=>x-mean(right));
    const correlation=a.reduce((sum,x,i)=>sum+x*b[i],0)/Math.sqrt(a.reduce((sum,x)=>sum+x*x,0)*b.reduce((sum,x)=>sum+x*x,0));
    for(const values of [left,right])assert.ok(Math.max(...values)-Math.min(...values)>.12,`${name}缺少可观察的摆臂幅度`);
    assert.ok(correlation<-.65,`${name}双臂应交替摆动，相关系数${correlation.toFixed(3)}`);
    for(const pose of poses)for(const side of ['Left','Right'])assert.ok(2*Math.acos(Math.min(1,Math.abs(pose.rotation(side+'Hand').w)))<.35,`${name}手腕过度折弯`);
  }
});

test('方向混合以同一支撑相位对齐整条上身，不能只让两臂彼此反相',async()=>{
  const manifest=JSON.parse(await readFile(new URL(`../../public/manual-roam/locomotion-${version}.manifest.json`,import.meta.url),'utf8'));
  const vectorAt=(poses:ReturnType<typeof sampledPoses>,phase:number,side:string)=>{
    const frame=((phase%1+1)%1)*poses.length,lo=Math.floor(frame),hi=(lo+1)%poses.length;
    const vector=(i:number)=>poses[i].position(side+'Hand').subtract(poses[i].position(side+'Arm'));
    return Vector3.Lerp(vector(lo),vector(hi),frame-lo);
  };
  for(const family of ['Walk','Run']) {
    const forward=sampledPoses(family+'Forward'),referenceOffset=manifest.clips[family+'Forward'].phaseOffset;
    for(const direction of ['Backward','Left','Right']) {
      const name=family+direction,poses=sampledPoses(name),offset=manifest.clips[name].phaseOffset;
      for(let i=0;i<24;i++)for(const side of ['Left','Right']) {
        const error=Vector3.Distance(vectorAt(forward,i/24+referenceOffset,side),vectorAt(poses,i/24+offset,side));
        assert.ok(error<.04,`${name}/${side}公共支撑相位的上身误差${error.toFixed(3)}m`);
      }
    }
  }
});

test('左右侧移保持膝盖前后屈伸，不能将屈膝轴旋成横向折膝', () => {
  for (const name of ['WalkLeft','WalkRight','RunLeft','RunRight']) {
    const animation = json.animations.find((clip:{name:string})=>clip.name===name);
    for (const side of ['Left','Right']) {
      const channel = animation.channels.find((channel:{target:{node:number;path:string}})=>json.nodes[channel.target.node].name===side+'Leg'&&channel.target.path==='rotation');
      const data = read(animation.samplers[channel.sampler].output);
      let maxSideBend = 0;
      for(let i=0;i<data.length;i+=4) maxSideBend=Math.max(maxSideBend,2*Math.asin(Math.min(1,Math.abs(data[i+2]))));
      assert.ok(maxSideBend<0.3,`${name}/${side} lateral knee bend ${(maxSideBend*180/Math.PI).toFixed(2)}deg`);
    }
  }
});

test('侧移和后退来源可追溯，禁止腿链轴旋转或时间倒放冒充方向动作', async () => {
  const manifest = JSON.parse(await readFile(new URL(`../../public/manual-roam/locomotion-${version}.manifest.json`,import.meta.url),'utf8'));
  for(const name of ['WalkLeft','WalkRight','RunLeft','RunRight','WalkBackward','RunBackward']) {
    const source=manifest.clips[name].source;
    assert.match(source.clip,/Strafe|Backwards/);
    assert.equal(typeof source.author,'string');
    assert.doesNotMatch(source.derivation??'',/axis-remap|reverse-time/);
    assert.ok(source.clip&&source.sha256&&source.url);
  }
});

test('前进走路为平稳的上班步态，骨盆侧倾与扭转有界且左右对称', { skip: version !== 'v2' }, () => {
  const roll: number[] = [], yaw: number[] = [];
  for (const pose of sampledPoses('WalkForward')) {
    const euler = pose.rotation('Hips').toEulerAngles();
    roll.push(euler.z * 180 / Math.PI); yaw.push(euler.y * 180 / Math.PI);
  }
  const range = (values: number[]) => Math.max(...values) - Math.min(...values);
  const center = (values: number[]) => (Math.max(...values) + Math.min(...values)) / 2;
  // 源动作为侧倾约11.7°、扭转约14.6°且偏向一侧，男性巡检人物看起来像扭胯走模特步。
  assert.ok(range(roll) <= 7, `骨盆侧倾幅度 ${range(roll).toFixed(1)}°`);
  assert.ok(range(yaw) <= 8, `骨盆扭转幅度 ${range(yaw).toFixed(1)}°`);
  assert.ok(Math.abs(center(roll)) <= 1 && Math.abs(center(yaw)) <= 1, '骨盆摆动不能偏向一侧');
  assert.ok(range(roll) >= 2 && range(yaw) >= 2, '保留自然的骨盆随步摆动，不能完全锁死');
});

test('前进走路两脚各走一条平行线、支撑腿接近伸直，不能踩一条线或屈膝走', { skip: version !== 'v2' }, async () => {
  const manifest = JSON.parse(await readFile(new URL(`../../public/manual-roam/locomotion-${version}.manifest.json`, import.meta.url), 'utf8'));
  const clip = manifest.clips.WalkForward, poses = sampledPoses('WalkForward');
  const offsets: Record<'Left' | 'Right', number[]> = { Left: [], Right: [] }, straightest = { Left: 180, Right: 180 };
  poses.forEach((pose, frame) => {
    const index = Math.round(frame / poses.length * (clip.contacts.left.length - 1));
    for (const side of ['Left', 'Right'] as const) {
      if (clip.contacts[side.toLowerCase()][index] < 1) continue;
      offsets[side].push(pose.position(side + 'Foot').x - pose.position('Hips').x);
      const hip = pose.position(side + 'UpLeg'), knee = pose.position(side + 'Leg'), ankle = pose.position(side + 'Foot');
      const bend = Math.acos(Math.min(1, Vector3.Dot(knee.subtract(hip).normalize(), ankle.subtract(knee).normalize()))) * 180 / Math.PI;
      straightest[side] = Math.min(straightest[side], bend);
    }
  });
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const left = mean(offsets.Left), right = mean(offsets.Right);
  // 源 Xbot 步行支撑脚距中线仅5.4/3.7厘米且左右不对称，背面看两腿内收交叉，形成扭胯的观感。
  assert.ok(left - right >= 0.10 && left - right <= 0.16, `支撑步宽 ${(left - right).toFixed(3)}m`);
  assert.ok(Math.abs(left + right) < 0.01, `左右脚距中线不对称 ${left.toFixed(3)}/${right.toFixed(3)}`);
  for (const side of ['Left', 'Right'] as const) assert.ok(straightest[side] <= 15, `${side}支撑腿最直时仍屈膝${straightest[side].toFixed(1)}°`);
  assert.equal(clip.source.kind, 'original-authored-commute-walk');
});
