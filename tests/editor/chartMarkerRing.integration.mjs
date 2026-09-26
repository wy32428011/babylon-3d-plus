import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/chart-marker-ring-media');
await mkdir(output, { recursive: true });
const moduleSource = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Engine,Scene,FreeCamera,MeshBuilder,StandardMaterial,Vector3,Matrix} from '@babylonjs/core';
import {ChartMarkerPresentation} from '/src/runtime/babylon/ChartMarkerPresentation.ts';
import {DataPlatformScreenOverlay} from '/src/runtime/babylon/DataPlatformScreenOverlay.tsx';
import {CHART_MARKER_DEFAULTS} from '/src/editor/model/chartMarker.ts';
const canvas=document.querySelector('#scene'),engine=new Engine(canvas,true,{preserveDrawingBuffer:true,stencil:true}),scene=new Scene(engine);
scene.clearColor.set(.025,.055,.095,1);
const camera=new FreeCamera('camera',new Vector3(8,7,-12),scene);camera.setTarget(new Vector3(0,2,0));camera.minZ=.1;
const mesh=MeshBuilder.CreateGround('marker',{width:2,height:2,updatable:true},scene);mesh.scaling.set(2,1.125,1);mesh.position.y=1.125;
mesh.material=new StandardMaterial('original',scene);mesh.material.backFaceCulling=false;
const cube=MeshBuilder.CreateBox('hole-reference',{size:1},scene);cube.position.y=-1;cube.material=new StandardMaterial('reference',scene);cube.material.disableLighting=true;cube.material.emissiveColor.set(.1,.75,.3);
let style={...CHART_MARKER_DEFAULTS,panelShape:'ring',ringRadius:3,backgroundColor:'#123456',text:'RING DISPLAY',faceCamera:false};
let url='',visible=true,interactive=true;const presentation=new ChartMarkerPresentation();
const runtime={getDataPlatformScreenOverlayItems(){presentation.update(mesh,style,visible);mesh.setEnabled(visible);return visible?[{entityId:'ring',name:'环形测试',chartMarker:true,mesh,markerStyle:style,markerText:style.text,screenUrl:url}]:[];}};
const root=createRoot(document.querySelector('#react'));function render(){root.render(React.createElement(DataPlatformScreenOverlay,{scene,runtime,canvas,interactive}));}render();engine.runRenderLoop(()=>scene.render());
window.fixture={scene,engine,camera,mesh,root,cube,setStyle(patch){style={...style,...patch};},setSource(value){url=value;},setVisible(value){visible=value;},project(x=0,y=2,z=-3){const p=Vector3.Project(new Vector3(x,y,z),Matrix.Identity(),scene.getTransformMatrix(),camera.viewport.toGlobal(engine.getRenderWidth(),engine.getRenderHeight()));return{x:p.x,y:p.y};},settle(){return new Promise(resolve=>{let n=0;const observer=scene.onAfterRenderObservable.add(()=>{if(++n===5){scene.onAfterRenderObservable.remove(observer);resolve();}});});},dispose(){root.unmount();presentation.remove(mesh);scene.dispose();engine.dispose();}};
`;
const iframeHtml = `<!doctype html><html><body style="margin:0;background:#20b060"><canvas id="chart" width="1280" height="720"></canvas><button id="change" style="position:absolute;left:40%;top:45%;padding:20px">切换蓝色</button><script>
let color='#20b060';window.frameRequests=0;window.clicked=0;
document.querySelector('#change').onclick=()=>{color='#2050d0';window.clicked++;document.body.style.background=color;};
addEventListener('message',e=>{if(e.source!==parent||e.data?.channel!=='babylon-chart-marker-surface'||e.data.type!=='request-frame')return;frameRequests++;const c=document.querySelector('#chart');c.width=e.data.width;c.height=e.data.height;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,c.width,c.height);x.fillStyle='white';x.font='64px sans-serif';x.fillText('LIVE '+frameRequests,40,110);parent.postMessage({channel:e.data.channel,version:1,type:'frame',requestId:e.data.requestId,width:c.width,height:c.height,dataUrl:c.toDataURL()},e.origin);});
</script></body></html>`;
const harness = path.join(output, 'media.html');
const bundleDir = path.join(output, 'bundle');
await writeFile(harness, '<!doctype html><html><body style="margin:0"><div style="position:relative;width:100vw;height:100vh"><canvas id="scene" style="width:100%;height:100%;display:block"></canvas><div id="react"></div></div><script type="module" src="/__ring__.tsx"></script></body></html>');
await build({configFile:false,base:'/',logLevel:'warn',plugins:[react(),{
  name:'ring-media-fixture',resolveId(id){if(id==='/__ring__.tsx')return '\0ring-media.tsx';},load(id){if(id==='\0ring-media.tsx')return moduleSource;},
}],build:{outDir:bundleDir,emptyOutDir:false,copyPublicDir:false,minify:false,rollupOptions:{input:harness}}});
const server=await preview({configFile:false,build:{outDir:bundleDir},preview:{host:'127.0.0.1',port:0,strictPort:false}});
let browser;
const errors=[];
try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1200,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  const html=await readFile(path.join(bundleDir,path.relative(process.cwd(),harness)),'utf8');
  await page.route('**/__ring_test__',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.route('**/__ring_source__*',r=>r.fulfill({contentType:'text/html',body:iframeHtml}));
  await page.goto(server.resolvedUrls.local[0]+'__ring_test__',{waitUntil:'commit'});
  await page.waitForFunction(()=>window.fixture,{},{timeout:120000});
  const settle=()=>page.evaluate(()=>window.fixture.settle());
  await settle();
  await page.screenshot({path:path.join(output,'01-native-ring.png')});
  async function pixel(point){const png=await page.screenshot();return page.evaluate(async({data,point})=>{const i=new Image();i.src='data:image/png;base64,'+data;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const x=c.getContext('2d');x.drawImage(i,0,0);return [...x.getImageData(Math.round(point.x),Math.round(point.y),1,1).data];},{data:png.toString('base64'),point});}
  const point=await page.evaluate(()=>window.fixture.project(0,1.8,-3));
  const native=await pixel(point);
  assert.ok(native[2]>native[1]&&native[1]>native[0]&&native[2]>50,'曲面背景确实进入WebGL像素: '+native);
  await page.evaluate(()=>{const f=window.fixture;f.setStyle({appearance:'none'});f.camera.position.set(0,12,0);f.camera.upVector.set(0,0,1);f.camera.setTarget(new (f.camera.position.constructor)(0,0,0));});
  await settle();
  const hole=await pixel({x:600,y:450});
  assert.ok(hole[1]>120&&hole[1]>hole[2]*1.5,'俯视中心镂空可见下方绿色参考块: '+hole);
  await page.screenshot({path:path.join(output,'02-open-center.png')});
  await page.evaluate(url=>{const f=window.fixture;f.camera.position.set(8,7,-12);f.camera.upVector.set(0,1,0);f.camera.setTarget(new (f.camera.position.constructor)(0,2,0));f.setSource(url);f.setStyle({contentType:'screen',appearance:'line'});},server.resolvedUrls.local[0]+'__ring_source__');
  await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.frameRequests>=2,{},{timeout:15000});
  await settle();
  assert.equal(await page.locator('iframe').count(),1,'一圈只加载一个大屏');
  const green=await pixel(point);
  assert.ok(green[1]>100&&green[1]>green[2]*1.4,'实时iframe帧映射到曲面: '+green);
  await page.screenshot({path:path.join(output,'03-live-screen.png')});
  await page.mouse.dblclick(point.x,point.y);
  await page.getByRole('dialog',{name:'环形屏原始内容'}).waitFor();
  const before=await page.locator('iframe').evaluate(el=>el.contentWindow.frameRequests);
  await page.frameLocator('iframe').locator('#change').click();
  await page.getByRole('button',{name:'关闭环形屏原始内容'}).click();
  await page.waitForFunction(previous=>document.querySelector('iframe')?.contentWindow?.frameRequests>previous,before,{timeout:10000});
  await settle();
  assert.equal(await page.locator('iframe').evaluate(el=>el.contentWindow.clicked),1,'展开/关闭保持同一个页面状态');
  const blue=await pixel(point);
  assert.ok(blue[2]>120&&blue[2]>blue[1]*1.4,'原页面交互更新仍回到环形屏: '+blue);
  // 使用 Playwright 的视频录制器，避免 headless Chrome 的 captureStream 不产出帧。
  const videoPage=await browser.newPage({viewport:{width:320,height:180},recordVideo:{dir:path.join(output,'video-fixture'),size:{width:320,height:180}}});
  await videoPage.setContent('<body style="margin:0;background:#c020b0"><span style="color:white">VIDEO</span></body>');
  await videoPage.screenshot();
  await videoPage.waitForTimeout(1000);
  const recording=videoPage.video();
  await videoPage.close();
  const videoBytes=await readFile(await recording.path());
  assert.ok(videoBytes.length>1000, '录制夹具必须包含有效视频帧');
  await page.route('**/__ring_video__.webm',r=>r.fulfill({contentType:'video/webm',body:Buffer.from(videoBytes)}));
  await page.evaluate(url=>{window.fixture.setSource(url);window.fixture.setStyle({contentType:'video',videoLoop:true});},server.resolvedUrls.local[0]+'__ring_video__.webm');
  await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2 && document.querySelector('video').currentTime>.1,{},{timeout:15000}).catch(async error=>{
    console.error(await page.evaluate(()=>{const v=document.querySelector('video');return {video:v?{src:v.src,ready:v.readyState,time:v.currentTime,paused:v.paused,error:v.error?.message,html:v.outerHTML}:null,status:document.querySelector('[data-chart-marker-video-status]')?.textContent};}));
    throw error;
  });
  await settle();
  const video=await pixel(point);
  assert.ok(video[0]>140&&video[2]>100&&video[1]<100,'视频帧进入真实环形纹理: '+video);
  await page.screenshot({path:path.join(output,'04-video-ring.png')});
  await page.evaluate(()=>window.fixture.setVisible(false));await settle();
  assert.equal(await page.locator('iframe').count(),0,'隐藏释放源页面');
  assert.equal(await page.evaluate(()=>window.fixture.scene.textures.filter(t=>t.name==='chart-marker-transparent-content').length),0,'隐藏释放画面纹理');
  await page.evaluate(()=>{window.fixture.setVisible(true);window.fixture.setStyle({panelShape:'plane',contentType:'builtin'});});await settle();
  assert.equal(await page.evaluate(()=>window.fixture.mesh.getTotalVertices()),4,'切回矩形恢复四角');
  await page.evaluate(()=>window.fixture.dispose());
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'result.json'),JSON.stringify({native,hole,green,blue,video,errors,passed:true},null,2));
  console.log('环形原生纹理、中心镂空、单iframe实时更新、视频纹理、原页面交互、隐藏释放和平面恢复验证通过');
} finally {
  await browser?.close();
  await new Promise((resolve,reject)=>server.httpServer.close(error=>error?reject(error):resolve()));
}
