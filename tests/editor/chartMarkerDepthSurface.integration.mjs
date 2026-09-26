import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/chart-marker-depth-surface');
await mkdir(output, { recursive: true });
const harness = path.join(output, 'depth.html');
const bundleDir = path.join(output, 'bundle');
const moduleSource = `
import {Engine,Scene,FreeCamera,HemisphericLight,MeshBuilder,StandardMaterial,Vector3} from '@babylonjs/core';
import {ChartMarkerDepthSurface} from '/src/runtime/babylon/ChartMarkerDepthSurface.ts';
import {waitForSceneRenderReady} from '/src/runtime/babylon/sceneRenderReadiness.ts';
const canvas=document.querySelector('canvas'),engine=new Engine(canvas,true,{preserveDrawingBuffer:true}),scene=new Scene(engine);
new HemisphericLight('light',Vector3.Up(),scene);
const camera=new FreeCamera('first',new Vector3(0,0,-6),scene),second=new FreeCamera('second',new Vector3(0,0,-6),scene),other=new FreeCamera('other',new Vector3(0,0,-6),scene);
for(const item of [camera,second,other])item.setTarget(Vector3.Zero());scene.activeCamera=camera;
const mesh=MeshBuilder.CreatePlane('marker',{width:4,height:2.25},scene);
const original=new StandardMaterial('original',scene),secondPrevious=new StandardMaterial('previous-second-pass',scene),unrelated=new StandardMaterial('unrelated-pass',scene);
for(const item of [secondPrevious,unrelated]){item.disableLighting=true;item.emissiveColor.set(.2,.3,.4);}
mesh.material=original;mesh.setMaterialForRenderPass(second.renderPassId,secondPrevious);mesh.setMaterialForRenderPass(other.renderPassId,unrelated);
const bitmap=document.createElement('canvas');bitmap.width=320;bitmap.height=180;const ctx=bitmap.getContext('2d');ctx.fillStyle='#158aba';ctx.fillRect(0,0,320,180);
const frame={canvas:bitmap,revision:1,ring:true,opaque:true,repeats:3};let visible=true,materialChanges=0;
mesh.onMaterialChangedObservable.add(()=>materialChanges++);
const surface=new ChartMarkerDepthSurface(scene,canvas),contents=new Map([[mesh,frame]]);
const before=scene.onBeforeCameraRenderObservable.add(()=>surface.beginFrame(visible?[mesh]:[],visible?contents:new Map()));
const after=scene.onAfterRenderObservable.add(()=>surface.endFrame());engine.runRenderLoop(()=>scene.render());
async function settle(count=5){await new Promise(resolve=>{let n=0;const observer=scene.onAfterRenderObservable.add(()=>{if(++n===count){scene.onAfterRenderObservable.remove(observer);resolve();}});});}
async function ready(){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),2500);try{await waitForSceneRenderReady(scene,controller.signal);return true;}catch(error){if(error.name==='AbortError')return false;throw error;}finally{clearTimeout(timer);}}
window.fixture={scene,engine,mesh,camera,second,other,original,secondPrevious,unrelated,surface,frame,settle,ready,setVisible(value){visible=value;},get materialChanges(){return materialChanges;},disposeSurface(){scene.onBeforeCameraRenderObservable.remove(before);scene.onAfterRenderObservable.remove(after);surface.dispose();},dispose(){engine.stopRenderLoop();scene.dispose();engine.dispose();}};
`;
await writeFile(harness, '<!doctype html><html><body style="margin:0"><div style="position:relative;width:800px;height:600px"><canvas style="width:800px;height:600px"></canvas></div><script type="module" src="/__depth_fixture__.ts"></script></body></html>');
await build({ configFile: false, base: '/', logLevel: 'warn', plugins: [{
  name: 'marker-depth-fixture', resolveId(id) { if (id === '/__depth_fixture__.ts') return '\0marker-depth-fixture.ts'; },
  load(id) { if (id === '\0marker-depth-fixture.ts') return moduleSource; },
}], build: { outDir: bundleDir, emptyOutDir: false, copyPublicDir: false, minify: false, rollupOptions: { input: harness } } });
const server = await preview({ configFile: false, build: { outDir: bundleDir }, preview: { host: '127.0.0.1', port: 0 } });
let browser;
const errors = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', error => errors.push(error.message));
  const html = await readFile(path.join(bundleDir, path.relative(process.cwd(), harness)), 'utf8');
  await page.route('**/__depth_test__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__depth_test__');
  await page.waitForFunction(() => window.fixture);
  await page.evaluate(() => window.fixture.settle());
  assert.equal(await page.evaluate(() => window.fixture.ready()), true, '同帧前后真实材质就绪，首帧等待应自然完成');
  assert.deepEqual(await page.evaluate(async () => {
    const f = window.fixture, material = f.mesh.getMaterialForRenderPass(f.camera.renderPassId);
    await f.settle(10);
    return { original: f.mesh.material === f.original, stableOverride: material === f.mesh.getMaterialForRenderPass(f.camera.renderPassId),
      ownedOverride: material !== undefined, other: f.mesh.getMaterialForRenderPass(f.other.renderPassId) === f.unrelated,
      second: f.mesh.getMaterialForRenderPass(f.second.renderPassId) === f.secondPrevious, changes: f.materialChanges };
  }), { original: true, stableOverride: true, ownedOverride: true, other: true, second: true, changes: 0 });
  assert.deepEqual(await page.evaluate(async () => {
    const f = window.fixture; f.scene.activeCamera = f.second; await f.settle();
    return { ready: await f.ready(), previousRestored: f.mesh.getMaterialForRenderPass(f.camera.renderPassId) === undefined,
      activeOverride: f.mesh.getMaterialForRenderPass(f.second.renderPassId) !== f.secondPrevious,
      other: f.mesh.getMaterialForRenderPass(f.other.renderPassId) === f.unrelated };
  }), { ready: true, previousRestored: true, activeOverride: true, other: true });
  assert.deepEqual(await page.evaluate(async () => {
    const f = window.fixture; f.mesh.setMaterialForRenderPass(f.camera.renderPassId, f.original);
    f.scene.activeCameras = [f.camera, f.second]; await f.settle();
    const first = f.mesh.getMaterialForRenderPass(f.camera.renderPassId);
    const second = f.mesh.getMaterialForRenderPass(f.second.renderPassId);
    await f.settle(10);
    const result = { firstStable: first === f.mesh.getMaterialForRenderPass(f.camera.renderPassId),
      secondStable: second === f.mesh.getMaterialForRenderPass(f.second.renderPassId),
      bothOwned: first !== undefined && second !== f.secondPrevious,
      other: f.mesh.getMaterialForRenderPass(f.other.renderPassId) === f.unrelated };
    f.frame.canvas.width = 640; f.frame.revision++; await f.settle();
    const resized = f.mesh.getMaterialForRenderPass(f.camera.renderPassId);
    result.resized = resized !== first && resized === f.mesh.getMaterialForRenderPass(f.second.renderPassId);
    f.scene.activeCameras = []; f.scene.activeCamera = f.second; await f.settle();
    result.firstRestored = f.mesh.getMaterialForRenderPass(f.camera.renderPassId) === f.original;
    return result;
  }), { firstStable: true, secondStable: true, bothOwned: true, other: true, resized: true, firstRestored: true });
  assert.deepEqual(await page.evaluate(async () => {
    const f = window.fixture; f.setVisible(false); await f.settle();
    return { restored: f.mesh.getMaterialForRenderPass(f.second.renderPassId) === f.secondPrevious,
      textures: f.scene.textures.filter(texture => texture.name === 'chart-marker-transparent-content').length,
      materials: f.scene.materials.filter(material => material.name === 'chart-marker-transparent-content').length };
  }), { restored: true, textures: 0, materials: 0 });
  assert.deepEqual(await page.evaluate(async () => {
    const f = window.fixture; f.setVisible(true); f.frame.opaque = false; f.frame.ring = false; f.frame.revision++; await f.settle();
    const ready = await f.ready();
    // 宿主在最后一帧后修改覆盖材质，释放时不得覆盖这次外部更新。
    f.mesh.setMaterialForRenderPass(f.second.renderPassId, f.unrelated); f.disposeSurface();
    return { ready, original: f.mesh.material === f.original,
      restored: f.mesh.getMaterialForRenderPass(f.second.renderPassId) === f.unrelated,
      other: f.mesh.getMaterialForRenderPass(f.other.renderPassId) === f.unrelated,
      textures: f.scene.textures.filter(texture => texture.name === 'chart-marker-transparent-content').length,
      materials: f.scene.materials.filter(material => material.name.startsWith('chart-marker-')).length,
      changes: f.materialChanges };
  }), { ready: true, original: true, restored: true, other: true, textures: 0, materials: 0, changes: 0 });
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.fixture.dispose());
  console.log(JSON.stringify({ passed: 6, checks: ['ready-frame', 'stable-material', 'camera-pass-isolation', 'multiple-active-cameras', 'hide-cleanup', 'plane-and-external-override-dispose'] }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
