import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output=path.resolve('output/environment-building-effect');
await mkdir(output,{recursive:true});
// 生成两栋独立 PBR 建筑的真实 GLB，使用完整 SceneView/GLB 加载链路。
const positions=new Float32Array([-1,-1,-1,1,-1,-1,1,1,-1,-1,1,-1,-1,-1,1,1,-1,1,1,1,1,-1,1,1]);
const indices=new Uint16Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,1,2,6,1,6,5,0,4,7,0,7,3]);
const binary=Buffer.concat([Buffer.from(positions.buffer),Buffer.from(indices.buffer)]);
const gltf={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0,1]}],nodes:[{name:'BuildingA',mesh:0,translation:[-3,2,0],scale:[2,2,2]},{name:'BuildingB',mesh:0,translation:[3,3,0],scale:[2,3,2]}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],materials:[{name:'Facade',pbrMetallicRoughness:{baseColorFactor:[.28,.38,.48,1],metallicFactor:0,roughnessFactor:1}}],buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.byteLength},{buffer:0,byteOffset:positions.byteLength,byteLength:indices.byteLength}],accessors:[{bufferView:0,componentType:5126,count:8,type:'VEC3',min:[-1,-1,-1],max:[1,1,1]},{bufferView:1,componentType:5123,count:36,type:'SCALAR'}]};
const json=Buffer.from(JSON.stringify(gltf));const jsonPadded=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+jsonPadded.length+binary.length,8);header.writeUInt32LE(jsonPadded.length,12);header.writeUInt32LE(0x4e4f534a,16);
const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(binary.length,0);binHeader.writeUInt32LE(0x004e4942,4);
const modelPath=path.join(output,'factory.glb');await writeFile(modelPath,Buffer.concat([header,jsonPadded,binHeader,binary]));
const server=await createServer({server:{host:'127.0.0.1',port:53129,strictPort:true,hmr:{port:53129}}});
let browser,page;const errors=[];let glbRequests=0;
try{
  await server.listen();await server.watcher.close();
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets']});
  page=await browser.newPage({viewport:{width:1500,height:1050}});page.setDefaultTimeout(30000);
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  page.on('console',m=>{if(m.type()==='error'){errors.push(m.text());console.error(m.text());}});
  page.on('request',r=>{if(r.url().includes('factory.glb'))glbRequests++;});
  await page.addInitScript(p=>{window.environmentFixturePath=p;},modelPath);
  const html=await server.transformIndexHtml('/__env_effect__','<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/environmentBuildingEffect.harness.tsx"></script></body></html>');
  await page.route('**/__env_effect__',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.goto(server.resolvedUrls.local[0]+'__env_effect__',{waitUntil:'commit'});
  await page.waitForFunction(()=>window.environmentEffectHarness?.ready(),null,{timeout:180000});
  await page.evaluate(()=>window.environmentEffectHarness.camera());
  const originalRoot=await page.evaluate(()=>window.environmentEffectHarness.environmentRoot().uniqueId);
  const originalLoads=glbRequests;
  await page.getByRole('button',{name:'特效库',exact:true}).click();
  const drop=page.getByRole('region',{name:'环境建筑物特效拖放区'});
  await drop.scrollIntoViewIfNeeded();
  await page.getByRole('button',{name:/高度渐变着色/}).dragTo(drop);
  await page.waitForFunction(()=>window.environmentEffectHarness.current()?.visual?.targetEntityId==='__scene_environment_model__');
  assert.equal(await page.getByLabel('特效绑定目标').inputValue(),'__scene_environment_model__');
  await page.waitForFunction(()=>window.environmentEffectHarness.meshes().some(m=>m.material?.name.endsWith('_effect')));
  await page.evaluate(()=>window.environmentEffectHarness.camera());
  const firstFrame=await page.evaluate(()=>window.environmentEffectHarness.scene().getFrameId());
  await page.waitForFunction(f=>window.environmentEffectHarness.scene().getFrameId()>f+20&&window.environmentEffectHarness.meshes().every(m=>m.isReady(true)),firstFrame);
  async function cyanPixels(){
    const png=await page.locator('canvas').first().screenshot();
    return page.evaluate(async data=>{const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const p=ctx.getImageData(0,0,canvas.width,canvas.height).data;let count=0;for(let i=0;i<p.length;i+=4)if(p[i+1]>190&&p[i+2]>190&&p[i]<170)count++;return count;},png.toString('base64'));
  }
  const gradientPixels=await cyanPixels();
  await page.screenshot({path:path.join(output,'editor-environment-gradient.png')});
  console.log('gradient pixels',gradientPixels);
  await writeFile(path.join(output,'material-diagnostics.json'),JSON.stringify(await page.evaluate(()=>window.environmentEffectHarness.meshes().map(m=>({name:m.name,enabled:m.isEnabled(),material:m.material?.name,frozen:m.material?.isFrozen,unlit:m.material?.unlit,plugins:m.material?.pluginManager?._plugins?.map(p=>p.name),effectHasGradient:m.subMeshes?.some(sub=>sub.effect?._fragmentSourceCode?.includes('dtHeight'))}))),null,2));
  assert.ok(gradientPixels>1000,'绑定环境必须渲染可见高度渐变，而不只是替换材质名称');
  const kinds=['model-outline','model-edges','model-emissive','model-scan','height-gradient','hologram','xray','dissolve'];
  for(const kind of kinds){
    await page.getByLabel('特效类型').selectOption(kind);
    assert.equal(await page.getByLabel('特效绑定目标').inputValue(),'__scene_environment_model__','切换建筑类型保留环境绑定');
    const frame=await page.evaluate(()=>window.environmentEffectHarness.scene().getFrameId());
    await page.waitForFunction(frame=>window.environmentEffectHarness.scene().getFrameId()>frame+15&&window.environmentEffectHarness.meshes().every(m=>m.isReady(true)),frame);
    assert.equal(await page.evaluate(()=>window.environmentEffectHarness.environmentRoot().uniqueId),originalRoot);
  }
  assert.equal(glbRequests,originalLoads,'改变特效参数不能重新请求环境 GLB');
  await page.getByLabel('特效类型').selectOption('height-gradient');
  const saved=await page.evaluate(()=>window.environmentEffectHarness.save());await writeFile(path.join(output,'scene.scene.json'),saved);
  await page.evaluate(content=>window.environmentEffectHarness.reopen(content),saved);
  await page.waitForFunction(()=>window.environmentEffectHarness.ready()&&window.environmentEffectHarness.meshes().some(m=>m.material?.name.endsWith('_effect')));
  await page.evaluate(()=>{const h=window.environmentEffectHarness,s=h.store.getState();s.selectEntity(s.scene.entityIds.find(id=>s.scene.entities[id].components.poiEffect));h.camera();});
  await page.getByLabel('特效绑定目标').selectOption('');
  await page.waitForFunction(()=>window.environmentEffectHarness.meshes().every(m=>!m.material?.name.endsWith('_effect')));
  await page.getByLabel('特效绑定目标').selectOption('__scene_environment_model__');
  await page.waitForFunction(()=>window.environmentEffectHarness.meshes().some(m=>m.material?.name.endsWith('_effect')));
  await page.evaluate(()=>window.environmentEffectHarness.store.getState().selectEntity(null));
  await page.getByRole('button',{name:'配置 高度渐变着色',exact:true}).click();
  assert.equal(await page.getByLabel('特效绑定目标').inputValue(),'__scene_environment_model__');
  await page.evaluate(()=>window.environmentEffectHarness.store.getState().updateEnvironmentConfig(null));
  await page.getByRole('status').filter({hasText:'当前场景尚未配置适用的环境模型'}).waitFor();
  await page.evaluate(()=>window.environmentEffectHarness.store.getState().undo());
  await page.waitForFunction(()=>window.environmentEffectHarness.ready()&&window.environmentEffectHarness.meshes().some(m=>m.material?.name.endsWith('_effect')));
  await page.evaluate(()=>window.environmentEffectHarness.camera());
  const restoreFrame=await page.evaluate(()=>window.environmentEffectHarness.scene().getFrameId());
  await page.waitForFunction(f=>window.environmentEffectHarness.scene().getFrameId()>f+20&&window.environmentEffectHarness.meshes().every(m=>m.isReady(true)),restoreFrame);
  assert.ok(await cyanPixels()>1000,'撤销清除环境后恢复可见特效');
  await page.screenshot({path:path.join(output,'editor-restored.png')});
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,kinds,gradientPixels,originalLoads,glbRequests,errors,checks:['real-glb','library-drag','environment-target-option','switch-kind','no-resource-reload','save-reopen','unbind-rebind','property-entry','clear-undo']},null,2));
  await page.evaluate(()=>window.environmentEffectHarness.dispose());
  console.log('PASS: 环境特效拖放、目标选择、8种切换、无GLB重载、保存重开及清除恢复');
}catch(e){if(page)await page.screenshot({path:path.join(output,'failure.png')});throw e;}
finally{await browser?.close();await server.close();}
