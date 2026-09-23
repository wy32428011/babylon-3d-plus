import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConveyorArrowModules } from '../helpers/conveyorSurfaceArrowModules.mjs';

const [systems, telemetry, sessions, configs, motions] = await loadConveyorArrowModules([
  'src/runtime/babylon/telemetry/StackerMotionArrowSystem.ts', 'src/runtime/mqtt/deviceTelemetry.ts',
  'src/runtime/stackerMotionArrowSession.ts', 'src/editor/model/stackerMotionArrows.ts',
  'src/runtime/babylon/telemetry/stackerMotionState.ts',
]);
const session = sessions.stackerMotionArrowSession, store = telemetry.deviceTelemetryStore;
function fixture(t) {
  session.clear(); store.clear(); const calls = new Map();
  const renderer = {
    update(id,model,config,channel,direction,delta,visible) { calls.set(JSON.stringify([id,channel]),{direction,visible}); return null; },
    retain(ids) { for(const id of calls.keys()) if(!ids.has(id))calls.delete(id); }, clear(){calls.clear();},dispose(){calls.clear();},
  };
  const system = new systems.StackerMotionArrowSystem(renderer);
  const model = (code,source='default') => ({assetCode:code,assetHandle:{},stackerTelemetryReady:true,root:{isDisposed:()=>false},
    telemetryBinding:{enabled:true,sourceId:source,deviceType:'stacker',staleAfterMs:2000,
      stackerMotionArrows:{...configs.createDefaultStackerMotionArrowsConfig(),enabled:true}}});
  const entry=(id,model)=>({entityId:id,model,deviceType:'stacker',visible:true});
  const push=(code,source='default',faulted=false)=>store.upsert({sourceId:source,assetCode:code,deviceType:'stacker',topic:'',payloadDeviceCode:code,
    sourceTimestamp:null,sequence:null,receivedAt:10000,fields:{movement_x:2,movement_y:2},faulted,
    currentLocationKey:null,targetLocationKey:null,hasTargetLocation:false,message:''});
  const publish=(model,changes={travel:.2,lift:.1,frontFork:0,backFork:0},frame=5)=>motions.publishStackerMotionFrame(model,frame,.1,changes);
  const call=(id,channel)=>calls.get(JSON.stringify([id,channel]));
  t.after(()=>{system.dispose();session.clear();store.clear();});return{system,model,entry,push,publish,call,calls};
}
test('同帧实际位移决定四路方向，忽略相反的遥测方向编码且设备身份隔离',t=>{
  const h=fixture(t),a=h.model('001'),b=h.model('001','other');h.push('001');h.push('001','other');
  h.publish(a);h.publish(b,{travel:0,lift:0,frontFork:-.1,backFork:.2});
  h.system.tick([h.entry('a',a),h.entry('b',b)],true,.1,5,11000);
  assert.deepEqual(h.call('a','travel'),{direction:1,visible:true});
  assert.deepEqual(h.call('a','lift'),{direction:1,visible:true});
  assert.deepEqual(h.call('b','frontFork'),{direction:-1,visible:true});
  assert.deepEqual(h.call('b','backFork'),{direction:1,visible:true});
});
test('旧帧、故障、过期、禁用绑定立即隐藏；正常到位保留淡出入口',t=>{
  const h=fixture(t),a=h.model('001'),entries=[h.entry('a',a)];h.push('001');h.publish(a);
  h.system.tick(entries,true,.1,6,11000);assert.equal(h.call('a','travel').visible,false);
  h.system.tick(entries,true,.1,5,13000);assert.equal(h.call('a','travel').visible,false);assert.match(session.getDiagnostic('a','travel'),/过期/);
  h.push('001','default',true);h.system.tick(entries,true,.1,5,11000);assert.equal(h.call('a','travel').visible,false);
  h.push('001');h.publish(a,{travel:0,lift:0,frontFork:0,backFork:0});h.system.tick(entries,true,.1,5,11000);
  assert.deepEqual(h.call('a','travel'),{direction:0,visible:true});
  a.telemetryBinding.enabled=false;h.system.tick(entries,true,.1,5,11000);assert.equal(h.call('a','travel').visible,false);
});
test('关闭箭头的设备仍参与绑定冲突，旧场景缺配置无资源',t=>{
  const h=fixture(t),a=h.model('001'),b=h.model('001');delete b.telemetryBinding.stackerMotionArrows;h.push('001');h.publish(a);
  h.system.tick([h.entry('a',a),h.entry('b',b)],true,.1,5,11000);
  assert.equal(h.call('a','travel').visible,false);assert.match(session.getDiagnostic('a','travel'),/冲突/);assert.equal(h.call('b','travel'),undefined);
});
test('编辑预览可独立控制四路，运行忽略预览，删除释放所有通道与会话',t=>{
  const h=fixture(t),a=h.model('001'),entries=[h.entry('a',a)];
  session.setPreview('a','frontFork',-1);session.setPreview('a','lift',1);
  h.system.tick(entries,false,.1,5,11000);
  assert.deepEqual(h.call('a','frontFork'),{direction:-1,visible:true});assert.equal(h.call('a','lift').direction,1);assert.equal(h.call('a','travel').visible,false);
  h.system.tick(entries,true,.1,5,11000);assert.equal(h.call('a','frontFork').visible,false);
  h.system.tick([],true,.1,5,11000);assert.equal(h.calls.size,0);assert.equal(session.getDiagnostic('a','lift'),'');
});
