import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/chart-marker-gizmo');
await mkdir(output, { recursive: true });
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Engine, Scene, FreeCamera, HemisphericLight, Vector3, Matrix } from '@babylonjs/core';
import { SceneRuntime } from '/src/runtime/babylon/SceneRuntime.ts';
import { TransformGizmoController } from '/src/runtime/babylon/TransformGizmoController.ts';
import { DataPlatformScreenOverlay } from '/src/runtime/babylon/DataPlatformScreenOverlay.tsx';
import { useEditorStore as store } from '/src/editor/store/editorStore.ts';
const canvas=document.querySelector('canvas');
const engine=new Engine(canvas,true,{stencil:true});
const scene=new Scene(engine);scene.clearColor.set(.05,.065,.08,1);
const camera=new FreeCamera('camera',new Vector3(8,6,-12),scene);camera.setTarget(new Vector3(0,1.8,0));camera.minZ=.1;
new HemisphericLight('light',Vector3.Up(),scene);
const runtime=new SceneRuntime(scene);
const controller=new TransformGizmoController(scene,{
  previewTransform:(id,t)=>store.getState().previewEntityTransform(id,t),
  commitTransform:(id,before,after)=>store.getState().commitEntityTransform(id,before,after),
  previewEnvironmentTransform(){},commitEnvironmentTransform(){},beginEntityArrayDrag(){return null;},
  previewEntityArrayDrag(){},completeEntityArrayDrag(){},cancelEntityArrayDrag(){},
});
function sync(){const s=store.getState();runtime.sync(s.scene);controller.attachToTarget(runtime.getGizmoTargetByEntityId(s.scene.selectedEntityId),s.scene.selectedEntityId);}
const unsubscribe=store.subscribe(sync);
function reset(){store.getState().newScene();store.getState().createChartMarker({x:0,y:0,z:0});controller.setTransformSpace('local');controller.setTool('translate');}
reset();
const root=createRoot(document.querySelector('#overlay'));root.render(React.createElement(DataPlatformScreenOverlay,{scene,runtime,canvas}));
engine.runRenderLoop(()=>scene.render());
function settle(){return new Promise(resolve=>{let n=0;const o=scene.onAfterRenderObservable.add(()=>{if(++n===4){scene.onAfterRenderObservable.remove(o);resolve();}});});}
function project(point){const p=Vector3.Project(point,Matrix.Identity(),scene.getTransformMatrix(),camera.viewport.toGlobal(engine.getRenderWidth(),engine.getRenderHeight()));return {x:p.x,y:p.y};}
function marker(){const s=store.getState();return s.scene.entities[s.scene.selectedEntityId];}
window.fixture={reset,settle,marker,store,controller,runtime,scene,camera,
  axis(axis){const h=controller.gizmoManager.gizmos.positionGizmo[axis+'Gizmo'];h._update();const v=axis==='x'?Vector3.Right():axis==='y'?Vector3.Up():Vector3.Forward();const world=h._rootMesh.computeWorldMatrix(true);return {start:project(Vector3.TransformCoordinates(v.scale(.08),world)),end:project(Vector3.TransformCoordinates(v.scale(.18),world)),direction:Vector3.TransformNormal(v,world).normalize().asArray()};},
  dispose(){unsubscribe();root.unmount();controller.dispose();runtime.dispose();scene.dispose();engine.dispose();}
};
`;
const server = await createServer({
  cacheDir: path.join(output, 'vite-cache'), server: { port: 0, strictPort: false, hmr: false },
  plugins: [{ name: 'chart-marker-gizmo-fixture',
    resolveId(id) { if (id === '/__chart_gizmo__.tsx') return '\0chart-gizmo.tsx'; },
    load(id) { if (id === '\0chart-gizmo.tsx') return source; },
  }],
});
let browser, page;
const errors = [];
try {
  await server.listen();
  const html=await server.transformIndexHtml('/__chart_gizmo__','<!doctype html><html><body style="margin:0"><div style="position:relative;width:100vw;height:100vh"><canvas style="display:block;width:100%;height:100%"></canvas><div id="overlay"></div></div><script type="module" src="/__chart_gizmo__.tsx"></script></body></html>');
  browser=await chromium.launch({channel:'chrome',headless:true});
  page=await browser.newPage({viewport:{width:1100,height:760}});
  page.setDefaultTimeout(90_000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/__chart_gizmo__',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
  await page.goto(server.resolvedUrls.local[0]+'__chart_gizmo__',{timeout:90_000});
  await page.waitForFunction(()=>window.fixture);
  await page.evaluate(()=>window.fixture.settle());
  assert.equal(await page.evaluate(()=>window.fixture.scene.getMeshByName('__SceneShadowCatcher').isEnabled()),false,'只有立标时不能显示阴影地面');
  const frame=await page.screenshot({path:path.join(output,'standard-xyz.png')});
  const background=await page.evaluate(async data=>{
    const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
    const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const context=c.getContext('2d');context.drawImage(image,0,0);
    return [[20,720],[550,650],[1080,720]].map(([x,y])=>Array.from(context.getImageData(x,y,1,1).data));
  },frame.toString('base64'));
  for(const pixel of background)assert.ok(pixel.every((v,i)=>Math.abs(v-[13,17,20,255][i])<=1),'立标外围应保持场景背景，不能被地面覆盖');
  for (const axis of ['x','y','z']) {
    await page.evaluate(()=>{window.fixture.reset();return window.fixture.settle();});
    const before=await page.evaluate(()=>window.fixture.marker().components.transform);
    const arrow=await page.evaluate(axis=>window.fixture.axis(axis),axis);
    const expected=['x','y','z'].map(key=>key===axis?1:0);
    assert.ok(arrow.direction.every((value,index)=>Math.abs(value-expected[index])<1e-5),axis+' 轴方向');
    const dx=arrow.end.x-arrow.start.x,dy=arrow.end.y-arrow.start.y,length=Math.hypot(dx,dy);
    await page.mouse.move(arrow.start.x,arrow.start.y);
    await page.mouse.down();
    await page.mouse.move(arrow.start.x+dx/length*65,arrow.start.y+dy/length*65,{steps:12});
    await page.mouse.up();
    await page.evaluate(()=>window.fixture.settle());
    const after=await page.evaluate(()=>window.fixture.marker().components.transform);
    assert.ok(after.position[axis]>before.position[axis]+.01,axis+' 轴真实鼠标拖动应沿正方向移动');
    for(const other of ['x','y','z'].filter(key=>key!==axis))assert.ok(Math.abs(after.position[other]-before.position[other])<1e-5,axis+' 轴不得修改 '+other);
    await page.evaluate(()=>window.fixture.store.getState().undo());
    assert.deepEqual(await page.evaluate(()=>window.fixture.marker().components.transform),before,'拖动撤销');
    await page.evaluate(()=>window.fixture.store.getState().redo());
    assert.deepEqual(await page.evaluate(()=>window.fixture.marker().components.transform),after,'拖动重做');
  }
  await page.evaluate(()=>{window.fixture.reset();window.fixture.store.getState().updateChartMarker(window.fixture.marker().id,{faceCamera:false,floatHeight:0});return window.fixture.settle();});
  const sizes=await page.evaluate(()=>{
    const f=window.fixture,m=f.runtime.getGizmoTargetByEntityId(f.marker().id),before=m.getBoundingInfo().boundingBox.extendSizeWorld.scale(2).asArray();
    f.controller.setTool('scale');f.controller.beginDragSnapshot();m.scaling.y*=2;f.controller.previewAttachedTransform();f.controller.commitActiveDrag();
    const after=m.getBoundingInfo().boundingBox.extendSizeWorld.scale(2).asArray();return {before,after};
  });
  assert.ok(Math.abs(sizes.after[1]/sizes.before[1]-2)<1e-5,'Y 缩放必须改变面板高度');
  assert.ok(Math.abs(sizes.after[0]-sizes.before[0])<1e-5,'Y 缩放不得改变面板宽度');
  await page.evaluate(()=>{const f=window.fixture;f.store.getState().updateSelectedTransform('rotation','y',Math.PI/4);});
  await page.evaluate(()=>window.fixture.settle());
  const local=await page.evaluate(()=>{window.fixture.controller.setTool('translate');return window.fixture.axis('x').direction;});
  assert.ok(Math.abs(local[2])>.6,'Local 轴跟随用户旋转');
  await page.evaluate(()=>window.fixture.controller.setTransformSpace('global'));
  const global=await page.evaluate(()=>window.fixture.axis('x').direction);
  assert.ok(Math.abs(global[0]-1)<1e-5&&Math.abs(global[2])<1e-5,'Global 轴保持世界方向');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks:['no implicit floor','xyz pointer drag','undo redo','y scale height','local global'],screenshot:path.join(output,'standard-xyz.png')}));
} catch(error) {
  if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  throw error;
} finally {
  if(page)await page.evaluate(()=>window.fixture?.dispose()).catch(()=>{});
  await browser?.close();await server.close();
}
