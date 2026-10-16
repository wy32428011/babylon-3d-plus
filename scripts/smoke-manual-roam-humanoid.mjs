import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const outputDir = path.resolve('output/playwright/manual-roam-humanoid', `run-${Date.now()}`);
const moduleId = '\0manual-roam-humanoid.js';
const harness = `
import '@babylonjs/loaders';
import { ArcRotateCamera, Color3, Engine, HemisphericLight, Matrix, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { ManualRoamRuntime } from '/src/runtime/roam/ManualRoamRuntime.ts';
const canvas=document.querySelector('canvas'),engine=new Engine(canvas,true,{preserveDrawingBuffer:true,stencil:true}),scene=new Scene(engine);
scene.clearColor.set(.055,.075,.11,1);
const camera=new ArcRotateCamera('observer',-Math.PI/2,1.3,4,new Vector3(0,.9,0),scene);
const light=new HemisphericLight('light',new Vector3(.5,1,-.5),scene);light.intensity=1.5;
const ground=MeshBuilder.CreateGround('ground',{width:100,height:100},scene);ground.checkCollisions=true;
const material=new StandardMaterial('ground-material',scene);material.diffuseColor=new Color3(.2,.25,.3);ground.material=material;
const lines=[];for(let i=-30;i<=30;i++){lines.push([new Vector3(-30,.002,i),new Vector3(30,.002,i)]);lines.push([new Vector3(i,.002,-30),new Vector3(i,.002,30)]);}
const grid=MeshBuilder.CreateLineSystem('ground-grid',{lines},scene);grid.color=new Color3(.3,.36,.42);grid.isPickable=false;
const urls={ordinary:'/scripts/manual-roam-assets/sources/Xbot.glb',standard:'/tests/fixtures/roam/worker-blue-rigged-v2.glb'};
const logs=[],runtime=new ManualRoamRuntime({scene,engine,camera,canvas,avatarUrl:new URL(urls.ordinary,location.href).href,
  resolveSpawnPose:()=>({position:{x:0,y:0,z:0},yaw:0}),setOrbitControlsEnabled:()=>{},onLog:message=>logs.push(message)});
const qa={scene,engine,camera,runtime,logs,stage:'loading',samples:[],ready:true,observe:true,lastSample:0,skinCache:null,skinContainer:null};
window.humanoidQA=qa;
document.querySelector('#roam').onclick=()=>{runtime.setEnabled(!runtime.getSnapshot().enabled);canvas.focus();};
document.querySelector('#fly').onclick=()=>runtime.setLocomotionMode(runtime.getSnapshot().locomotionMode==='fly'?'ground':'fly');
document.querySelector('#view').onclick=()=>runtime.setViewMode(runtime.getSnapshot().viewMode==='thirdPerson'?'firstPerson':'thirdPerson');
document.querySelector('#reset').onclick=()=>runtime.reset();
document.querySelector('#skin').onchange=event=>runtime.setAvatarUrl(new URL(urls[event.target.value],location.href).href);

function buildSkinCache(){
  if(qa.skinContainer===runtime.avatarContainer)return;
  qa.skinContainer=runtime.avatarContainer;qa.skinCache=[];
  const binding=runtime.skeletalAnimator?.getRigBinding();if(!binding)return;
  for(const mesh of runtime.avatarContainer.meshes){
    if(!mesh.skeleton||!mesh.getTotalVertices())continue;
    const positions=mesh.getVerticesData('position'),indices=mesh.getVerticesData('matricesIndices'),weights=mesh.getVerticesData('matricesWeights');
    if(!positions||!indices||!weights)continue;
    const sideBones={};for(const side of ['Left','Right']){
      const foot=binding.joints.get(side+'Foot');sideBones[side]=new Set();
      for(const bone of mesh.skeleton.bones){let parent=bone;while(parent){if(parent.getTransformNode()===foot){sideBones[side].add(bone.getIndex());break;}parent=parent.getParent();}}
    }
    const points=[];for(let vertex=0;vertex<mesh.getTotalVertices();vertex++)for(const side of ['Left','Right']){
      let amount=0;for(let k=0;k<4;k++)if(sideBones[side].has(indices[vertex*4+k]))amount+=weights[vertex*4+k];
      if(amount>=.5)points.push({vertex,side});
    }
    qa.skinCache.push({mesh,positions,indices,weights,points});
  }
}
function measureSoles(){
  buildSkinCache();const soles={Left:null,Right:null};
  for(const data of qa.skinCache??[]){
    const {mesh,positions,indices,weights,points}=data,raw=mesh.skeleton.getTransformMatrices(mesh);
    const matrices=Array.from({length:raw.length/16},(_,i)=>Matrix.FromArray(raw,i*16)),world=mesh.computeWorldMatrix(true);
    for(const {vertex,side} of points){const source=Vector3.FromArray(positions,vertex*3),skinned=Vector3.Zero();
      for(let k=0;k<4;k++)skinned.addInPlace(Vector3.TransformCoordinates(source,matrices[indices[vertex*4+k]]).scale(weights[vertex*4+k]));
      const point=Vector3.TransformCoordinates(skinned,world);if(!soles[side]||point.y<soles[side].point[1])soles[side]={mesh:mesh.name,vertex,point:point.asArray()};
    }
  }return soles;
}
scene.onBeforeRenderObservable.add(()=>{
  if(!qa.observe||!runtime.getSnapshot().enabled||runtime.getSnapshot().viewMode!=='thirdPerson')return;
  // 只改变验收摄像机；输入、碰撞、动画、IK 和真实人物变形全部使用正式 Runtime。
  const p=runtime.collider.position,target=p.add(new Vector3(0,.85,0)),yaw=runtime.turnState.visualYaw;
  camera.setTarget(target);camera.setPosition(target.add(new Vector3(Math.cos(yaw)*3.5,1.2,-Math.sin(yaw)*3.5-2)));
});
scene.onAfterRenderObservable.add(()=>{
  if(!runtime.getSnapshot().enabled||!runtime.skeletalAnimator||performance.now()-qa.lastSample<45||qa.samples.length>=12000)return;
  qa.lastSample=performance.now();const binding=runtime.skeletalAnimator.getRigBinding(),joints={},rotations={};
  for(const [name,node] of binding.joints){node.computeWorldMatrix(true);joints[name]=node.getAbsolutePosition().asArray();rotations[name]=(node.rotationQuaternion??node.rotation).asArray();}
  const animator=runtime.skeletalAnimator.getStatus(),debug=runtime.footIK?.getDebugState();
  qa.samples.push({time:performance.now(),stage:qa.stage,position:runtime.collider.position.asArray(),
    grounded:runtime.getSnapshot().grounded,mode:runtime.getSnapshot().avatarAnimationMode,view:runtime.getSnapshot().viewMode,
    clips:animator.activeGroups,phase:animator.phase,joints,rotations,soles:measureSoles(),ik:debug,
    visible:runtime.avatarContainer.meshes.some(mesh=>mesh.getTotalVertices()>0&&mesh.isEnabled()&&mesh.isVisible),
    worldMatricesFinite:runtime.avatarContainer.meshes.every(mesh=>Array.from(mesh.getWorldMatrix().m).every(Number.isFinite))});
});
engine.runRenderLoop(()=>{scene.render();document.querySelector('#status').textContent=qa.stage+'\\n'+JSON.stringify(runtime.getSnapshot(),null,2);});
window.addEventListener('resize',()=>engine.resize());
qa.dispose=()=>{runtime.dispose();scene.dispose();engine.dispose();};
`;

function stageMetrics(samples, label) {
  assert.ok(samples.length >= 10, `${label} 必须保留至少 10 帧实际渲染采样`);
  assert.ok(samples.every(sample => sample.worldMatricesFinite), `${label} 存在无效世界矩阵`);
  assert.ok(samples.every(sample => Object.keys(sample.joints).length === 22 && Object.values(sample.joints).flat().every(Number.isFinite)), `${label} 关键关节世界位置必须完整且有限`);
  const first = samples[0];
  const rotationChange = Math.max(...samples.flatMap(sample => Object.keys(sample.rotations).map(name => (
    Math.hypot(...sample.rotations[name].map((value, index) => value - first.rotations[name][index]))
  ))));
  assert.ok(rotationChange > .002, `${label} 真实关节必须随动作变化，当前 ${rotationChange}`);
  const solePoints = samples.flatMap(sample => Object.values(sample.soles).filter(Boolean));
  assert.equal(solePoints.length, samples.length * 2, `${label} 两只脚都必须有实际 CPU 蒙皮顶点`);
  assert.ok(solePoints.every(sole => sole.point.every(Number.isFinite)), `${label} 实际蒙皮出现无效坐标`);
  const metrics = { samples: samples.length, rotationChange, clips: [...new Set(samples.flatMap(sample => sample.clips))],
    minSoleY: Math.min(...solePoints.map(sole => sole.point[1])), maxSoleY: Math.max(...solePoints.map(sole => sole.point[1])) };
  const limbPairs = ['Left', 'Right'].flatMap(side => [['UpLeg', 'Leg'], ['Leg', 'Foot'], ['Arm', 'ForeArm'], ['ForeArm', 'Hand']].map(pair => pair.map(name => side + name)));
  const distance = (sample, pair) => Math.hypot(...sample.joints[pair[0]].map((value, index) => value - sample.joints[pair[1]][index]));
  metrics.maxLimbLengthRelativeError = Math.max(...limbPairs.flatMap(pair => samples.map(sample => Math.abs(distance(sample, pair) / distance(first, pair) - 1))));
  assert.ok(metrics.maxLimbLengthRelativeError <= .03, `${label} 真实四肢骨段长度发生异常拉伸：${metrics.maxLimbLengthRelativeError}`);
  if (['Idle', 'Walk', 'Run', 'Turn'].includes(label)) {
    const grounded = samples.filter(sample => sample.grounded);
    assert.ok(grounded.length > 5, `${label} 缺少地面采样`);
    const penetration = Math.max(0, ...grounded.flatMap(sample => Object.values(sample.soles).map(sole => -sole.point[1])));
    metrics.maxPenetration = penetration;
    assert.ok(penetration <= .02, `${label} 真实脚底穿地超过 2 厘米：${penetration}`);
    const support = grounded.flatMap(sample => ['Left', 'Right'].filter(side => sample.ik?.[side.toLowerCase()]?.phase === 'Support')
      .map(side => Math.abs(sample.soles[side].point[1])));
    assert.ok(support.length >= 6, `${label} 必须测到实际脚部支撑阶段，不能只验证状态标签`);
    if (support.length) {
      metrics.supportSamples = support.length; metrics.maxSupportError = Math.max(...support);
      assert.ok(metrics.maxSupportError <= .03, `${label} 支撑期真实脚底离地超过 3 厘米：${metrics.maxSupportError}`);
    }
  }
  if (['Walk', 'Run'].includes(label)) {
    const backwardBends = [];
    for (const sample of samples) for (const side of ['Left', 'Right']) {
      const hip = sample.joints[side + 'UpLeg'], knee = sample.joints[side + 'Leg'], ankle = sample.joints[side + 'Foot'];
      const axis = ankle.map((value, i) => value - hip[i]);
      const projection = knee.reduce((sum, value, i) => sum + (value - hip[i]) * axis[i], 0) / axis.reduce((sum, value) => sum + value * value, 0);
      const bend = knee.map((value, i) => value - hip[i] - projection * axis[i]);
      // 跑步后踢时脚尖可向后旋转，前向基准必须来自身体，不能由正在运动的脚掌决定。
      const lateral = [sample.joints.RightUpLeg[0] - sample.joints.LeftUpLeg[0], sample.joints.RightUpLeg[2] - sample.joints.LeftUpLeg[2]];
      const forward = [-lateral[1], lateral[0]];
      if (Math.hypot(...forward) > .02) backwardBends.push((bend[0] * forward[0] + bend[2] * forward[1]) / Math.hypot(...forward));
    }
    assert.ok(backwardBends.length > 10, `${label} 缺少实际膝关节弯曲数据`);
    metrics.minKneeForwardBend = Math.min(...backwardBends);
    assert.ok(metrics.minKneeForwardBend >= -.02, `${label} 膝关节明显向身体后方折叠：${metrics.minKneeForwardBend}`);
  }
  return metrics;
}

await mkdir(outputDir, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(outputDir, 'vite-cache'),
  optimizeDeps: { entries: [], include: ['@babylonjs/core', '@babylonjs/loaders'], noDiscovery: true },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [{ name: 'manual-roam-humanoid-smoke',
    resolveId(id) { if (id === '/__manual_roam_humanoid__.js') return moduleId; },
    load(id) { if (id === moduleId) return harness; },
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] !== '/__manual_roam_humanoid__') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>普通人物自动适配动作验收</title><style>body{margin:0;background:#101822;color:#eee;font:14px sans-serif}header{height:56px;display:flex;align-items:center;gap:10px;padding:0 16px}button,select{padding:8px}canvas{width:100vw;height:calc(100vh - 56px);display:block}pre{position:absolute;right:12px;top:60px;max-width:370px;font-size:11px;pointer-events:none}</style><header><select id="skin"><option value="ordinary">普通 Mixamo Xbot</option><option value="standard">现有蓝色人物</option></select><button id="roam">启停漫游</button><button id="fly">地面/飞行</button><button id="view">第一/第三人称</button><button id="reset">回出生点</button></header><canvas tabindex="0"></canvas><pre id="status"></pre><script type="module" src="/__manual_roam_humanoid__.js"></script></html>');
    }); },
  }] });
await server.listen();
const url = server.resolvedUrls.local[0] + '__manual_roam_humanoid__';
await writeFile(path.join(outputDir, 'url.txt'), url);
console.log(`普通人物验证：${url}`);
if (process.argv.includes('--serve')) {
  const close = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
} else {
  let browser, page;
  const pageErrors = [], metrics = {};
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, recordVideo: { dir: path.join(outputDir, 'video'), size: { width: 1280, height: 900 } } });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.humanoidQA?.ready, null, { timeout: 90000 });
    await page.waitForFunction(() => window.humanoidQA.runtime.getSnapshot().avatarAnimationMode !== 'loading', null, { timeout: 90000 });
    assert.equal(await page.evaluate(() => window.humanoidQA.runtime.getSnapshot().avatarAnimationMode), 'auto-skeleton', await page.evaluate(() => window.humanoidQA.runtime.getSnapshot().statusMessage));
    await page.getByRole('button', { name: '启停漫游', exact: true }).click();
    await page.waitForFunction(() => window.humanoidQA.runtime.getSnapshot().grounded);
    const focus = () => page.locator('canvas').focus();
    const waitClip = name => page.waitForFunction(name => {
      const clips = window.humanoidQA.runtime.skeletalAnimator.getStatus().activeGroups;
      return clips.length === 1 && clips[0] === name;
    }, name, { timeout: 10000 });
    const capture = async (stage, count = 26) => {
      await page.evaluate(stage => { window.humanoidQA.stage = stage; }, stage);
      await page.waitForFunction(({ stage, count }) => window.humanoidQA.samples.filter(sample => sample.stage === stage).length >= count, { stage, count }, { timeout: 15000 });
      await page.screenshot({ path: path.join(outputDir, stage + '.png') });
    };
    await waitClip('Idle'); await capture('Idle');
    await page.evaluate(() => { window.humanoidQA.stage = 'WalkStart'; });
    await focus(); await page.keyboard.down('KeyW'); await waitClip('WalkForward'); await capture('Walk');
    await page.evaluate(() => { window.humanoidQA.stage = 'WalkToRun'; });
    await page.keyboard.down('Shift'); await waitClip('RunForward'); await capture('Run');
    await page.evaluate(() => { window.humanoidQA.stage = 'RunStop'; });
    await page.keyboard.up('KeyW'); await page.keyboard.up('Shift'); await waitClip('Idle');
    await page.evaluate(() => { window.humanoidQA.stage = 'Jump'; });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !window.humanoidQA.runtime.getSnapshot().grounded);
    await page.screenshot({ path: path.join(outputDir, 'Jump-airborne.png') });
    await page.waitForFunction(() => window.humanoidQA.runtime.getSnapshot().grounded);
    await waitClip('Idle');
    await page.evaluate(() => { window.humanoidQA.stage = 'Turn'; });
    await page.mouse.move(240, 450); await page.mouse.down({ button: 'right' });
    await page.mouse.move(240 + Math.PI / 2 / .0025, 450, { steps: 12 }); await page.mouse.up({ button: 'right' });
    await page.waitForFunction(() => window.humanoidQA.samples.some(sample => sample.stage === 'Turn' && sample.clips.some(clip => clip.startsWith('Turn'))), null, { timeout: 10000 });
    await capture('Turn', 24); await waitClip('Idle');
    await page.evaluate(() => { window.humanoidQA.stage = 'FlyStart'; });
    await page.getByRole('button', { name: '地面/飞行', exact: true }).click(); await focus();
    await page.keyboard.down('KeyE'); await page.keyboard.down('KeyW'); await waitClip('FlyMove'); await capture('Fly');
    await page.evaluate(() => { window.humanoidQA.stage = 'AfterFlight'; });
    await page.keyboard.up('KeyE'); await page.keyboard.up('KeyW');
    await page.getByRole('button', { name: '第一/第三人称', exact: true }).click();
    assert.equal(await page.evaluate(() => window.humanoidQA.runtime.getSnapshot().viewMode), 'firstPerson');
    assert.equal(await page.evaluate(() => window.humanoidQA.runtime.avatarContainer.meshes.every(mesh => !mesh.isEnabled())), true, '第一人称必须实际隐藏人物网格');
    await page.screenshot({ path: path.join(outputDir, 'First-person.png') });
    await page.getByRole('button', { name: '第一/第三人称', exact: true }).click();
    assert.equal(await page.evaluate(() => window.humanoidQA.runtime.avatarContainer.meshes.some(mesh => mesh.getTotalVertices() > 0 && mesh.isEnabled() && mesh.isVisible)), true, '第三人称必须恢复可渲染人物网格');
    await page.getByRole('button', { name: '地面/飞行', exact: true }).click();
    await page.getByRole('button', { name: '回出生点', exact: true }).click();
    await page.waitForFunction(() => !window.humanoidQA.runtime.resetTransition && window.humanoidQA.runtime.getSnapshot().grounded);
    await waitClip('Idle');
    const counts = () => page.evaluate(() => ({ meshes: window.humanoidQA.scene.meshes.length, skeletons: window.humanoidQA.scene.skeletons.length, groups: window.humanoidQA.scene.animationGroups.length }));
    const baseline = await counts();
    for (let index = 0; index < 5; index++) {
      await page.selectOption('#skin', 'standard');
      await page.waitForFunction(() => window.humanoidQA.runtime.getSnapshot().avatarAnimationMode === 'shared-skeleton');
      await page.selectOption('#skin', 'ordinary');
      await page.waitForFunction(() => window.humanoidQA.runtime.getSnapshot().avatarAnimationMode === 'auto-skeleton');
    }
    await waitClip('Idle');
    assert.deepEqual(await counts(), baseline, '人物反复切换后场景资源数量必须稳定');
    for (let index = 0; index < 10; index++) {
      await page.getByRole('button', { name: '启停漫游', exact: true }).click();
      await page.getByRole('button', { name: '启停漫游', exact: true }).click();
    }
    await waitClip('Idle');
    assert.deepEqual(await counts(), baseline, '重复启停后场景资源数量必须稳定');
    const samples = await page.evaluate(() => window.humanoidQA.samples);
    await writeFile(path.join(outputDir, 'telemetry.json'), JSON.stringify(samples));
    const failures = [];
    for (const stage of ['Idle', 'Walk', 'Run', 'Jump', 'Turn', 'Fly']) {
      try { metrics[stage] = stageMetrics(samples.filter(sample => sample.stage === stage), stage); }
      catch (error) { metrics[stage] = { error: String(error) }; failures.push(String(error)); }
    }
    const routeSamples = samples.filter(sample => ['Idle', 'WalkStart', 'Walk', 'WalkToRun', 'Run', 'RunStop', 'Turn'].includes(sample.stage) && sample.grounded);
    const routePenetration = Math.max(0, ...routeSamples.flatMap(sample => Object.values(sample.soles).map(sole => -sole.point[1])));
    if (routePenetration > .02) failures.push(`起停与地面动作全过程真实脚底穿地超过 2 厘米：${routePenetration}`);
    assert.deepEqual(pageErrors, [], '浏览器不能发生未处理错误');
    await writeFile(path.join(outputDir, 'results.json'), JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', source: 'Xbot.glb without project profile', metrics, routePenetration, failures, baseline, after: await counts(), pageErrors }, null, 2));
    assert.equal(failures.length, 0, failures.join('\n'));
    console.log(`PASS: 普通人物真实 WebGL、键鼠走跑跳转飞、CPU 蒙皮脚底/膝盖、视角、换肤及启停。${outputDir}`);
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(outputDir, 'failure.png') }).catch(() => {});
      const state = await page.evaluate(() => ({ snapshot: window.humanoidQA?.runtime.getSnapshot(), logs: window.humanoidQA?.logs, samples: window.humanoidQA?.samples })).catch(() => null);
      await writeFile(path.join(outputDir, 'failure.json'), JSON.stringify({ error: String(error), metrics, pageErrors, state }, null, 2));
    }
    throw error;
  } finally {
    try {
      if (page) {
        await page.evaluate(() => window.humanoidQA?.dispose()).catch(() => {});
        const video = page.video(); await page.close();
        const videoPath = path.join(outputDir, 'humanoid-validation.webm');
        if (video) { await video.saveAs(videoPath); assert.ok((await stat(videoPath)).size > 1000, '实际动画录像必须落盘'); }
      }
    } finally { try { await browser?.close(); } finally { await server.close(); } }
  }
}
