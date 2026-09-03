import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const outputDir = path.resolve('output/playwright/chart-marker-transparency');
await mkdir(outputDir, { recursive: true });
const moduleSource = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Engine, Scene, FreeCamera, MeshBuilder, StandardMaterial, Vector3, Matrix } from '@babylonjs/core';
import { DataPlatformScreenOverlay } from '/src/runtime/babylon/DataPlatformScreenOverlay.tsx';
import { CHART_MARKER_DEFAULTS } from '/src/editor/model/chartMarker.ts';
const canvas=document.querySelector('#scene');
const engine=new Engine(canvas,true,{preserveDrawingBuffer:false,stencil:true});
const scene=new Scene(engine);scene.clearColor.set(.08,.08,.09,1);
const camera=new FreeCamera('camera',new Vector3(0,0,8),scene);camera.setTarget(Vector3.Zero());camera.minZ=.1;
const plane=MeshBuilder.CreateGround('marker',{width:2,height:2},scene);plane.scaling.set(2,1,1.125);plane.rotation.x=Math.PI/2;
const originalMaterial=new StandardMaterial('screen',scene);originalMaterial.backFaceCulling=false;plane.material=originalMaterial;
function box(name,width,height,z,r,g,b){const mesh=MeshBuilder.CreateBox(name,{width,height,depth:.5},scene);mesh.position.z=z;const material=new StandardMaterial(name,scene);material.disableLighting=true;material.emissiveColor.set(r/255,g/255,b/255);mesh.material=material;return mesh;}
const rear=box('rear',10,8,-2,30,80,220);
const pillar=box('pillar',1,4,2,208,64,48);
let style={...CHART_MARKER_DEFAULTS,contentType:'builtin',backgroundColor:'transparent',text:'',appearance:'none',faceCamera:false,width:320,height:180};
const runtime={getDataPlatformScreenOverlayItems:()=>[{entityId:'marker',name:'透明立标',chartMarker:true,mesh:plane,markerStyle:style,markerText:style.text}]};
let canvasClicks=0;canvas.addEventListener('pointerdown',()=>canvasClicks++);
const root=createRoot(document.querySelector('#react'));root.render(React.createElement(DataPlatformScreenOverlay,{scene,runtime,canvas,interactive:true}));
engine.runRenderLoop(()=>scene.render());
window.fixture={scene,engine,camera,plane,pillar,rear,root,originalMaterial,setStyle(patch){style={...style,...patch};},get style(){return style;},get canvasClicks(){return canvasClicks;},image(color){const c=document.createElement('canvas');c.width=320;c.height=180;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,106,180);return c.toDataURL('image/png');},project(x=0,y=0,z=0){const p=Vector3.Project(new Vector3(x,y,z),Matrix.Identity(),scene.getTransformMatrix(),camera.viewport.toGlobal(engine.getRenderWidth(),engine.getRenderHeight()));return {x:p.x,y:p.y};},settle(){return new Promise(resolve=>{let n=0;const o=scene.onAfterRenderObservable.add(()=>{if(++n===5){scene.onAfterRenderObservable.remove(o);resolve();}});});}};
`;
const server = await createServer({
  cacheDir: path.join(outputDir, 'vite-cache'),
  server: { port: 0, strictPort: false, hmr: false },
  plugins: [{ name: 'transparent-marker-fixture',
    resolveId(id) { if (id === '/__transparent_marker__.tsx') return '\0transparent-marker.tsx'; },
    load(id) { if (id === '\0transparent-marker.tsx') return moduleSource; },
  }],
});
let browser;
let page;
const errors=[];
async function settle() { await page.evaluate(()=>window.fixture.settle()); }
async function pixels(points) {
  const png=await page.screenshot();
  return page.evaluate(async ({data,points})=>{
    const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d');context.drawImage(image,0,0);
    return points.map(p=>Array.from(context.getImageData(Math.round(p.x),Math.round(p.y),1,1).data));
  },{data:png.toString('base64'),points});
}
const blue=p=>p[2]>150&&p[0]<80;
const red=p=>p[0]>150&&p[1]<110;
const green=p=>p[1]>150&&p[0]<80;
const yellow=p=>p[0]>180&&p[1]>180&&p[2]<80;
async function check(message,predicates,points){const values=await pixels(points);assert.ok(values.every((p,i)=>predicates[i](p)),message+': '+JSON.stringify(values));}
try {
  await server.listen();
  browser=await chromium.launch({channel:'chrome',headless:true});
  page=await browser.newPage({viewport:{width:1000,height:800}});
  page.on('pageerror',e=>errors.push(e.message));
  const html=await server.transformIndexHtml('/__transparent_marker_test__','<!doctype html><html><body style="margin:0"><div style="position:relative;width:100vw;height:100vh;background:#141414"><canvas id="scene" style="display:block;width:100%;height:100%"></canvas><div id="react"></div></div><script type="module" src="/__transparent_marker__.tsx"></script></body></html>');
  await page.route('**/__transparent_marker_test__',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.goto(server.resolvedUrls.local[0]+'__transparent_marker_test__',{waitUntil:'commit'});
  await page.waitForFunction(()=>!!window.fixture,{},{timeout:90_000});
  await settle();
  const points=await page.evaluate(()=>[1.4,0,-1.4].map(x=>window.fixture.project(x)));
  await check('无色空白区域应显示立标后方模型，前方柱子正常遮挡',[blue,red,blue],points);
  await page.evaluate(()=>window.fixture.setStyle({backgroundImage:window.fixture.image('#20c080')}));
  await settle();
  await check('透明 PNG 左侧不透明内容可见，透明右侧露出后方真实模型',[green,red,blue],points);
  await page.screenshot({path:path.join(outputDir,'transparent-image.png')});
  await page.evaluate(()=>{const c=document.createElement('canvas');c.width=320;c.height=180;const ctx=c.getContext('2d');ctx.fillStyle='#20c080';ctx.fillRect(0,0,106,60);window.fixture.setStyle({backgroundImage:c.toDataURL('image/png')});});await settle();
  const verticalPoints=await page.evaluate(()=>[.7,-.7].map(y=>window.fixture.project(1.4,y)));
  await check('图片上下方向与内置内容一致',[green,blue],verticalPoints);
  await page.evaluate(()=>{const f=window.fixture;f.camera.position.z=-8;f.camera.setTarget(f.plane.position);f.rear.setEnabled(false);f.pillar.setEnabled(false);});await settle();
  const backPoints=await page.evaluate(()=>[.7,-.7].map(y=>window.fixture.project(-1.4,y)));
  await check('背面文字图片仍保持可读方向',[green,p=>p[0]<80&&p[1]<80&&p[2]<80],backPoints);
  await page.evaluate(()=>{const f=window.fixture;f.camera.position.z=8;f.camera.setTarget(f.plane.position);f.rear.setEnabled(true);f.pillar.setEnabled(true);const c=document.createElement('canvas');c.width=320;c.height=180;const ctx=c.getContext('2d');ctx.fillStyle='#20c08080';ctx.fillRect(0,0,106,180);f.setStyle({backgroundImage:c.toDataURL('image/png')});});await settle();
  await check('半透明图片正确混合后方场景',[p=>p[0]<60&&p[1]>120&&p[1]<150&&p[2]>160&&p[2]<190,red,blue],points);
  await page.evaluate(()=>window.fixture.setStyle({backgroundImage:window.fixture.image('#20c080')}));await settle();
  await page.evaluate(()=>{window.fixture.pillar.position.z=-1;});await settle();
  await check('后方柱子可透过背景图片透明区显示',[green,red,blue],points);
  await page.evaluate(()=>window.fixture.setStyle({backgroundImage:window.fixture.image('#f0e020')}));await settle();
  await check('替换背景后动态纹理及时更新',[yellow,red,blue],points);
  await page.evaluate(()=>window.fixture.setStyle({backgroundImage:''}));await settle();
  await check('清除背景图片后不残留旧纹理',[blue,red,blue],points);
  await page.evaluate(()=>{window.fixture.pillar.position.z=2;window.fixture.setStyle({text:'MMMM',fontSize:60});});await settle();
  const textState=await page.evaluate(()=>{const textures=window.fixture.scene.textures.filter(t=>t.name==='chart-marker-transparent-content');const c=textures[0].getContext();const data=c.getImageData(0,0,320,180).data;return {textures:textures.length,white:data.filter((v,i)=>i%4===0&&v>200).length};});
  assert.equal(textState.textures,1);assert.ok(textState.white>500,'文字必须绘入透明纹理');
  await page.evaluate(()=>window.fixture.setStyle({text:'I',fontSize:24,width:640,height:360}));await settle();
  const resized=await page.evaluate(()=>window.fixture.scene.textures.filter(t=>t.name==='chart-marker-transparent-content').map(t=>({width:t.getSize().width,height:t.getSize().height})));
  assert.deepEqual(resized,[{width:640,height:360}],'尺寸修改应替换并释放旧纹理');
  await page.evaluate(()=>{const texture=window.fixture.scene.textures.find(t=>t.name==='chart-marker-transparent-content');const original=texture.update;window.fixture.uploads=0;texture.update=function(...args){window.fixture.uploads++;return original.apply(this,args);};window.fixture.setStyle({marquee:true});});await settle();
  assert.ok(await page.evaluate(()=>window.fixture.uploads)>1,'跑马灯需要持续更新三维纹理');
  await page.evaluate(()=>window.fixture.setStyle({marquee:false}));await settle();
  await page.evaluate(()=>window.fixture.uploads=0);await settle();
  assert.equal(await page.evaluate(()=>window.fixture.uploads),0,'静态文字无需每帧重复上传');
  await page.evaluate(()=>window.fixture.setStyle({backgroundColor:'#00cbe6',text:''}));await settle();
  assert.equal(await page.evaluate(()=>window.fixture.scene.textures.filter(t=>t.name==='chart-marker-transparent-content').length),0,'改为有色时应释放透明纹理');
  await page.evaluate(()=>window.fixture.setStyle({backgroundColor:'transparent',text:'',width:320,height:180}));await settle();
  await check('重新选择无色恢复真实场景透视',[blue,red,blue],points);
  const beforeClicks=await page.evaluate(()=>window.fixture.canvasClicks);
  await page.mouse.click(points[0].x,points[0].y);
  assert.equal(await page.evaluate(()=>window.fixture.canvasClicks),beforeClicks+1,'无色立标仍通过场景接受拾取交互');
  assert.equal(await page.evaluate(()=>window.fixture.plane.material===window.fixture.originalMaterial),true,'帧后恢复原始材质');
  await page.evaluate(()=>window.fixture.root.unmount());await settle();
  assert.equal(await page.evaluate(()=>window.fixture.scene.textures.filter(t=>t.name==='chart-marker-transparent-content').length),0,'卸载释放纹理');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks:['real scene through transparent background','foreground occlusion','transparent PNG','background replacement and clearing','live text','resize disposal','color mode switch','scene input','dispose'],screenshots:outputDir}));
} catch(error) {
  if(page) await page.screenshot({path:path.join(outputDir,'failure.png')});
  console.error(errors);throw error;
} finally { await browser?.close();await server.close(); }
