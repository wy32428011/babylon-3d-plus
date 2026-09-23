import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root=path.resolve('output/playwright/editable-composition/viewer'),output=path.dirname(root);
const expected=JSON.parse(await fs.readFile(path.join(root,'project/scene.json'),'utf8')).scene;
const ids=Object.values(expected.entities).filter(e=>e.components.meshRenderer).map(e=>e.id);
const mime={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.wasm':'application/wasm','.png':'image/png'};
const server=createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname)),relative=path.relative(root,file);
    if(relative.startsWith('..')||path.isAbsolute(relative)){res.writeHead(403).end();return;}
    res.setHeader('Content-Type',mime[path.extname(file)]??'application/octet-stream');await pipeline(createReadStream(file),res);
  }catch(error){if(!res.headersSent)res.writeHead(error.code==='ENOENT'?404:500);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser,page;const errors=[];
try{
  browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1400,height:850}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/v1/digital-twin/runtime-config/detail',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{projectId:'123',runtimeEnabled:true}})}));
  await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load'});
  const module=(await fs.readdir(path.join(root,'assets'))).find(name=>name.startsWith('engineStore-'));assert.ok(module);
  await page.evaluate(async source=>{const values=await import('/assets/'+source);window.compositionEngineStore=Object.values(values).find(v=>Array.isArray(v?.Instances));},module);
  await page.waitForFunction(ids=>{
    const meshes=window.compositionEngineStore?.Instances.flatMap(e=>e.scenes.flatMap(s=>s.meshes))??[];
    return ids.every(id=>meshes.some(m=>m.metadata?.editorEntityId===id&&m.getTotalVertices()>0&&m.isReady(true)));
  },ids,{timeout:120000});
  await page.getByRole('progressbar').waitFor({state:'hidden',timeout:120000});
  const rendered=await page.evaluate(ids=>{
    const meshes=window.compositionEngineStore.Instances.flatMap(e=>e.scenes.flatMap(s=>s.meshes));
    return ids.map(id=>{const m=meshes.find(m=>m.metadata?.editorEntityId===id&&m.getTotalVertices()>0);return {id,position:{x:m.position.x,y:m.position.y,z:m.position.z},vertices:m.getTotalVertices()};});
  },ids);
  for(const mesh of rendered)assert.deepEqual(mesh.position,expected.entities[mesh.id].components.transform.position);
  assert.equal(rendered.length,4);assert.deepEqual(errors,[]);
  const png=await page.locator('canvas').first().screenshot();
  const visibleBluePixels=await page.evaluate(async data=>{const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,image.width,image.height).data;let count=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>30&&pixels[i+2]>70&&pixels[i+2]>pixels[i]*1.2&&pixels[i+2]>pixels[i+1]*1.03)count++;return count;},png.toString('base64'));
  assert.ok(visibleBluePixels>100,'发布场景必须绘制可见组合模型像素');
  await page.screenshot({path:path.join(output,'viewer.png')});
  await fs.writeFile(path.join(output,'viewer-result.json'),JSON.stringify({status:'PASS',rendered,visibleBluePixels,firstFrameVisible:true,errors,platformConfig:'local-fixture'},null,2));
  console.log('PASS: 实际 DIST Viewer 绘制两组四个成员，位置一致且无页面脚本错误');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
