import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {mkdir, readdir, writeFile} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {chromium} from 'playwright';

const output=path.resolve('output/generated-follow'),root=path.join(output,'viewer');await mkdir(output,{recursive:true});
const mime={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.gltf':'model/gltf+json','.glb':'model/gltf-binary','.wasm':'application/wasm','.png':'image/png'};
const server=createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname)),relative=path.relative(root,file);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative)){res.writeHead(403).end();return;}
  res.setHeader('Content-Type',mime[path.extname(file)]??'application/octet-stream');await pipeline(createReadStream(file),res);
}catch(error){if(!res.headersSent)res.writeHead(error.code==='ENOENT'?404:500);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let browser,page,column=0;const errors=[],requests=[];
try{
  browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1280,height:800}});
  page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});
  await page.route('**/api/v1/digital-twin/runtime-config/detail',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{projectId:'123',runtimeEnabled:true,apiBaseUrl:base+'/inventory'}})}));
  await page.route('**/inventory',route=>{requests.push({column,body:route.request().postDataJSON()});return route.fulfill({contentType:'application/json',body:JSON.stringify({data:{records:[{result:column?[{containerCode:'000317',containerType:'box',isEmpty:false,row:'1',column,layer:1,tier:0,stackingRow:'1',stackingColumn:column,stackingLayer:1}]:[]}]}})});});
  await page.goto(base,{waitUntil:'load'});
  const moduleName=(await readdir(path.join(root,'assets'))).find(name=>name.startsWith('engineStore-'));assert.ok(moduleName);
  await page.evaluate(async name=>{const module=await import('/assets/'+name);window.followEngineStore=Object.values(module).find(value=>Array.isArray(value?.Instances));},moduleName);
  const controls=page.getByRole('region',{name:'运行时目标跟随'});await controls.waitFor({timeout:120000});
  await page.waitForFunction(()=>document.querySelector('.runtime-follow-content [role="status"]')?.textContent?.includes('等待'),null,{timeout:20000});
  const snapshot=()=>page.evaluate(()=>{const scene=window.followEngineStore.Instances.flatMap(engine=>engine.scenes).find(scene=>scene.activeCamera);return{target:scene.activeCamera.target.asArray(),meshes:scene.meshes.filter(mesh=>mesh.name.startsWith('fetch_batch_')).map(mesh=>({id:mesh.uniqueId,count:mesh.thinInstanceCount}))};});
  const waiting=await snapshot();assert.equal(waiting.meshes.length,0);
  column=1;
  await page.waitForFunction(()=>document.querySelector('.runtime-follow-controls select')?.value && window.followEngineStore.Instances.some(engine=>engine.scenes.some(scene=>scene.meshes.some(mesh=>mesh.name.startsWith('fetch_batch_')&&mesh.thinInstanceCount>0))),null,{timeout:25000});
  const first=await snapshot();assert.ok(first.meshes.length>0);
  column=3;
  await page.waitForFunction(previous=>window.followEngineStore.Instances.flatMap(engine=>engine.scenes).some(scene=>scene.activeCamera?.target&&scene.activeCamera.target.asArray().some((value,index)=>Math.abs(value-previous[index])>1)),first.target,{timeout:20000});
  const moved=await snapshot();assert.deepEqual(moved.meshes.map(mesh=>mesh.id),first.meshes.map(mesh=>mesh.id),'库存坐标更新应复用薄实例几何');
  await page.screenshot({path:path.join(output,'viewer-following.png')});
  column=0;
  await page.waitForFunction(()=>window.followEngineStore.Instances.every(engine=>engine.scenes.every(scene=>!scene.meshes.some(mesh=>mesh.name.startsWith('fetch_batch_')))),null,{timeout:20000});
  await page.waitForFunction(()=>document.querySelector('.runtime-follow-content [role="status"]')?.textContent?.includes('等待'),null,{timeout:10000});
  const missing=await snapshot();assert.deepEqual(missing.target,moved.target,'实例消失时镜头保持');
  column=2;
  await page.waitForFunction(previous=>document.querySelector('.runtime-follow-controls select')?.value&&window.followEngineStore.Instances.flatMap(engine=>engine.scenes).some(scene=>scene.activeCamera?.target&&scene.activeCamera.target.asArray().some((value,index)=>Math.abs(value-previous[index])>1)),missing.target,{timeout:20000});
  const restored=await snapshot();assert.ok(restored.meshes.length>0);assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'viewer-result.json'),JSON.stringify({ok:true,waiting,first,moved,missing,restored,requests,errors,checks:['actual-DIST','no-edit-model-instance','public-inventory-fetch','late-generated-follow','thin-instance-move-reuse','missing-hold','same-container-recreate']},null,2));
  console.log('PASS: actual DIST Viewer inventory → generated model → follow → move → disappear → recreate');
}catch(error){if(page)await page.screenshot({path:path.join(output,'viewer-failure.png')});throw error;}
finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
