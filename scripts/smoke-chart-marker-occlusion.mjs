import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const outputDir = path.resolve('output/playwright/chart-marker-occlusion');
await mkdir(outputDir, { recursive: true });
const server = await createServer({
  cacheDir: path.join(outputDir, 'vite-cache'),
  server: { port: 0, strictPort: false, hmr: false },
  plugins: [{ name: 'occlusion-fixture',
    resolveId(id) { if (id === '/__occlusion_harness__.tsx') return '\0occlusion-harness.tsx'; },
    load(id) { if (id === '\0occlusion-harness.tsx') return harness.split('<script type="module">')[1].split('</script>')[0]; },
  }],
});
let browser;
let page;
const errors = [];
const fixture = `<!doctype html><html><body style="margin:0;background:#20c080;width:100vw;height:100vh"><script>window.ticks=0;window.clicks=0;setInterval(()=>window.ticks++,100);document.body.onclick=()=>window.clicks++;</script></body></html>`;
const harness = `<!doctype html><html><body style="margin:0"><div style="position:relative;width:100vw;height:100vh;background:#141414"><canvas id="scene" style="display:block;width:100%;height:100%;background:#151515"></canvas><div id="react"></div></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Engine, Scene, FreeCamera, MeshBuilder, StandardMaterial, Vector3, Matrix } from '@babylonjs/core';
import { DataPlatformScreenOverlay } from '/src/runtime/babylon/DataPlatformScreenOverlay.tsx';
import { ChartMarkerDepthSurface } from '/src/runtime/babylon/ChartMarkerDepthSurface.ts';
const metrics={frames:0,pixels:0,durations:[]};let readingInteraction=false;
const originalUpdate=ChartMarkerDepthSurface.prototype.updateInteraction;
ChartMarkerDepthSurface.prototype.updateInteraction=function(...args){const start=performance.now();readingInteraction=true;try{return originalUpdate.apply(this,args);}finally{readingInteraction=false;metrics.frames++;metrics.durations.push(performance.now()-start);}};
const originalRead=CanvasRenderingContext2D.prototype.getImageData;
CanvasRenderingContext2D.prototype.getImageData=function(...args){if(readingInteraction)metrics.pixels+=args[2]*args[3];return originalRead.apply(this,args);};
const canvas=document.querySelector('#scene');
const engine=new Engine(canvas,true,{preserveDrawingBuffer:false,stencil:true});
const scene=new Scene(engine);scene.clearColor.set(.08,.08,.09,1);
const camera=new FreeCamera('camera',new Vector3(0,0,8),scene);camera.setTarget(Vector3.Zero());camera.minZ=.1;
// Overlay 的局部平面范围是 [-1, 1]；尺寸使用实体缩放。
const plane=MeshBuilder.CreateGround('marker',{width:2,height:2},scene);plane.scaling.set(2,1,1.125);plane.rotation.x=Math.PI/2;
plane.material=new StandardMaterial('screen',scene);plane.material.backFaceCulling=false;
const pillar=MeshBuilder.CreateBox('pillar',{width:1,height:4,depth:.5},scene);pillar.position.z=2;
const material=new StandardMaterial('pillar',scene);material.disableLighting=true;material.emissiveColor.set(208/255,64/255,48/255);pillar.material=material;
let screenUrl='http://screen.fixture.test/live';
const extra=[];
let canvasClicks=0;canvas.addEventListener('pointerdown',()=>canvasClicks++);
const runtime={getDataPlatformScreenOverlayItems:()=>[...(plane.isEnabled()?[{entityId:'marker',name:'遮挡回归',chartMarker:true,mesh:plane,screenUrl}]:[]),...extra]};
const root=createRoot(document.querySelector('#react'));
const mount=(interactive)=>root.render(React.createElement(DataPlatformScreenOverlay,{scene,runtime,canvas,interactive}));
mount(false);engine.runRenderLoop(()=>scene.render());
window.fixture={engine,scene,camera,plane,pillar,mount,root,metrics,extra,setScreenUrl(v){screenUrl=v;},get canvasClicks(){return canvasClicks;},addCrossingScreen(){
const mesh=MeshBuilder.CreateGround('second',{width:2,height:2},scene);mesh.scaling.copyFrom(plane.scaling);mesh.rotation.set(Math.PI/2,Math.PI/4,0);mesh.material=plane.material.clone('second-original');
extra.push({entityId:'second',name:'交叉立标',chartMarker:true,mesh,screenUrl:'http://screen.fixture.test/second'});return mesh;},project(x=0,y=0,z=0){const p=Vector3.Project(new Vector3(x,y,z),Matrix.Identity(),scene.getTransformMatrix(),camera.viewport.toGlobal(engine.getRenderWidth(),engine.getRenderHeight()));return {x:p.x,y:p.y};}};
window.addEventListener('resize',()=>engine.resize());
</script></body></html>`;

async function pixels(points) {
  const png = await page.screenshot();
  return page.evaluate(async ({ data, points }) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    return points.map(({ x, y }) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data]);
  }, { data: png.toString('base64'), points });
}
const isGreen = (p) => p[1] > 150 && p[0] < 80;
const isPillar = (p) => p[0] > 150 && p[1] < 110;
async function check(message, predicates, points) {
  const values = await pixels(points);
  assert.ok(values.every((v, i) => predicates[i](v)), `${message}: ${JSON.stringify(values)}`);
}
async function settle() { await page.evaluate(() => new Promise(r => { let n=0; const o=window.fixture.scene.onAfterRenderObservable.add(()=>{if(++n===3){window.fixture.scene.onAfterRenderObservable.remove(o);r();}}); })); }

try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
  await page.route('http://screen.fixture.test/live', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.route('http://screen.fixture.test/second', route => route.fulfill({ contentType: 'text/html', body: fixture.replace('#20c080','#2870e0') }));
  const transformedHarness = await server.transformIndexHtml('/__occlusion_test__', harness.replace(/<script type="module">[\s\S]*?<\/script>/, '<script type="module" src="/__occlusion_harness__.tsx"></script>'));
  await page.route('**/__occlusion_test__', route => route.fulfill({ contentType: 'text/html', body: transformedHarness }));
  console.log('Loading occlusion fixture');
  await page.goto(server.resolvedUrls.local[0] + '__occlusion_test__', { waitUntil: 'commit' });
  console.log('Waiting for live screen');
  const iframe = page.locator('[data-screen-entity-id="marker"] iframe');
  await iframe.waitFor({ timeout: 90_000 });
  const frame = await iframe.elementHandle().then(h=>h.contentFrame());
  await frame.waitForFunction(()=>window.ticks>2);
  console.log('Checking partial occlusion');
  await settle();
  const points = await page.evaluate(()=>[-1.4,0,1.4].map(x=>window.fixture.project(x)));
  await page.screenshot({ path: path.join(outputDir, 'partial.png') });
  await check('柱子应仅遮住立标中央，两侧仍显示实时网页', [isGreen,isPillar,isGreen], points);
  await page.evaluate(()=>window.fixture.pillar.scaling.x=8);await settle();
  await check('完全挡住立标时网页不得穿透', [isPillar,isPillar,isPillar], points);
  await page.evaluate(()=>{window.fixture.pillar.scaling.x=1;window.fixture.pillar.position.z=-2;});await settle();
  await check('位于立标后方的柱子不能遮住网页', [isGreen,isGreen,isGreen], points);
  await page.evaluate(()=>{window.fixture.pillar.position.z=2;window.fixture.pillar.isPickable=false;window.fixture.mount(true);});await settle();
  const clicks=await frame.evaluate(()=>window.clicks);
  await page.mouse.click(points[0].x,points[0].y);
  assert.equal(await frame.evaluate(()=>window.clicks),clicks+1,'可见区域应可操作跨域大屏');
  await page.mouse.click(points[1].x,points[1].y);
  assert.equal(await frame.evaluate(()=>window.clicks),clicks+1,'从 iframe 内移到遮挡区域也不得穿透点击锁定柱子');
  await page.mouse.click(points[2].x,points[2].y);
  assert.equal(await frame.evaluate(()=>window.clicks),clicks+2);
  await page.evaluate(()=>{window.fixture.camera.position.x=3;window.fixture.camera.setTarget(window.fixture.plane.position);});await settle();
  const angled=await page.evaluate(()=>[window.fixture.project(1.6),window.fixture.project(0,0,2)]);
  await check('转动视角后遮挡边界随模型移动', [isGreen,isPillar], angled);
  await page.screenshot({ path: path.join(outputDir, 'angled.png') });
  const ticks=await frame.evaluate(()=>window.ticks);await frame.waitForFunction(n=>window.ticks>n,ticks);
  await page.evaluate(()=>window.fixture.setScreenUrl(undefined));await settle();
  await iframe.waitFor({state:'detached'});
  const canvasClicks=await page.evaluate(()=>window.fixture.canvasClicks);
  await page.mouse.click(angled[0].x,angled[0].y);
  assert.equal(await page.evaluate(()=>window.fixture.canvasClicks),canvasClicks+1,'空立标仍应接收场景相机操作');
  await page.evaluate(()=>{const f=window.fixture;f.setScreenUrl('http://screen.fixture.test/live');f.camera.position.set(0,0,8);f.camera.setTarget(f.plane.position);f.pillar.setEnabled(false);f.addCrossingScreen();});
  const secondIframe=page.locator('[data-screen-entity-id="second"] iframe');await secondIframe.waitFor();
  const secondFrame=await secondIframe.elementHandle().then(h=>h.contentFrame());await secondFrame.waitForFunction(()=>window.ticks>2);await settle();
  const crossingPoints=await page.evaluate(()=>[-.8,.8].map(x=>window.fixture.project(x)));
  await check('交叉立标按各自可见深度显示，不依赖中心排序',[p=>p[2]>150&&p[0]<100,isGreen],crossingPoints);
  await page.screenshot({path:path.join(outputDir,'crossing.png')});
  const secondClicks=await secondFrame.evaluate(()=>window.clicks);
  await page.mouse.click(crossingPoints[0].x,crossingPoints[0].y);
  assert.equal(await secondFrame.evaluate(()=>window.clicks),secondClicks+1,'交叉部分应操作位于前方的大屏');
  await page.evaluate(()=>{const f=window.fixture;f.setScreenUrl(undefined);f.plane.position.z=2;});await settle();
  await iframe.waitFor({state:'detached'});
  const coveredClicks=await page.evaluate(()=>window.fixture.canvasClicks);
  await page.mouse.click(crossingPoints[0].x,crossingPoints[0].y);
  assert.equal(await page.evaluate(()=>window.fixture.canvasClicks),coveredClicks+1,'前方空牌应挡住后方网页点击并保留场景操作');
  await page.evaluate(()=>{const f=window.fixture;f.setScreenUrl('http://screen.fixture.test/live');f.plane.position.set(-2.8,0,0);f.plane.scaling.set(.7,1,.4);f.extra[0].mesh.position.x=2.8;f.extra[0].mesh.scaling.set(.7,1,.4);f.extra[0].mesh.rotation.y=0;});
  await iframe.waitFor();const reboundFrame=await iframe.elementHandle().then(h=>h.contentFrame());await reboundFrame.waitForFunction(()=>window.ticks>2);await settle();
  const perf=await page.evaluate(()=>new Promise(resolve=>{const f=window.fixture;f.metrics.frames=0;f.metrics.pixels=0;f.metrics.durations=[];const observer=f.scene.onAfterRenderObservable.add(()=>{if(f.metrics.frames>=20){f.scene.onAfterRenderObservable.remove(observer);resolve({...f.metrics,area:innerWidth*innerHeight});}});}));
  assert.ok(perf.pixels/perf.frames<perf.area*.15,'分散小立标不应按总包围盒读取整片视口');
  console.log(JSON.stringify({interactionAverageMs:perf.durations.reduce((a,b)=>a+b,0)/perf.frames,readPixelsPerFrame:perf.pixels/perf.frames,viewportPixels:perf.area}));
  await page.evaluate(()=>window.fixture.plane.setEnabled(false));await settle();
  await iframe.waitFor({ state:'detached' });
  await page.evaluate(()=>window.fixture.root.unmount());
  assert.equal(await page.locator('#scene').evaluate(c=>c.style.clipPath),'','卸载时还原 canvas');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks:['partial','full','behind','cross-origin input','locked occluder','camera move','live updates','empty screen input','crossing screens','empty front screen input','separated readback regions','dispose'],screenshots:outputDir}));
} catch(error) {
  if(page) await page.screenshot({path:path.join(outputDir,'failure.png')});
  console.error(errors);
  throw error;
} finally {
  await browser?.close();await server.close();
}
