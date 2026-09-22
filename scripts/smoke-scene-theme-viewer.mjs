import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const output = path.resolve('output/scene-theme');
const { viewerRoot } = JSON.parse(await readFile(path.join(output, 'packages-result.json'), 'utf8'));
assert.ok(viewerRoot && path.dirname(viewerRoot) === output, '先运行主题 SOURCE/DIST 双包验证');
const root = path.resolve(viewerRoot);
const mime = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.css':'text/css', '.wasm':'application/wasm', '.png':'image/png' };
const server = createServer(async (req,res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type',mime[path.extname(file)] ?? 'application/octet-stream');
    await pipeline(createReadStream(file),res);
  } catch (error) { if(!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500);res.end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser,page;const errors=[];
try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  page=await browser.newPage({viewport:{width:1280,height:800}});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  // 只替代平台启用查询；页面、场景与运行时代码来自刚构建的真实 DIST。
  await page.route('**/api/v1/digital-twin/runtime-config/detail',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{projectId:'123',runtimeEnabled:true}})}));
  const engineModule=(await readdir(path.join(root,'assets'))).find(name=>name.startsWith('engineStore-'));
  assert.ok(engineModule);
  async function observe() {
    await page.evaluate(async source=>{
      const module=await import('/assets/'+source);
      window.themeViewerEngines=Object.values(module).find(value=>Array.isArray(value?.Instances));
    },engineModule);
    await page.waitForFunction(()=>window.themeViewerEngines?.Instances.some(engine=>engine.scenes.some(scene=>scene.lights.some(light=>light.name==='__SceneThemeMain')&&scene.meshes.some(mesh=>mesh.getTotalVertices()>0&&mesh.isReady(true)))),null,{timeout:120000});
    return page.evaluate(()=>{
      const engine=window.themeViewerEngines.Instances.find(engine=>engine.scenes.some(scene=>scene.lights.some(light=>light.name==='__SceneThemeMain')));
      const scene=engine.scenes.find(scene=>scene.lights.some(light=>light.name==='__SceneThemeMain'));
      const camera=scene.activeCamera;const target=camera.target.clone();target.set(0,3,0);
      camera.setTarget(target);camera.alpha=-1.2;camera.beta=1.05;camera.radius=35;
      const main=scene.lights.filter(light=>light.name==='__SceneThemeMain');
      const work=scene.lights.find(light=>light.metadata?.nightBehavior==='keep');
      return {renderer:engine.getGlInfo().renderer,mainLights:main.length,mainColor:main[0].diffuse.toHexString().toLowerCase(),
        exposure:scene.imageProcessingConfiguration.exposure,contrast:scene.imageProcessingConfiguration.contrast,
        environment:scene.environmentIntensity,fogStart:scene.fogStart,fogEnd:scene.fogEnd,
        workColor:work?.diffuse.toHexString().toLowerCase(),workRange:work?.range,
        disabledGlobalLights:scene.lights.filter(light=>!light.isEnabled()).length,frame:scene.getFrameId()};
    });
  }
  await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'load'});
  const state=await observe();
  assert.equal(state.mainLights,1);assert.equal(state.mainColor,'#b5d4ff');
  assert.equal(state.exposure,1.27);assert.equal(state.contrast,1.1);assert.equal(state.environment,.3);
  assert.equal(state.fogStart,125);assert.equal(state.fogEnd,820);
  assert.equal(state.workColor,'#ffd6a3');assert.equal(state.workRange,24);assert.equal(state.disabledGlobalLights,2);
  await page.waitForFunction(frame=>window.themeViewerEngines.Instances.some(engine=>engine.scenes.some(scene=>scene.getFrameId()>frame+15)),state.frame);
  const png=await page.locator('canvas').first().screenshot();
  const pixels=await page.evaluate(async data=>{
    const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();
    const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
    const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const p=ctx.getImageData(0,0,c.width,c.height).data;
    let bright=0;for(let i=0;i<p.length;i+=4)if(p[i]+p[i+1]+p[i+2]>180)bright++;
    return {bright,total:c.width*c.height};
  },png.toString('base64'));
  assert.ok(pixels.bright>1000,'发布场景必须实际画出可辨认的建筑：'+JSON.stringify(pixels));
  await writeFile(path.join(output,'viewer.png'),png);
  await page.reload({waitUntil:'load'});
  const reloaded=await observe();assert.equal(reloaded.mainLights,1);assert.equal(reloaded.exposure,1.27);assert.equal(reloaded.workRange,24);
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'viewer-result.json'),JSON.stringify({ok:true,state,reloaded,pixels,errors,platformConfig:'local-fixture'},null,2));
  console.log('PASS: 实际 DIST Viewer 的主题主光、曝光、雾、暖灯、可见像素及刷新一致性。');
} catch(error) {if(page)await page.screenshot({path:path.join(output,'viewer-failure.png')});throw error;}
finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
