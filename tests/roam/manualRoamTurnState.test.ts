import assert from 'node:assert/strict';
import test from 'node:test';
import { createManualRoamTurnState, stepManualRoamTurnState } from '../../src/runtime/roam/manualRoamTurnState.ts';

const base = { deltaSeconds: 1 / 60, controlYaw: 0, horizontalSpeed: 0, grounded: true, fly: false };
const radians = (degrees: number) => degrees / 180 * Math.PI;

test('巡检身体朝向真实移动方向，停止保持朝向且相机控制yaw不变',()=>{
  let state=createManualRoamTurnState(0);
  for(let i=0;i<90;i++)state=stepManualRoamTurnState(state,{...base,horizontalSpeed:1.6,orientToMovement:true,movementYaw:Math.PI/2});
  assert.ok(Math.abs(state.visualYaw-Math.PI/2)<.01,'侧向位移应以转身后前走呈现');
  assert.equal(state.controlYaw,0,'不能改变键位、相机或位移的控制朝向');
  state=stepManualRoamTurnState(state,{...base,horizontalSpeed:1.6,grounded:false,orientToMovement:true,movementYaw:Math.PI/2});
  assert.ok(Math.abs(state.visualYaw-Math.PI/2)<.01,'跳跃不能让身体突然转回相机朝向');
  for(let i=0;i<120;i++)state=stepManualRoamTurnState(state,{...base,orientToMovement:true});
  assert.ok(Math.abs(state.visualYaw-Math.PI/2)<.01,'停止后不得自动转回控制yaw');
  for(let i=0;i<120;i++)state=stepManualRoamTurnState(state,{...base,orientToMovement:true,controlYaw:.5});
  assert.ok(Math.abs(state.visualYaw-(Math.PI/2+.5))<.01,'站立转向沿相机输入增量旋转');
});

test('运动方向跨正负PI平滑转向，倒退和斜向都不改变控制yaw',()=>{
  for(const heading of [Math.PI,-Math.PI/2,Math.PI/4]) {
    let state=createManualRoamTurnState(0);
    for(let i=0;i<120;i++) {const previous=state.visualYaw;state=stepManualRoamTurnState(state,{...base,horizontalSpeed:1.6,orientToMovement:true,movementYaw:heading});assert.ok(Math.abs(state.visualYaw-previous)<=8/60+1e-8);}
    assert.ok(Math.abs(Math.atan2(Math.sin(state.visualYaw-heading),Math.cos(state.visualYaw-heading)))<.01);
    assert.equal(state.controlYaw,0);assert.equal(state.turnClip,null);
  }
});

test('只有90度资源时180度转向分两次双步，不请求不存在的180片段', () => {
  let state=createManualRoamTurnState(0),turns=0,previous:string|null=null;
  for(let i=0;i<180;i++) {
    state=stepManualRoamTurnState(state,{...base,controlYaw:Math.PI,turnDurations:{TurnLeft90:.8,TurnRight90:.8}});
    if(state.turnClip&&previous===null)turns++;
    if(state.turnClip)assert.equal(state.turnClip,'TurnRight90');
    previous=state.turnClip;
  }
  assert.equal(turns,2);assert.ok(Math.abs(state.visualYaw-Math.PI)<.01);
});

test('控制朝向与移动不改动，原地90度锁定终点并随动作进度转身', () => {
  const input = { ...base, controlYaw: Math.PI / 2 };
  const state = stepManualRoamTurnState(createManualRoamTurnState(0), input);
  assert.equal(state.turnClip, 'TurnRight90');
  assert.equal(input.controlYaw, Math.PI / 2);
  assert.equal(state.targetYaw, Math.PI / 2);
  assert.ok(state.visualYaw >= 0 && state.visualYaw < Math.PI / 2);
  assert.equal(state.animationYaw, state.visualYaw);
  const continued = stepManualRoamTurnState(state, { ...input, controlYaw: radians(110) });
  assert.equal(continued.targetYaw, Math.PI / 2, '普通持续输入不能把当前转身终点不断推远');
  assert.ok(continued.turnProgress > state.turnProgress);
});

test('跨越正负PI选择最短方向，180度方向确定，完成后不反复触发', () => {
  const small = stepManualRoamTurnState(createManualRoamTurnState(radians(175)), { ...base, controlYaw: radians(-175) });
  assert.equal(small.turnClip, null);
  assert.ok(Math.abs(small.deltaYaw) < radians(11));
  for (const [target, clip] of [[Math.PI, 'TurnRight180'], [-Math.PI, 'TurnLeft180']] as const) {
    let state = createManualRoamTurnState(0);
    for (let i = 0; i < 120; i++) state = stepManualRoamTurnState(state, { ...base, controlYaw: target });
    assert.equal(state.turnClip, null);
    assert.ok(Math.abs(state.deltaYaw) < 1e-3, clip);
  }
});

test('30/60/120FPS相同墙钟进度一致且遵守角速度上界', () => {
  const values: number[] = [];
  for (const fps of [30, 60, 120]) {
    let state = createManualRoamTurnState(0);
    for (let i = 0; i < fps / 2; i++) {
      const previous = state.visualYaw;
      state = stepManualRoamTurnState(state, { ...base, deltaSeconds: 1 / fps, controlYaw: Math.PI / 2 });
      assert.ok(Math.abs(state.visualYaw - previous) <= 8 / fps + 1e-8);
    }
    values.push(state.visualYaw);
  }
  assert.ok(Math.max(...values) - Math.min(...values) < 1e-6);
});

test('行走、腾空和反向急转中断转身，重新移动保持视觉朝向连续', () => {
  let state = createManualRoamTurnState(0);
  for (let i = 0; i < 10; i++) state = stepManualRoamTurnState(state, { ...base, controlYaw: Math.PI / 2 });
  const moving = stepManualRoamTurnState(state, { ...base, controlYaw: Math.PI / 2, horizontalSpeed: 1.6 });
  assert.equal(moving.turnClip, null);
  assert.ok(moving.visualYaw > state.visualYaw && moving.visualYaw < Math.PI / 2);
  assert.equal(stepManualRoamTurnState(state, { ...base, grounded: false }).turnClip, null);
  assert.equal(stepManualRoamTurnState(state, { ...base, fly: true }).turnClip, null);
  const reversed = stepManualRoamTurnState(state, { ...base, controlYaw: -Math.PI / 2 });
  assert.equal(reversed.turnClip, 'TurnLeft90');
  assert.ok(Math.abs(reversed.visualYaw - state.visualYaw) < 0.1);
});

test('小角度允许短暂头身差，停稳后收敛；reset和非法帧不污染状态', () => {
  let state = createManualRoamTurnState(0);
  state = stepManualRoamTurnState(state, { ...base, controlYaw: radians(20) });
  assert.equal(state.visualYaw, 0);
  for (let i = 0; i < 120; i++) state = stepManualRoamTurnState(state, { ...base, controlYaw: radians(20) });
  assert.ok(Math.abs(state.deltaYaw) < radians(0.1));
  const reset = createManualRoamTurnState(7);
  assert.equal(reset.visualYaw, 7); assert.equal(reset.turnClip, null);
  const invalid = stepManualRoamTurnState(reset, { ...base, deltaSeconds: Number.NaN, controlYaw: Number.NaN });
  assert.equal(invalid.visualYaw, 7); assert.ok(Number.isFinite(invalid.deltaYaw));
});

test('首步完成身体转角后保持到另一脚归位，资源曲线使用同帧进度', () => {
  let state = createManualRoamTurnState(0);
  for (let i = 0; i < 30; i++) state = stepManualRoamTurnState(state, { ...base, controlYaw: Math.PI / 2 });
  assert.ok(Math.abs(state.visualYaw - Math.PI / 2) < 1e-6);
  assert.equal(state.turnClip, 'TurnRight90', '身体转完时动作仍继续归位');
  const before = state.visualYaw;
  for (let i = 0; i < 8; i++) state = stepManualRoamTurnState(state, { ...base, controlYaw: Math.PI / 2 });
  assert.equal(state.visualYaw, before);
  const curve = [0, 0.1, 1, 1, 1];
  state = createManualRoamTurnState(0);
  for (let i = 0; i < 12; i++) state = stepManualRoamTurnState(state, { ...base, controlYaw: Math.PI / 2, turnDurations: { TurnRight90: 1 }, turnRotationCurves: { TurnRight90: curve } });
  assert.ok(Math.abs(state.visualYaw - Math.PI / 2 * 0.08) < 1e-6);
  assert.deepEqual(curve, [0, 0.1, 1, 1, 1], '不得修改资源曲线');
});
