import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const outputDir = path.resolve('output/playwright/manual-roam-humanoid-terrain', `run-${Date.now()}`);
const moduleId = '\0manual-roam-humanoid-terrain.js';
const rampAngle = 10 * Math.PI / 180;
const rampHeight = Math.tan(rampAngle) * 4;
const harness = `
import '@babylonjs/loaders';
import { ArcRotateCamera, Color3, Engine, HemisphericLight, Matrix, MeshBuilder, Ray, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { ManualRoamRuntime } from '/src/runtime/roam/ManualRoamRuntime.ts';
const canvas=document.querySelector('canvas'),engine=new Engine(canvas,true,{preserveDrawingBuffer:true,stencil:true}),scene=new Scene(engine);
scene.clearColor.set(.055,.075,.11,1);
const camera=new ArcRotateCamera('observer',-Math.PI/2,1.2,4,new Vector3(0,.9,0),scene);
const light=new HemisphericLight('light',new Vector3(.5,1,-.5),scene);light.intensity=1.5;
const terrain=new Set();
function surface(mesh,color){const material=new StandardMaterial(mesh.name+'-material',scene);material.diffuseColor=Color3.FromHexString(color);mesh.material=material;mesh.checkCollisions=true;terrain.add(mesh);return mesh;}
surface(MeshBuilder.CreateGround('floor',{width:30,height:40},scene),'#35485A');
const step=surface(MeshBuilder.CreateBox('step-15cm',{width:3,height:.15,depth:2},scene),'#3482A8');step.position.set(0,.075,3);
const angle=${rampAngle},height=${rampHeight},thickness=.1;
const ramp=surface(MeshBuilder.CreateBox('ramp-10deg',{width:3,height:thickness,depth:4/Math.cos(angle)},scene),'#397E67');
ramp.rotation.x=-angle;ramp.position.set(0,height/2-thickness/2*Math.cos(angle),8+thickness/2*Math.sin(angle));
const plateau=surface(MeshBuilder.CreateBox('ramp-top',{width:3,height,depth:2},scene),'#4B967F');plateau.position.set(0,height/2,11);
const runtime=new ManualRoamRuntime({scene,engine,camera,canvas,avatarUrl:new URL('/scripts/manual-roam-assets/sources/Xbot.glb',location.href).href,
 resolveSpawnPose:()=>({position:{x:0,y:0,z:0},yaw:0}),setOrbitControlsEnabled:()=>{}});
const qa={runtime,scene,engine,stage:'loading',samples:[],lastSample:0,ready:true,cache:null};window.humanoidTerrainQA=qa;
document.querySelector('#start').onclick=()=>{runtime.setEnabled(true);canvas.focus();};
function buildCache(){
 if(qa.cache)return;qa.cache=[];const binding=runtime.skeletalAnimator.getRigBinding();
 for(const mesh of runtime.avatarContainer.meshes){
  if(!mesh.skeleton||!mesh.getTotalVertices())continue;
  const positions=mesh.getVerticesData('position'),ids=mesh.getVerticesData('matricesIndices'),weights=mesh.getVerticesData('matricesWeights');
  const extraIds=mesh.getVerticesData('matricesIndicesExtra'),extraWeights=mesh.getVerticesData('matricesWeightsExtra'),extended=mesh.numBoneInfluencers>4;
  const sides={};for(const side of ['Left','Right']){const foot=binding.joints.get(side+'Foot');sides[side]=new Set(mesh.skeleton.bones.filter(bone=>{const node=bone.getTransformNode();return node===foot||node?.isDescendantOf(foot);}).map(bone=>bone.getIndex()));}
  const vertices=[];for(const vertex of new Set(mesh.getIndices()??[]))for(const side of ['Left','Right']){
   const influences=[];let amount=0;for(let k=0;k<(extended?8:4);k++){const index=k<4?ids[vertex*4+k]:extraIds[vertex*4+k-4],weight=k<4?weights[vertex*4+k]:extraWeights[vertex*4+k-4];if(weight>0)influences.push({index,weight});if(sides[side].has(index))amount+=weight;}
   if(amount>=.5)vertices.push({point:Vector3.FromArray(positions,vertex*3),side,influences});
  }
  qa.cache.push({mesh,vertices});
 }
}
function measureFeet(){
 buildCache();const feet={Left:{vertices:0,minClearance:Infinity,maxPenetration:0,terrains:new Set(),point:null,ground:null},Right:{vertices:0,minClearance:Infinity,maxPenetration:0,terrains:new Set(),point:null,ground:null}};
 for(const {mesh,vertices} of qa.cache){
  mesh.skeleton.prepare(true);const raw=mesh.skeleton.getTransformMatrices(mesh),matrices=Array.from({length:raw.length/16},(_,i)=>Matrix.FromArray(raw,i*16)),world=mesh.computeWorldMatrix(true);
  for(const vertex of vertices){
   const skinned=Vector3.Zero();for(const influence of vertex.influences)skinned.addInPlace(Vector3.TransformCoordinates(vertex.point,matrices[influence.index]).scale(influence.weight));
   const point=Vector3.TransformCoordinates(skinned,world),foot=feet[vertex.side];foot.vertices++;
   // 每个真实足部顶点都独立向实际场景几何发射线；台阶与坡面不能用固定worldY或踝部高度替代。
   const hit=scene.pickWithRay(new Ray(point.add(new Vector3(0,1,0)),Vector3.Down(),3),mesh=>terrain.has(mesh),false);
   if(!hit?.pickedPoint)throw new Error('真实足部下方缺少地形射线命中');
   const normal=hit.getNormal(true,true);if(!normal||normal.y<.5)throw new Error('地形射线命中无效朝上表面');
   const clearance=Vector3.Dot(point.subtract(hit.pickedPoint),normal.normalize());
   foot.terrains.add(hit.pickedMesh.name);foot.maxPenetration=Math.max(foot.maxPenetration,-clearance);
   if(clearance<foot.minClearance){foot.minClearance=clearance;foot.point=point.asArray();foot.ground={point:hit.pickedPoint.asArray(),normal:normal.asArray(),mesh:hit.pickedMesh.name};}
  }
 }
 for(const foot of Object.values(feet))foot.terrains=[...foot.terrains];return feet;
}
scene.onBeforeRenderObservable.add(()=>{
 if(!runtime.getSnapshot().enabled)return;const p=runtime.collider.position,target=p.add(new Vector3(0,.8,0));
 camera.setTarget(target);camera.setPosition(target.add(new Vector3(3.9,1.7,-2.8)));
});
scene.onAfterRenderObservable.add(()=>{
 if(!runtime.skeletalAnimator||!runtime.getSnapshot().enabled||performance.now()-qa.lastSample<120||qa.samples.length>=800)return;
 qa.lastSample=performance.now();const binding=runtime.skeletalAnimator.getRigBinding(),joints={};
 for(const [name,node] of binding.joints){node.computeWorldMatrix(true);joints[name]=node.getAbsolutePosition().asArray();}
 const feet=measureFeet(),snapshot=runtime.getSnapshot(),ik=runtime.footIK?.getDebugState();
 const edge=Object.values(feet).some(foot=>foot.terrains.length>1)||[2,4,6,10].some(edge=>Math.abs(runtime.collider.position.z-edge)<.35);
 const classification=!snapshot.grounded?'airborne':edge?'edge-crossing':'grounded-interior';
 qa.samples.push({time:performance.now(),stage:qa.stage,classification,position:runtime.collider.position.asArray(),grounded:snapshot.grounded,
  mode:snapshot.avatarAnimationMode,clips:runtime.skeletalAnimator.getStatus().activeGroups,joints,feet,
  ik:ik?Object.fromEntries(Object.entries(ik).map(([side,value])=>[side,{phase:value.phase,reason:value.reason,normalAlignment:value.normalAlignment}])):null,
  finite:Object.values(joints).flat().every(Number.isFinite)&&runtime.avatarContainer.meshes.every(mesh=>Array.from(mesh.getWorldMatrix().m).every(Number.isFinite))});
});
engine.runRenderLoop(()=>{scene.render();document.querySelector('#status').textContent=qa.stage+'\\n'+JSON.stringify({position:runtime.collider.position.asArray(),snapshot:runtime.getSnapshot()},null,2);});
qa.dispose=()=>{runtime.dispose();scene.dispose();engine.dispose();};
`;

function measureGroup(samples) {
  const feet = samples.flatMap(sample => Object.values(sample.feet));
  const bends = [];
  for (const sample of samples) for (const side of ['Left', 'Right']) {
    const hip = sample.joints[side + 'UpLeg'], knee = sample.joints[side + 'Leg'], ankle = sample.joints[side + 'Foot'];
    const axis = ankle.map((value, i) => value - hip[i]);
    const along = knee.reduce((sum, value, i) => sum + (value - hip[i]) * axis[i], 0) / axis.reduce((sum, value) => sum + value * value, 0);
    const bend = knee.map((value, i) => value - hip[i] - along * axis[i]);
    const lateral = [sample.joints.RightUpLeg[0] - sample.joints.LeftUpLeg[0], sample.joints.RightUpLeg[2] - sample.joints.LeftUpLeg[2]];
    const forward = [-lateral[1], lateral[0]], length = Math.hypot(...forward);
    if (length > .02) bends.push((bend[0] * forward[0] + bend[2] * forward[1]) / length);
  }
  const supports = samples.flatMap(sample => ['Left', 'Right'].filter(side => sample.ik?.[side.toLowerCase()]?.phase === 'Support').map(side => Math.abs(sample.feet[side].minClearance)));
  return { samples: samples.length, footSamples: feet.length, vertexQueries: feet.reduce((sum, foot) => sum + foot.vertices, 0),
    maxPenetration: feet.length ? Math.max(...feet.map(foot => foot.maxPenetration)) : null,
    supportSamples: supports.length, maxSupportError: supports.length ? Math.max(...supports) : null,
    minKneeForwardBend: bends.length ? Math.min(...bends) : null,
    surfaces: [...new Set(feet.flatMap(foot => foot.terrains))] };
}

await mkdir(outputDir, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(outputDir, 'vite-cache'),
  optimizeDeps: { entries: [], include: ['@babylonjs/core', '@babylonjs/loaders'], noDiscovery: true },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [{ name: 'humanoid-terrain-smoke',
    resolveId(id) { if (id === '/__humanoid_terrain__.js') return moduleId; }, load(id) { if (id === moduleId) return harness; },
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] !== '/__humanoid_terrain__') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>普通人物地形动作验收</title><style>body{margin:0;background:#101822;color:#eee;font:14px sans-serif}header{height:48px;padding:0 16px;display:flex;gap:16px;align-items:center}canvas{display:block;width:100vw;height:calc(100vh - 48px)}pre{position:absolute;right:10px;top:48px;max-width:360px;font:11px monospace;pointer-events:none}</style><header><button id="start">开始地形验收</button><span>普通 Xbot · 15cm 台阶 · 10° 坡道 · 真实键盘往返</span></header><canvas tabindex="0"></canvas><pre id="status"></pre><script type="module" src="/__humanoid_terrain__.js"></script></html>');
    }); },
  }] });
await server.listen();
const url = server.resolvedUrls.local[0] + '__humanoid_terrain__';
let browser, page;
const errors = [], checkpoints = [], metrics = {};
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, recordVideo: { dir: path.join(outputDir, 'video'), size: { width: 1280, height: 900 } } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.humanoidTerrainQA?.ready, null, { timeout: 90000 });
  await page.waitForFunction(() => window.humanoidTerrainQA.runtime.getSnapshot().avatarAnimationMode !== 'loading', null, { timeout: 90000 });
  assert.equal(await page.evaluate(() => window.humanoidTerrainQA.runtime.getSnapshot().avatarAnimationMode), 'auto-skeleton');
  await page.getByRole('button', { name: '开始地形验收', exact: true }).click();
  await page.waitForFunction(() => window.humanoidTerrainQA.runtime.getSnapshot().grounded);
  const travel = async (stage, key, targetZ, height) => {
    await page.evaluate(stage => { window.humanoidTerrainQA.stage = stage; }, stage);
    await page.locator('canvas').focus(); await page.keyboard.down(key);
    try {
      await page.waitForFunction(({ targetZ, forward }) => {
        const z = window.humanoidTerrainQA.runtime.collider.position.z; return forward ? z >= targetZ : z <= targetZ;
      }, { targetZ, forward: key === 'KeyW' }, { timeout: 25000 });
    } finally { await page.keyboard.up(key); }
    await page.waitForFunction(() => { const qa = window.humanoidTerrainQA; return qa.runtime.getSnapshot().grounded && qa.runtime.skeletalAnimator.getStatus().activeGroups.join() === 'Idle'; });
    const position = await page.evaluate(() => window.humanoidTerrainQA.runtime.collider.position.asArray());
    checkpoints.push({ stage, targetZ, expectedHeight: height, position });
    assert.ok(Math.abs(position[1] - height) < .035, `${stage} 碰撞体没有实际到达地形高度：${JSON.stringify(position)}，预期 ${height}`);
    await page.screenshot({ path: path.join(outputDir, stage + '.png') });
  };
  await travel('StepUp', 'KeyW', 3.1, .15);
  await travel('StepDown', 'KeyW', 5.2, 0);
  await travel('RampUp', 'KeyW', 11.1, rampHeight);
  await travel('RampDown', 'KeyS', 5.2, 0);
  await travel('ReturnStepUp', 'KeyS', 3.1, .15);
  await travel('ReturnStepDown', 'KeyS', .3, 0);
  const samples = await page.evaluate(() => window.humanoidTerrainQA.samples);
  await writeFile(path.join(outputDir, 'telemetry.json'), JSON.stringify(samples));
  const failures = [];
  if (errors.length) failures.push(...errors);
  if (!samples.every(sample => sample.finite)) failures.push('存在非有限关节位置或世界矩阵');
  if (!samples.every(sample => Object.values(sample.feet).every(foot => foot.vertices > 0 && Number.isFinite(foot.minClearance) && Number.isFinite(foot.maxPenetration)))) failures.push('实际CPU足底或局部地形间隙采样缺失');
  for (const classification of ['grounded-interior', 'edge-crossing', 'airborne']) {
    const group = samples.filter(sample => sample.classification === classification);
    const result = measureGroup(group); metrics[classification] = result;
    if (classification !== 'airborne' && group.length < 8) failures.push(`${classification} 实际采样不足`);
    if (classification !== 'airborne' && result.maxPenetration > .02) failures.push(`${classification} 真实足底穿地超过2cm：${result.maxPenetration}`);
    if (classification !== 'airborne' && result.minKneeForwardBend < -.02) failures.push(`${classification} 膝关节反向折叠超过2cm：${result.minKneeForwardBend}`);
  }
  for (const stage of checkpoints.map(point => point.stage)) {
    const group = samples.filter(sample => sample.stage === stage); metrics[stage] = measureGroup(group);
    if (group.length < 6) failures.push(`${stage} 实际采样不足`);
  }
  assert.ok(metrics.RampUp.surfaces.includes('ramp-10deg') && metrics.RampDown.surfaces.includes('ramp-10deg'), '上/下坡都必须实际测到坡面');
  await writeFile(path.join(outputDir, 'results.json'), JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', terrain: { stepHeight: .15, rampAngleDegrees: 10, rampHeight }, checkpoints, metrics, failures, errors }, null, 2));
  assert.equal(failures.length, 0, failures.join('\n'));
  console.log(`PASS: 普通人物真实15cm台阶/10度坡道往返、CPU蒙皮与局部地形射线。${outputDir}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
    const state = await page.evaluate(() => ({ snapshot: window.humanoidTerrainQA?.runtime.getSnapshot(), samples: window.humanoidTerrainQA?.samples })).catch(() => null);
    await writeFile(path.join(outputDir, 'failure.json'), JSON.stringify({ error: String(error), checkpoints, metrics, errors, state }));
  }
  throw error;
} finally {
  try {
    if (page) {
      await page.keyboard.up('KeyW').catch(() => {}); await page.keyboard.up('KeyS').catch(() => {});
      await page.evaluate(() => window.humanoidTerrainQA?.dispose()).catch(() => {});
      const video = page.video(); await page.close();
      if (video) { const videoPath = path.join(outputDir, 'terrain-validation.webm'); await video.saveAs(videoPath); assert.ok((await stat(videoPath)).size > 1000); }
    }
  } finally { try { await browser?.close(); } finally { await server.close(); } }
}
