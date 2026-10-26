import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('模块化入口在完整core懒加载前已注册真实WebGL GPU计时观察器', () => {
  const code = `
    import assert from 'node:assert/strict';
    import { Engine } from '@babylonjs/core/Engines/engine.js';
    import { Observable } from '@babylonjs/core/Misc/observable.js';
    import { PerfCounter } from '@babylonjs/core/Misc/perfCounter.js';
    await import(${JSON.stringify(new URL('../../src/runtime/babylon/babylonSideEffects.ts', import.meta.url).href)});
    const counter=new PerfCounter(), token={}; let starts=0,ends=0;
    const engine={onBeginFrameObservable:new Observable(),onEndFrameObservable:new Observable(),
      getGPUFrameTimeCounter:()=>counter,startTimeQuery:()=>{starts++;return token;},
      endTimeQuery:value=>{assert.equal(value,token);ends++;return 1230000;}};
    Engine.prototype.captureGPUFrameTime.call(engine,true);
    assert.equal(engine.onBeginFrameObservable.observers.length,1,'必须注册实际ThinEngine捕获，不能停在AbstractEngine空实现');
    assert.equal(engine.onEndFrameObservable.observers.length,1);
    engine.onBeginFrameObservable.notifyObservers(engine); engine.onEndFrameObservable.notifyObservers(engine);
    assert.equal(starts,1);assert.equal(ends,1);assert.equal(counter.current,1230000);assert.ok(counter.count>0);
    Engine.prototype.captureGPUFrameTime.call(engine,false);
    // Observable的移除按SDK规则延迟，资格标记必须同步取消。
    assert.equal(engine._onBeginFrameObserver,null);assert.equal(engine._onEndFrameObserver,null);
    console.log('PASS');
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS/);
});
