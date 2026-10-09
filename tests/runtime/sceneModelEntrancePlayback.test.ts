import assert from 'node:assert/strict';
import test from 'node:test';
import { SceneModelEntrancePlayback } from '../../src/shared/opening/SceneModelEntrancePlayback.ts';
import { PlayerInitialLoadGate } from '../../src/player/playerInitialLoadState.ts';

function preparationHarness(t: { after: (callback: () => void) => void }) {
  const previous = { document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame, getComputedStyle: globalThis.getComputedStyle };
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  Object.assign(globalThis, { document: Object.assign(new EventTarget(), { hidden: false }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => frames.delete(id), getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) });
  t.after(() => Object.assign(globalThis, previous));
  return { frames, container: { getBoundingClientRect: () => ({ width: 100, height: 100 }) } as HTMLElement,
    frame: () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); } } };
}

test('分批准备未完成时不安排首播或撤去首帧遮罩，完成后仍等实际渲染和两帧', async t => {
  const h = preparationHarness(t); let finishPreparation!: () => void, finishRender!: () => void;
  let started = 0, completed = 0, renderWaits = 0;
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
  const rendering = new Promise<void>(resolve => { finishRender = resolve; });
  const playback = new SceneModelEntrancePlayback({ container: h.container, settings: { enabled: true } as never,
    runtime: { prepareModelEntrance: () => preparation, startModelEntrance: () => { started++; },
      cancelModelEntrance: () => {}, setModelEntranceVisible: () => {} } });
  playback.start(); h.frame(); h.frame(); assert.equal(started, 0);
  const gate = new PlayerInitialLoadGate(() => { completed++; }, { schedule: callback => { callback(); return 0; },
    verifyReady: async () => { await playback.ready; renderWaits++; await rendering; } });
  gate.startTracking(); await Promise.resolve(); assert.equal(renderWaits, 0); assert.equal(completed, 0);
  finishPreparation(); await playback.ready; await Promise.resolve();
  assert.equal(renderWaits, 1); assert.equal(completed, 0);
  h.frame(); assert.equal(started, 0); h.frame(); assert.equal(started, 1);
  finishRender(); await rendering; await Promise.resolve(); assert.equal(completed, 1);
  playback.dispose(); gate.dispose();
});

test('异步准备失败恢复普通模型，ready可结算且不会留下未处理拒绝', async t => {
  const h = preparationHarness(t); const errors: unknown[] = []; let cancelled = 0, started = 0;
  const playback = new SceneModelEntrancePlayback({ container: h.container, settings: { enabled: true } as never,
    runtime: { prepareModelEntrance: async () => { throw new Error('async clone failed'); }, startModelEntrance: () => { started++; },
      cancelModelEntrance: () => { cancelled++; }, setModelEntranceVisible: () => {} }, onError: error => errors.push(error) });
  playback.start(); await playback.ready; h.frame(); h.frame();
  assert.equal(cancelled, 1); assert.equal(started, 0); assert.equal(errors.length, 1); assert.match(String(errors[0]), /async clone failed/);
});

test('准备中销毁会中止信号，迟到的准备完成不能播放或重新安装监听', async t => {
  const h = preparationHarness(t); let finish!: () => void; let signal: AbortSignal | undefined, started = 0, cancelled = 0;
  const playback = new SceneModelEntrancePlayback({ container: h.container, settings: { enabled: true } as never,
    runtime: { prepareModelEntrance: (_settings, currentSignal) => { signal = currentSignal; return new Promise<void>(resolve => { finish = resolve; }); },
      startModelEntrance: () => { started++; }, cancelModelEntrance: () => { cancelled++; }, setModelEntranceVisible: () => {} } });
  playback.start(); playback.dispose(); assert.equal(signal?.aborted, true);
  finish(); await playback.ready; h.frame(); h.frame(); playback.start();
  assert.equal(started, 0); assert.equal(cancelled, 1); assert.equal(h.frames.size, 0);
});

test('加载单元改变取消首帧验证后，旧Playback标记失效并允许新一轮完整准备', async t => {
  const h = preparationHarness(t); const verification = new AbortController(); let finish!: () => void;
  let prepared = 0, started = 0;
  const runtime = { prepareModelEntrance: () => { prepared++; return new Promise<void>(resolve => { finish = resolve; }); },
    startModelEntrance: () => { started++; }, cancelModelEntrance: () => {}, setModelEntranceVisible: () => {} };
  const options = { container: h.container, settings: { enabled: true } as never, runtime };
  let current = new SceneModelEntrancePlayback({ ...options, signal: verification.signal });
  verification.abort(); assert.equal(current.isDisposed, true); finish(); await current.ready;
  current = new SceneModelEntrancePlayback(options); finish(); await current.ready; current.start(); h.frame(); h.frame();
  assert.equal(prepared, 2); assert.equal(started, 1); assert.equal(current.isDisposed, false); current.dispose();
});

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
  await playback.ready;
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

test('宿主隐藏不消耗首播，恢复可见后等待两帧；准备失败可见地降级并恢复', async t => {
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
  await playback.ready;
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
