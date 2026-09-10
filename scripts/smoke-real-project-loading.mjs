import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { _electron } from 'playwright';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, project: { type: 'string' }, executable: { type: 'string' },
  cold: { type: 'string', default: '1' }, warm: { type: 'string', default: '1' },
  timeout: { type: 'string', default: '120000' }, output: { type: 'string' },
  profile: { type: 'boolean', default: false },
} });
assert.ok(values.url && values.project, '用法：node scripts/smoke-real-project-loading.mjs --url <中台地址> --project <项目名称> [--cold 3 --warm 10]');
assert.ok(['http:', 'https:'].includes(new URL(values.url).protocol));
const coldCount = Number(values.cold), warmCount = Number(values.warm), timeoutMs = Number(values.timeout);
assert.ok(Number.isInteger(coldCount) && coldCount >= 1 && coldCount <= 10);
assert.ok(Number.isInteger(warmCount) && warmCount >= 0 && warmCount <= 20);
const repo = process.cwd();
const root = await mkdtemp(path.join(tmpdir(), 'twin-real-loading-'));
const output = path.resolve(values.output ?? `output/playwright/real-project-loading-${Date.now()}`);
await mkdir(output, { recursive: true });
const runs = [];
const errors = [];
let app, page;

// 只读运行时快照；不会为取得诊断提前调用 isReady 干预加载。
function runtimeSnapshot() {
  const host = document.getElementById('root');
  const key = Object.keys(host ?? {}).find(key => key.startsWith('__reactContainer$'));
  const first = host?.[key];
  const stack = first ? [first.stateNode?.current ?? first] : [];
  const seen = new Set(), runtimes = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    const current = value.current ?? value;
    if (current.scene?.meshes && typeof current.getPerformanceMetrics === 'function') runtimes.add(current);
  };
  while (stack.length && seen.size < 30000) {
    const fiber = stack.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    visit(fiber.memoizedProps); for (const value of Object.values(fiber.memoizedProps ?? {})) visit(value);
    let hook = fiber.memoizedState;
    for (let n = 0; hook && n < 500; n++, hook = hook.next) visit(hook.memoizedState);
    stack.push(fiber.child, fiber.sibling);
  }
  return [...runtimes].filter(r => !r.scene.isDisposed).map(runtime => {
    const scene = runtime.scene;
    const active = scene.getActiveMeshes();
    return { loading: runtime.getPerformanceMetrics().loading,
      meshes: scene.meshes.length, activeMeshes: active.length,
      environmentMeshes: scene.meshes.filter(m => m.metadata?.editorEnvironmentMesh && m.isEnabled() && m.getTotalVertices() > 0).length,
      activeEnvironmentMeshes: Array.from({length:active.length}, (_, i) => active.data[i]).filter(m => m.metadata?.editorEnvironmentMesh).length,
      pending: scene.getWaitingItemsCount(), frame: scene.getFrameId(), fps: scene.getEngine().getFps(),
      skybox: runtime.getSkyboxReadiness(),
    };
  });
}

async function openAndMeasure(kind, index) {
  const button = page.locator('.home-data-platform-card').filter({ hasText: values.project })
    .getByRole('button', { name: '打开', exact: true });
  await button.waitFor({ state: 'visible', timeout: 30000 });
  let profiler;
  if (values.profile) {
    profiler = await page.context().newCDPSession(page);
    await profiler.send('Profiler.enable');
    await profiler.send('Profiler.start');
    await app.evaluate(async () => {
      const { Session } = process.getBuiltinModule('inspector');
      globalThis.__loadProfiler = new Session();
      globalThis.__loadProfiler.connect();
      await new Promise((resolve,reject) => globalThis.__loadProfiler.post('Profiler.enable', error => error ? reject(error) : resolve()));
      await new Promise((resolve,reject) => globalThis.__loadProfiler.post('Profiler.start', error => error ? reject(error) : resolve()));
    });
  }
  if (values.profile) await page.evaluate(() => {
    window.__assetTiming = [];
    if (window.__assetTimingInstalled) return;
    window.__assetTimingInstalled = true;
    const records = new WeakMap();
    const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      records.set(this, {kind:'xhr', url:String(url).slice(0,350)});
      return open.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      const row = records.get(this); if (row) {
        row.started = performance.now();
        this.addEventListener('progress', event => { row.lastByteMs=performance.now()-row.started; row.bytes=event.loaded; });
        this.addEventListener('loadend', () => { row.ms=performance.now()-row.started; row.status=this.status; window.__assetTiming.push(row); });
      }
      return send.apply(this,args);
    };
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
    Object.defineProperty(HTMLImageElement.prototype,'src',{...descriptor,set(value) {
      const started=performance.now();
      this.addEventListener('load',()=>window.__assetTiming.push({kind:'image',url:String(value).slice(0,120),ms:performance.now()-started,width:this.naturalWidth,height:this.naturalHeight}),{once:true});
      descriptor.set.call(this,value);
    }});
    const bitmap = window.createImageBitmap;
    if (bitmap) window.createImageBitmap = function(...args) {
      const started=performance.now(), result=bitmap.apply(this,args);
      result.then(value=>window.__assetTiming.push({kind:'bitmap',ms:performance.now()-started,width:value.width,height:value.height}),()=>{});
      return result;
    };
  });
  await page.evaluate(() => {
    window.__loadAuditObserver?.disconnect();
    window.__loadAudit = { startedAt: performance.now(), seen: false, completedMs: null, transitions: [] };
    const sample = () => {
      const phase = document.querySelector('[data-scene-preparation-phase]')?.getAttribute('data-scene-preparation-phase') ?? null;
      const state = window.__loadAudit;
      if (phase) state.seen = true;
      if (state.transitions.at(-1)?.phase !== phase) state.transitions.push({phase, at:performance.now()-state.startedAt});
      if (!phase && state.seen && state.completedMs === null) state.completedMs = performance.now()-state.startedAt;
    };
    window.__loadAuditObserver = new MutationObserver(sample);
    window.__loadAuditObserver.observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  await button.click();
  const deadline = Date.now() + timeoutMs;
  let trace, status;
  while (Date.now() < deadline) {
    status = await page.evaluate(() => ({ trace:window.__loadAudit,
      error:document.querySelector('.home-status-error')?.textContent,
      label:document.querySelector('[data-scene-preparation-phase]')?.textContent?.slice(-550),
      issue:document.querySelector('aside[aria-label="场景资源状态"]')?.textContent }));
    trace = status.trace;
    if (status.error || status.issue || status.label?.includes('场景资源加载失败')) throw new Error(status.error || status.issue || status.label);
    if (trace.completedMs !== null) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(Number.isFinite(trace?.completedMs), `场景超过 ${timeoutMs}ms 未完成：${status?.label}`);
  if (profiler) {
    const cpu = await profiler.send('Profiler.stop');
    const mainCpu = await app.evaluate(async () => {
      const result = await new Promise((resolve,reject) => globalThis.__loadProfiler.post('Profiler.stop', (error,result) => error ? reject(error) : resolve(result)));
      globalThis.__loadProfiler.disconnect();
      delete globalThis.__loadProfiler;
      return result;
    });
    await writeFile(path.join(output, `${kind}-${index}-renderer.cpuprofile`),JSON.stringify(cpu.profile));
    await writeFile(path.join(output, `${kind}-${index}-main.cpuprofile`),JSON.stringify(mainCpu.profile));
    await profiler.detach();
  }
  const runtime = (await page.evaluate(runtimeSnapshot))[0];
  const resources = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter(entry => /\.glb(?:\?|$)|\.exr(?:\?|$)/i.test(entry.name))
    .map(entry => ({ name:entry.name.split('?')[0], duration:entry.duration, initiatorType:entry.initiatorType,
      responseStart:entry.responseStart, responseEnd:entry.responseEnd, decodedBodySize:entry.decodedBodySize }))
    .sort((a,b)=>b.duration-a.duration).slice(0,30));
  assert.ok(runtime, '完成后应存在场景运行时');
  assert.equal(runtime.pending, 0, '完成后不应残留引擎等待项');
  assert.ok(['idle', 'ready'].includes(runtime.skybox.phase), '当前天空盒应真实就绪');
  assert.ok(['idle', 'ready'].includes(runtime.loading.environmentPhase));
  assert.equal(runtime.loading.pendingModelCount, 0);
  assert.equal(runtime.loading.failedModelAcquisitions, 0);
  assert.ok(runtime.activeMeshes > 0, '必须存在实际渲染网格');
  if (runtime.loading.environmentPhase === 'ready') assert.ok(runtime.activeEnvironmentMeshes > 0, '环境必须实际进入渲染帧');
  assert.ok((runtime.loading.stages.environmentReadDecode?.count ?? 0) <= 1, '同一轮打开不应重复解码环境');
  await page.screenshot({ path:path.join(output, `${kind}-${index}.png`) });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const later = (await page.evaluate(runtimeSnapshot))[0];
  assert.ok(later.frame > runtime.frame, '完成后应继续渲染');
  assert.ok(['idle', 'ready'].includes(later.skybox.phase), '共享缓存重关联不得再次加载相同天空盒');
  const assetTiming = values.profile ? await page.evaluate(()=>window.__assetTiming) : undefined;
  const result = { kind, index, completedMs:trace.completedMs, trace, runtime, later, resources, assetTiming };
  runs.push(result);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({project:values.project,root,runs,errors},null,2));
  console.log(JSON.stringify({kind,index,completedMs:Math.round(trace.completedMs), pending:runtime.pending,
    parses:runtime.loading.stages.assetReadDecode?.count,environmentParses:runtime.loading.stages.environmentReadDecode?.count,
    skybox:runtime.loading.skyboxTiming,fps:later.fps}));
}

try {
  for (let cold = 0; cold < coldCount; cold++) {
    const profile = path.join(root, `cold-${cold}`);
    const userData = path.join(profile, 'user-data');
    await mkdir(userData, { recursive: true });
    await writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({version:2,baseUrl:values.url,workspaceRoot:path.join(profile,'workspace')}));
    app = await _electron.launch({ executablePath: values.executable ? path.resolve(values.executable) : path.join(repo,'node_modules/electron/dist/electron.exe'),
      args:[...(values.executable?[]:[repo]), `--user-data-dir=${userData}`], cwd:repo,
      env:{...process.env,OPEN_DEVTOOLS:'false'} });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.stack || String(error)));
    page.on('dialog', dialog => dialog.accept()); // 仅本测试新建工作区，无用户编辑。
    await openAndMeasure('cold',cold+1);
    if (cold === 0) {
      for (let warm = 0; warm < warmCount; warm++) {
        await page.locator('.toolbar-home-button').click();
        await page.locator('.home-page').waitFor({state:'visible'});
        await openAndMeasure('warm',warm+1);
      }
    }
    await app.close(); app = null; page = null;
  }
  assert.equal(errors.length, 0, '不应出现未捕获的页面异常');
} catch(error) {
  errors.push(error.stack || String(error));
  if (page) await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  const percentile = (list, p) => list.length ? [...list].sort((a,b)=>a-b)[Math.ceil(list.length*p)-1] : null;
  const summary = Object.fromEntries(['cold','warm'].map(kind => {
    const durations = runs.filter(r=>r.kind===kind).map(r=>r.completedMs);
    return [kind,{count:durations.length,p50:percentile(durations,.5),p95:percentile(durations,.95)}];
  }));
  await writeFile(path.join(output,'result.json'),JSON.stringify({passed:!process.exitCode,project:values.project,root,summary,runs,errors},null,2));
  console.log(JSON.stringify({passed:!process.exitCode,output,summary,errors}));
}
