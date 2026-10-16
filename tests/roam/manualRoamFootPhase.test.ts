import assert from 'node:assert/strict';
import test from 'node:test';
import { createManualRoamFootPhaseState, stepManualRoamFootPhase } from '../../src/runtime/roam/manualRoamFootPhase.ts';

const frame={dt:1/60,contact:1,moving:true,soleClearance:0,verticalSpeed:0,canPlant:true};
test('短促跑步已触地即可支撑，未触地的高接触曲线仍不能锁住摆动脚',()=>{
  const landed=stepManualRoamFootPhase(createManualRoamFootPhaseState(),frame);
  assert.equal(landed.phase,'Support');assert.equal(landed.canLock,true);
  const airborne=stepManualRoamFootPhase(createManualRoamFootPhaseState(),{...frame,soleClearance:.2,verticalSpeed:-.1});
  assert.equal(airborne.phase,'Swing');assert.equal(airborne.canLock,false);
});
test('首次静态贴地直接Support，支撑满权重且接触阈值附近不反复开锁',()=>{
  let state=stepManualRoamFootPhase(createManualRoamFootPhaseState(),{...frame,moving:false});
  assert.equal(state.phase,'Support');assert.equal(state.canLock,true);
  for(const contact of [.56,.54,.56,.54,.4]){
    state=stepManualRoamFootPhase(state,{...frame,contact});
    assert.equal(state.phase,'Support');assert.deepEqual([state.positionWeight,state.rotationWeight,state.plantWeight],[1,1,1]);
  }
});
test('高空摆动不能水平锁；下降Landing分开位置和姿态，最终才进入Support',()=>{
  let state=stepManualRoamFootPhase(createManualRoamFootPhaseState(),{...frame,soleClearance:.25,verticalSpeed:-.3});
  assert.equal(state.phase,'Swing');assert.equal(state.canLock,false);
  state=stepManualRoamFootPhase(state,{...frame,soleClearance:.06,verticalSpeed:-.3});
  assert.equal(state.phase,'Landing');assert.equal(state.plantWeight,0);
  assert.ok(state.positionWeight>state.rotationWeight);
  for(let i=0;i<12;i++)state=stepManualRoamFootPhase(state,frame);
  assert.equal(state.phase,'Support');assert.equal(state.plantWeight,1);assert.equal(state.canLock,true);
});
test('ToeOff先解锁再渐隐，结束回Swing，重新起落不会携带旧水平锁',()=>{
  let state=stepManualRoamFootPhase(createManualRoamFootPhaseState(),{...frame,moving:false});
  state=stepManualRoamFootPhase(state,{...frame,contact:.2,verticalSpeed:.2});
  assert.equal(state.phase,'ToeOff');assert.equal(state.canLock,false);
  assert.ok(state.positionWeight>0&&state.rotationWeight<state.positionWeight);
  for(let i=0;i<12;i++)state=stepManualRoamFootPhase(state,{...frame,contact:0,soleClearance:.2});
  assert.equal(state.phase,'Swing');assert.equal(state.positionWeight,0);
});
test('30/60/120FPS同一着地时段权重一致，非法输入和无效地面清状态',()=>{
  const samples=[];
  for(const fps of [30,60,120]){
    let state=createManualRoamFootPhaseState();
    for(let i=0;i<fps/10;i++)state=stepManualRoamFootPhase(state,{...frame,dt:1/fps,soleClearance:.06,verticalSpeed:-.2});
    samples.push([state.positionWeight,state.rotationWeight,state.plantWeight]);
  }
  for(let i=0;i<3;i++)assert.ok(Math.max(...samples.map(s=>s[i]))-Math.min(...samples.map(s=>s[i]))<1e-9);
  const support=stepManualRoamFootPhase(createManualRoamFootPhaseState(),{...frame,moving:false});
  for(const invalid of [{dt:Number.NaN},{contact:Number.NaN},{soleClearance:Infinity},{verticalSpeed:Number.NaN},{canPlant:false}]){
    const state=stepManualRoamFootPhase(support,{...frame,...invalid});assert.equal(state.phase,'Swing');assert.equal(state.canLock,false);assert.equal(state.plantWeight,0);
  }
  assert.equal(createManualRoamFootPhaseState().phase,'Swing');
});
