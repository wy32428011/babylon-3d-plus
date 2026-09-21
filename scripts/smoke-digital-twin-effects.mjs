import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import mqttPacket from 'mqtt-packet';

const output = path.resolve('output/playwright/digital-twin-effects');
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host:'127.0.0.1',port:53127,strictPort:true,hmr:{port:53127},watch:null } });
const broker = new WebSocketServer({ noServer: true });
server.httpServer.on('upgrade', (request, socket, head) => {
  if (request.url === '/__effects_mqtt__') broker.handleUpgrade(request, socket, head, ws => broker.emit('connection', ws, request));
});
broker.on('connection', socket => {
  const parser = mqttPacket.parser();
  let protocolVersion = 4;
  const send = packet => socket.send(mqttPacket.generate(packet, { protocolVersion }));
  socket.on('message', data => parser.parse(data));
  parser.on('error', () => socket.close());
  parser.on('packet', packet => {
    if (packet.cmd === 'connect') { protocolVersion = packet.protocolVersion; send({ cmd: 'connack', returnCode: 0, reasonCode: 0, sessionPresent: false }); }
    if (packet.cmd === 'subscribe') send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(subscription => subscription.qos) });
    if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
    if (packet.cmd === 'disconnect') socket.close();
  });
});
let browser;
const errors=[];
const checks=[];
try {
  await server.listen();
  await server.watcher.close();
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets']});
  const page=await browser.newPage({viewport:{width:1500,height:1050}});
  page.setDefaultTimeout(30000);
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  page.on('console',m=>{if(m.type()==='error'){errors.push(m.text());console.error(m.text());}});
  async function open(fixture,route) {
    const html=await server.transformIndexHtml(route,`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/${fixture}"></script></body></html>`);
    await page.route('**'+route,r=>r.fulfill({contentType:'text/html',body:html}));
    await page.goto(server.resolvedUrls.local[0]+route.slice(1),{waitUntil:'commit'});
  }
  if (!process.argv.includes('--editor-only')) {
  await open('digitalTwinEffectsGallery.harness.ts','/__effects_gallery__');
  await page.waitForFunction(()=>window.gallery?.ready(),null,{timeout:180000});
  const definitions=await page.evaluate(()=>window.gallery.definitions.map(d=>({kind:d.kind,name:d.name})));
  for(const definition of definitions) {
    const start=await page.evaluate(kind=>{window.gallery.change(kind);return window.gallery.frames();},definition.kind);
    await page.waitForFunction(start=>window.gallery.ready()&&window.gallery.frames()>start+15,start,{timeout:30000});
    assert.equal(errors.length,0,`WebGL error: ${definition.kind}: ${errors.join('\n')}`);
    const metrics=await page.evaluate(()=>({meshes:window.gallery.scene.meshes.length,materials:window.gallery.scene.materials.length,frame:window.gallery.frames()}));
    await page.screenshot({path:path.join(output,definition.kind+'.png')});
    checks.push({...definition,...metrics});
    console.log('WebGL',definition.kind,metrics.meshes);
  }
  await page.evaluate(()=>window.gallery.dispose());
  }
  await open('digitalTwinEffects.harness.tsx','/__effects_editor__');
  await page.getByRole('button',{name:'特效库',exact:true}).waitFor({timeout:180000});
  await page.getByRole('button',{name:'特效库',exact:true}).click();
  await page.getByRole('button',{name:/EFF.*路径与物流|流光路径/}).filter({hasText:'流光路径'}).first().click();
  await page.waitForFunction(()=>window.effectHarness?.current()?.effectKind==='flow-path');
  await page.evaluate(()=>window.effectHarness.camera());
  await page.screenshot({path:path.join(output,'editor-path.png')});
  const pointInput=page.getByLabel('局部坐标 (X, Y, Z / m)',{exact:true});
  await pointInput.fill('-6,0.1,-2\n0,0.1,5\n6,0.1,-2');
  await page.getByRole('button',{name:/应用.*配置|应用.*数据|应用.*路径|应用.*坐标/}).click();
  assert.equal((await page.evaluate(()=>window.effectHarness.current())).visual.points[0].x,-6);
  await pointInput.fill('0,0,0');
  await page.getByRole('button',{name:/应用.*配置|应用.*数据|应用.*路径|应用.*坐标/}).click();
  await page.getByRole('alert').waitFor();
  assert.equal((await page.evaluate(()=>window.effectHarness.current())).visual.points.length,3);
  const saved=await page.evaluate(()=>window.effectHarness.save());
  await writeFile(path.join(output,'editor-saved.scene.json'),saved);
  await page.evaluate(content=>window.effectHarness.reopen(content),saved);
  await page.evaluate(()=>{const h=window.effectHarness,s=h.store.getState();s.selectEntity(s.scene.entityIds.find(id=>s.scene.entities[id].components.poiEffect));h.camera();});
  assert.equal((await page.evaluate(()=>window.effectHarness.current())).visual.points[0].x,-6);
  await page.getByRole('button',{name:/建筑扫光/}).click();
  await page.getByLabel('特效绑定目标').selectOption(await page.evaluate(()=>window.effectHarness.buildingId));
  await page.waitForFunction(()=>window.effectHarness?.scene()?.meshes.some(m=>m.material?.name.endsWith('_effect')));
  await page.screenshot({path:path.join(output,'editor-model-scan.png')});
  await page.getByLabel('特效类型').selectOption('height-gradient');
  await page.getByLabel('特效绑定目标').selectOption(await page.evaluate(()=>window.effectHarness.buildingId));
  const sceneBefore=await page.evaluate(()=>window.effectHarness.save());
  assert.ok(JSON.parse(sceneBefore).scene.entities);
  await page.evaluate(content=>window.effectHarness.reopen(content),sceneBefore);
  await page.waitForFunction(()=>window.effectHarness.scene()?.meshes.some(m=>m.material?.name.endsWith('_effect')));
  const preview=await page.evaluate(()=>{
    const store=window.effectHarness.store;
    store.getState().updateMqttConfig({...store.getState().scene.mqttConfig,enabled:true,address:'ws://'+location.host+'/__effects_mqtt__',ip:'',simulatorEnabled:false});
    return store.getState().startRuntimePreview();
  });
  assert.equal(preview.ok,true,JSON.stringify(preview));
  await page.waitForFunction(()=>window.effectHarness.store.getState().runtimeMode==='preview'&&window.effectHarness.scene()?.meshes.some(m=>m.material?.name.endsWith('_effect')));
  await page.evaluate(()=>window.effectHarness.camera());
  await page.screenshot({path:path.join(output,'editor-preview.png')});
  await page.evaluate(()=>window.effectHarness.store.getState().stopRuntimePreview());
  await page.waitForFunction(()=>window.effectHarness.store.getState().runtimeMode==='edit');
  await page.evaluate(()=>window.effectHarness.dispose());
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,process.argv.includes('--editor-only')?'editor-result.json':'result.json'),JSON.stringify({ok:true,checks,editor:['create','edit-points','invalid-draft','save-reopen','bind-target','target-reopen','preview','stop-preview'],errors},null,2));
  console.log('PASS: effects WebGL/editor/save-reopen/runtime preview');
} finally {
  await browser?.close();
  for (const socket of broker.clients) socket.terminate();
  await new Promise(resolve=>broker.close(resolve));
  await server.close();
}
