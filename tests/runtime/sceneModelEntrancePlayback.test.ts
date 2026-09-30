import assert from 'node:assert/strict';
import test from 'node:test';
import { SceneModelEntrancePlayback } from '../../src/shared/opening/SceneModelEntrancePlayback.ts';

test('入场准备先隐藏模型，等待可见帧后只开始一次，取消不会复活', async t => {
  const previous = { document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame, getComputedStyle: globalThis.getComputedStyle };
  const document = Object.assign(new EventTarget(), { hidden: false });
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  Object.assign(globalThis, { document, requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++next,callback);return next; },
    cancelAnimationFrame: (id: number) => frames.delete(id), getComputedStyle: () => ({ visibility:'visible', display:'block' }) });
  t.after(() => Object.assign(globalThis, previous));
  const calls: string[] = [];
  const runtime = { prepareModelEntrance: () => calls.push('prepare'), startModelEntrance: () => calls.push('start'),
    cancelModelEntrance: () => calls.push('cancel'), setModelEntranceVisible: (visible: boolean) => calls.push('visible:'+visible) };
  const container = { getBoundingClientRect: () => ({ width:100,height:100 }) } as HTMLElement;
  const playback = new SceneModelEntrancePlayback({ runtime, settings:{enabled:true} as never, container });
  assert.deepEqual(calls, ['prepare','visible:true']);
  playback.start(); playback.start();
  assert.equal(calls.includes('start'), false);
  for(const [id,frame] of [...frames]) { frames.delete(id); frame(0); }
  assert.equal(calls.includes('start'), false);
  for(const [id,frame] of [...frames]) { frames.delete(id); frame(16); }
  assert.equal(calls.filter(call => call==='start').length, 1);
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls.at(-1), 'visible:false');
  playback.dispose(); playback.dispose();
  assert.equal(calls.filter(call => call==='cancel').length, 1);
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); playback.start();
  assert.equal(calls.filter(call => call==='start').length, 1);
});

test('宿主隐藏不消耗首播，恢复可见后等待两帧；准备失败可见地降级并恢复', t => {
  const previous = { document:globalThis.document, requestAnimationFrame:globalThis.requestAnimationFrame,
    cancelAnimationFrame:globalThis.cancelAnimationFrame, getComputedStyle:globalThis.getComputedStyle };
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  Object.assign(globalThis, { document:Object.assign(new EventTarget(),{hidden:false}),
    requestAnimationFrame:(callback:FrameRequestCallback)=>{frames.set(++next,callback);return next;},
    cancelAnimationFrame:(id:number)=>frames.delete(id), getComputedStyle:()=>({visibility:'visible',display:'block'}) });
  t.after(()=>Object.assign(globalThis,previous));
  let hostVisible=false, startCount=0, cancelled=0, hostListener=()=>{}, unsubscribed=0;
  const options={settings:{enabled:true} as never, container:{getBoundingClientRect:()=>({width:100,height:100})} as HTMLElement,
    runtime:{prepareModelEntrance:()=>{},startModelEntrance:()=>{startCount++;},cancelModelEntrance:()=>{cancelled++;},setModelEntranceVisible:()=>{}},
    isHostVisible:()=>hostVisible, subscribeToHostVisibility:(listener:()=>void)=>{hostListener=listener;return()=>{unsubscribed++;};}};
  const playback=new SceneModelEntrancePlayback(options); playback.start();
  assert.equal(frames.size,0);assert.equal(startCount,0);
  hostVisible=true;hostListener();
  for(const [id,frame]of [...frames]){frames.delete(id);frame(0);}
  playback.dispose();
  for(const [id,frame]of [...frames]){frames.delete(id);frame(16);}
  assert.equal(startCount,0);assert.equal(cancelled,1);assert.equal(unsubscribed,1);
  const errors:unknown[]=[];
  new SceneModelEntrancePlayback({...options,runtime:{...options.runtime,prepareModelEntrance:()=>{throw new Error('material unavailable');}},onError:error=>errors.push(error)});
  assert.equal(errors.length,1);assert.match(String(errors[0]),/material unavailable/);assert.equal(cancelled,2);
});
