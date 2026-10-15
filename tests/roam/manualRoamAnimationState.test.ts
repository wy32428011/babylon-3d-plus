import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createManualRoamAnimationState, stepManualRoamAnimationState } from '../../src/runtime/roam/manualRoamAnimationState.ts';
import { createDefaultManualRoamConfig } from '../../src/runtime/roam/manualRoamCore.ts';

const frame = { deltaSeconds: 0.05, velocityX: 0, velocityZ: 0, yaw: 0, verticalVelocity: 0, grounded: true, jumped: false, fly: false, sprint: false, walkSpeed: 1.6, worldScale: 1 };
test('碰撞后速度归零进入Idle；方向由实际世界速度和人物yaw共同决定', () => {
  const idle = stepManualRoamAnimationState(createManualRoamAnimationState(), frame);
  assert.deepEqual(idle.weights, { Idle: 1 });
  const backward = stepManualRoamAnimationState(idle, { ...frame, velocityZ: -1.6 });
  assert.deepEqual(backward.weights, { WalkBackward: 1 });
  const diagonal = stepManualRoamAnimationState(idle, { ...frame, velocityX: 1, velocityZ: 1 });
  assert.equal(diagonal.weights.WalkForward, 0.5);
  assert.equal(diagonal.weights.WalkRight, 0.5);
  const turned = stepManualRoamAnimationState(idle, { ...frame, velocityX: 1.6, yaw: Math.PI / 2 });
  assert.ok(turned.weights.WalkForward! > 0.99999);
});
test('空中与落地按真实grounded和垂直速度推进，飞行不落回地面动作', () => {
  let state = stepManualRoamAnimationState(createManualRoamAnimationState(), { ...frame, jumped: true, grounded: false, verticalVelocity: 4 });
  assert.equal(state.kind, 'JumpStart');
  for (let i = 0; i < 4; i++) state = stepManualRoamAnimationState(state, { ...frame, grounded: false, verticalVelocity: 3 });
  assert.equal(state.kind, 'JumpUp');
  state = stepManualRoamAnimationState(state, { ...frame, grounded: false, verticalVelocity: -1 });
  assert.equal(state.kind, 'Fall');
  state = stepManualRoamAnimationState(state, frame);
  assert.equal(state.kind, 'Land');
  for (let i = 0; i < 5; i++) state = stepManualRoamAnimationState(state, frame);
  assert.equal(state.kind, 'ground');
  state = stepManualRoamAnimationState(state, { ...frame, fly: true, grounded: false, verticalVelocity: 0 });
  assert.equal(state.kind, 'FlyIdle');
  state = stepManualRoamAnimationState(state, { ...frame, fly: true, grounded: false, verticalVelocity: 2 });
  assert.equal(state.kind, 'FlyMove');
});
test('步频随真实速度和人物外层尺度换算，非法与长帧输入有界', () => {
  const initial = createManualRoamAnimationState();
  const first = stepManualRoamAnimationState(initial, { ...frame, velocityZ: 1.6 });
  const scaled = stepManualRoamAnimationState(initial, { ...frame, velocityZ: 1.6, worldScale: 2 });
  assert.ok(Math.abs(first.phase - scaled.phase * 2) < 1e-9);
  const invalid = stepManualRoamAnimationState(initial, { ...frame, deltaSeconds: Number.NaN, velocityZ: Number.NaN });
  assert.deepEqual(invalid.weights, { Idle: 1 });
  assert.equal(invalid.phase, 0);
  const run = stepManualRoamAnimationState(initial, { ...frame, sprint: true, velocityZ: 3.2 });
  assert.deepEqual(run.weights, { RunForward: 1 });
});

test('落地期间移动或新跳跃立即打断Land', () => {
  const falling = stepManualRoamAnimationState(createManualRoamAnimationState(), { ...frame, grounded: false, verticalVelocity: -1 });
  const land = stepManualRoamAnimationState(falling, frame);
  assert.equal(land.kind, 'Land');
  assert.equal(stepManualRoamAnimationState(land, { ...frame, velocityZ: 1.6 }).kind, 'ground');
  assert.equal(stepManualRoamAnimationState(land, { ...frame, grounded: false, jumped: true, verticalVelocity: 4 }).kind, 'JumpStart');
});

test('方向动作按各自标定步长推进，同速侧步不能套用前进周期', () => {
  const timing = { walkSpeed: 1.6, runSpeed: 3.2, walkDuration: 1, runDuration: 1,
    jumpStartDuration: 0.1, landDuration: 0.2, clipCycleDistances: { WalkForward: 1, WalkRight: 2 } };
  const forward = stepManualRoamAnimationState(createManualRoamAnimationState(), { ...frame, velocityZ: 1 }, timing);
  const sideways = stepManualRoamAnimationState(createManualRoamAnimationState(), { ...frame, velocityX: 1 }, timing);
  assert.ok(Math.abs(forward.phase - sideways.phase * 2) < 1e-9);
});

test('真实清单长起跳片段不会吞掉默认物理跳跃的上升阶段', async () => {
  const manifest = JSON.parse(await readFile('public/manual-roam/locomotion-v1.manifest.json', 'utf8'));
  const config = createDefaultManualRoamConfig();
  const timing = { walkSpeed: 1.6, runSpeed: 3.2, walkDuration: 1, runDuration: 1, jumpStartDuration: Math.max(0.3, manifest.clips.JumpStart.duration), landDuration: 0.3 };
  for (const fps of [30, 60, 120]) {
    let state = createManualRoamAnimationState(); let vertical = config.jumpSpeed; let height = 0;
    const stages = new Set<string>();
    for (let tick = 0; tick < fps; tick++) {
      vertical += config.gravity / fps; height += vertical / fps;
      const grounded = tick > 0 && height <= 0;
      if (grounded) { height = 0; vertical = 0; }
      state = stepManualRoamAnimationState(state, { ...frame, deltaSeconds: 1 / fps, grounded, jumped: tick === 0, verticalVelocity: vertical }, timing);
      stages.add(state.kind);
      if (!grounded && vertical <= 0.15) assert.equal(state.kind, 'Fall', `${fps} FPS 下不能在下降时保留起跳状态`);
    }
    assert.ok(stages.has('JumpStart'));
    assert.ok(stages.has('JumpUp'), `${fps} FPS 默认跳跃必须播放上升动作`);
    assert.ok(stages.has('Fall')); assert.ok(stages.has('Land'));
  }
});

test('v2默认步速下步频自然且无需拉伸步幅，超出原生步速时有界拉伸，逐帧视觉距离与实际位移保持一致',async()=>{
  const manifest=JSON.parse(await readFile('public/manual-roam/locomotion-v2.manifest.json','utf8'));
  const clip=manifest.clips.WalkForward;
  const timing={walkSpeed:clip.referenceSpeed,runSpeed:3.2,walkDuration:clip.duration,runDuration:.7,jumpStartDuration:.1,landDuration:.2,clipCycleDistances:{WalkForward:clip.cycleDistanceMeters},enableStrideWarp:true};
  let state=createManualRoamAnimationState(),distance=0;
  const scale=.9567,dt=1/60;
  for(let i=0;i<120;i++){
    const previous=state;
    state=stepManualRoamAnimationState(state,{...frame,deltaSeconds:dt,velocityZ:1.6,worldScale:scale},timing);
    assert.ok(state.strideScale>=1&&state.strideScale<=1.3);
    assert.ok(Math.abs(state.strideScale-previous.strideScale)<=.6*dt+1e-10);
    const cycles=(state.phase-previous.phase+1)%1;
    distance+=cycles*clip.cycleDistanceMeters*state.strideScale*scale;
  }
  assert.ok(Math.abs(distance-3.2)<1e-8);
  // 原创步行按默认步速标定：足部IK拉伸步幅会让支撑脚超出可达范围、骨盆下沉成屈膝走，默认步速不能依赖它。
  const cadence=1.6/(clip.cycleDistanceMeters*state.strideScale*scale)*120;
  assert.ok(cadence>=110&&cadence<=145,`默认步速步频${cadence.toFixed(1)}步/分钟`);
  assert.ok(state.strideScale<=1.02,`默认步速步幅系数${state.strideScale}`);
  let fast=createManualRoamAnimationState();
  for(let i=0;i<180;i++)fast=stepManualRoamAnimationState(fast,{...frame,deltaSeconds:dt,velocityZ:2.2,worldScale:scale},timing);
  assert.ok(fast.strideScale>1.1&&fast.strideScale<=1.3,`超速步幅系数${fast.strideScale}`);
  const old=stepManualRoamAnimationState(createManualRoamAnimationState(),{...frame,velocityZ:1.6},{...timing,enableStrideWarp:false});
  assert.equal(old.strideScale,1,'旧人物不得自动改变步幅');
});

test('步幅平滑30/60/120FPS一致，停止回收，极端速度有界且不产生NaN',()=>{
  const timing={walkSpeed:1,runSpeed:2,walkDuration:1,runDuration:1,jumpStartDuration:.1,landDuration:.2,enableStrideWarp:true};
  const results=[];
  for(const fps of [30,60,120]){
    let state=createManualRoamAnimationState();
    for(let i=0;i<fps;i++)state=stepManualRoamAnimationState(state,{...frame,deltaSeconds:1/fps,velocityZ:3.2,sprint:true},timing);
    results.push(state.strideScale);assert.ok(state.strideScale<=1.3);
    for(let i=0;i<fps*3;i++)state=stepManualRoamAnimationState(state,{...frame,deltaSeconds:1/fps},timing);
    assert.ok(state.strideScale-1<1e-6);
    state=stepManualRoamAnimationState(state,{...frame,velocityZ:Number.MAX_VALUE,worldScale:Number.NaN},timing);
    assert.ok(Number.isFinite(state.phase)&&Number.isFinite(state.strideScale));
  }
  assert.ok(Math.max(...results)-Math.min(...results)<1e-9);
});
