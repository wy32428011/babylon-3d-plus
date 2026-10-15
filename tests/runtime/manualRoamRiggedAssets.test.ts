import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

const names = ['Idle', 'WalkForward', 'WalkBackward', 'WalkLeft', 'WalkRight', 'RunForward', 'RunBackward', 'RunLeft', 'RunRight', 'JumpStart', 'JumpUp', 'Fall', 'Land', 'FlyIdle', 'FlyMove'];
const bones = ['Hips','Spine','Spine1','Spine2','Neck','Head',...['Left','Right'].flatMap(side => ['Shoulder','Arm','ForeArm','Hand','UpLeg','Leg','Foot','ToeBase'].map(part => side+part))];
async function glb(path: string) {
  const bytes = await readFile(new URL(path, import.meta.url));
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const length = bytes.readUInt32LE(12);
  return { bytes, json: JSON.parse(bytes.subarray(20, 20 + length).toString()), binary: bytes.subarray(28 + length) };
}
function values(asset: Awaited<ReturnType<typeof glb>>, id: number): number[] {
  const accessor = asset.json.accessors[id];
  const view = asset.json.bufferViews[accessor.bufferView];
  const width = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as Record<string, number>)[accessor.type];
  const bytes = accessor.componentType === 5123 ? 2 : 4;
  return Array.from({ length: accessor.count * width }, (_, i) => {
    const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + Math.floor(i / width) * (view.byteStride ?? width * bytes) + i % width * bytes;
    return bytes === 2 ? asset.binary.readUInt16LE(offset) : asset.binary.readFloatLE(offset);
  });
}

test('新人物保留外观资源与拓扑，所有顶点具备有效归一化蒙皮权重', async () => {
  const original = await glb('../../public/manual-roam/EQ_People.glb');
  assert.equal(createHash('sha256').update(original.bytes).digest('hex'), '42499f8bdd191f2a97143a668f705d840e9b9ee3a3a565285d550f89d542f6e6');
  for (const path of ['../../public/manual-roam/EQ_People_rigged_v2.glb', '../fixtures/roam/worker-blue-rigged-v2.glb']) {
    const asset = await glb(path);
    assert.equal(asset.json.animations?.length ?? 0, 0);
    assert.equal(asset.json.skins.length, 1);
    const root = asset.json.nodes[asset.json.scenes[0].nodes[0]];
    assert.deepEqual(root.extras.manualRoamRig, { profile: 'mixamo-humanoid-v2', version: 2 });
    assert.deepEqual(asset.json.skins[0].joints.map((i: number) => asset.json.nodes[i].name), bones);
    if (path.includes('EQ_People')) assert.deepEqual(asset.json.materials, original.json.materials);
    assert.equal(asset.json.images.length, original.json.images.length);
    for (let i = 0; i < original.json.images.length; i++) {
      const imageBytes = (a: typeof asset) => { const v = a.json.bufferViews[a.json.images[i].bufferView]; return a.binary.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength); };
      assert.deepEqual(imageBytes(asset), imageBytes(original));
    }
    for (let i = 0; i < asset.json.meshes[0].primitives.length; i++) {
      const primitive = asset.json.meshes[0].primitives[i];
      assert.equal(asset.json.accessors[primitive.indices].count, original.json.accessors[original.json.meshes[0].primitives[i].indices].count);
      const joints = values(asset, primitive.attributes.JOINTS_0);
      const weights = values(asset, primitive.attributes.WEIGHTS_0);
      assert.ok(joints.every(j => Number.isInteger(j) && j >= 0 && j < bones.length));
      for (let n = 0; n < weights.length; n += 4) {
        assert.ok(weights.slice(n, n + 4).every(w => w >= 0 && w <= 1));
        assert.ok(Math.abs(weights.slice(n, n + 4).reduce((sum, w) => sum + w, 0) - 1) < 1e-5);
      }
    }
  }
});

test('原始 bind 姿态的绑定矩阵保持网格，真实行走轨道驱动腿部蒙皮且不产生爆点', async () => {
  const avatar = await glb('../../public/manual-roam/EQ_People_rigged_v2.glb');
  const motion = await glb('../../public/manual-roam/locomotion-v2.glb');
  const primitive = avatar.json.meshes[0].primitives[0];
  const positions = values(avatar, primitive.attributes.POSITION);
  const joints = values(avatar, primitive.attributes.JOINTS_0);
  const weights = values(avatar, primitive.attributes.WEIGHTS_0);
  const bind = values(avatar, avatar.json.skins[0].inverseBindMatrices);
  const evaluate = (frame: number | null, clipName = 'WalkForward') => {
    const nodes = structuredClone(avatar.json.nodes);
    if (frame !== null) {
      nodes.forEach((node: { extras?: { manualRoamReferencePose?: object } }) => Object.assign(node, node.extras?.manualRoamReferencePose ?? {}));
      const clip = motion.json.animations.find((clip: {name: string}) => clip.name === clipName);
      for (const channel of clip.channels) {
        const output = values(motion, clip.samplers[channel.sampler].output);
        const width = channel.target.path === 'rotation' ? 4 : 3;
        nodes[channel.target.node][channel.target.path] = output.slice(frame * width, (frame + 1) * width);
      }
    }
    const world: Matrix[] = [];
    const visit = (id: number, parent: Matrix) => {
      const n = nodes[id];
      world[id] = Matrix.Compose(Vector3.FromArray(n.scale ?? [1,1,1]), Quaternion.FromArray(n.rotation ?? [0,0,0,1]), Vector3.FromArray(n.translation ?? [0,0,0])).multiply(parent);
      for (const child of n.children ?? []) visit(child, world[id]);
    };
    visit(0, Matrix.Identity());
    const matrices = avatar.json.skins[0].joints.map((node: number, i: number) => Matrix.FromArray(bind.slice(i * 16, (i + 1) * 16)).multiply(world[node]));
    return Array.from({length: positions.length / 3}, (_, index) => {
      const position = Vector3.FromArray(positions.slice(index * 3, index * 3 + 3));
      const result = Vector3.Zero();
      for (let k = 0; k < 4; k++) result.addInPlace(Vector3.TransformCoordinates(position, matrices[joints[index * 4 + k]]).scale(weights[index * 4 + k]));
      return result;
    });
  };
  const resting = evaluate(null), walking = evaluate(8);
  let movingLegVertices = 0;
  resting.forEach((position, i) => {
    assert.ok(Vector3.Distance(position, Vector3.FromArray(positions.slice(i * 3, i * 3 + 3))) < 1e-6);
    assert.ok(walking[i].asArray().every(Number.isFinite));
    assert.ok(walking[i].length() < 2.5, 'skin must remain within plausible human bounds');
    if (position.y < 0.7 && Vector3.Distance(position, walking[i]) > 0.04) movingLegVertices++;
  });
  assert.ok(movingLegVertices > 100, `expected many leg vertices to move, observed ${movingLegVertices}`);
  const surfaceArea = (vertices: Vector3[], indices: number[]) => {
    let total = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const [a,b,c] = indices.slice(i, i + 3).map(index => vertices[index]);
      total += Vector3.Cross(b.subtract(a), c.subtract(a)).length() / 2;
    }
    return total;
  };
  const indices = [3,5].map(material => values(avatar, avatar.json.meshes[0].primitives[material].indices));
  const originalAreas = indices.map(triangles => surfaceArea(resting, triangles));
  const areaFailures: string[] = [];
  for (const [name, tolerance] of [['Idle',0.03],['WalkForward',0.05],['WalkBackward',0.05],['WalkLeft',0.05],['WalkRight',0.05],['RunForward',0.10],['RunLeft',0.10],['RunRight',0.10]] as const) {
    const clip = motion.json.animations.find((clip: { name: string }) => clip.name === name);
    const times = values(motion, clip.samplers[0].input);
    const ranges = [{min:Infinity,max:-Infinity},{min:Infinity,max:-Infinity}];
    for (let frame = 0; frame < times.length; frame++) {
      const animated = evaluate(frame, name);
      indices.forEach((triangles, material) => {
        const ratio = surfaceArea(animated, triangles) / originalAreas[material];
        ranges[material].min = Math.min(ranges[material].min, ratio);
        ranges[material].max = Math.max(ranges[material].max, ratio);
        if (Math.abs(ratio - 1) >= tolerance) areaFailures.push(`${name} frame ${frame}, material ${material === 0 ? 3 : 5}: dynamic area ratio ${ratio}`);
      });
    }
    console.log(`Dynamic geometry ${name}: shirt ${ranges[0].min.toFixed(6)}..${ranges[0].max.toFixed(6)}, trousers ${ranges[1].min.toFixed(6)}..${ranges[1].max.toFixed(6)}`);
  }
  assert.deepEqual(areaFailures, [], '动态几何超出约定范围');
});

test('补绑仅改变单位与整体位置，逐顶点轮廓和各材质三角面积保持原样', async () => {
  const original = await glb('../../public/manual-roam/EQ_People.glb');
  const avatar = await glb('../../public/manual-roam/EQ_People_rigged_v2.glb');
  const before = values(original, 0).map(value => value * 100);
  const attributes = avatar.json.meshes[0].primitives[0].attributes;
  const after = values(avatar, attributes.POSITION);
  const offset = after.slice(0, 3).map((value, axis) => value - before[axis]);
  assert.equal(before.length, after.length);
  let maxOutlineError = 0;
  after.forEach((value, index) => {
    const error = Math.abs(value - before[index] - offset[index % 3]);
    maxOutlineError = Math.max(maxOutlineError, error);
    assert.ok(error < 1e-6, `vertex ${Math.floor(index / 3)} moved ${error}m beyond global normalization`);
  });
  assert.deepEqual(values(avatar, attributes.NORMAL), values(original, 1));
  assert.deepEqual(values(avatar, attributes.TANGENT), values(original, 2));
  const area = (positions: number[], indices: number[]) => {
    const [a,b,c] = indices.map(index => Vector3.FromArray(positions.slice(index * 3, index * 3 + 3)));
    return Vector3.Cross(b.subtract(a), c.subtract(a)).length() / 2;
  };
  for (const primitive of original.json.meshes[0].primitives) {
    const indices = values(original, primitive.indices);
    let originalArea = 0, newArea = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const triangle = indices.slice(i, i + 3), oldValue = area(before, triangle), newValue = area(after, triangle);
      originalArea += oldValue; newArea += newValue;
      if (oldValue > 1e-8) assert.ok(Math.abs(newValue / oldValue - 1) < 0.001, `material ${primitive.material} triangle ${i / 3} stretched`);
    }
    assert.ok(Math.abs(newArea / originalArea - 1) < 1e-5, `material ${primitive.material} area ratio ${newArea / originalArea}`);
  }
  console.log(`Original mesh outline maximum error ${maxOutlineError.toExponential(3)}m`);
});

test('共享动作包仅包含骨架与15个明确动作，平移不驱动世界位置', async () => {
  const asset = await glb('../../public/manual-roam/locomotion-v2.glb');
  const manifest = JSON.parse(await readFile(new URL('../../public/manual-roam/locomotion-v2.manifest.json', import.meta.url), 'utf8'));
  assert.equal(asset.json.meshes?.length ?? 0, 0);
  assert.equal(asset.json.skins?.length ?? 0, 0);
  assert.deepEqual(asset.json.animations.map((a: { name: string }) => a.name), [...names,'TurnLeft90','TurnRight90']);
  assert.equal(manifest.profile, 'mixamo-humanoid-v2');
  assert.equal(manifest.files.animation.sha256, createHash('sha256').update(asset.bytes).digest('hex'));
  for (const animation of asset.json.animations) {
    assert.ok(manifest.clips[animation.name].source);
    const moved = [];
    for (const channel of animation.channels) {
      assert.ok(bones.includes(asset.json.nodes[channel.target.node].name));
      const sampler = animation.samplers[channel.sampler];
      const times = values(asset, sampler.input);
      assert.equal(times[0], 0);
      assert.ok(times.at(-1)! > 0);
      assert.ok(times.every((time, i) => i === 0 || time > times[i - 1]));
      const data = values(asset, sampler.output);
      assert.ok(data.every(Number.isFinite));
      if (channel.target.path === 'rotation') {
        for (let i = 0; i < data.length; i += 4) assert.ok(Math.abs(Math.hypot(...data.slice(i, i + 4)) - 1) < 1e-4);
        moved.push(data.some((v, i) => Math.abs(v - data[i % 4]) > 1e-4));
      } else {
        assert.equal(channel.target.path, 'translation');
        assert.equal(asset.json.nodes[channel.target.node].name, 'Hips');
        for (let i = 0; i < data.length; i += 3) { assert.equal(data[i], data[0]); assert.equal(data[i + 2], data[2]); }
      }
    }
    assert.ok(moved.some(Boolean), `${animation.name} must contain an actual changing pose`);
  }
});

test('衣领袖口裤腰的原始近邻跨材质接合在恢复基准姿态后不被拉开', async () => {
  const original = await glb('../../public/manual-roam/EQ_People.glb');
  const avatar = await glb('../../public/manual-roam/EQ_People_rigged_v2.glb');
  const before = values(original, 0).map(value => value * 100);
  const after = values(avatar, avatar.json.meshes[0].primitives[0].attributes.POSITION);
  const distance = (data: number[], a: number, b: number) => Math.hypot(data[a*3]-data[b*3], data[a*3+1]-data[b*3+1], data[a*3+2]-data[b*3+2]);
  let checked = 0, maxIncrease = 0;
  for (const [a, b] of [[1,3],[3,4],[3,5],[5,6]]) {
    const left = [...new Set(values(original, original.json.meshes[0].primitives[a].indices))];
    const right = [...new Set(values(original, original.json.meshes[0].primitives[b].indices))];
    for (const index of left) {
      let nearest = -1, oldDistance = Infinity;
      for (const candidate of right) {
        const candidateDistance = distance(before, index, candidate);
        if (candidateDistance < oldDistance) { nearest = candidate; oldDistance = candidateDistance; }
      }
      if (oldDistance > 0.012) continue;
      checked++;
      const increase = distance(after, index, nearest) - oldDistance;
      maxIncrease = Math.max(maxIncrease, increase);
      assert.ok(increase < 0.005, `materials ${a}/${b}, vertices ${index}/${nearest}: seam increased ${increase}m`);
    }
  }
  assert.ok(checked > 50, `must exercise original surface joins; observed ${checked}`);
  console.log(`Surface-join regression: ${checked} pairs, maximum distance increase ${maxIncrease.toFixed(6)}m`);
});

test('左右侧移接地脚在人物局部坐标中沿行进方向的反方向移动', async () => {
  const motion = await glb('../../public/manual-roam/locomotion-v2.glb');
  for (const name of ['WalkLeft','WalkRight','RunLeft','RunRight']) {
    const clip = motion.json.animations.find((clip: {name: string}) => clip.name === name);
    const frames = values(motion, clip.samplers[0].input);
    const foot = motion.json.nodes.findIndex((n: {name:string}) => n.name === 'LeftFoot');
    const samples = frames.map((_time, frame) => {
      const nodes = structuredClone(motion.json.nodes);
      for (const channel of clip.channels) {
        const output = values(motion, clip.samplers[channel.sampler].output), width = channel.target.path === 'rotation' ? 4 : 3;
        nodes[channel.target.node][channel.target.path] = output.slice(frame*width,(frame+1)*width);
      }
      const world: Matrix[] = [];
      const visit = (id: number, parent: Matrix) => {
        const node = nodes[id];
        world[id] = Matrix.Compose(Vector3.One(), Quaternion.FromArray(node.rotation ?? [0,0,0,1]), Vector3.FromArray(node.translation ?? [0,0,0])).multiply(parent);
        for (const child of node.children ?? []) visit(child, world[id]);
      };
      visit(0, Matrix.Identity());
      return world[foot].getTranslation();
    });
    let frame = 1;
    for (let i = 2; i < samples.length-1; i++) if (samples[i].y < samples[frame].y) frame = i;
    const velocity = (samples[frame+1].x-samples[frame-1].x)/(frames[frame+1]-frames[frame-1]);
    assert.ok(name.endsWith('Left') ? velocity < -0.1 : velocity > 0.1, `${name} contact-frame local X velocity ${velocity}`);
  }
});
