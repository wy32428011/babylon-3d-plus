import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { performance as nodePerformance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { Buffer as BabylonBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { WebGLDataBuffer } from '@babylonjs/core/Meshes/WebGL/webGLDataBuffer.js';
import { installClassificationAudit, measureClassificationWindow, captureClassificationFunction, readClassificationReadyReceipt } from '../../scripts/lib/phase2LightingClassificationAudit.mjs';
import { closeClassificationOwnedApplication, preserveClassificationFailure, assertClassificationSceneReady, deriveClassificationReadinessResources, inspectClassificationSkybox } from '../../scripts/phase2-lighting-classification-abba.mjs';

function fixture(t, arm = 'A') {
  const names = ['window', 'document', 'performance', 'PerformanceObserver', 'setTimeout'];
  const descriptors = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => { for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  let clock = 0, timer, frame, size = [1920, 1080], focused = true;
  const resources = [], source = [{ key: 'unchanged-object' }], scene = { meshes: [], isDisposed: false,
    getEngine: () => ({ getRenderWidth: () => size[0], getRenderHeight: () => size[1],
      onEndFrameObservable: { add: callback => { frame = callback; return callback; }, remove: callback => assert.equal(callback, frame) },
      get _gl() { throw new Error('性能窗口不得读取GPU pixels'); } }) };
  let enabled = false;
  class Lighting {
    options = { getSources() { assert.equal(this, lighting.options); return source; } };
    hasClassificationConsumer() { assert.equal(this, lighting); return true; }
    refreshSources() { return this.options.getSources(); }
    tick() { return this.refreshSources(); }
    getError() { return null; }
    getInvalidationDiagnostics() { return { enabled, skipped: { coalesced: 0, noConsumer: 0 } }; }
    setInvalidationDiagnosticsEnabled(value) { enabled = value; }
    resetInvalidationDiagnostics() {}
  }
  const lighting = new Lighting(), runtime = { scene, environment: { lightingRuntime: lighting },
    telemetry: { telemetryPreviewActive: false }, fetch: { fetchSyncTimer: null, fetchConfigSnapshot: null, fetchInFlightOperations: 0 },
    getPerformanceMetrics() { if (globalThis.window.__phase2ClassificationAudit?.active) throw new Error('性能窗口不得读全量runtime快照'); return {}; },
    getInitialLoadSnapshot: () => ({}) };
  const root = { __reactContainer$fixture: { stateNode: { current: { memoizedProps: { runtime: { current: runtime } } } } } };
  class FakeObserver {
    static supportedEntryTypes = ['longtask'];
    observe() {} takeRecords() { return []; } disconnect() {}
  }
  for (const [name, value] of Object.entries({ window: {}, document: { getElementById: () => root, visibilityState: 'visible', hasFocus: () => focused },
    performance: { now: () => clock, getEntriesByType: () => resources }, PerformanceObserver: FakeObserver,
    setTimeout: callback => { timer = callback; return 1; } })) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const originals = { source: lighting.options.getSources, tick: lighting.tick, refresh: lighting.refreshSources, consumer: lighting.hasClassificationConsumer };
  const installed = installClassificationAudit({ arm });
  return { lighting, runtime, source, installed, originals, resources, FakeObserver,
    setFocused: value => { focused = value; }, setSize: value => { size = value; },
    finish: async (promise, frames = 501, elapsed = 60001) => { for (let index = 0; index < frames; index++) { clock = index * 60000 / (frames - 1); lighting.tick(); frame(); }
      clock = elapsed; timer(); return promise; } };
}

test('A只改变两个实例开关；包装保留this/返回对象/异常并可逐descriptor恢复', t => {
  const f = fixture(t, 'A'), audit = globalThis.window.__phase2ClassificationAudit;
  assert.equal(f.installed.effectiveCoalesce, 0); assert.equal(f.installed.originalCoalesce, 'absent-default-250');
  assert.equal(f.installed.ownConsumerOverride, true); assert.equal(f.lighting.options.getSources(), f.source);
  assert.equal(f.lighting.tick(), f.source);
  audit.restore();
  assert.equal(f.lighting.options.getSources, f.originals.source); assert.equal(f.lighting.tick, f.originals.tick);
  assert.equal(f.lighting.refreshSources, f.originals.refresh); assert.equal(f.lighting.hasClassificationConsumer, f.originals.consumer);
  assert.equal(Object.hasOwn(f.lighting, 'hasClassificationConsumer'), false);
  assert.equal(Object.hasOwn(f.lighting.options, 'classificationCoalesceMinMs'), false);
  assert.throws(() => installClassificationAudit({ arm: 'unknown' }), /未知arm/);
});

test('B保留原consumer与缺省250；60s仅采样calls/LongTask/帧，不访问像素或全量runtime', async t => {
  const f = fixture(t, 'B');
  assert.equal(f.installed.effectiveCoalesce, 250); assert.equal(f.installed.ownConsumerOverride, false);
  assert.equal(Object.hasOwn(f.lighting.options, 'classificationCoalesceMinMs'), false);
  const result = await f.finish(measureClassificationWindow({ durationMs: 60000 }));
  assert.equal(result.measurementValid, true); assert.equal(result.frameIntervalsMs.length, 500);
  assert.equal(result.calls.getSources.count, 501); assert.equal(result.calls.tick.count, 501);
  assert.ok(result.calls.getSources.raw.every(row => row.withinTick)); assert.deepEqual(result.invalidReasons, []);
  assert.equal(globalThis.window.__phase2ClassificationAudit.active, null);
  assert.equal(f.lighting.getInvalidationDiagnostics().enabled, false);
});

test('无LongTask能力不能将未知写0或开始正式窗口', t => {
  const f = fixture(t); f.FakeObserver.supportedEntryTypes = [];
  assert.throws(() => measureClassificationWindow({ durationMs: 60000 }), /LongTask unavailable/);
  assert.equal(globalThis.window.__phase2ClassificationAudit.active, null);
});

test('失焦/resize/preview/fetch/加载/不足帧与超时均使窗口无效', async t => {
  const variants = [
    ['hidden-or-unfocused', f => f.setFocused(false)], ['drawing-buffer-changed', f => f.setSize([1280, 720])],
    ['not-idle-editor-editing-fetch-state', f => { f.runtime.telemetry.telemetryPreviewActive = true; }],
    ['not-idle-editor-editing-fetch-state', f => { f.runtime.fetch.fetchSyncTimer = 1; }],
    ['new-resource-timing-entry', f => f.resources.push({ name: 'late-resource', startTime: 100, duration: 5 })],
  ];
  for (const [reason, mutate] of variants) await t.test(reason, async child => {
    const f = fixture(child), promise = measureClassificationWindow({ durationMs: 60000 }); mutate(f);
    const result = await f.finish(promise); assert.equal(result.measurementValid, false); assert.ok(result.invalidReasons.includes(reason));
  });
  await t.test('不足帧/时间超限', async child => {
    const f = fixture(child), result = await f.finish(measureClassificationWindow({ durationMs: 60000 }), 11, 64001);
    assert.equal(result.measurementValid, false); assert.ok(result.invalidReasons.includes('fewer-than-300-frame-intervals'));
    assert.ok(result.invalidReasons.includes('elapsed-outside-60-to-63-seconds'));
  });
});

function captureFixture(t) {
  const nullEngine=new NullEngine(), actualScene=new Scene(nullEngine);t.after(()=>{actualScene.dispose();nullEngine.dispose();});
  const empty=new AbstractMesh('native-empty',actualScene), geometry=new Mesh('native-geometry',actualScene);
  geometry.setVerticesData('position',new Float32Array([0,0,0,1,0,0,0,1,0]));geometry.setIndices([0,1,2]);
  const instance=new InstancedMesh('native-instance',geometry);
  const engine={getRenderWidth:()=>2,getRenderHeight:()=>2,getGlInfo:()=>({renderer:'VM fixture; not GPU evidence'}),
    _gl:{RGBA:0x1908,UNSIGNED_BYTE:0x1401,readPixels(_x,_y,_w,_h,_f,_t,pixels){pixels.fill(17);}}};
  const scene={meshes:actualScene.meshes,activeCamera:null,onAfterRenderObservable:actualScene.onAfterRenderObservable,getEngine:()=>engine,getFrameId:()=>actualScene.getFrameId()};
  const window={crypto:webcrypto,btoa:text=>Buffer.from(text,'latin1').toString('base64'),__phase2ClassificationAudit:{active:null,runtime:{scene}}};
  const capture=vm.runInNewContext('('+captureClassificationFunction.toString()+')',{window,performance:nodePerformance,TextEncoder});
  return {empty,geometry,instance,engine,scene,window,capture,actualScene,frame:()=>scene.onAfterRenderObservable.notifyObservers(scene)};
}

test('capture自包含VM使用installed SDK：空AbstractMesh保留矩阵，原生实例读取真实source几何',async t=>{
  const f=captureFixture(t);assert.equal(typeof f.empty.getVerticesDataKinds,'undefined');assert.equal(f.empty.getTotalVertices(),0);
  assert.equal(f.instance.sourceMesh,f.geometry);const pending=f.capture();f.frame();const result=await pending;
  assert.equal(result.rows.length,3);assert.equal(result.actualGeometryMeshes,2);
  const empty=result.rows.find(row=>row.key.includes('native-empty')),source=result.rows.find(row=>row.key.includes('native-geometry')),instance=result.rows.find(row=>row.key.includes('native-instance'));
  assert.equal(empty.vertices,0);assert.equal(empty.worldSha256.length,64);assert.equal(empty.geometry.length,0);
  assert.ok(source.geometry.some(row=>row.kind==='position'&&row.bytes===36));assert.ok(source.geometry.some(row=>row.kind==='indices'));
  assert.equal(JSON.stringify(source.geometry),JSON.stringify(instance.geometry));assert.equal(result.rgbaBytes,16);
});

test('capture onAfterRender异常必须reject原error，不能留下不settle的Promise',async t=>{
  const f=captureFixture(t), marker=new Error('real readPixels boundary exception');f.engine._gl.readPixels=()=>{throw marker;};
  const pending=f.capture();try{f.frame();}catch{/* 旧实现会逃出Observable，Promise仍挂起；回归必须捕获此差异。 */}
  const bounded=Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(new Error('capture promise did not reject')),50))]);
  await assert.rejects(bounded,error=>error===marker);
});

test('capture缺浏览器crypto能力需明确失败，不能写伪造SHA',async t=>{
  const f=captureFixture(t);delete f.window.crypto;
  const pending=f.capture();f.frame();await assert.rejects(pending,/CLASSIFICATION_CAPTURE_BROWSER_API_UNAVAILABLE/);
});

test('capture未知有顶点但没有可读布局必须拒绝，不能optional空数组漏掉几何',async t=>{
  const f=captureFixture(t);f.empty.getTotalVertices=()=>3;
  const pending=f.capture();f.frame();await assert.rejects(pending,/CLASSIFICATION_CAPTURE_UNREADABLE_GEOMETRY/);
});

test('capture原生实例GPU更新清CPU mirror后，严格native wrapper读取权威矩阵全字节和列布局',async t=>{
  const f=captureFixture(t),matrices=new Float32Array(32);matrices[0]=1;matrices[3]=-0;matrices[16]=1;matrices[28]=2.2;
  const wrapper=new BabylonBuffer(f.geometry.getEngine(),matrices,true,16,false,true);
  const storage=f.geometry._instanceDataStorage,pass=storage.useMonoDataStorageRenderPass?storage.dataStorageRenderPass:storage.renderPasses[storage.engine.currentRenderPassId];
  pass.instancesData=matrices;pass.instancesBuffer=wrapper;const vertexBuffers={};
  for(let column=0;column<4;column++)vertexBuffers['world'+column]=wrapper.createVertexBuffer('world'+column,column*4,4);
  f.geometry._userInstancedBuffersStorage={data:{},strides:{},sizes:{},vertexBuffers};wrapper.updateDirectly(matrices,0,2);
  assert.equal(vertexBuffers.world0.getData(),null);assert.equal(f.geometry.getVerticesData('world0'),null);assert.equal(f.geometry.worldMatrixInstancedBuffer,matrices);
  const pending=f.capture();f.frame();const result=await pending,source=result.rows.find(row=>row.key.includes('native-geometry'));
  const expected=createHash('sha256').update(new Uint8Array(matrices.buffer)).digest('hex');
  for(let column=0;column<4;column++){
    const attribute=source.geometry.find(row=>row.kind==='world'+column);assert.equal(attribute.sha256,expected);assert.equal(attribute.bytes,128);
    assert.equal(attribute.layout.byteOffset,column*16);assert.equal(attribute.layout.byteStride,64);assert.equal(attribute.layout.instanced,true);
    assert.match(attribute.dataSource,/worldMatrixInstancedBuffer/);
  }
});

test('capture未知GPU-only自定义/普通geometry属性必须有界错误，不丢kind或伪造空hash',async t=>{
  const f=captureFixture(t),values=new Float32Array(16),wrapper=new BabylonBuffer(f.geometry.getEngine(),values,true,4,false,true);
  const custom=wrapper.createVertexBuffer('custom-instance',0,4);f.geometry._userInstancedBuffersStorage={data:{},strides:{},sizes:{},vertexBuffers:{'custom-instance':custom}};
  wrapper.updateDirectly(values,0,2);assert.equal(custom.getData(),null);
  const pending=f.capture();f.frame();await assert.rejects(pending,error=>/CLASSIFICATION_CAPTURE_BUFFER_UNAVAILABLE/.test(error.message)
    &&/custom-instance/.test(error.message)&&/native-geometry/.test(error.message)&&/byteStride/.test(error.message)&&/cpuMirrorAvailable/.test(error.message));
});

test('capture同Geometry双carrier保留各自真实custom buffer，不复用第一carrier属性',async t=>{
  const f=captureFixture(t),second=new Mesh('second-carrier',f.actualScene);f.geometry.geometry.applyToMesh(second);
  assert.equal(second.geometry,f.geometry.geometry);
  for(const [mesh,value]of[[f.geometry,1],[second,2]]){
    const wrapper=new BabylonBuffer(mesh.getEngine(),new Float32Array([value,0,0,1]),false,4,false,true);
    mesh._userInstancedBuffersStorage={data:{},strides:{},sizes:{},vertexBuffers:{custom:wrapper.createVertexBuffer('custom',0,4)}};
  }
  const pending=f.capture();f.frame();const result=await pending;
  const first=result.rows.find(row=>row.key.includes('native-geometry')).geometry,other=result.rows.find(row=>row.key.includes('second-carrier')).geometry;
  assert.equal(first.find(x=>x.kind==='position').sha256,other.find(x=>x.kind==='position').sha256);
  assert.notEqual(first.find(x=>x.kind==='custom').sha256,other.find(x=>x.kind==='custom').sha256);
});

function gpuReadbackFixture(t,options={}){
  const f=captureFixture(t),bytes=options.bytes??new Uint8Array([...new Uint8Array([0,0,128,63,0,0,0,128,1,0,192,127,4,3,2,1,9,8,7,6,5,4,3,2,1,0,255,254,253,252,251,250]),...Array.from({length:32},(_,i)=>i)]);
  const native={label:'actual-gpu-buffer'},previous={label:'previous-copy-read-binding'},dataBuffer=new WebGLDataBuffer(native);
  dataBuffer.capacity=bytes.length;const vertexBuffers={};
  for(const [kind,offset]of[['gpu-a',0],['gpu-b',4]]){const wrapper=new BabylonBuffer(f.geometry.getEngine(),new Float32Array(16),true,8,false,true),vb=wrapper.createVertexBuffer(kind,offset,4);
    Object.defineProperty(vb,'getBuffer',{value:()=>dataBuffer});Object.defineProperty(vb,'effectiveBuffer',{value:dataBuffer});vertexBuffers[kind]=vb;wrapper.updateDirectly(new Float32Array(16),0,2);}
  assert.equal(vertexBuffers['gpu-a'].getData(),null);assert.notEqual(vertexBuffers['gpu-a'].getWrapperBuffer(),vertexBuffers['gpu-b'].getWrapperBuffer());
  f.geometry._userInstancedBuffersStorage={data:{},strides:{},sizes:{},vertexBuffers};let binding=previous,error=options.preexistingError??0;
  const calls={reads:0,sizes:0,binds:[],allocations:0},nativeBytes=new Map([[native,bytes]]);
  const gl={...f.engine._gl,COPY_READ_BUFFER:0x8f36,COPY_READ_BUFFER_BINDING:0x8f36,BUFFER_SIZE:0x8764,NO_ERROR:0,
    isContextLost:()=>options.contextLost===true,isBuffer:value=>options.invalidBuffer!==true&&nativeBytes.has(value),
    getParameter:name=>{assert.equal(name,0x8f36);return binding;},getError:()=>{const result=error;error=0;return result;},
    bindBuffer(target,value){assert.equal(target,0x8f36);calls.binds.push(value);binding=value;},
    getBufferParameter(target,name){assert.equal(target,0x8f36);assert.equal(name,0x8764);assert.ok(nativeBytes.has(binding));calls.sizes++;return options.byteSize??nativeBytes.get(binding).length;},
    getBufferSubData(target,offset,targetBytes){assert.equal(target,0x8f36);assert.equal(offset,0);assert.ok(nativeBytes.has(binding));calls.reads++;
      if(options.readThrows)throw new Error('original GPU read failure');targetBytes.set(nativeBytes.get(binding));if(options.readError)error=0x0502;}};
  f.engine.webGLVersion=options.webGL1?1:2;f.engine._gl=gl;
  if(options.badLayout)vertexBuffers['gpu-a'].byteStride=3;
  return{...f,bytes,native,previous,calls,nativeBytes,binding:()=>binding};
}

test('GPU-readback缺CPU mirror时读实际native bytes，同GPU buffer只读一次并恢复COPY_READ绑定',async t=>{
  const f=gpuReadbackFixture(t),pending=f.capture();f.frame();const result=await pending;
  const attrs=result.rows.find(row=>row.key.includes('native-geometry')).geometry.filter(row=>row.kind.startsWith('gpu-'));
  assert.equal(attrs.length,2);const expected=createHash('sha256').update(f.bytes).digest('hex');
  for(const row of attrs){assert.equal(row.sha256,expected);assert.equal(row.bytes,f.bytes.length);assert.match(row.dataSource,/getBufferSubData/);}
  assert.equal(f.calls.reads,1);assert.equal(f.calls.sizes,1);assert.equal(f.binding(),f.previous);assert.deepEqual(f.calls.binds,[f.native,f.previous]);
  assert.equal(result.gpuReadbackBuffers,1);assert.equal(result.gpuReadbackBytes,f.bytes.length);assert.equal(result.frameId,result.frameIdEnd);
});

test('GPU-readback拒绝超过128MiB/context lost/非本context buffer/未知layout/WebGL1，不用空hash通过',async t=>{
  for(const [name,options]of[['oversize',{byteSize:128*1024**2+1}],['lost',{contextLost:true}],['wrong buffer',{invalidBuffer:true}],['layout',{badLayout:true}],['webgl1',{webGL1:true}],['preexisting GL error',{preexistingError:0x0502}]]){
    await t.test(name,async child=>{const f=gpuReadbackFixture(child,options),pending=f.capture();f.frame();await assert.rejects(pending,/CLASSIFICATION_CAPTURE_(GPU_READ|BUFFER)_UNAVAILABLE/);assert.equal(f.calls.reads,0);assert.equal(f.binding(),f.previous);});
  }
});

test('GPU-readback原读取异常或GL错误仍恢复绑定，拒绝部分数据',async t=>{
  for(const options of[{readThrows:true},{readError:true}])await t.test(JSON.stringify(options),async child=>{
    const f=gpuReadbackFixture(child,options),pending=f.capture();f.frame();await assert.rejects(pending,/CLASSIFICATION_CAPTURE_GPU_READ_UNAVAILABLE/);
    assert.equal(f.calls.reads,1);assert.equal(f.binding(),f.previous);assert.equal(f.calls.binds.at(-1),f.previous);
  });
});

test('GPU-readback同帧冻结后GPU内容再改变也不污染快照',async t=>{
  const f=gpuReadbackFixture(t),expected=createHash('sha256').update(f.bytes).digest('hex');let mutated=false;
  f.window.crypto={subtle:{digest:async(algorithm,bytes)=>{if(!mutated){mutated=true;f.bytes[0]^=0xff;}return webcrypto.subtle.digest(algorithm,bytes);}}};
  const pending=f.capture();f.frame();const result=await pending,attribute=result.rows.find(row=>row.key.includes('native-geometry')).geometry.find(row=>row.kind==='gpu-a');
  assert.equal(attribute.sha256,expected);assert.notEqual(attribute.sha256,createHash('sha256').update(f.bytes).digest('hex'));assert.equal(f.calls.reads,1);
});

test('GPU-readback同G双carrier不同native buffer分别保存，不按Geometry/layout混用',async t=>{
  const f=gpuReadbackFixture(t),second=new Mesh('gpu-second-carrier',f.actualScene);f.geometry.geometry.applyToMesh(second);
  const native={label:'second-native'},bytes=new Uint8Array(f.bytes).fill(37),dataBuffer=new WebGLDataBuffer(native);dataBuffer.capacity=bytes.length;f.nativeBytes.set(native,bytes);
  const wrapper=new BabylonBuffer(second.getEngine(),new Float32Array(16),true,8,false,true),vb=wrapper.createVertexBuffer('gpu-c',0,4);
  Object.defineProperty(vb,'getBuffer',{value:()=>dataBuffer});Object.defineProperty(vb,'effectiveBuffer',{value:dataBuffer});wrapper.updateDirectly(new Float32Array(16),0,2);
  second._userInstancedBuffersStorage={data:{},strides:{},sizes:{},vertexBuffers:{'gpu-c':vb}};
  const pending=f.capture();f.frame();const result=await pending,first=result.rows.find(row=>row.key.includes('native-geometry')).geometry.find(row=>row.kind==='gpu-a'),other=result.rows.find(row=>row.key.includes('gpu-second-carrier')).geometry.find(row=>row.kind==='gpu-c');
  assert.notEqual(first.sha256,other.sha256);assert.equal(other.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(f.calls.reads,2);assert.equal(result.gpuReadbackBuffers,2);
});

test('capture像素/矩阵/geometry同帧冻结，首个async hash后改live源也不能混进快照',async t=>{
  const f=captureFixture(t),original=new Float32Array(f.geometry.getVerticesData('position')),frameId=f.scene.getFrameId();let mutated=false;
  f.window.crypto={subtle:{digest:async(algorithm,bytes)=>{if(!mutated){mutated=true;f.geometry.getVerticesData('position')[0]=99;f.scene.getFrameId=()=>77;}return webcrypto.subtle.digest(algorithm,bytes);}}};
  const pending=f.capture();f.frame();const result=await pending,position=result.rows.find(row=>row.key.includes('native-geometry')).geometry.find(x=>x.kind==='position');
  assert.equal(position.sha256,createHash('sha256').update(new Uint8Array(original.buffer)).digest('hex'));
  assert.notEqual(position.sha256,createHash('sha256').update(new Uint8Array(f.geometry.getVerticesData('position').buffer)).digest('hex'));
  assert.equal(result.frameId,frameId);assert.equal(result.frameIdEnd,frameId);assert.ok(result.frozenGeometryBytes>0);
});

test('close事前持有PID/CreationDate/ChildProcess，句柄销毁和PID复用不导致晚getter或误终止',async()=>{
  const old={pid:1234,parentPid:1,creationDate:'2026-10-25T00:00:00Z'},replacement={...old,creationDate:'2026-10-25T00:01:00Z'};
  let closed=false,lateGetters=0;const childProcess={exitCode:null};
  const app={process(){lateGetters++;throw new Error('disposed Playwright _object');},async close(){closed=true;childProcess.exitCode=0;}};
  const closure=await closeClassificationOwnedApplication({application:app,childProcess,mainPid:old.pid,observedProcesses:[old]},async()=>closed?[replacement]:[old]);
  assert.equal(closure.status,'OBSERVED_OWNED_PROCESSES_CLOSED');assert.equal(closure.mainExitCode,0);assert.equal(lateGetters,0);
  assert.equal(closure.stillAlive.length,0);assert.equal(closure.pidReplacements.length,1);assert.equal(closure.noForcedTermination,true);
});

test('原error在诊断/截图/cleanup前持久化；所有次错保留且不能改写原栈',async()=>{
  const original=new Error('original functional capture error'),report={name:'A1'},snapshots=[];
  await preserveClassificationFailure(report,original,{save:async()=>snapshots.push(JSON.parse(JSON.stringify(report))),
    readRuntime:async()=>{throw new Error('bounded runtime read failed');},captureScreenshot:async()=>{throw new Error('screenshot failed');}});
  assert.equal(snapshots[0].error,original.stack);assert.equal(snapshots[0].failureRuntimeReadError,undefined);assert.equal(report.error,original.stack);
  assert.match(report.failureRuntimeReadError,/runtime read failed/);assert.match(report.failureScreenshotError,/screenshot failed/);
  const identity={pid:1234,creationDate:'same'};let closed=false;
  const closure=await closeClassificationOwnedApplication({mainPid:1234,childProcess:{exitCode:0},observedProcesses:[identity],application:{async close(){closed=true;throw new Error('secondary close error');}}},async()=>closed?[]:[identity]);
  assert.match(closure.closeError,/secondary close error/);assert.equal(report.error,original.stack);
});

function strictReadyFixture(){
  const expected={sceneId:'scene',modelIds:['model'],instanceIds:['instance'],batchedEntities:2,
    environment:{sourceUrl:'editor-asset://local/owned/env.glb',meshCount:2,vertexCount:6,triangleCount:2,sourceFileBytes:60}};
  const receipt={sceneId:'scene',preparationTimings:{completed:true,settled:true,runtimeStable:true,forcedSettled:false,totalMs:100,phases:{'loading-scene-models':100}},
    preparationState:{sceneSessionId:'session',phase:'completed',completed:true,modelSyncStatus:'skipped',assetRefreshStatus:'settled',modelSyncProgress:null,warnings:[],
      runtime:{generation:'session',stable:true,forcedSettled:false,totalModels:2,settledModels:2,expectedBatchedEntities:2,batchedEntities:2}},
    metrics:{modelRuntimeCount:1,modelArrayInstanceEntityCount:1,modelArrayBatchEntityCount:2,loading:{pendingModelCount:0,active:[],environmentPhase:'ready',failedModelAcquisitions:0,
      stages:{modelInitialize:{activeCount:0,failedCount:0}},cargoPreload:{pendingCount:0,failedCount:0,readyAssetCount:1}}},
    initial:{error:null},modelErrors:[],modelIds:['model'],readyModelIds:['model'],instanceIds:['instance'],resourceIssue:null,hudVisible:false,
    environment:{phase:'ready',sourceUrl:expected.environment.sourceUrl,message:null,statistics:{meshCount:2,vertexCount:6,triangleCount:2,fileSizeBytes:60}},
    actualEnvironment:{meshCount:2,vertexCount:6,triangleCount:2,invalidMeshes:[]},skybox:{phase:'idle',sourceUrl:null}};
  return {receipt,expected};
}

test('strict ready只接受明确自然settled/零失败/完整模型环境，不能用遮罩消失替代',()=>{
  const {receipt,expected}=strictReadyFixture();assert.equal(assertClassificationSceneReady(receipt,expected),true);
});

test('实体天空盒按精确来源ready验收，sceneSettings旧skybox空值不代表没有实体天空盒',()=>{
  const {receipt,expected}=strictReadyFixture();
  expected.skybox={entityId:'sky',sourceUrl:'editor-asset://local/owned/sky.hdr',sourceFileBytes:32,sourceSha256:'a'.repeat(64)};
  receipt.skybox={phase:'ready',sourceUrl:expected.skybox.sourceUrl,message:null};
  assert.equal(assertClassificationSceneReady(receipt,expected),true);
  for(const invalid of [{...receipt.skybox,phase:'loading'},{...receipt.skybox,sourceUrl:'other-revision'},
    {...receipt.skybox,message:'decode failed'},{...receipt.skybox,phase:'error'}]) {
    assert.throws(()=>assertClassificationSceneReady({...receipt,skybox:invalid},expected));
  }
});

test('天空盒计划从真实实体组件冻结源文件，拒绝URL错配/隐藏/越界/多实体',async t=>{
  const project=await fs.mkdtemp(path.join(os.tmpdir(),'classification-skybox-'));
  t.after(()=>fs.rm(project,{recursive:true,force:true}));
  const file=path.join(project,'Assets','Skyboxes','sky.hdr');await fs.mkdir(path.dirname(file),{recursive:true});
  const bytes=Buffer.from('independent file identity fixture');await fs.writeFile(file,bytes);
  const scene={entityIds:['sky'],sceneSettings:{skybox:null},entities:{sky:{id:'sky',visible:true,parentId:null,components:{skybox:{sourcePath:file,sourceUrl:'editor-asset://local/'+encodeURIComponent(file),assetRevision:'asset-revision'}}}}};
  const expected=await inspectClassificationSkybox(scene,project);
  assert.equal(expected.sourceFileBytes,bytes.length);assert.equal(expected.sourceSha256,createHash('sha256').update(bytes).digest('hex'));
  for(const mutate of [value=>{value.entities.sky.components.skybox.sourceUrl='editor-asset://local/wrong';},value=>{value.entities.sky.visible=false;},
    value=>{value.entities.sky.components.skybox.sourcePath=path.join(project,'..','outside.hdr');},
    value=>{value.entityIds.push('second');value.entities.second={...value.entities.sky,id:'second'};}]){
    const invalid=structuredClone(scene);mutate(invalid);await assert.rejects(inspectClassificationSkybox(invalid,project));
  }
});

test('strict ready拒绝模型/stage/cargo失败、forced/partial/缺证据与资源数量漂移',async t=>{
  const variants=[
    ['failed model',r=>{r.metrics.loading.failedModelAcquisitions=1;}],['failed stage',r=>{r.metrics.loading.stages.modelInitialize.failedCount=1;}],
    ['failed cargo',r=>{r.metrics.loading.cargoPreload.failedCount=1;}],['missing stages',r=>{delete r.metrics.loading.stages;}],
    ['forced settled',r=>{r.preparationTimings.forcedSettled=true;}],['not settled',r=>{r.preparationTimings.settled=false;}],
    ['unknown forced flag',r=>{delete r.preparationTimings.forcedSettled;}],['missing preparation timings',r=>{delete r.preparationTimings;}],
    ['partial phase',r=>{r.preparationState.phase='partial';}],['partial history',r=>{r.preparationTimings.phases.partial=1;}],
    ['model IDs disappeared',r=>{r.modelIds=[];}],['environment missing geometry',r=>{r.actualEnvironment.meshCount=1;}],
    ['environment false source',r=>{r.environment.sourceUrl='different-version';}],['batch missing',r=>{r.metrics.modelArrayBatchEntityCount=1;}],
    ['HUD still expanded',r=>{r.hudVisible=true;}],['model readiness error',r=>{r.modelErrors=[{entityId:'model',error:'missing old pin'}];}],
  ];
  for(const [name,mutate]of variants)await t.test(name,()=>{const {receipt,expected}=strictReadyFixture();mutate(receipt);assert.throws(()=>assertClassificationSceneReady(receipt,expected));});
});

test('readiness源资源区分基础model和实例，批次只数有效来源/祖先可见实体',()=>{
  const scene={entityIds:['model','hidden','instance'],entities:{model:{id:'model',components:{modelAsset:{}}},hidden:{id:'hidden',visible:false,components:{}},
    instance:{id:'instance',parentId:'hidden',components:{modelAsset:{},modelArrayInstance:{sourceEntityId:'model'}}}}};
  assert.deepEqual(deriveClassificationReadinessResources(scene),{version:1,modelIds:['model'],instanceIds:['instance'],batchedEntities:1});
});

test('准备状态reader在缺当前useSyncExternalStore证据时拒绝，不能回落到假false',()=>{
  const runtime={};const reader=vm.runInNewContext('('+readClassificationReadyReceipt.toString()+')',{window:{__phase2ClassificationAudit:{runtime}},document:{getElementById:()=>({})}});
  assert.throws(()=>reader({entityIds:[],modelIds:[]}),/CLASSIFICATION_PREPARATION_STATE_UNAVAILABLE/);
});

test('准备reader只取当前selector证据和真实资源集合，不主动分类且正式窗口拒读',()=>{
  const {receipt,expected}=strictReadyFixture();expected.entityIds=['model','instance'];let classificationCalls=0;
  const meshes=['a','b'].map(name=>({name,metadata:{editorEnvironmentMesh:true},isDisposed:()=>false,getTotalVertices:()=>3,getTotalIndices:()=>3}));
  const environmentRuntime={getSnapshot:()=>receipt.environment,current:{renderMeshes:meshes}},runtime={scene:{meshes},document:{shadowDocument:{id:'scene'}},
    assets:{models:new Map([['model',{}]])},arrays:{modelArrayInstanceEntities:new Map([['instance',{}]])},
    environment:{environmentRuntime,lightingRuntime:{options:{getSources(){classificationCalls++;throw new Error('ready不得主动分类');}}}},
    getPerformanceMetrics:()=>receipt.metrics,getInitialLoadSnapshot:()=>receipt.initial,getModelReadinessError:()=>null,isModelReady:()=>true,getSkyboxReadiness:()=>receipt.skybox};
  const hook={memoizedState:{...receipt.preparationState,phase:'partial'},queue:{getSnapshot:()=>receipt.preparationState}};
  const root={__reactContainer$fixture:{stateNode:{current:{memoizedState:hook}}}},window={__phase2ClassificationAudit:{runtime,active:null}};
  const reader=vm.runInNewContext('('+readClassificationReadyReceipt.toString()+')',{window,document:{getElementById:()=>root,querySelector:()=>null}});
  const actual=JSON.parse(JSON.stringify(reader(expected)));actual.preparationTimings=receipt.preparationTimings;
  assert.equal(actual.preparationState.phase,'completed');assert.equal(assertClassificationSceneReady(actual,expected),true);assert.equal(classificationCalls,0);
  window.__phase2ClassificationAudit.active={};assert.throws(()=>reader(expected),/FORBIDDEN_DURING_PERFORMANCE/);
});
