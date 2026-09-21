import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const output=path.resolve('output/dissolve-completion');await mkdir(output,{recursive:true});
const server=await createServer({server:{host:'127.0.0.1',port:53129,strictPort:true,hmr:{port:53129}}});
let browser;const errors=[],results=[];
try{
  await server.listen();await server.watcher.close();
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets']});
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const html=await server.transformIndexHtml('/__dissolve__','<!doctype html><html><body><script type="module" src="/tests/fixtures/dissolveCompletion.harness.ts"></script></body></html>');
  await page.route('**/__dissolve__',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.goto(server.resolvedUrls.local[0]+'__dissolve__',{waitUntil:'commit'});
  await page.waitForFunction(()=>window.dissolveCompletion,null,{timeout:180000});
  for(const environment of [false,true])for(const material of ['standard','pbr'])for(const loop of [false,true])for(const axis of ['x','y','z']){
    const result=await page.evaluate(options=>window.dissolveCompletion.run(options),{environment,material,loop,axis});
    const image=result.completedImage;delete result.completedImage;
    const name=`${environment?'environment':'model'}-${material}-${loop?'loop':'once'}-${axis}`;
    await writeFile(path.join(output,name+'.png'),Buffer.from(image.split(',')[1],'base64'));
    results.push(result);console.log(name,JSON.stringify(result.completed));
  }
  await page.evaluate(()=>window.dissolveCompletion.dispose());
  await writeFile(path.join(output,'result.json'),JSON.stringify({results,errors},null,2));
  assert.deepEqual(errors,[]);
  for(const result of results){
    assert.ok(result.midpoint.missing>100,'中途确实执行裁剪');
    assert.equal(result.completed.missing,0,'完成时模型不能缺失：'+JSON.stringify(result));
    assert.equal(result.completed.changed,0,'完成时恢复原始外观：'+JSON.stringify(result));
    assert.equal(result.settled.missing,0,'完成状态须保持：'+JSON.stringify(result));
    assert.equal(result.settled.changed,0,'结束后没有残余溶解发光');
  }
  console.log('PASS: 24个真实WebGL场景，生长完成画面与原始模型一致');
}finally{await browser?.close();await server.close();}
