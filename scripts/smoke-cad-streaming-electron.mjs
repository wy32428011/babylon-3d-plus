import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';

// 自动化仅替代文件选择对话框；复制、协议、Worker、store 和 GPU 全部使用编辑器真实入口。
const workspace = path.resolve(import.meta.dirname, '..');
const inputPath = path.resolve(process.argv[2] ?? process.env.CAD_SMOKE_INPUT
  ?? 'C:/Users/WY/Downloads/4-五期焊接物流配送路线图-26.1.10 (1).dxf');
const artifactRoot = path.resolve(process.env.CAD_SMOKE_ARTIFACTS ?? 'test-artifacts/cad-streaming-electron');
const timeout = Number(process.env.CAD_SMOKE_TIMEOUT_MS ?? 1_800_000);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'cad-streaming-electron-'));
const projectRoot = path.join(temporaryRoot, 'project');
const scenePath = path.join(projectRoot, 'cad.scene.json');
const report = { inputPath, startedAt: new Date().toISOString(), status: 'RUNNING', checks: [], phases: [], metrics: [], rendererGone: [], consoleErrors: [], pageErrors: [], screenshots: [] };
let server, application, page, monitor, sampling = false;
const elapsed = () => Date.now() - Date.parse(report.startedAt);
const check = (name) => { report.checks.push(name); console.log(`[cad-electron] ${name} (${elapsed()} ms)`); };

async function launch() {
  const environment = { ...process.env, VITE_DEV_SERVER_URL: server.resolvedUrls.local[0], OPEN_DEVTOOLS: 'false' };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.EDITOR_ALLOW_SOFTWARE_WEBGL;
  application = await electron.launch({ args: [path.join(workspace, 'dist-electron/main.js'), `--user-data-dir=${path.join(temporaryRoot, 'user-data')}`], cwd: workspace, env: environment, timeout: 60_000 });
  await application.evaluate(({ app, BrowserWindow, dialog }, selected) => {
    globalThis.cadSmokeGone = [];
    globalThis.cadSmokeInput = selected.inputPath;
    const listen = (win) => { win.webContents.setBackgroundThrottling(false); win.webContents.on('render-process-gone', (_event, details) => globalThis.cadSmokeGone.push({ ...details, at: Date.now() })); };
    BrowserWindow.getAllWindows().forEach(listen);
    app.on('browser-window-created', (_event, win) => listen(win));
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.properties?.includes('openDirectory')) return { canceled: false, filePaths: [selected.projectRoot] };
      if (options?.filters?.some((filter) => filter.extensions.includes('dxf'))) return { canceled: false, filePaths: [globalThis.cadSmokeInput] };
      if (options?.filters?.some((filter) => filter.extensions.includes('json'))) return { canceled: false, filePaths: [selected.scenePath] };
      throw new Error(`验收脚本遇到未知选文件对话框：${options?.title ?? ''}`);
    };
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected.scenePath });
  }, { inputPath, projectRoot, scenePath });
  page = await application.firstWindow();
  page.setDefaultTimeout(60_000);
  page.on('pageerror', (error) => report.pageErrors.push({ at: elapsed(), message: error.message }));
  page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push({ at: elapsed(), message: message.text() }); if (message.text().startsWith('[cad-progress]')) console.log(message.text()); });
  await page.getByRole('button', { name: '进入空白编辑器' }).click();
  await page.locator('canvas.scene-canvas').waitFor({ state: 'visible' });
  const transformed = await server.transformRequest('/src/runtime/babylon/createEngine.ts');
  const engineUrl = transformed.code.match(/from\s+['"]([^'"]*@babylonjs_core\.js[^'"]*)['"]/)?.[1];
  assert.ok(engineUrl, '必须从当前 Vite 转译结果定位共享 Babylon Engine');
  await page.evaluate(async (engineUrl) => {
    const { useEditorStore } = await import('/src/editor/store/editorStore.ts');
    const { Engine } = await import(engineUrl);
    const { getCadReferenceLoadStatus } = await import('/src/editor/cad/cadReferenceLoadStatus.ts');
    window.cadSmoke = { store: useEditorStore, engines: Engine, getLoadStatus: getCadReferenceLoadStatus, progress: [], workerStarts: 0, workerStops: 0, workers: new Set(), heartbeat: 0, maxHeartbeatGap: 0 };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); window.cadSmoke.workerStarts++; window.cadSmoke.workers.add(this); }
      terminate() { if (window.cadSmoke.workers.delete(this)) window.cadSmoke.workerStops++; return super.terminate(); }
    };
    useEditorStore.subscribe((state, before) => {
      const progress = state.cadImportProgress;
      if (JSON.stringify(progress) !== JSON.stringify(before.cadImportProgress)) window.cadSmoke.progress.push({ ...progress, at: Date.now() });
      if (progress?.active && Date.now() - (window.cadSmoke.lastProgressLogAt ?? 0) > 15000) {
        window.cadSmoke.lastProgressLogAt = Date.now(); console.info('[cad-progress] ' + progress.percent + '% ' + progress.label + ': ' + progress.detail);
      }
    });
    let last = performance.now();
    window.cadSmoke.timer = setInterval(() => { const now = performance.now(); window.cadSmoke.maxHeartbeatGap = Math.max(window.cadSmoke.maxHeartbeatGap, now - last); last = now; window.cadSmoke.heartbeat++; }, 100);
    useEditorStore.getState().setGridVisible(false);
  }, engineUrl);
  report.gpu = await application.evaluate(async ({ app }) => ({ enabled: app.isHardwareAccelerationEnabled(), features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('complete') }));
  assert.equal(report.gpu.enabled, true);
}

async function sample() {
  if (!application || sampling) return;
  sampling = true;
  try {
    const value = await application.evaluate(({ app }) => ({ at: Date.now(), processes: app.getAppMetrics(), gone: globalThis.cadSmokeGone }));
    report.metrics.push(value);
    for (const event of value.gone ?? []) if (!report.rendererGone.some(old => old.at === event.at)) report.rendererGone.push(event);
  } catch (error) { report.samplingError = String(error); }
  finally { sampling = false; }
}

async function snapshot() {
  return page.evaluate(() => {
    const h = window.cadSmoke, state = h.store.getState();
    const cad = Object.values(state.scene.entities).filter((entity) => entity.components.cadReference);
    const scene = h.engines.Instances.flatMap((engine) => engine.scenes).find(scene => scene.activeCamera);
    const cadDrawMeshes=scene?.meshes.filter(mesh => cad.some(entity=>mesh.name.startsWith(entity.id+'_cadLayer_'))) ?? [];
    const worldBounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
    for(const mesh of cadDrawMeshes){mesh.computeWorldMatrix(true);const box=mesh.getBoundingInfo().boundingBox;
      for(let i=0;i<3;i++){const key=['x','y','z'][i];worldBounds.min[i]=Math.min(worldBounds.min[i],box.minimumWorld[key]);worldBounds.max[i]=Math.max(worldBounds.max[i],box.maximumWorld[key]);}}
    const drawDiagnostics=cadDrawMeshes.slice(0,5).map(mesh=>({name:mesh.name,isVisible:mesh.isVisible,visibility:mesh.visibility,ready:mesh.isReady(),matrix:mesh._thinInstanceDataStorage.matrixData?.slice(0,16),positions:mesh.getVerticesData('position')?.slice(0,12)}));
    return { worldBounds, drawDiagnostics, cad, progress: state.cadImportProgress, logs: state.logs.slice(0, 15), workers: h.workers.size, workerStarts: h.workerStarts, workerStops: h.workerStops,
      camera: scene?.activeCamera ? {mode:scene.activeCamera.mode,radius:scene.activeCamera.radius,ortho:[scene.activeCamera.orthoLeft,scene.activeCamera.orthoRight,scene.activeCamera.orthoTop,scene.activeCamera.orthoBottom],target:scene.activeCamera.target?.asArray(),position:scene.activeCamera.position.asArray(),minZ:scene.activeCamera.minZ,maxZ:scene.activeCamera.maxZ} : null, heartbeat: h.heartbeat, maxHeartbeatGapMs: h.maxHeartbeatGap, meshes: scene?.meshes.length, geometries: scene?.geometries.length,
      cadMeshes: scene?.meshes.filter((mesh) => cad.some((entity) => mesh.name.startsWith(entity.id + "_cadLayer_")) && mesh.getTotalVertices() > 0).map((mesh) => ({ name: mesh.name, vertices: mesh.getTotalVertices(), instances: mesh.thinInstanceCount, enabled: mesh.isEnabled() })) };
  });
}

async function waitReady(id) {
  await page.waitForFunction((id) => {
    const status = window.cadSmoke.getLoadStatus(id);
    if (status?.state === 'error' || status?.error) throw new Error(status.error ?? status.detail);
    return status?.state === 'ready';
  }, id, { timeout });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function capture(name) {
  const buffer = await page.locator('canvas.scene-canvas').screenshot({ path: path.join(artifactRoot, `${name}.png`), timeout: 60_000 });
  const pixels = await page.evaluate(async (base64) => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let cyan = 0, minX=canvas.width, minY=canvas.height, maxX=-1, maxY=-1;
    for (let i = 0; i < data.length; i += 4) {
      const pixel=i/4, x=pixel%canvas.width, y=Math.floor(pixel/canvas.width);
      if ((x < 170 && y < 45) || (x > canvas.width-165 && y < 190)) { data[i]=data[i+1]=data[i+2]=0; continue; }
      if (data[i+1]>75 && data[i+2]>75 && data[i+1]>data[i]*1.4 && data[i+2]>data[i]*1.4) {
        cyan++; minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y);
      }
    }
    const digest=await crypto.subtle.digest('SHA-256',data);
    const cadHash=Array.from(new Uint8Array(digest), value=>value.toString(16).padStart(2,'0')).join('');
    const glCanvas = document.querySelector('canvas.scene-canvas'), gl = glCanvas.getContext('webgl2') ?? glCanvas.getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return { cyan, cadHash, cadPixelBounds:{minX,minY,maxX,maxY}, lost: gl?.isContextLost(), renderer: gl && gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER), error: gl?.getError() };
  }, buffer.toString('base64'));
  report.lastPixelProbe=pixels;
  assert.equal(pixels.lost, false, 'WebGL 上下文不能丢失');
  assert.equal(pixels.error, 0, 'WebGL 不能出现错误');
  assert.doesNotMatch(pixels.renderer ?? '', /swiftshader|llvmpipe|software|basic render/i, '必须使用硬件 GPU');
  assert.ok(pixels.cyan > 100, '排除 HUD 后截图必须包含真实 CAD 青色线稿');
  if (name==='full-drawing') {
    const width=pixels.cadPixelBounds.maxX-pixels.cadPixelBounds.minX, height=pixels.cadPixelBounds.maxY-pixels.cadPixelBounds.minY;
    assert.ok(Math.max(width,height)>100 && width*height>1000, '图纸应覆盖可检查区域；轨道视角下地面图纸允许较扁的投影');
    const state=report.focused, bounds=state.worldBounds;
    const center=bounds.min.map((min,i)=>(min+bounds.max[i])/2);
    assert.ok(state.camera.target.every((value,i)=>Math.abs(value-center[i])<0.05), '相机聚焦必须对准全部 CAD 实例的世界中心');
    const radius=Math.hypot(...bounds.max.map((max,i)=>(max-bounds.min[i])/2));
    assert.ok(state.camera.radius>=radius*0.5 && state.camera.radius<=radius*5, '相机距离必须依据图纸世界尺寸，不能依据远处的原型坐标');
  }
  const hash = createHash('sha256').update(buffer).digest('hex'); report.screenshots.push({ name, hash, ...pixels }); return pixels.cadHash;
}

async function cancelImport(phase) {
  const before = await snapshot();
  await page.evaluate(() => { window.cadSmoke.pending = window.cadSmoke.store.getState().importCadReference(); });
  await page.waitForFunction((phase) => {
    const h = window.cadSmoke, state = h.store.getState();
    return state.cadImportProgress?.active && (phase === 'parse' ? h.workers.size > 0 : /构建|场景|绘制/.test(state.cadImportProgress.label));
  }, phase, { timeout });
  await page.evaluate(() => window.cadSmoke.store.getState().cancelCadImport());
  await page.evaluate(() => window.cadSmoke.pending);
  await page.waitForFunction(() => !window.cadSmoke.store.getState().cadImportProgress?.active && window.cadSmoke.workers.size === 0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await snapshot();
  assert.equal(after.cad.length, before.cad.length, `${phase}取消不能保留新 CAD 实体`);
  assert.equal(after.cadMeshes.length, before.cadMeshes.length, `${phase}取消必须释放临时 mesh`);
  report[`${phase}Cancellation`] = after; check(`cancel-${phase}-cleanup`);
}

try {
  await mkdir(projectRoot); await mkdir(artifactRoot, { recursive: true });
  report.bytes = (await stat(inputPath)).size;
  server = await createServer({ root: workspace, cacheDir: path.join(temporaryRoot, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'warn' });
  await server.listen(); await launch();
  monitor = setInterval(() => void sample(), 1000);
  const emptyHash = createHash('sha256').update(await page.locator('canvas.scene-canvas').screenshot()).digest('hex');
  if (report.bytes < 64 * 1024 * 1024) {
    // 小图调试也覆盖真实大文件 Worker 取消，不要求用户额外提供大图。
    const parseFixture = path.join(temporaryRoot, 'cancel-parse.dxf');
    const file = await open(parseFixture, 'w');
    try {
      await file.write('0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n');
      const comments = `999\n${'stream cancellation fixture '.repeat(1500)}\n`.repeat(25);
      for (let i = 0; i < 68; i++) await file.write(comments);
      await file.write('0\nLINE\n8\nfixture\n10\n0\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n');
    } finally { await file.close(); }
    await application.evaluate((_electron, selected) => { globalThis.cadSmokeInput = selected; }, parseFixture);
    await cancelImport('parse');
    await application.evaluate((_electron, selected) => { globalThis.cadSmokeInput = selected; }, inputPath);
  } else await cancelImport('parse');
  report.phases.push({ name: 'import-start', at: elapsed() });
  await page.evaluate(() => { window.cadSmoke.pending = window.cadSmoke.store.getState().importCadReference(); });
  await page.waitForFunction(() => Object.values(window.cadSmoke.store.getState().scene.entities).some((entity) => entity.components.cadReference), null, { timeout });
  const id = (await snapshot()).cad[0].id; await waitReady(id);
  await page.evaluate(() => window.cadSmoke.pending);
  report.imported = await snapshot(); report.phases.push({ name: 'first-frame', at: elapsed() });
  assert.equal(report.imported.cad.length, 1); assert.ok(report.imported.cadMeshes.length > 0); assert.equal(report.imported.workers, 0);
  assert.equal(report.imported.progress?.active ?? false, false);
  const reference = report.imported.cad[0].components.cadReference;
  assert.ok(reference.pointCount > 0 && reference.polylineCount > 0); assert.equal(reference.budgetLimited ?? false, false);
  await page.evaluate((id) => { const state = window.cadSmoke.store.getState(); state.selectEntity(id); state.toggleEntityLocked(id); state.updateSelectedCadReference({ lineColor: '#00ffff', opacity: 0.8 }); state.toggleEntityLocked(id); state.requestSceneFocusForSelection([id]); state.selectEntity(null); }, id);
  await page.waitForTimeout(1200); report.focused=await snapshot(); assert.notEqual(await capture('full-drawing'), emptyHash); check('full-import-first-frame');
  const box = await page.locator('canvas.scene-canvas').boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -600); await page.waitForTimeout(600);
  const zoom = await capture('zoom'); const beforePan=await snapshot(); await page.mouse.down({ button: 'middle' }); await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 4, { steps: 15 }); await page.mouse.up({ button: 'middle' }); await page.waitForTimeout(500); const afterPan=await snapshot(); report.panCamera={before:beforePan.camera,after:afterPan.camera}; assert.ok(afterPan.camera.target.some((value,i)=>Math.abs(value-beforePan.camera.target[i])>0.001), '中键平移必须实际移动相机目标点');
  assert.notEqual(await capture('pan'), zoom, '平移必须改变实际画面'); check('zoom-pan-pixels');
  assert.equal(await page.evaluate(() => window.cadSmoke.store.getState().saveScene()), true); const saved = JSON.parse(await readFile(scenePath, 'utf8')); report.saved = { bytes: (await stat(scenePath)).size, reference }; assert.ok(saved.scene ?? saved);
  report.importProgress = await page.evaluate(() => window.cadSmoke.progress);
  await sample(); await application.close(); application = null; await launch();
  report.phases.push({ name: 'reopen-start', at: elapsed() }); assert.equal(await page.evaluate(() => window.cadSmoke.store.getState().loadScene()), true); await waitReady(id); report.reopened = await snapshot();
  assert.deepEqual(report.reopened.cad[0].components.cadReference, { ...reference, lineColor: '#00ffff', opacity: 0.8 });
  await page.evaluate((id) => { const s = window.cadSmoke.store.getState(); s.requestSceneFocusForSelection([id]); s.selectEntity(null); }, id); await page.waitForTimeout(1200); await page.evaluate(() => window.cadSmoke.store.getState().toggleCameraStandardView('top')); await page.waitForTimeout(600); await capture('reopened'); check('saved-reopened-project-copy');
  // 构建阶段取消使用独立小图，避免重复读取原始 1.46 GB 图纸。
  const cancellationFixture = path.join(temporaryRoot, 'cancel-build.dxf');
  const fixtureEntities = Array.from({ length: 30_000 }, (_, i) => `0\nLINE\n8\nfixture\n10\n${i % 200}\n20\n${Math.floor(i / 200)}\n30\n0\n11\n${i % 200 + 0.5}\n21\n${Math.floor(i / 200) + 0.5}\n31\n0\n`).join('');
  await writeFile(cancellationFixture, `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${fixtureEntities}0\nENDSEC\n0\nEOF\n`);
  await application.evaluate((_electron, selected) => { globalThis.cadSmokeInput = selected; }, cancellationFixture);
  await cancelImport('build');
  await page.evaluate((id) => { const s = window.cadSmoke.store.getState(); window.cadSmoke.deletedId = id; s.selectEntity(id); if (s.scene.entities[id]?.locked) s.toggleEntityLocked(id); s.deleteSelectedEntity(); }, id);
  await page.waitForFunction(() => { const h = window.cadSmoke, cadIds = Object.values(h.store.getState().scene.entities).filter(e => e.components.cadReference); return cadIds.length === 0 && h.workers.size === 0 && h.engines.Instances.every(engine => engine.scenes.every(scene => scene.meshes.every(mesh => !mesh.name.startsWith(window.cadSmoke.deletedId + "_cadLayer_")))); });
  report.deleted = await snapshot(); assert.equal(report.deleted.cadMeshes.length, 0); check('delete-mesh-worker-cleanup');
  await sample(); assert.equal(report.rendererGone.length, 0, '不能发生 render-process-gone'); assert.equal(report.pageErrors.length, 0, 'renderer不能有未处理异常'); report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack ?? String(error); process.exitCode = 1;
  try { await page?.screenshot({ path: path.join(artifactRoot, 'failure.png'), timeout: 5000 }); report.failureState = await snapshot(); } catch { /* 进程退出时保留主进程诊断。 */ }
} finally {
  clearInterval(monitor); await sample();
  report.cleanupErrors = [];
  try { await application?.close(); } catch (error) { report.cleanupErrors.push(String(error)); }
  try { await server?.close(); } catch (error) { report.cleanupErrors.push(String(error)); }
  report.finishedAt = new Date().toISOString(); report.elapsedMs = elapsed();
  // 只删除本脚本创建且确认位于系统 temp 下的项目、用户数据和 1.46 GB 副本。
  assert.equal(path.dirname(temporaryRoot), path.resolve(tmpdir())); assert.ok(path.basename(temporaryRoot).startsWith('cad-streaming-electron-'));
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (report.cleanupErrors.length) { report.status = 'FAIL'; process.exitCode = 1; }
  await mkdir(artifactRoot, { recursive: true }); await writeFile(path.join(artifactRoot, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ status: report.status, elapsedMs: report.elapsedMs, artifactRoot, checks: report.checks, error: report.error }, null, 2));
}
