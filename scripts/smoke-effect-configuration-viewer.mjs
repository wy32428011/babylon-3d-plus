import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {mkdir,readdir,writeFile} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {chromium} from 'playwright';
const root=path.resolve('output/effect-configuration/viewer'),output=path.resolve('output/effect-configuration');await mkdir(output,{recursive:true});
const mime={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.wasm':'application/wasm','.png':'image/png'};
const server=createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname)),relative=path.relative(root,file);if(!relative||relative.startsWith('..')||path.isAbsolute(relative)){res.writeHead(403).end();return;}res.setHeader('Content-Type',mime[path.extname(file)]??'application/octet-stream');await pipeline(createReadStream(file),res);}catch(e){if(!res.headersSent)res.writeHead(e.code==='ENOENT'?404:500);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,page;const errors=[],requests=[];let value=27;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1280,height:800}});
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  await page.route('**/api/v1/digital-twin/runtime-config/detail',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{projectId:'123',runtimeEnabled:true}})}));
  await page.route('**/api/v1/data-sources/fetch',route=>{requests.push(route.request().postDataJSON());return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{statusCode:200,responseBody:JSON.stringify({rows:[{id:'A',x:-2,y:0,z:0,value,name:'A区'},{id:'B',x:2,y:0,z:0,value:61,name:'B区'}]})}})});});
  await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'load'});
  const moduleName=(await readdir(path.join(root,'assets'))).find(name=>name.startsWith('engineStore-'));assert.ok(moduleName);
  await page.evaluate(async name=>{const module=await import('/assets/'+name);window.viewerEngineStore=Object.values(module).find(v=>Array.isArray(v?.Instances));},moduleName);
  await page.waitForFunction(()=>window.viewerEngineStore?.Instances.some(e=>e.scenes.some(s=>s.meshes.some(m=>m.metadata?.effectRole==='data-bar'&&m.metadata.value===27&&m.isReady(true)))),null,{timeout:120000});
  const first=await page.evaluate(()=>{const scene=window.viewerEngineStore.Instances.flatMap(e=>e.scenes).find(s=>s.meshes.some(m=>m.metadata?.effectRole==='data-bar'));const camera=scene.activeCamera,center=camera.target.clone();center.set(0,2,0);camera.setTarget(center);camera.alpha=-1.2;camera.beta=1.05;camera.radius=15;return scene.meshes.filter(m=>m.metadata?.effectRole==='data-bar').map(m=>({id:m.uniqueId,value:m.metadata.value}));});
  assert.deepEqual(first.map(m=>m.value),[27,61]);value=38;
  await page.waitForFunction(()=>window.viewerEngineStore.Instances.some(e=>e.scenes.some(s=>s.meshes.some(m=>m.metadata?.effectRole==='data-bar'&&m.metadata.value===38))),null,{timeout:15000});
  const next=await page.evaluate(()=>window.viewerEngineStore.Instances.flatMap(e=>e.scenes).flatMap(s=>s.meshes.filter(m=>m.metadata?.effectRole==='data-bar').map(m=>({id:m.uniqueId,value:m.metadata.value}))));
  assert.deepEqual(next.map(m=>m.id),first.map(m=>m.id),'数据刷新不能重建柱体');assert.deepEqual(next.map(m=>m.value),[38,61]);
  assert.ok(requests.length>=2);assert.ok(requests.every(r=>r.id==='42'&&r.runParams.assetCode==='000317'));
  await page.screenshot({path:path.join(output,'viewer-data.png')});assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'viewer-result.json'),JSON.stringify({ok:true,first,next,requests,errors,platform:'local-fixture'},null,2));
  console.log('PASS: 实际 DIST Viewer 托管HTTP按字符串资产号取数、数据柱增量刷新且Mesh不重建');
}catch(e){if(page)await page.screenshot({path:path.join(output,'viewer-failure.png')});throw e;}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
