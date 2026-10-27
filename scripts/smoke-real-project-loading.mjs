import assert from 'node:assert/strict';
/* global document, window, XMLHttpRequest, HTMLImageElement, MutationObserver */
import { mkdir, mkdtemp, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright';
import { assertSceneOpenReady } from './lib/sceneOpenAcceptance.mjs';
import { createFreshSceneOpenOutput, createSceneOpenPairedSchedule, sceneOpenSha256, stableSceneOpenJson, freezeSceneOpenInput,
  compareSceneOpenInputs, hashSceneOpenReferencedFiles, readSceneOpenLogicalInput, summarizeSceneOpenMemory,
  collectSceneOpenLocationPointers, collectSceneOpenLocationRules, validateSceneOpenResolvedBaseline } from './lib/sceneOpenPairedPlan.mjs';
import { normalizeSceneOpenBase, isStringId, matchSceneOpenExclusion } from './lib/sceneOpenReadOnlyGuard.mjs';
import { deriveSceneOpenLogicalImageSlots, captureSceneOpenLogicalImages } from './lib/sceneOpenLogicalImages.mjs';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, project: { type: 'string' }, executable: { type: 'string' },
  cold: { type: 'string', default: '1' }, warm: { type: 'string', default: '1' },
  timeout: { type: 'string', default: '120000' }, output: { type: 'string' },
  profile: { type: 'boolean', default: false },
  paired: { type: 'boolean', default: false }, 'prepare-read-only-manifest': { type: 'boolean', default: false },
  'verification-only': { type: 'boolean', default: false },
  'project-id': { type: 'string' }, 'freeze-scene': { type: 'string' }, 'read-only-manifest': { type: 'string' }, 'budget-file': { type: 'string' },
  'resolved-baseline': { type: 'string' },
} });
const p0Mode = values.paired || values['prepare-read-only-manifest'];
assert.ok(!(values.paired && values['prepare-read-only-manifest']), '前置与正式paired必须分开');
if (p0Mode) {
  assert.ok(values.url && isStringId(values['project-id']) && values['freeze-scene'] && values.output, 'P0需要--url/--project-id(字符串)/--freeze-scene/--output');
  assert.equal(values.profile, false, '正式P0与元数据前置禁用profile hooks');
  assert.ok(!values.executable, 'P0 native守卫仅支持本仓库bundled Electron bootstrap；packaged生命周期尚未验证');
} else assert.ok(values.url && values.project, '用法：node scripts/smoke-real-project-loading.mjs --url <中台地址> --project <项目名称> [--cold 3 --warm 10]');
assert.ok(['http:', 'https:'].includes(new URL(values.url).protocol));
const coldCount = Number(values.cold), warmCount = Number(values.warm), timeoutMs = Number(values.timeout);
assert.ok(Number.isInteger(coldCount) && coldCount >= 1 && coldCount <= 10);
assert.ok(Number.isInteger(warmCount) && warmCount >= 0 && warmCount <= 20);
const repo = process.cwd();
const root = p0Mode ? null : await mkdtemp(path.join(tmpdir(), 'twin-real-loading-'));
const output = path.resolve(values.output ?? `output/playwright/real-project-loading-${Date.now()}`);
if (!p0Mode) await mkdir(output, { recursive: true });
const runs = [];
const errors = [];
let app, page;
let p0OutputOwned = false;

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

/** 旧模式保留before-click计时；新paired只从真实Home click开始，同一个DOM observer。 */
function installSceneOpenDomAudit({ actualClick = false } = {}) {
  window.__loadAuditObserver?.disconnect();
  if (window.__loadAuditClickListener) document.removeEventListener('click', window.__loadAuditClickListener, true);
  window.__loadAudit = { startedAt: actualClick ? null : performance.now(), seen: false, completedMs: null, readySinceMs: null, transitions: [] };
  const sample = () => {
    const state = window.__loadAudit; if (state.startedAt === null) return;
    const phase = document.querySelector('[data-scene-preparation-phase]')?.getAttribute('data-scene-preparation-phase') ?? null;
    const library = actualClick ? document.querySelector('button.library-import-button[title^="同步中台全部普通、组合和环境模型"]') : null;
    const libraryBusy = actualClick && (!library || library.disabled);
    if (phase) state.seen = true;
    if (state.transitions.at(-1)?.phase !== phase || state.transitions.at(-1)?.libraryBusy !== libraryBusy) {
      state.transitions.push({ phase, libraryBusy, at: performance.now() - state.startedAt });
    }
    // 首帧后的自动全库事务也是这次打开的一部分；再次进入准备状态必须撤销瞬时 ready。
    if (phase || libraryBusy) { state.readySinceMs = null; state.completedMs = null; }
    else if (state.seen) {
      state.readySinceMs ??= performance.now();
      if (state.completedMs === null && (!actualClick || performance.now() - state.readySinceMs >= 1000)) {
        state.completedMs = performance.now() - state.startedAt;
      }
    }
  };
  if (actualClick) {
    window.__loadAuditClickListener = event => {
      const button = event.target?.closest?.('.home-data-platform-card button');
      if (!button || button.textContent.trim() !== '打开') return;
      window.__loadAudit.startedAt = performance.now();
      document.removeEventListener('click', window.__loadAuditClickListener, true); window.__loadAuditClickListener = null;
    };
    document.addEventListener('click', window.__loadAuditClickListener, true);
  }
  window.__loadAuditObserver = new MutationObserver(sample);
  window.__sampleLoadAudit = sample;
  window.__loadAuditObserver.observe(document.body, { subtree: true, childList: true, attributes: true });
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
  await page.evaluate(installSceneOpenDomAudit);
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

if (p0Mode) {
  try { await runSceneOpenP0(); }
  catch (error) {
    process.exitCode = 1;
    if (p0OutputOwned) await writeFile(path.join(output, 'p0-preflight-failure.json'), JSON.stringify({ status: 'FAIL_BEFORE_COHORT', error: error.stack ?? String(error) }, null, 2), { flag: 'wx' });
    console.error(error.stack ?? String(error));
  }
} else try {
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

async function p0BuildFingerprint() {
  const files = [];
  for (const directory of ['dist', 'dist-electron']) {
    const pending = [path.join(repo, directory)];
    while (pending.length) {
      const folder = pending.pop();
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false, '构建目录含链接'); const file = path.join(folder, entry.name);
        if (entry.isDirectory()) { if(entry.name!=='__pycache__')pending.push(file); }
        else if(entry.isFile())files.push(file);
        else throw new Error('构建目录包含非普通文件');
      }
    }
  }
  files.push(path.join(repo, 'package.json'), path.join(repo, 'package-lock.json'), fileURLToPath(import.meta.url),
    path.join(repo, 'scripts/lib/sceneOpenPairedPlan.mjs'), path.join(repo, 'scripts/lib/sceneOpenReadOnlyGuard.mjs'), path.join(repo, 'scripts/lib/sceneOpenManifestPrepare.mjs'));
  files.push(path.join(repo,'scripts/lib/sceneOpenLogicalImages.mjs'));
  return Promise.all(files.sort().map(async file => ({ file: path.relative(repo, file), sha256: sceneOpenSha256(await readFile(file)) })));
}

function p0Bootstrap({ userData, workspace, artifact, manifest, prepare, source }) {
  const url = file => pathToFileURL(path.join(repo, file)).href;
  return `import { app, net, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installSceneOpenNetGuard } from ${JSON.stringify(url('scripts/lib/sceneOpenReadOnlyGuard.mjs'))};
import { collectSceneOpenLocationPointers, collectSceneOpenLocationRules, collectSceneOpenAuthorizedExclusions } from ${JSON.stringify(url('scripts/lib/sceneOpenPairedPlan.mjs'))};
import { prepareSceneOpenReadOnlyManifest, requestSceneOpenQueryJson } from ${JSON.stringify(url('scripts/lib/sceneOpenManifestPrepare.mjs'))};
app.setPath('userData', ${JSON.stringify(userData)});
app.commandLine.appendSwitch('enable-precise-memory-info');
app.getAppPath = () => ${JSON.stringify(repo)};
const owned = ${JSON.stringify(workspace)}, artifact = ${JSON.stringify(artifact)};
const host = globalThis.__e3P0 = { ready: false, error: null, processId:process.pid, createdWindowCount:0, preparationQueries: [], memorySamples: [], activeTrial: null };
app.on('browser-window-created',()=>{host.createdWindowCount++;});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = file => { const relative = path.relative(owned, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
// prepare的net查询等ready；formal须先装守卫并在ready前导入产品注册协议，不能共用ready回调。
// formal顶层只等待入口导入，绝不await app.whenReady()，避免ESM阻断ready事件。
async function runBootstrap() {
  try {
    if (${Boolean(prepare)}) {
      const sourceFile = ${JSON.stringify(source)}, sourceBytes = await fs.readFile(sourceFile), input = JSON.parse(sourceBytes.toString('utf8'));
      const traversal = await import(${JSON.stringify(url('dist-electron/shared/sceneResourceTraversal.js'))});
      const planner = await import(${JSON.stringify(url('dist-electron/shared/sceneModelUpdatePlan.js'))});
      const environmentRefs = await import(${JSON.stringify(url('dist-electron/shared/sceneEnvironmentReferences.js'))});
      const sourceKey = hash(Buffer.from(${JSON.stringify(normalizeSceneOpenBase(values.url))}));
      const issues = [], modelPlan = planner.planSceneModelUpdates(input.scene, sourceKey, { allowSourceRebind: true,
        resolveAgainstCurrentSource: false, requireSourceIdentity: false, onIssue: issue => issues.push(issue) });
      if (issues.length) throw new Error('E3_INPUT_RESOURCE_PLAN_ISSUES:'+JSON.stringify(issues));
      const query = async (endpoint, body) => {
        const row = { method:'POST', endpoint, body, startedAtMs: performance.now() }; host.preparationQueries.push(row);
        try { const payload = await requestSceneOpenQueryJson(net, ${JSON.stringify(values.url)}, ${JSON.stringify(values['project-id'])}, endpoint, body);
          const responseText=JSON.stringify(payload); row.responseSha256 = hash(Buffer.from(responseText));
          row.responseArtifact='preparation-response-'+host.preparationQueries.length+'.json';
          await fs.writeFile(path.join(artifact,row.responseArtifact),responseText,{flag:'wx'}); row.completed = true; return payload;
        } catch (error) { row.error = String(error); throw error; }
        finally { row.endedAtMs = performance.now(); await fs.writeFile(path.join(artifact,'preparation-queries.json'), JSON.stringify(host.preparationQueries,null,2)); }
      };
      host.manifest = await prepareSceneOpenReadOnlyManifest({ baseUrl: ${JSON.stringify(values.url)}, projectId: ${JSON.stringify(values['project-id'])},
        inputSceneSha256: hash(sourceBytes), inputModelResources: modelPlan.map(item => ({kind:item.kind,resourceId:item.resourceId})),
        requiredEnvironmentIds: environmentRefs.getRequiredEnvironmentResourceIds(input.scene), query,
        locationPointers: collectSceneOpenLocationPointers(input,traversal),
        locationRules: collectSceneOpenLocationRules(input,traversal),
        originalRoots: [{ tag:'project',path:path.dirname(path.dirname(sourceFile)) }, { tag:'workspace',path:${JSON.stringify(repo)} }],
        exclusions: collectSceneOpenAuthorizedExclusions(input) });
      if(host.createdWindowCount!==0 || BrowserWindow.getAllWindows().length!==0) throw new Error('E3_PREPARATION_UNEXPECTED_BROWSER_WINDOW');
      host.manifest.browserWindowCreatedCount=host.createdWindowCount;
      await fs.writeFile(path.join(artifact,'read-only-manifest.json'),JSON.stringify(host.manifest,null,2)+String.fromCharCode(10),{flag:'wx'});
    } else {
      host.guard = installSceneOpenNetGuard(net, ${JSON.stringify(manifest ?? {})});
      host.readSource = async () => {
        const bindings = await import(${JSON.stringify(url('dist-electron/ipc/dataPlatformBindingStore.js'))});
        const current = bindings.getCurrentDataPlatformBinding();
        if (!current || current.metadata.projectId !== ${JSON.stringify(values['project-id'])} || !inside(current.projectRoot) || !current.metadata.entryScenePath) throw new Error('E3_CURRENT_SOURCE_BINDING_MISSING');
        const file = path.resolve(current.projectRoot,current.metadata.entryScenePath); if (!inside(file)) throw new Error('E3_SOURCE_OUTSIDE_OWNED');
        return { file, projectRoot:current.projectRoot, workspaceRoot:owned, binding:current.metadata, text:await fs.readFile(file,'utf8') };
      };
      host.sampleMemory = () => {
        const metrics = app.getAppMetrics(), self = metrics.find(row=>row.pid===process.pid);
        const ratio = self?.memory?.workingSetSize * 1024 / process.memoryUsage().rss;
        const unitVerified = Number.isFinite(ratio) && ratio>=.5 && ratio<=2;
        return { atMs:performance.now(), unit:'Electron memory-info KiB converted to bytes only after main RSS ratio check',unitVerified,ratio,
          processes:metrics.map(row=>({pid:row.pid,creationTime:row.creationTime,type:row.type,
            workingSetBytes:unitVerified?row.memory.workingSetSize*1024:null,
            peakWorkingSetBytes:unitVerified?row.memory.peakWorkingSetSize*1024:null,memoryRaw:row.memory})) };
      };
      host.startTrial = name => { host.activeTrial=name; host.memorySamples=[]; host.guard.setTrial(name); host.memorySamples.push(host.sampleMemory()); };
      host.stopTrial = () => { host.memorySamples.push(host.sampleMemory()); host.activeTrial=null; host.guard.setTrial('post-ready'); return host.memorySamples; };
      host.timer = setInterval(()=>{if(host.activeTrial)host.memorySamples.push(host.sampleMemory());},500);
      app.on('before-quit',()=>clearInterval(host.timer));
      await import(${JSON.stringify(url('dist-electron/main.js'))});
    }
  } catch (error) { host.error=String(error.stack??error); await fs.writeFile(path.join(artifact,'native-failure.json'),JSON.stringify({status:'FAIL',error:host.error,processId:host.processId,browserWindowCreatedCount:host.createdWindowCount,queries:host.preparationQueries},null,2)); }
  if (${Boolean(prepare)} || host.error) host.ready=true;
  else app.whenReady().then(()=>{host.ready=true;});
}
if (${Boolean(prepare)}) app.whenReady().then(runBootstrap);
else await runBootstrap();
`;
}

async function p0Launch({ directory, manifest, prepare = false, source }) {
  const userData = path.join(directory, 'user-data'), workspace = path.join(directory, 'workspace');
  await mkdir(userData); await mkdir(workspace);
  await writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({ version: 2, baseUrl: normalizeSceneOpenBase(values.url), workspaceRoot: workspace }));
  await writeFile(path.join(userData, 'recent-workspaces.json'), JSON.stringify({ version: 1, projects: [], scenes: [] }));
  const bootstrap = path.join(directory, 'bootstrap.mjs');
  await writeFile(bootstrap, p0Bootstrap({ userData, workspace, artifact: directory, manifest, prepare, source }), { flag: 'wx' });
  const env = { ...process.env, OPEN_DEVTOOLS: 'false' };
  // 正式文件入口必须移除开发地址；空字符串仍会进入天空资源的页面来源校验并产生 Invalid URL。
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE; delete env.ZENDING_EDITOR_STORAGE_ROOT; delete env.ZENDING_ALLOW_STORAGE_ROOT_OVERRIDE;
  let owned;
  try {
    const application = await _electron.launch({ args: [bootstrap, '--user-data-dir=' + userData], cwd: repo, env, timeout: 120000 });
    // Playwright close后销毁内部handle；提前保存ChildProcess/PID，不能在close后再调用application.process()。
    const childProcess = application.process();
    owned = { application, childProcess, mainPid: childProcess.pid, userData, workspace, directory, observedProcesses: [] };
    owned.observedProcesses = await p0ReadOwnedProcesses(owned.mainPid);
    await writeFile(path.join(directory,'process-identity.json'),JSON.stringify({mainPid:owned.mainPid,observedProcesses:owned.observedProcesses},null,2),{flag:'wx'});
    assert.ok(owned.observedProcesses.some(row => row.pid === owned.mainPid), 'E3_OWNED_PROCESS_IDENTITY_UNKNOWN');
    const deadline = Date.now() + Math.max(timeoutMs, 120000);
    while (Date.now() < deadline) {
      const state = await application.evaluate(() => ({ ready: globalThis.__e3P0?.ready, error: globalThis.__e3P0?.error }));
      if (state.ready) { if (state.error) throw new Error(state.error); return owned; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('E3_NATIVE_BOOTSTRAP_TIMEOUT');
  } catch (error) {
    await writeFile(path.join(directory,'launch-failure.json'),JSON.stringify({status:'FAIL',error:error.stack??String(error)},null,2),{flag:'wx'});
    if (owned) {
      try { await p0CloseOwned(owned); }
      catch (closeError) { await writeFile(path.join(directory,'process-close-failure.json'),JSON.stringify({originalError:String(error),closeError:closeError.stack??String(closeError)},null,2),{flag:'wx'}); }
    }
    else await writeFile(path.join(directory, 'process-closure.json'), JSON.stringify({ status: 'UNKNOWN_NO_APP_HANDLE', error: String(error),
      scope: 'Playwright launch failed before an owned process identity could be observed; no unrelated process was terminated' }, null, 2), { flag: 'wx' });
    throw error;
  }
}

/** 只读记录已证实的main及其子树；PID复用按CreationDate区分，绝不按进程名终止。 */
async function p0ReadOwnedProcesses(mainPid, observed = []) {
  assert.equal(process.platform, 'win32', '本次P0进程收束协议仅冻结Windows');
  assert.ok(Number.isSafeInteger(mainPid) && mainPid > 0);
  assert.ok(observed.every(row => Number.isSafeInteger(row.pid) && row.pid > 0));
  const command = `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process); $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${mainPid});
do { $changed=$false; foreach($row in $rows) { if($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $changed=$true } } } while($changed);
foreach($knownId in @(${observed.map(row => row.pid).join(',')})) { [void]$ids.Add([int]$knownId) };
$result=@($rows | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; creationDate=$_.CreationDate.ToUniversalTime().ToString('o') } });
ConvertTo-Json -InputObject $result -Compress`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
  const rows = JSON.parse(stdout.trim()); assert.ok(Array.isArray(rows));
  return rows;
}

async function p0CloseOwned(owned) {
  const closure = { status: 'UNKNOWN', mainPid: owned.mainPid, observed: owned.observedProcesses ?? [],
    scope: 'observed owned main/descendant identities before launch-ready and graceful close; PID reuse is distinguished by CreationDate; no forced process termination' };
  try {
    const beforeClose = await p0ReadOwnedProcesses(closure.mainPid);
    const known = new Map(closure.observed.map(row => [row.pid + ':' + row.creationDate, row]));
    // 根PID必须仍属原进程，不能把复用PID的新子树算作本任务。
    const root = closure.observed.find(row => row.pid === closure.mainPid), currentRoot = beforeClose.find(row => row.pid === closure.mainPid);
    if (root && currentRoot?.creationDate === root.creationDate) for (const row of beforeClose) known.set(row.pid + ':' + row.creationDate, row);
    closure.observed = [...known.values()];
  } catch (error) { closure.preCloseReadError = String(error); }
  try { await owned.application.close(); } catch (error) { closure.gracefulCloseError = String(error); }
  closure.mainExitCode = owned.childProcess.exitCode;
  try {
    const deadline = Date.now() + 10000;
    do {
      const after = await p0ReadOwnedProcesses(closure.mainPid, closure.observed);
      closure.stillAlive = closure.observed.filter(row => after.some(current => current.pid === row.pid && current.creationDate === row.creationDate));
      closure.pidReplacements = after.filter(row => closure.observed.some(previous => row.pid === previous.pid && row.creationDate !== previous.creationDate));
      if (!closure.stillAlive.length) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    closure.status = closure.observed.length && !closure.preCloseReadError && !closure.stillAlive.length ? 'OBSERVED_OWNED_PROCESSES_CLOSED' : 'FAIL_OWNED_PROCESS_REMAINS_OR_UNKNOWN';
  } catch (error) { closure.postCloseReadError = String(error); }
  await writeFile(path.join(owned.directory, 'process-closure.json'), JSON.stringify(closure, null, 2), { flag: 'wx' });
  return closure;
}

async function p0DirectoryBytes(directory) {
  const pending = [directory]; let bytes = 0, count = 0;
  while (pending.length) {
    const folder = pending.pop(); let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      assert.ok(++count <= 100000, 'owned output文件计数超界'); assert.equal(entry.isSymbolicLink(), false);
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) try { bytes += (await stat(file)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return bytes;
}

async function p0CopyPreparationReport(target) {
  const toggle=target.getByRole('checkbox',{name:'性能监控',exact:true}),summary=target.locator('.scene-performance-summary');
  assert.equal(await toggle.count(),1,'复制准备报告需要真实监控入口');
  const enabledBefore=await toggle.isChecked();let expandedBefore,result,primary,hasPrimaryError=false;
  try {
    await target.evaluate(() => {
      window.__e3ClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard'); window.__e3CopiedReport = null;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__e3CopiedReport = value; } } });
    });
    await toggle.check();await summary.waitFor({state:'visible'});
    expandedBefore=await summary.getAttribute('aria-expanded');assert.ok(['true','false'].includes(expandedBefore));
    if(expandedBefore==='false')await summary.click();
    await target.locator('.scene-performance-copy').click();
    await target.waitForFunction(() => typeof window.__e3CopiedReport === 'string');
    result=JSON.parse(await target.evaluate(() => window.__e3CopiedReport));
  }catch(error){primary=error;hasPrimaryError=true;}
  // 冷启动后的诊断不能把监控/GPU查询状态留给暖启动，剪贴板也只替换临时描述符、不写用户内容。
  const cleanupErrors=[];let expandedAfter,enabledAfter;
  try{if(expandedBefore!==undefined){if(await summary.getAttribute('aria-expanded')!==expandedBefore)await summary.click();
    expandedAfter=await summary.getAttribute('aria-expanded');assert.equal(expandedAfter,expandedBefore);}}catch(error){cleanupErrors.push(error);}
  try{await toggle.setChecked(enabledBefore);enabledAfter=await toggle.isChecked();assert.equal(enabledAfter,enabledBefore);}catch(error){cleanupErrors.push(error);}
  try{await target.evaluate(()=>{const before=window.__e3ClipboardDescriptor;
    if(before)Object.defineProperty(navigator,'clipboard',before);else delete navigator.clipboard;
    const after=Object.getOwnPropertyDescriptor(navigator,'clipboard');
    if(before? !after||['get','set','value','writable','enumerable','configurable'].some(key=>before[key]!==after[key]):after!==undefined)throw new Error('E3_CLIPBOARD_DESCRIPTOR_RESTORE_FAILED');
    delete window.__e3ClipboardDescriptor;});}catch(error){cleanupErrors.push(error);}
  if(cleanupErrors.length){throw new AggregateError(hasPrimaryError?[primary,...cleanupErrors]:cleanupErrors,'E3_UI_CAPTURE_CLEANUP_FAILED'+(hasPrimaryError?'\nOriginal: '+(primary?.stack??String(primary)):''));}
  if(hasPrimaryError)throw primary;
  return {...result,__e3CaptureUi:{enabledBefore,expandedBefore,enabledAfter,expandedAfter,clipboardRestored:true}};
}

async function p0EnsureProjectCard(target, projectName) {
  await target.locator('.home-page').waitFor({ state: 'visible', timeout: 120000 });
  const locate = () => target.locator('.home-data-platform-card').filter({ has: target.getByText(projectName, { exact: true }) });
  if (!await locate().count()) {
    const textbox = target.getByRole('searchbox', { name: '项目名称', exact: true });
    assert.equal(await textbox.count(), 1, '项目不在首屏且未确认搜索UI，不猜selector或改trusted cache');
    await textbox.fill(projectName); await target.getByRole('button', { name: '搜索', exact: true }).click();
  }
  await locate().getByRole('button', { name: '打开', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  assert.equal(await locate().count(), 1, '项目名非唯一，必须按身份先解决');
  return locate().getByRole('button', { name: '打开', exact: true });
}

async function runSceneOpenP0() {
  await createFreshSceneOpenOutput(output, path.join(repo, 'output'));
  p0OutputOwned = true;
  const expectedBytes = await readFile(path.resolve(values['freeze-scene'])), expectedDocument = JSON.parse(expectedBytes.toString('utf8'));
  assert.equal(expectedDocument.scene?.entityIds?.length, 383, '本P0冻结当前383输入，不能换合成/空工程');
  const build = await p0BuildFingerprint(); await writeFile(path.join(output, 'build-source-fingerprint.json'), JSON.stringify(build, null, 2));
  if (values['prepare-read-only-manifest']) {
    let owned;
    try {
      owned = await p0Launch({ directory: output, prepare: true, source: path.resolve(values['freeze-scene']) });
      const result = await owned.application.evaluate(() => ({ result: globalThis.__e3P0.manifest, queries: globalThis.__e3P0.preparationQueries,
        createdWindowCount:globalThis.__e3P0.createdWindowCount }));
      assert.equal(result.result.status, 'TRUSTED_METADATA_NOT_DOWNLOADED_NOT_BYTE_VERIFIED');
      assert.equal(result.createdWindowCount,0);
      await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: result.result.status, downloaded: false, editorCreated: false,
        projectId: values['project-id'], queryCount: result.queries.length, browserWindowCreatedCount:result.createdWindowCount,
        manifest: path.join(output, 'read-only-manifest.json') }, null, 2), { flag: 'wx' });
    } catch (error) { process.exitCode = 1; await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'FAIL_PREPARATION', error: error.stack ?? String(error), downloaded: false, editorCreated: false }, null, 2), { flag: 'wx' }); }
    finally { if (owned) {
      const closure = await p0CloseOwned(owned), resultPath = path.join(output, 'result.json'), result = JSON.parse(await readFile(resultPath, 'utf8'));
      result.processClosure = closure;
      if (closure.status !== 'OBSERVED_OWNED_PROCESSES_CLOSED') { process.exitCode = 1; result.preparationStatus = result.status; result.status = 'FAIL_PROCESS_CLOSURE'; }
      await writeFile(resultPath, JSON.stringify(result, null, 2));
    } }
    return;
  }
  const verificationOnly=values['verification-only'];
  if(verificationOnly){assert.equal(coldCount,1);assert.equal(warmCount,0,'收尾单次打开不当冷暖性能验收');}
  else{assert.equal(coldCount, 5); assert.equal(warmCount, 5, 'paired正式模式锁定五冷五暖，不补失败样本');}
  assert.ok(values['read-only-manifest'], '请先显式执行--prepare-read-only-manifest，禁止猜下载前缀');
  const manifestBytes = await readFile(path.resolve(values['read-only-manifest'])), manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.status, 'TRUSTED_METADATA_NOT_DOWNLOADED_NOT_BYTE_VERIFIED'); assert.equal(manifest.projectId, values['project-id']);
  assert.equal(manifest.baseUrl, normalizeSceneOpenBase(values.url)); assert.equal(manifest.inputSceneSha256, sceneOpenSha256(expectedBytes));
  // 元数据查询清单不决定路径字段语义；始终从同一份冻结SOURCE及当前生产schema派生，避免旧枚举漏掉合法换根。
  const traversal=await import(pathToFileURL(path.join(repo,'dist-electron/shared/sceneResourceTraversal.js')).href);
  const sceneVersions=await import(pathToFileURL(path.join(repo,'dist-electron/shared/sceneFileVersion.js')).href);
  const sceneLighting=await import(pathToFileURL(path.join(repo,'dist-electron/shared/sceneLightingConfig.js')).href);
  assert.ok(sceneVersions.isSupportedSceneFileVersion(expectedDocument.version),'冻结 SOURCE 格式不受当前生产迁移支持');
  // 物化过程按生产协议升级格式；原始压缩包 SHA 仍独立逐字节核对，不能把版本字段泛忽略。
  const materializedExpected={...expectedDocument,version:sceneVersions.CURRENT_SCENE_FILE_VERSION,
    scene:sceneLighting.migrateSceneLightingDocument(structuredClone(expectedDocument.scene))};
  const materializedExpectedBytes=Buffer.from(stableSceneOpenJson(materializedExpected));
  const sourceLocations={locationPointers:collectSceneOpenLocationPointers(materializedExpected,traversal),locationRules:collectSceneOpenLocationRules(materializedExpected,traversal)};
  let resolvedBaseline, resolvedBaselineBytes, resolvedBytes;
  if(values['resolved-baseline']) {
    resolvedBaselineBytes=await readFile(path.resolve(values['resolved-baseline']));resolvedBaseline=JSON.parse(resolvedBaselineBytes.toString('utf8'));
    resolvedBytes=await readFile(resolvedBaseline.resolvedFile);
    const document=JSON.parse(resolvedBytes.toString('utf8'));
    validateSceneOpenResolvedBaseline(resolvedBaseline,manifest,resolvedBytes,{locationPointers:collectSceneOpenLocationPointers(document,traversal),locationRules:collectSceneOpenLocationRules(document,traversal)});
    const slots=deriveSceneOpenLogicalImageSlots(document);
    assert.ok(resolvedBaseline.logicalImages&&stableSceneOpenJson(slots)===stableSceneOpenJson(resolvedBaseline.logicalImages.slots),'活跃逻辑图片必须独立冻结，不能仅冻结ID或图库updatedAt');
  }
  else assert.equal(deriveSceneOpenLogicalImageSlots(expectedDocument).length,0,'当前输入有活跃逻辑图片，需显式含byte基线的--resolved-baseline');
  const budgets = values['budget-file'] ? JSON.parse(await readFile(path.resolve(values['budget-file']), 'utf8')) : null;
  if (budgets) for (const field of ['rendererHeapBytes', 'simultaneousWorkingSetBytes', 'ownedOutputBytes']) assert.ok(Number.isSafeInteger(budgets[field]) && budgets[field] > 0, '未冻结完整预算：' + field);
  const report = { status: 'RUNNING', mode: verificationOnly?'single-open-final-verification-not-performance':'paired-session-warm',
    verificationOnly,schedule: verificationOnly?[{name:'C1',pair:1,kind:'cold'}]:createSceneOpenPairedSchedule(),
    sourceExpectedSha256: sceneOpenSha256(expectedBytes), readOnlyManifestSha256: sceneOpenSha256(manifestBytes), projectId: manifest.projectId,
    sourceLocationSchema:{pointerCount:sourceLocations.locationPointers.length,sha256:sceneOpenSha256(Buffer.from(stableSceneOpenJson(sourceLocations))),basis:'same frozen original SOURCE plus production typed traversal; query/download authorization manifest unchanged'},
    profile: false, budgets, runs: [], failures: [], skippedSlots: [], processClosures: [], gpuUploadDurationMs: null,
    conditions: 'actual Home click to natural ready; C/W per independent owned output pair, same process/userData/workspace inside each pair; physical OS/network caches uncontrolled',
    scope: 'P0 outer wallclock/current preparation timings and input/byte freeze; NOT seven-stage same-ID critical-path trace',
    resolvedBaseline:resolvedBaseline?{receiptSha256:sceneOpenSha256(resolvedBaselineBytes),resolvedLiveSha256:resolvedBaseline.resolvedLiveSha256,
      sourceArchiveSha256:resolvedBaseline.sourceArchiveSha256,scope:'explicitly approved current resolved revisions; original SOURCE checked independently; NOT historical370 baseline'}:null };
  const save = () => writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); let owned;
  try {
    for (let pair = 1; pair <= (verificationOnly?1:5); pair++) {
      const directory = path.join(output, 'pair-' + pair); await mkdir(directory);
      owned = await p0Launch({ directory, manifest }); const target = await owned.application.firstWindow(); target.setDefaultTimeout(30000);
      const problems = [], dialogs = [], context = { returningHome: false, current: 'startup' };
      const exactExclusions = new Map((manifest.exclusions ?? []).map(row => [row.url, row]));
      const requestExclusions = new WeakMap(), provenFrameUrls = new Map();
      const recordProblem = (kind, message, rawUrl = '', proven = null) => {
        let parsed; try { parsed = new URL(rawUrl); parsed.hash = ''; } catch { /* message仍保留 */ }
        const exemption = proven ?? (parsed && (matchSceneOpenExclusion(manifest.exclusions ?? [], { url: rawUrl }) ?? provenFrameUrls.get(parsed.href)));
        let redacted = rawUrl; if (parsed) { parsed.username = ''; parsed.password = ''; parsed.search = ''; redacted = parsed.href; }
        problems.push({ kind, message, url: redacted, urlSha256: sceneOpenSha256(Buffer.from(rawUrl)), excluded: Boolean(exemption), reason: exemption?.reason ?? null,
          screenId: exemption?.screenId ?? null, sourceField: exemption?.field ?? null, trial: context.current });
      };
      target.on('pageerror', error => recordProblem('page', error.message));
      target.on('console', message => { if (message.type() === 'error') recordProblem('console', message.text(), message.location().url); });
      target.on('requestfailed', request => recordProblem('requestfailed', request.failure()?.errorText, request.url(), requestExclusions.get(request)));
      target.on('dialog', async dialog => {
        const allowed = context.returningHome && dialog.type() === 'confirm' && dialog.message() === '当前场景有未保存修改。返回首页会丢失这些修改，是否继续？';
        dialogs.push({ type: dialog.type(), message: dialog.message(), allowed, trial: context.current });
        if (allowed) await dialog.accept(); else { await dialog.dismiss(); recordProblem('unexpected-dialog', dialog.message()); }
      });
      await target.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
        url.hash = ''; const candidateRule = exactExclusions.get(url.href); let frameSourceUrl;
        if (candidateRule?.field === 'screenUrl') {
          try { const element = await request.frame().frameElement(); frameSourceUrl = await element.getAttribute('src'); } catch { /* 无法证明iframe源就不豁免 */ }
        }
        const rule = matchSceneOpenExclusion(manifest.exclusions ?? [], { url: url.href, frameSourceUrl });
        if (rule) { requestExclusions.set(request, rule); if (rule.field === 'screenUrl') provenFrameUrls.set(url.href, rule);
          recordProblem('exact-exclusion-blocked', 'outbound request refused before contact', url.href, rule); return route.abort(); }
        // renderer只允许manifest精确GET；所有查询实际应由native API执行，Fetch.invoke未豁免。
        if (request.method() === 'GET' && manifest.downloads.some(row => row.url === url.href)) return route.continue();
        recordProblem('unexpected-renderer-network', request.method(), url.href); return route.abort();
      });
      assert.equal(typeof target.routeWebSocket, 'function', '无法确认旧MQTT出站守卫，停止而非尝试连接');
      await target.routeWebSocket('**/*', socket => {
        const rule = exactExclusions.get(socket.url());
        if (rule?.kind === 'authorized-unavailable-mqtt') recordProblem('exact-exclusion-websocket', 'no broker contact/messages', socket.url(), rule);
        else recordProblem('unexpected-websocket', 'outbound websocket refused', socket.url());
        socket.close();
      });
      const config = await target.evaluate(() => window.editorApi.getDataPlatformConfig());
      assert.equal(config.workspaceRoot, owned.workspace); assert.equal(config.baseUrl, manifest.baseUrl);
      const nativeWindow=await owned.application.browserWindow(target);
      const rendererIdentity=()=>nativeWindow.evaluate(window=>({windowId:window.id,webContentsId:window.webContents.id,
        osProcessId:window.webContents.getOSProcessId(),chromiumProcessId:window.webContents.getProcessId()}));
      assert.equal(await owned.application.evaluate(({app})=>app.commandLine.hasSwitch('enable-precise-memory-info')),true,'精确内存采样标志未设置');
      for (const kind of (verificationOnly?['cold']:['cold', 'warm'])) {
        const name = (kind === 'cold' ? 'C' : 'W') + pair, runRoot = path.join(directory, name); await mkdir(runRoot); context.current = name;
        const run = { name, pair, kind, status: 'RUNNING', failures: [], resourceBudgetPass: null,
          diskScope: 'this pair directory including userData/workspace and evidence, sampled through post-ready validation; earlier pairs excluded' }; report.runs.push(run); await save();
        run.rendererAtStart=await rendererIdentity();run.preciseMemorySwitchEnabled=true;
        const beforeProblems = problems.length, beforeDialogs = dialogs.length;
        if (kind === 'warm') {
          context.returningHome = true; await target.locator('.toolbar-home-button').click(); await target.locator('.home-page').waitFor({ state: 'visible' }); context.returningHome = false;
        }
        const button = await p0EnsureProjectCard(target, manifest.project.projectName); await target.bringToFront();
        await target.evaluate(installSceneOpenDomAudit, { actualClick: true });
        await owned.application.evaluate((_electron, trial) => globalThis.__e3P0.startTrial(trial), name);
        const heapSamples = [], diskSamples = []; let diskError, pendingDisk;
        const sampleDisk = async () => { try { const bytes = await p0DirectoryBytes(directory); diskSamples.push({ atMs: performance.now(), bytes });
          if (budgets && bytes > budgets.ownedOutputBytes) throw new Error('E3_OWNED_OUTPUT_BUDGET_EXCEEDED');
        } catch (error) { diskError = String(error); } };
        await sampleDisk(); const diskTimer = setInterval(() => { if (!pendingDisk) pendingDisk = sampleDisk().finally(() => { pendingDisk = null; }); }, 2000);
        try {
          await button.click(); const deadline = Date.now() + timeoutMs; let observed;
          while (Date.now() < deadline) {
            observed = await target.evaluate(() => { window.__sampleLoadAudit?.(); return { trace: window.__loadAudit, visible: document.visibilityState, focused: document.hasFocus(),
              homeError: document.querySelector('.home-status-error')?.textContent, issue: document.querySelector('aside[aria-label="场景资源状态"]')?.textContent,
              label: document.querySelector('[data-scene-preparation-phase]')?.textContent?.slice(-550), heap: performance.memory?.usedJSHeapSize ?? null }; });
            heapSamples.push({ rendererHeapBytes: observed.heap });
            assert.equal(observed.visible, 'visible'); assert.equal(observed.focused, true, '打开期间失焦，不能与其它条件混算');
            if (diskError) throw new Error(diskError);
            if (budgets && observed.heap !== null) assert.ok(observed.heap <= budgets.rendererHeapBytes, 'E3_RENDERER_HEAP_BUDGET_EXCEEDED');
            if (budgets) {
              const last = await owned.application.evaluate(() => globalThis.__e3P0.memorySamples.at(-1));
              if (last?.unitVerified) assert.ok(last.processes.reduce((sum, row) => sum + row.workingSetBytes, 0) <= budgets.simultaneousWorkingSetBytes, 'E3_SUM_WORKING_SET_BUDGET_EXCEEDED');
            }
            if (observed.homeError || observed.issue || observed.label?.includes('场景资源加载失败')) throw new Error(observed.homeError || observed.issue || observed.label);
            if (observed.trace?.completedMs !== null && observed.trace?.completedMs !== undefined) break;
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          assert.ok(Number.isFinite(observed?.trace?.completedMs), 'E3_OPEN_TIMEOUT'); run.wall = observed.trace;
          const memory = await owned.application.evaluate(() => globalThis.__e3P0.stopTrial()); run.memory = summarizeSceneOpenMemory([...memory, ...heapSamples]);
          const logical = await target.evaluate(readSceneOpenLogicalInput); assert.equal(logical.entityCount, 383);
          const sourceState = await owned.application.evaluate(() => globalThis.__e3P0.readSource());
          await writeFile(path.join(runRoot, 'downloaded-materialized-scene.json'), sourceState.text, { flag: 'wx' });
          await writeFile(path.join(runRoot, 'logical-scene.json'), logical.text, { flag: 'wx' });
          await writeFile(path.join(runRoot, 'source-context.json'), JSON.stringify({ file: sourceState.file, binding: sourceState.binding }, null, 2), { flag: 'wx' });
          assert.equal(sourceState.binding.projectId, manifest.projectId); assert.equal(sourceState.binding.latestVersionId, manifest.project.source.versionId);
          assert.equal(sourceState.binding.resourceRevision, manifest.project.currentResourceRevision);
          const roots = [...manifest.originalRoots, ...(resolvedBaseline?.roots??[]), { tag: 'project', path: sourceState.projectRoot }, { tag: 'workspace', path: owned.workspace }];
          const freezeOptions = { roots,...sourceLocations };
          const expected = freezeSceneOpenInput(materializedExpectedBytes, freezeOptions);
          run.sourceFormatMigration={from:expectedDocument.version,to:materializedExpected.version,
            rawSourceSha256:sceneOpenSha256(expectedBytes),materializedExpectedSha256:sceneOpenSha256(materializedExpectedBytes),
            basis:'production sceneFileVersion and migrateSceneLightingDocument; original SOURCE archive remains byte-verified'};
          const actualSource = freezeSceneOpenInput(Buffer.from(sourceState.text), freezeOptions);
          const logicalFreezeOptions=resolvedBaseline?{roots:[...roots,...resolvedBaseline.roots],locationPointers:resolvedBaseline.locationPointers,locationRules:resolvedBaseline.locationRules}:freezeOptions;
          const originalLive = freezeSceneOpenInput(resolvedBytes??Buffer.from(stableSceneOpenJson({ scene: expectedDocument.scene })),logicalFreezeOptions);
          const live = freezeSceneOpenInput(Buffer.from(logical.text),logicalFreezeOptions);
          run.sourceVsExpected = compareSceneOpenInputs(expected, actualSource, { requireCanonicalSourceBytes: false });
          run.logicalVsExpected = compareSceneOpenInputs(originalLive, live, { requireCanonicalSourceBytes: false });
          assert.ok(run.sourceVsExpected.equal && run.logicalVsExpected.equal, 'E3_BUSINESS_OR_RESOURCE_VERSION_DIFF; see saved full projection differences');
          const frozen = { source: actualSource, logical: live, resources: await hashSceneOpenReferencedFiles(JSON.parse(logical.text),
            { locationPointers: logicalFreezeOptions.locationPointers, workspaceRoot: owned.workspace, projectRoot: sourceState.projectRoot,
              bundledSkyboxRoot:path.join(repo,'public','builtin-skybox-environments') }) };
          if(resolvedBaseline)assert.equal(stableSceneOpenJson(frozen.resources),stableSceneOpenJson(resolvedBaseline.resources),'E3_APPROVED_RESOLVED_BASELINE_FILE_BYTES_DRIFT');
          run.rendererAtReady=await rendererIdentity();
          const heapSession=await target.context().newCDPSession(target);
          try{run.mainTargetHeapAtReady=await heapSession.send('Runtime.getHeapUsage');}finally{await heapSession.detach();}
          run.heapScope='sampled usedJSHeapSize in the actual Editor main target with precise-memory switch requested; point CDP backing storage/embedded figures are separate, not CPU working set or a guaranteed continuous peak';
          const diagnostics = await p0CopyPreparationReport(target), runtime = (await target.evaluate(runtimeSnapshot))[0];
          run.preparationCaptureUi=diagnostics.__e3CaptureUi;
          const {__e3CaptureUi:uiCapture,...copiedReport}=diagnostics;
          await writeFile(path.join(runRoot,'copied-performance-report.json'),JSON.stringify({report:copiedReport,uiCapture},null,2),{flag:'wx'});
          assertSceneOpenReady(diagnostics.scenePreparation, runtime?.loading); assert.equal(runtime.pending, 0); assert.ok(runtime.activeMeshes > 0);
          assert.ok(['idle', 'ready'].includes(runtime.skybox.phase)); assert.equal(runtime.loading.cargoPreload.pendingCount, 0);
          let logicalImageInputs=null;
          if(resolvedBaseline){
            assert.equal(stableSceneOpenJson(deriveSceneOpenLogicalImageSlots(JSON.parse(logical.text))),stableSceneOpenJson(resolvedBaseline.logicalImages.slots),'实际活跃图片槽位/修订漂移');
            const images=await captureSceneOpenLogicalImages(target,resolvedBaseline.logicalImages,{output:path.join(runRoot,'logical-images'),
              workspaceRoot:owned.workspace,bundledRoot:path.join(repo,'dist'),bindingVerified:true,runtimeBinding:'scene-canvas'});
            assert.equal(images.status,'PASS_ACTUAL_INPUT_IMAGE_BYTES_ONLY');
            run.logicalImages={status:images.status,receiptFile:path.join(runRoot,'logical-images/receipt.json'),slotCount:images.slots.length,uniqueImages:images.images.length,provesGpuTextureSuccess:false};
            logicalImageInputs={slots:images.slots.map(({actualResolvedUrl,...slot})=>slot),images:images.images.map(image=>({logicalReference:image.logicalReference,
              kind:image.kind,canonicalFileKey:image.canonicalFileKey,bytes:image.bytes,sha256:image.sha256,independentlyMatchedPhysicalFile:image.independentlyMatchedPhysicalFile}))};
          }
          const editing = await target.evaluate(() => {
            const root = document.getElementById('root'), key = Object.keys(root).find(value => value.startsWith('__reactContainer$'));
            const stack = [root[key]?.stateNode?.current ?? root[key]], seen = new Set(); let runtime;
            while (stack.length && seen.size < 30000) { const fiber = stack.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
              const visit = value => { const current = value?.current ?? value; if (current?.scene?.meshes && typeof current.getPerformanceMetrics === 'function') runtime = current; };
              for (const value of Object.values(fiber.memoizedProps ?? {})) visit(value); let hook = fiber.memoizedState;
              for (let i = 0; hook && i < 500; i++, hook = hook.next) visit(hook.memoizedState); stack.push(fiber.child, fiber.sibling); }
            return { preview: runtime?.telemetry?.telemetryPreviewActive, fetchSnapshot: runtime?.fetch?.fetchConfigSnapshot !== null,
              fetchTimer: runtime?.fetch?.fetchSyncTimer !== null, fetchInFlight: runtime?.fetch?.fetchInFlightOperations, renderer: runtime?.scene.getEngine().getGlInfo(),
              buffer: [runtime?.scene.getEngine().getRenderWidth(), runtime?.scene.getEngine().getRenderHeight()] };
          });
          assert.equal(editing.preview, false); assert.equal(editing.fetchSnapshot, false); assert.equal(editing.fetchTimer, false); assert.equal(editing.fetchInFlight, 0);
          const guarded = await owned.application.evaluate(() => ({ receipts: globalThis.__e3P0.guard.state.receipts, denied: globalThis.__e3P0.guard.state.denied, dropped: globalThis.__e3P0.guard.state.dropped }));
          const sourceReceipts = guarded.receipts.filter(row => row.trial === name && row.role === 'source' && row.complete && row.httpStatus >= 200 && row.httpStatus < 300);
          assert.ok(sourceReceipts.length, 'E3_SOURCE_BYTES_NOT_OBSERVED'); const sourceArchiveSha256 = sourceReceipts[0].actualSha256;
          assert.ok(sourceReceipts.every(row => row.actualSha256 === sourceArchiveSha256));
          if(resolvedBaseline)assert.equal(sourceArchiveSha256,resolvedBaseline.sourceArchiveSha256,'E3_APPROVED_SOURCE_ARCHIVE_BYTES_DRIFT');
          assert.equal(guarded.dropped, 0); assert.equal(guarded.denied.filter(row => !row.excluded).length, 0, 'E3_NATIVE_REQUEST_DENIED_OR_DRIFT');
          assert.equal(guarded.receipts.filter(row => row.httpStatus >= 400 && !row.excluded).length, 0, 'E3_NATIVE_HTTP_FAILURE');
          run.problems = problems.slice(beforeProblems); run.dialogs = dialogs.slice(beforeDialogs);
          assert.equal(run.problems.filter(row => !row.excluded).length, 0, 'E3_UNEXEMPTED_PAGE_OR_NETWORK_FAILURE');
          run.runtime = runtime; run.preparation = diagnostics.scenePreparation; run.editing = editing;
          run.sourceArchiveSha256 = sourceArchiveSha256; run.sourceRawSha256 = actualSource.rawSha256;
          run.gpuUploadDurationMs = null; run.logicalUndefinedFieldsOmittedFromNonpersistableState = logical.omittedUndefined;
          if (!report.firstColdFreeze) { assert.equal(name, 'C1'); report.firstColdFreeze = { ...frozen, sourceArchiveSha256, rendering: editing,logicalImageInputs }; }
          else {
            assert.ok(compareSceneOpenInputs(report.firstColdFreeze.source, frozen.source).equal, 'E3_MATERIALIZED_SOURCE_DRIFT');
            assert.ok(compareSceneOpenInputs(report.firstColdFreeze.logical, frozen.logical, { requireCanonicalSourceBytes: false }).equal, 'E3_LOGICAL_INPUT_DRIFT');
            assert.equal(stableSceneOpenJson(frozen.resources), stableSceneOpenJson(report.firstColdFreeze.resources), 'E3_REFERENCED_FILE_BYTES_DRIFT');
            assert.equal(sourceArchiveSha256, report.firstColdFreeze.sourceArchiveSha256, 'E3_SOURCE_ARCHIVE_BYTES_DRIFT');
            assert.deepEqual(editing, report.firstColdFreeze.rendering, 'E3_RENDERER_BUFFER_OR_MODE_DRIFT');
            assert.equal(stableSceneOpenJson(logicalImageInputs),stableSceneOpenJson(report.firstColdFreeze.logicalImageInputs),'E3_LOGICAL_IMAGE_RUNTIME_MAPPING_OR_BYTES_DRIFT');
          }
          await writeFile(path.join(runRoot, 'input-freeze.json'), JSON.stringify(frozen, null, 2), { flag: 'wx' });
          await writeFile(path.join(runRoot, 'native-guard.json'), JSON.stringify(guarded, null, 2), { flag: 'wx' });
          await target.screenshot({ path: path.join(runRoot, 'editor.png') });
          await new Promise(resolve => setTimeout(resolve, 1200)); const later = (await target.evaluate(runtimeSnapshot))[0]; assert.ok(later.frame > runtime.frame);
          run.status = 'PASS_NATURAL_READY_INPUT_FROZEN';
        } catch (error) { run.status = 'FAIL'; run.error = error.stack ?? String(error); throw error; }
        finally {
          if (!run.memory) {
            const memory = await owned.application.evaluate(() => globalThis.__e3P0.stopTrial()).catch(error => { run.memoryReadError = String(error); return []; });
            run.memory = summarizeSceneOpenMemory([...memory, ...heapSamples]);
          }
          run.problems = problems.slice(beforeProblems); run.dialogs = dialogs.slice(beforeDialogs);
          const guarded = await owned.application.evaluate(() => ({ receipts: globalThis.__e3P0.guard.state.receipts,
            denied: globalThis.__e3P0.guard.state.denied, dropped: globalThis.__e3P0.guard.state.dropped })).catch(error => ({ readbackError: String(error) }));
          await writeFile(path.join(runRoot, 'native-guard-final.json'), JSON.stringify(guarded, null, 2), { flag: 'wx' });
          clearInterval(diskTimer); if (pendingDisk) await pendingDisk; await sampleDisk(); run.diskSamples = diskSamples;
          if (diskError) { run.diskSamplingError = diskError; run.status = 'FAIL'; run.error ??= diskError; }
          run.ownedDiskMaxObservedBytes = diskSamples.length ? Math.max(...diskSamples.map(row => row.bytes)) : null;
          if (budgets && run.memory) {
            const known = [run.memory.rendererHeapMaxObservedBytes, run.memory.simultaneousWorkingSetMaxObservedBytes, run.ownedDiskMaxObservedBytes].every(value => Number.isFinite(value) && value > 0);
            run.resourceBudgetPass = known && run.memory.rendererHeapMaxObservedBytes <= budgets.rendererHeapBytes
              && run.memory.simultaneousWorkingSetMaxObservedBytes <= budgets.simultaneousWorkingSetBytes && run.ownedDiskMaxObservedBytes <= budgets.ownedOutputBytes;
            if (!run.resourceBudgetPass) { run.status = 'FAIL'; run.error ??= 'E3_RESOURCE_BUDGET_UNAVAILABLE_OR_EXCEEDED'; }
          }
          await writeFile(path.join(runRoot, 'result.json'), JSON.stringify(run, null, 2)); await save();
        }
        assert.notEqual(run.status, 'FAIL', run.error);
        assert.equal(stableSceneOpenJson(await p0BuildFingerprint()), stableSceneOpenJson(build), '构建/工具版本在本轮变化');
      }
      const closure = await p0CloseOwned(owned); report.processClosures.push(closure); owned = null;
      assert.equal(closure.status, 'OBSERVED_OWNED_PROCESSES_CLOSED', 'E3_OWNED_PROCESS_CLOSURE_UNCONFIRMED');
    }
    assert.equal(report.runs.length, verificationOnly?1:10);
    report.status=verificationOnly?'PASS_SINGLE_OPEN_VERIFICATION_NOT_PAIRED_PERFORMANCE':'PASS_P0_WALLCLOCK_AND_INPUT_FREEZE';
  } catch (error) { report.status = 'FAIL'; report.failures.push(error.stack ?? String(error)); process.exitCode = 1; }
  finally {
    if (owned) {
      await writeFile(path.join(owned.directory, 'native-final.json'), JSON.stringify(await owned.application.evaluate(() => ({
        receipts: globalThis.__e3P0?.guard?.state, memory: globalThis.__e3P0?.memorySamples, error: globalThis.__e3P0?.error,
      })).catch(error => ({ readbackError: String(error) })), null, 2));
      const closure = await p0CloseOwned(owned); report.processClosures.push(closure);
      if (closure.status !== 'OBSERVED_OWNED_PROCESSES_CLOSED') { report.status = 'FAIL'; report.failures.push('E3_OWNED_PROCESS_CLOSURE_UNCONFIRMED'); }
    }
    report.skippedSlots = report.schedule.filter(slot => !report.runs.some(run => run.name === slot.name)).map(slot => slot.name);
    const percentile = (list, p) => list.length ? [...list].sort((a, b) => a - b)[Math.ceil(list.length * p) - 1] : null;
    report.summary = Object.fromEntries(['cold', 'warm'].map(kind => { const list = report.runs.filter(run => run.kind === kind && run.status === 'PASS_NATURAL_READY_INPUT_FROZEN').map(run => run.wall.completedMs);
      return [kind, { successCount: list.length, failureCount: report.runs.filter(run => run.kind === kind && run.status === 'FAIL').length, p50Ms: percentile(list, .5), p95Ms: percentile(list, .95), rawMs: list }]; }));
    report.originalExpectedSceneUnchanged = sceneOpenSha256(await readFile(path.resolve(values['freeze-scene']))) === sceneOpenSha256(expectedBytes);
    if (!report.originalExpectedSceneUnchanged) report.status = 'FAIL';
    if(resolvedBaseline){report.approvedResolvedBaselineUnchanged=sceneOpenSha256(await readFile(path.resolve(values['resolved-baseline'])))===sceneOpenSha256(resolvedBaselineBytes)
      &&sceneOpenSha256(await readFile(resolvedBaseline.resolvedFile))===sceneOpenSha256(resolvedBytes);
      if(!report.approvedResolvedBaselineUnchanged)report.status='FAIL';}
    await save(); console.log(JSON.stringify({ status: report.status, output, summary: report.summary, failures: report.failures }));
  }
}
