import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const runContactMode = process.argv.includes('--run-contact');
const ikPhase2Mode = process.argv.includes('--ik-phase2') || runContactMode;
const ikPhase1Mode = process.argv.includes('--ik-phase1') || ikPhase2Mode;
const locomotionMode = process.argv.includes('--locomotion') || ikPhase1Mode;
const postureMode = process.argv.includes('--posture') || locomotionMode;
const factoryMode = process.argv.includes('--factory') || postureMode;
const outputDir = path.resolve(runContactMode?'output/playwright/manual-roam-run-contact/run-'+Date.now():ikPhase2Mode?'output/playwright/manual-roam-ik-phase2':ikPhase1Mode?'output/playwright/manual-roam-ik-phase1':locomotionMode?'output/playwright/manual-roam-locomotion':postureMode?'output/playwright/manual-roam-posture':factoryMode?'output/playwright/manual-roam-foot-ik':'output/playwright/manual-roam-skeletal');

function measureSupportSegments(samples) {
  const distance=(a,b)=>Math.hypot(a[0]-b[0],a[2]-b[2]),segments=[],previous={},handoffs=[];
  let supportSamples=0,lockedSupportSamples=0,validPairs=0;
  for(const s of samples)for(const side of ['left','right']) {
    const state=s.ik[side],lock=s.locks[side],point=s.soles?.[side],last=previous[side];
    if(state.phase==='Support')supportSamples++;
    if(state.phase!=='Support'||!state.locked||!lock||!point){if(last)handoffs.push({side,frame:s.sampleId,fromLock:last.lock,toLock:null,phase:state.phase,reason:state.releaseReason??state.reason,rawContact:s.contacts[side]});previous[side]=null;continue;}
    lockedSupportSamples++;
    if(last&&last.vertex===point.vertex&&last.endFrame+1===s.sampleId&&distance(last.lock,lock)<.0001) {
      last.pairs++;validPairs++;last.endFrame=s.sampleId;last.end=point.point;last.netDrift=distance(last.start,point.point);last.peakDrift=Math.max(last.peakDrift??0,last.netDrift);
    } else {
      const segment={side,lock,startFrame:s.sampleId,endFrame:s.sampleId,vertex:point.vertex,start:point.point,end:point.point,pairs:0,netDrift:null,peakDrift:null};
      segments.push(segment);previous[side]=segment;handoffs.push({side,frame:s.sampleId,fromLock:last?.lock??null,toLock:lock,phase:state.phase,reason:state.lockReason??state.reason,rawContact:s.contacts[side]});
    }
  }
  return {supportSamples,lockedSupportSamples,coverage:lockedSupportSamples/Math.max(1,supportSamples),validPairs,unmeasuredSingleSamples:segments.filter(s=>!s.pairs).length,segments,handoffs,
    maxSegmentDrift:validPairs?Math.max(...segments.filter(s=>s.pairs>0).map(s=>s.peakDrift)):null};
}
function assertPhase2Support(report,label) {
  assert.ok(report.supportSamples>0&&report.validPairs>0,`${label}没有真实Support连续同锁同顶点样本，不能报告零漂移`);
  for(const side of ['left','right'])assert.ok(report.segments.some(s=>s.side===side&&s.pairs>0),`${label}/${side}缺少连续有效支撑段`);
  assert.ok(report.coverage>.7,`${label}真实Support锁覆盖不足${report.coverage}`);
  assert.ok(report.segments.filter(s=>s.pairs>0).every(s=>s.peakDrift<=.01&&s.netDrift<=.01),`${label}实际鞋底同支撑段漂移超过1cm：${report.maxSegmentDrift}m`);
}
const moduleId = '\0manual-roam-skeletal.js';
const assetVersion = process.env.ROAM_ASSET_VERSION ?? 'v2';
if (!['v1','v2'].includes(assetVersion)) throw new Error('ROAM_ASSET_VERSION必须是v1或v2');
const harness = `
import '@babylonjs/loaders';
import { ArcRotateCamera, AnimatorAvatar, Color3, Engine, HemisphericLight, MeshBuilder, Scene, SceneLoader, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { ManualRoamRuntime } from '/src/runtime/roam/ManualRoamRuntime.ts';
import { prepareManualRoamReferencePose } from '/src/runtime/roam/manualRoamAvatarRig.ts';

const canvas = document.querySelector('canvas');
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);
scene.clearColor.set(0.10, 0.13, 0.17, 1);
const camera = new ArcRotateCamera('camera', -Math.PI / 2, 1.35, 3.5, new Vector3(0, .85, 0), scene);
camera.attachControl(canvas, true);
const light = new HemisphericLight('light', new Vector3(.3, 1, -.4), scene); light.intensity = 1.4;
const ground = MeshBuilder.CreateGround('ground', { width: 40, height: 40 }, scene);
ground.checkCollisions = true;
const material = new StandardMaterial('groundMaterial', scene); material.diffuseColor = new Color3(.22,.26,.3); ground.material = material;
const wall = MeshBuilder.CreateBox('wall', { width: 3, height: 2.4, depth: .3 }, scene); wall.position.set(0,1.2,3); wall.checkCollisions = true;
const step = MeshBuilder.CreateBox('step', { width: 2, height: .15, depth: 1 }, scene); step.position.set(3,.075,0); step.checkCollisions = true;
const root = new TransformNode('preview', scene);
const factoryMode=${factoryMode};
const locomotionMode=${locomotionMode};
const spawnZ=factoryMode?-30:0;
if(factoryMode){
  ground.scaling.set(3,1,3);wall.position.z=-25.5;step.position.set(0,.075,-28);
  const factory=await SceneLoader.LoadAssetContainerAsync('/Assets/Environments/'+encodeURIComponent('厂区环境模型_Optimized')+'/',encodeURIComponent('厂区环境模型_Optimized.glb'),scene);
  const factoryRoot=new TransformNode('factory-meters',scene);factoryRoot.scaling.setAll(.001);
  factory.addAllToScene();factory.rootNodes.forEach(node=>node.parent=factoryRoot);
  factory.meshes.forEach(mesh=>{mesh.checkCollisions=true;});
  root.position.z=spawnZ;camera.target.z=spawnZ;
}
if(locomotionMode){
  wall.setEnabled(false);step.setEnabled(false);const lines=[];
  for(let i=-40;i<=10;i++)lines.push([new Vector3(-10,.002,i),new Vector3(10,.002,i)]);
  for(let i=-10;i<=10;i++)lines.push([new Vector3(i,.002,-40),new Vector3(i,.002,10)]);
  const grid=MeshBuilder.CreateLineSystem('ground-reference-grid',{lines},scene);grid.color=new Color3(.42,.45,.48);grid.isPickable=false;
}
let avatar, groups = [], current, runtime;
const errors = [];
const ikTelemetry=[];let beforeFeet={};
scene.onAfterAnimationsObservable.add(()=>{
  beforeFeet={};if(!runtime?.getSnapshot().enabled)return;
  const fk={};for(const name of ['Hips','LeftUpLeg','LeftLeg','LeftFoot','RightUpLeg','RightLeg','RightFoot']){const node=runtime.avatarContainer?.transformNodes.find(n=>n.name===name);if(node){node.computeWorldMatrix(true);fk[name]=node.getAbsolutePosition().asArray();}}if(window.roamQA){window.roamQA.beforeFK=fk;if(window.roamQA.runContact)window.roamQA.beforeRotations=Object.fromEntries(runtime.avatarContainer.transformNodes.filter(n=>/Hips|UpLeg|Leg$|Foot$|ToeBase/.test(n.name)).map(n=>[n.name,n.rotationQuaternion?.asArray()??n.rotation.asArray()]));}
  for(const side of ['left','right']){const node=runtime.avatarContainer?.transformNodes.find(n=>n.name===(side==='left'?'LeftFoot':'RightFoot'));if(node){node.computeWorldMatrix(true);beforeFeet[side]=node.getAbsolutePosition().clone();}}
});
scene.onAfterRenderObservable.add(()=>{
  if(!runtime?.getSnapshot().enabled||!runtime.footIK||ikTelemetry.length>=12000)return;
  const debug=runtime.footIK.getDebugState(),contacts=runtime.skeletalAnimator.getFootContacts();
  for(const side of ['left','right']){const node=runtime.avatarContainer.transformNodes.find(n=>n.name===(side==='left'?'LeftFoot':'RightFoot'));node.computeWorldMatrix(true);const data=debug[side];
    ikTelemetry.push({side,locked:data.locked,reason:data.reason,weight:contacts[side],target:data.target?.asArray(),actual:node.getAbsolutePosition().asArray(),before:beforeFeet[side]?.asArray(),error:data.targetError,
      y:runtime.collider.position.y,turn:runtime.turnState.turnClip,turnProgress:runtime.turnState.turnProgress,controlYaw:runtime.kinematicState.yaw,visualYaw:runtime.turnState.visualYaw});}
});
const source = await SceneLoader.LoadAssetContainerAsync('/manual-roam/', 'locomotion-${assetVersion}.glb', scene);
source.animationGroups.forEach(group => group.stop());
const initialTransforms = source.transformNodes.map(node => ({node, position:node.position.clone(), rotation:node.rotationQuaternion?.clone(), scaling:node.scaling.clone()}));
function restoreSource(){for(const value of initialTransforms){value.node.position.copyFrom(value.position);if(value.rotation)value.node.rotationQuaternion.copyFrom(value.rotation);value.node.scaling.copyFrom(value.scaling);}}
async function loadAvatar(url) {
  groups.forEach(group => group.dispose()); groups=[]; current=undefined; avatar?.dispose();
  avatar = await SceneLoader.LoadAssetContainerAsync('', url, scene, undefined, '.glb');
  avatar.animationGroups.forEach(group => group.stop());
  prepareManualRoamReferencePose(avatar);avatar.skeletons.forEach(skeleton=>skeleton.returnToRest());
  avatar.meshes.forEach(mesh => {mesh.isPickable=false;mesh.checkCollisions=false;mesh.metadata={...mesh.metadata,manualRoamAvatar:true};});
  avatar.addAllToScene(); avatar.rootNodes.forEach(node=>node.parent=root);
  const rig = new AnimatorAvatar('preview-rig', avatar.rootNodes[0], false, false);
  for(const sourceGroup of source.animationGroups){restoreSource();groups.push(rig.retargetAnimationGroup(sourceGroup,{checkHierarchy:true,fixRootPosition:true,rootNodeName:'Hips',groundReferenceNodeName:'LeftFoot',fixGroundReference:false}));}
  chooseClip('Idle');
  if(window.roamQA)window.roamQA.avatarUrl=url;
  return { skins:avatar.skeletons.length, targets:groups.map(g=>[g.name,g.targetedAnimations.length]) };
}
function chooseClip(name) {
  groups.forEach(group=>group.stop()); avatar.skeletons.forEach(skeleton=>skeleton.returnToRest());
  current=groups.find(group=>group.name===name); if(current)current.start(true,1);
  document.querySelector('#clip').value=name;
}
const clip = document.querySelector('#clip');
source.animationGroups.forEach(group=>{const option=document.createElement('option');option.textContent=group.name;clip.append(option);});
clip.onchange=()=>chooseClip(clip.value);
document.querySelector('#phase').oninput=event=>{current?.pause();if(current)current.goToFrame(current.from+(current.to-current.from)*Number(event.target.value));scene.render();};
document.querySelector('#play').onclick=()=>current?.restart();
document.querySelector('#skin').onchange=event=>loadAvatar(event.target.value).catch(error=>errors.push(error.message));
document.querySelector('#roam').onclick=()=>{
  if(!runtime)runtime=new ManualRoamRuntime({scene,engine,camera,canvas,avatarUrl:new URL('/manual-roam/EQ_People_rigged_${assetVersion}.glb',location.href).href,resolveSpawnPose:()=>({position:{x:0,y:0,z:spawnZ},yaw:0}),setOrbitControlsEnabled:enabled=>enabled?camera.attachControl(canvas,true):camera.detachControl(),onLog:message=>errors.push(message)});
  const enabled=!runtime.getSnapshot().enabled;
  groups.forEach(group=>group.pause());root.setEnabled(!enabled);runtime.setEnabled(enabled);
  document.querySelector('#roam').textContent=enabled?'退出漫游':'进入漫游';canvas.focus();
};
document.querySelector('#fly').onclick=()=>runtime?.setLocomotionMode(runtime.getSnapshot().locomotionMode==='fly'?'ground':'fly');
document.querySelector('#view').onclick=()=>runtime?.setViewMode(runtime.getSnapshot().viewMode==='thirdPerson'?'firstPerson':'thirdPerson');
document.querySelector('#reset').onclick=()=>runtime?.reset();
engine.runRenderLoop(()=>{scene.render();document.querySelector('#status').textContent=runtime?.getSnapshot().enabled?JSON.stringify(runtime.getSnapshot(),null,2):'骨骼动画预览';});
window.addEventListener('resize',()=>engine.resize());
window.roamQA={loadAvatar,chooseClip,scene,engine,camera,ikTelemetry,get runtime(){return runtime},get avatar(){return avatar},get current(){return current},errors,dispose(){runtime?.dispose();groups.forEach(g=>g.dispose());avatar?.dispose();source.dispose();scene.dispose();engine.dispose();}};
await loadAvatar('/manual-roam/EQ_People_rigged_${assetVersion}.glb');
window.roamQA.ready=true;
`;

await mkdir(outputDir, { recursive: true });
const server = await createServer({
  configFile: false, root: process.cwd(), cacheDir: path.join(outputDir, 'vite-cache'),
  optimizeDeps: { entries: [], include: ['@babylonjs/core', '@babylonjs/loaders'], noDiscovery: true },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  plugins: [{ name: 'manual-roam-skeletal-fixture',
    resolveId(id) { if (id === '/__manual_roam_skeletal__.js') return moduleId; },
    load(id) { if (id === moduleId) return harness; },
    configureServer(vite) { vite.middlewares.use((req,res,next)=>{
      if(req.url?.split('?')[0]!=='/__manual_roam_skeletal__') return next();
      res.setHeader('Content-Type','text/html');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>漫游骨骼验证</title><style>body{margin:0;background:#19212b;color:#eee;font:14px sans-serif}header{height:56px;display:flex;gap:10px;align-items:center;padding:0 16px}canvas{width:100vw;height:calc(100vh - 56px);display:block}pre{position:absolute;right:12px;top:65px;max-width:330px;font-size:11px;pointer-events:none}button,select{padding:7px}</style><header><select id="skin"><option value="/manual-roam/EQ_People_rigged_${assetVersion}.glb">默认人物</option><option value="/tests/fixtures/roam/worker-blue-rigged-${assetVersion}.glb">蓝色人物</option></select><select id="clip"></select><input id="phase" type="range" min="0" max="1" step=".01" value="0"><button id="play">播放</button><button id="roam">进入漫游</button><button id="fly">地面/飞行</button><button id="view">第一/第三人称</button><button id="reset">回出生点</button></header><canvas tabindex="0"></canvas><pre id="status"></pre><script type="module" src="/__manual_roam_skeletal__.js"></script></html>`);
    }); },
  }],
});
await server.listen();
const url = server.resolvedUrls.local[0] + '__manual_roam_skeletal__';
console.log(url);
if (process.argv.includes('--serve')) {
  await writeFile(path.join(outputDir,'url.txt'), url);
  const shutdown = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
} else {
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true});
    const page = await browser.newPage({viewport:{width:1280,height:900},recordVideo:factoryMode?{dir:path.join(outputDir,'video'),size:{width:1280,height:900}}:undefined});
    const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
    await page.goto(url,{waitUntil:'commit'});
    await page.waitForFunction(()=>window.roamQA?.ready,null,{timeout:90000});
    const clips=await page.locator('#clip option').allTextContents();assert.equal(clips.length,assetVersion==='v2'?17:15);
    await page.waitForFunction(()=>window.roamQA.scene.isReady());
    for(const name of (runContactMode?['Idle']:clips)){await page.selectOption('#clip',name);await page.locator('#phase').fill('0.35');await page.screenshot({path:path.join(outputDir,name+'.png')});}
    await page.selectOption('#skin',`/tests/fixtures/roam/worker-blue-rigged-${assetVersion}.glb`);
    await page.waitForFunction(()=>window.roamQA.avatarUrl?.includes('worker-blue')||window.roamQA.errors.length>0);
    assert.deepEqual(await page.evaluate(()=>window.roamQA.errors),[],'换肤加载失败');
    await page.waitForFunction(()=>window.roamQA.scene.isReady());
    await page.screenshot({path:path.join(outputDir,'second-skin.png')});
    await page.getByRole('button',{name:'进入漫游',exact:true}).click();
    await page.waitForFunction(()=>window.roamQA.runtime?.getSnapshot().avatarAnimationMode!=='loading');
    assert.equal(await page.evaluate(()=>window.roamQA.runtime.getSnapshot().avatarAnimationMode),'shared-skeleton');
    await page.evaluate(()=>window.roamQA.runtime.updateConfig({thirdPersonDistance:4,thirdPersonHeight:.8}));
    const focus = () => page.locator('canvas').focus();
    const idle = () => page.waitForFunction(()=>{const a=window.roamQA.runtime.skeletalAnimator.getStatus().activeGroups;return a.length===1&&a[0]==='Idle';},null,{timeout:8000});
    if(postureMode) {
      await page.evaluate(({fixedCamera,everyFrame,runContact})=>{
        const q=window.roamQA;q.runContact=runContact;q.postureSamples=[];q.postureStage='Idle';
        const shoe=q.runtime.avatarContainer.meshes.find(m=>m.material?.name==='Ren_Xie_M');
        const shoeData=shoe?{indices:[...new Set(shoe.getIndices())],positions:shoe.getVerticesData('position'),joints:shoe.getVerticesData('matricesIndices'),weights:shoe.getVerticesData('matricesWeights')}:null;
        const soles=()=>{
          if(!shoeData)return null;
          const V=q.camera.position.constructor,M=shoe.getWorldMatrix().constructor,raw=shoe.skeleton.getTransformMatrices(shoe),matrices=Array.from({length:raw.length/16},(_,i)=>M.FromArray(raw,i*16)),world=shoe.computeWorldMatrix(true),out={left:null,right:null},points={left:[],right:[]};
          for(const i of shoeData.indices){const source=V.FromArray(shoeData.positions,i*3),p=V.Zero();for(let k=0;k<4;k++)p.addInPlace(V.TransformCoordinates(source,matrices[shoeData.joints[i*4+k]]).scale(shoeData.weights[i*4+k]));const value=V.TransformCoordinates(p,world),side=source.x>=0?'left':'right',point={vertex:i,point:value.asArray()};points[side].push(point);if(!out[side]||value.y<out[side].point[1])out[side]=point;}
          for(const side of ['left','right']){const point=out[side];if(!point)continue;const bottom=points[side].filter(p=>p.point[1]<point.point[1]+.08),candidates=new Map([[point.vertex,point]]);
            // 地面有局部高差时，接触可能在前掌/后跟，不能把最低世界Y点到低地面的间隙当成整脚悬空。
            for(let i=0;i<8;i++){const x=Math.cos(i*Math.PI/4),z=Math.sin(i*Math.PI/4),edge=bottom.reduce((a,b)=>a.point[0]*x+a.point[2]*z>b.point[0]*x+b.point[2]*z?a:b);candidates.set(edge.vertex,edge);}
            const clearances=[...candidates.values()].map(p=>{const ground=q.runtime.pickGround(p.point[0],p.point[2],p.point[1]+.2,.6);return ground?{vertex:p.vertex,point:p.point,groundHeight:ground.y,clearance:p.point[1]-ground.y}:null;}).filter(Boolean);
            let contact=clearances.sort((a,b)=>a.clearance-b.clearance)[0];
            // 窄高地面可能在鞋底轮廓内部；轮廓点全悬空时用完整鞋点复核真实接触。
            if(runContact&&contact?.clearance>.002)point.fullPoints=points[side];
            point.groundHeight=contact?.groundHeight??null;point.clearance=contact?.clearance??null;point.contact=contact;if(runContact)point.candidates=clearances;}
          return out;
        };
        // 仅验证机位跟随人物侧面，输入、运动、动画与IK仍使用正式Runtime。
        q.fixedCamera=fixedCamera;q.observationHeading=0;q.observationTarget=1.4;q.observationDistance=5;
        q.scene.onBeforeRenderObservable.add(()=>{const p=q.runtime.collider.position;if(q.fixedCamera){const V=p.constructor,heading=q.observationHeading,target=new V(Math.sin(heading)*q.observationTarget,.85,-30+Math.cos(heading)*q.observationTarget);q.camera.setTarget(target);q.camera.setPosition(target.add(new V(Math.cos(heading)*q.observationDistance,.65,-Math.sin(heading)*q.observationDistance)));}else{q.camera.setTarget(p.add(p.constructor.Up().scale(.85)));q.camera.setPosition(p.add(new p.constructor(3,1,0)));}});
        q.scene.onAfterRenderObservable.add(()=>{
          if(!q.postureStage||q.postureSamples.length>=4000)return;
          const nodes=q.runtime.avatarContainer.transformNodes,at=name=>{const n=nodes.find(n=>n.name===name);n.computeWorldMatrix(true);return n.getAbsolutePosition().asArray();};
          const active=q.scene.getActiveMeshes();
          q.postureSamples.push({sampleId:q.postureSamples.length,grounded:q.runtime.kinematicState.grounded,teleported:q.runtime.motionResetThisFrame,resetTransition:Boolean(q.runtime.resetTransition),dt:q.engine.getDeltaTime()/1000,requestedStrideScale:q.runtime.skeletalAnimator.getStrideScale(),stage:q.postureStage,beforeFK:q.beforeFK,...(runContact?{beforeRotations:q.beforeRotations,afterRotations:Object.fromEntries(nodes.filter(n=>/Hips|UpLeg|Leg$|Foot$|ToeBase/.test(n.name)).map(n=>[n.name,n.rotationQuaternion?.asArray()??n.rotation.asArray()]))}:{}),afterIK:{Hips:at('Hips'),LeftUpLeg:at('LeftUpLeg'),LeftLeg:at('LeftLeg'),RightUpLeg:at('RightUpLeg'),RightLeg:at('RightLeg')},phase:q.runtime.skeletalAnimator.getStatus().phase,clips:q.runtime.skeletalAnimator.getStatus().activeGroups,avatarVisible:active.data.slice(0,active.length).includes(shoe),visualYaw:q.runtime.turnState.visualYaw,controlYaw:q.runtime.kinematicState.yaw,root:q.runtime.collider.position.asArray(),contacts:q.runtime.skeletalAnimator.getFootContacts(),ik:q.runtime.footIK.getDebugState(),soles:q.fixedCamera&&(everyFrame||q.postureSamples.length%3===0)?soles():null,locks:{left:q.runtime.footIK.legs.left.lock?.asArray(),right:q.runtime.footIK.legs.right.lock?.asArray()},
            leftHand:at('LeftHand'),rightHand:at('RightHand'),leftArm:at('LeftArm'),rightArm:at('RightArm'),leftFoot:at('LeftFoot'),rightFoot:at('RightFoot'),leftHip:at('LeftUpLeg'),rightHip:at('RightUpLeg')});
        });
      },{fixedCamera:locomotionMode,everyFrame:ikPhase1Mode,runContact:runContactMode});
      await idle();await page.screenshot({path:path.join(outputDir,'runtime-idle-side.png')});
      const metrics={};
      for(const family of ['Walk','Run'])for(const [key,direction]of [['KeyW','Forward'],['KeyS','Backward'],['KeyA','Left'],['KeyD','Right']]) {
        if(runContactMode&&(family!=='Run'||direction!=='Forward'))continue;
        if(ikPhase1Mode&&(direction==='Backward'||family==='Run'&&direction!=='Forward'))continue;
        await page.getByRole('button',{name:'回出生点',exact:true}).click();
        await page.waitForFunction(()=>window.roamQA.runtime.getSnapshot().statusMessage!=='正在复位视角...'&&window.roamQA.runtime.getSnapshot().grounded);await idle();
        const clip=family+direction,expected=assetVersion==='v2'?family+'Forward':clip;
        const heading={Forward:0,Backward:Math.PI,Left:-Math.PI/2,Right:Math.PI/2}[direction];
        await page.evaluate(({name,heading,run,distance})=>{window.roamQA.postureStage=name;window.roamQA.observationHeading=heading;window.roamQA.observationTarget=run?3:1.4;window.roamQA.observationDistance=distance;},{name:clip,heading,run:family==='Run',distance:runContactMode?11:family==='Run'?7.5:5});
        await focus();if(family==='Run')await page.keyboard.down('Shift');await page.keyboard.down(key);
        await page.waitForFunction(name=>{const a=window.roamQA.runtime.skeletalAnimator.getStatus().activeGroups;return a.length===1&&a[0]===name;},expected);
        if(runContactMode)await page.waitForFunction(()=>window.roamQA.runtime.collider.position.z>-23.8,null,{timeout:20000});else await page.waitForTimeout(1800);
        await page.screenshot({path:path.join(outputDir,'runtime-'+clip+'.png')});
        if(assetVersion==='v2') {
          const yaw=await page.evaluate(()=>window.roamQA.runtime.turnState.visualYaw);
          assert.ok(Math.abs(Math.atan2(Math.sin(yaw-heading),Math.cos(yaw-heading)))<.04,`${clip}身体必须朝向实际移动方向`);
          assert.equal(await page.evaluate(()=>window.roamQA.runtime.kinematicState.yaw),0,'不得改变相机或键盘控制yaw');
        }
        await page.keyboard.up(key);if(family==='Run')await page.keyboard.up('Shift');
        if(ikPhase1Mode)await page.evaluate(name=>{window.roamQA.postureStage='Stop-'+name;},clip);
        await idle();if(ikPhase1Mode)await page.waitForTimeout(500);
        // 完整鞋点的静态地形重放放在松键后，避免验证射线阻塞渲染而漏掉短促跑步支撑帧。
        if(runContactMode)await page.evaluate(()=>{const q=window.roamQA;for(const s of q.postureSamples)for(const point of Object.values(s.soles??{})){if(!point.fullPoints)continue;for(const p of point.fullPoints){const ground=q.runtime.pickGround(p.point[0],p.point[2],p.point[1]+.2,.6);if(ground&&p.point[1]-ground.y<point.clearance){point.contact={vertex:p.vertex,point:p.point,groundHeight:ground.y,clearance:p.point[1]-ground.y};point.clearance=point.contact.clearance;point.groundHeight=ground.y;}}delete point.fullPoints;}});
        const samples=await page.evaluate(({name,expected})=>window.roamQA.postureSamples.filter(s=>s.stage===name&&s.clips.length===1&&s.clips[0]===expected),{name:clip,expected});
        assert.ok(samples.length>15,`${clip}必须实际运行完整的采样区间`);
        const cycles=samples.slice(1).reduce((sum,s,i)=>sum+(s.phase-samples[i].phase+1)%1,0);
        assert.ok(cycles>=1,`${clip}必须覆盖至少一个完整步态周期，当前${cycles}`);
        const along=(s,side)=>(s[side+'Hand'][0]-s[side+'Arm'][0])*Math.sin(s.visualYaw)+(s[side+'Hand'][2]-s[side+'Arm'][2])*Math.cos(s.visualYaw);
        const left=samples.map(s=>along(s,'left')),right=samples.map(s=>along(s,'right'));
        const range=values=>Math.max(...values)-Math.min(...values),mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
        const a=left.map(x=>x-mean(left)),b=right.map(x=>x-mean(right));
        const correlation=a.reduce((sum,x,i)=>sum+x*b[i],0)/Math.sqrt(a.reduce((sum,x)=>sum+x*x,0)*b.reduce((sum,x)=>sum+x*x,0));
        assert.ok(range(left)>.10&&range(right)>.10&&correlation<-.5,`${clip}实际人物必须交替摆臂`);
        metrics[clip]={samples:samples.length,cycles,leftSwingMeters:range(left),rightSwingMeters:range(right),correlation};
        if(locomotionMode) {
          assert.ok(samples.every(s=>s.avatarVisible),`${clip}人物和鞋必须在固定机位内实际渲染`);
          const measured=samples.filter(s=>s.soles);assert.ok(measured.length>4,'必须测量真实蒙皮鞋底');
          if(ikPhase2Mode)assert.ok(measured.every(s=>Object.values(s.soles).every(p=>Number.isFinite(p.clearance))),'真实鞋底必须有独立地面采样');
          const penetration=Math.max(0,...measured.flatMap(s=>['left','right'].map(side=>-(ikPhase2Mode?s.soles[side].clearance:s.soles[side].point[1]))));
          const steady=measured.filter(s=>Math.abs(Math.atan2(Math.sin(s.visualYaw-heading),Math.cos(s.visualYaw-heading)))<.08);
          // 平滑曲线的进出接触阶段允许脚掌卸载/抬起；贴地误差只对满支撑段断言，并单独保留过渡数据。
          const support=steady.flatMap(s=>['left','right'].filter(side=>ikPhase2Mode?s.ik[side].phase==='Support':s.contacts[side]>.999).map(side=>({side,locked:s.ik[side].locked,reason:s.ik[side].reason,height:ikPhase2Mode?s.soles[side].clearance:s.soles[side].point[1]})));
          const lockCoverage=support.filter(s=>s.locked).length/Math.max(1,support.length),maxSupportError=Math.max(...support.map(s=>Math.abs(s.height)));
          let maxDrift=0,segments=0,validPairs=0;const previous={};
          const distance=(a,b)=>Math.hypot(a[0]-b[0],a[2]-b[2]);
          for(const s of steady)for(const side of ['left','right']){
            const point=s.soles[side],last=previous[side],lock=s.locks[side];
            if((ikPhase2Mode?s.ik[side].phase==='Support':s.contacts[side]>.999)&&s.ik[side].locked&&lock){if(last&&last.vertex===point.vertex&&distance(last.lock,lock)<.0001&&(!ikPhase1Mode||last.frame+1===s.sampleId)){validPairs++;maxDrift=Math.max(maxDrift,distance(last.start,point.point));previous[side]={...last,frame:s.sampleId};}else{segments++;previous[side]={vertex:point.vertex,lock,start:point.point,frame:s.sampleId};}}else previous[side]=null;
          }
          metrics[clip].shoe={samples:measured.length,maxPenetrationMeters:penetration,supportSamples:support.length,lockCoverage,maxSupportErrorMeters:maxSupportError,maxFixedSoleDriftMeters:validPairs?maxDrift:null,validPairs,segments,lossReasons:support.filter(s=>!s.locked).map(s=>s.reason)};
          await writeFile(path.join(outputDir,'locomotion-progress.json'),JSON.stringify({metrics,samples},null,2));
          if(ikPhase2Mode){metrics[clip].trueSupport=measureSupportSegments(steady);await writeFile(path.join(outputDir,'phase2-progress.json'),JSON.stringify({metrics,samples},null,2));assertPhase2Support(metrics[clip].trueSupport,clip);}
          if(runContactMode) {
            const all=await page.evaluate(()=>window.roamQA.postureSamples);
            const report=measureSupportSegments(samples),score=s=>Math.max(...['left','right'].map(side=>s.ik[side].phase==='Support'?Math.abs(s.soles?.[side]?.clearance??0):-(s.soles?.[side]?.clearance??0)));
            const peakIds=all.filter(s=>s.soles).sort((a,b)=>score(b)-score(a)).slice(0,6).map(s=>s.sampleId);
            const peaks=all.filter(s=>peakIds.some(id=>Math.abs(id-s.sampleId)<=2)).map(s=>({...s,actualFootDisplacement:Object.fromEntries(['left','right'].map(side=>{const prior=all.find(p=>p.sampleId===s.sampleId-1);return[side,prior?s[side+'Foot'].map((v,i)=>v-prior[side+'Foot'][i]):null];}))}));
            const excluded=all.filter(s=>s.resetTransition||s.teleported||!s.grounded),eligible=all.filter(s=>!s.resetTransition&&!s.teleported&&s.grounded),excludedStats={count:excluded.length,resetTransition:excluded.filter(s=>s.resetTransition).length,teleported:excluded.filter(s=>s.teleported).length,airborne:excluded.filter(s=>!s.grounded).length,maxPenetration:Math.max(0,...excluded.filter(s=>s.soles).flatMap(s=>['left','right'].map(side=>-s.soles[side].clearance)))};
            const routePenetration=Math.max(0,...eligible.filter(s=>s.soles).flatMap(s=>['left','right'].map(side=>-s.soles[side].clearance))),routeSupportError=Math.max(0,...eligible.filter(s=>s.soles).flatMap(s=>['left','right'].filter(side=>s.ik[side].phase==='Support').map(side=>Math.abs(s.soles[side].clearance))));
            const errors=[];if(routePenetration>.002)errors.push('penetration='+routePenetration);if(routeSupportError>.002)errors.push('supportError='+routeSupportError);
            await writeFile(path.join(outputDir,'run-contact-report.json'),JSON.stringify({status:errors.length?'FAIL':'PASS',routePenetration,routeSupportError,excludedStats,metrics,report,peakIds,errors},null,2));
            await writeFile(path.join(outputDir,'run-contact-telemetry.json'),JSON.stringify(all));
            await writeFile(path.join(outputDir,'run-contact-peaks.json'),JSON.stringify(peaks,null,2));
            assertPhase2Support(report,'RunForward');assert.ok(support.length>0&&['left','right'].every(side=>support.some(s=>s.side===side)),'跑步必须存在双脚真实支撑样本');
            assert.equal(errors.length,0,'严格2mm真实鞋底门槛失败: '+errors.join(', '));
          }
          assert.ok(penetration<.015,`${clip}真实鞋底穿地${penetration}m`);
          for(const side of ['left','right'])assert.ok(support.filter(s=>s.side===side).length>=3,`${clip}/${side}必须有真实承重采样`);
          assert.ok(lockCoverage>.7&&segments>=2,`${clip}承重锁定覆盖不足${lockCoverage}`);
          assert.ok(maxSupportError<.02,`${clip}承重鞋底离地误差${maxSupportError}m`);
          if(ikPhase1Mode)assert.ok(validPairs>0,`${clip}没有连续同锁同顶点样本，禁止把漂移0当通过`);
          assert.ok(maxDrift<.025,`${clip}同一锁段实际鞋底漂移${maxDrift}m`);
        }
      }
      if(ikPhase2Mode&&!runContactMode)for(const angle of [45,90,180]) {
        await page.getByRole('button',{name:'回出生点',exact:true}).click();await page.waitForFunction(()=>!window.roamQA.runtime.resetTransition&&window.roamQA.runtime.getSnapshot().grounded);await idle();
        const stage='MovingTurn'+angle;
        await page.evaluate(({stage,angle})=>{const q=window.roamQA;q.postureStage=stage;q.observationHeading=angle*Math.PI/360;q.observationTarget=1.8;q.observationDistance=8;},{stage,angle});
        await focus();await page.keyboard.down('KeyW');
        let turnInputFrame=0;
        try {
          await page.waitForTimeout(850);turnInputFrame=await page.evaluate(()=>window.roamQA.postureSamples.length);
          await page.mouse.move(10,450);await page.mouse.down({button:'right'});
          await page.mouse.move(10+angle*Math.PI/180/.0025,450,{steps:12});await page.mouse.up({button:'right'});
          await page.waitForTimeout(1900);await page.screenshot({path:path.join(outputDir,stage+'.png')});
        } finally {await page.mouse.up({button:'right'});await page.keyboard.up('KeyW');}
        await idle();
        const turnSamples=await page.evaluate(stage=>window.roamQA.postureSamples.filter(s=>s.stage===stage),stage);
        const report=measureSupportSegments(turnSamples),turning=turnSamples.filter(s=>Math.abs(Math.atan2(Math.sin(s.controlYaw-s.visualYaw),Math.cos(s.controlYaw-s.visualYaw)))>.1);
        const yawChange=turnSamples.at(-1).controlYaw-turnSamples[0].controlYaw;
        report.actualControlTurnRadians=Math.abs(Math.atan2(Math.sin(yawChange),Math.cos(yawChange)));
        report.singleFootHeldDuringTurn=turning.filter(s=>s.ik.left.locked!==s.ik.right.locked).length;
        report.newAnchorAfterTurn=['left','right'].some(side=>{const before=report.segments.filter(s=>s.side===side&&s.pairs>0&&s.startFrame<turnInputFrame),after=report.segments.filter(s=>s.side===side&&s.pairs>0&&s.startFrame>=turnInputFrame);return before.some(a=>after.some(b=>Math.hypot(a.lock[0]-b.lock[0],a.lock[2]-b.lock[2])>.03));});
        metrics[stage]=report;await writeFile(path.join(outputDir,'phase2-turn-progress.json'),JSON.stringify({metrics,turnSamples},null,2));
        assert.ok(turnSamples.length>15&&turnSamples.every(s=>s.avatarVisible),'移动转向人物必须持续可见');
        assert.ok(Math.abs(report.actualControlTurnRadians-angle*Math.PI/180)<.08,`${stage}未实际完成要求的转向角度`);
        assert.ok(turning.length>0&&report.singleFootHeldDuringTurn>0,'转向期间不能双脚每帧清锁；需看到单脚保留支撑');
        assert.ok(report.newAnchorAfterTurn,'移动转向必须实际交接到新锁点');assertPhase2Support(report,stage);
      }
      if(ikPhase1Mode&&!runContactMode) {
        await page.evaluate(()=>{const q=window.roamQA;q.ikUpdate=q.runtime.footIK.update;q.setIK=enabled=>{q.runtime.footIK.reset();q.runtime.footIK.update=enabled?q.ikUpdate:function(){};};});
        try {
          for(const enabled of [false,true]) {
            await page.evaluate(enabled=>{const q=window.roamQA;q.setIK(enabled);q.postureStage='Comparison-'+(enabled?'IK':'FK');q.observationHeading=0;q.observationTarget=1.4;q.observationDistance=5;},enabled);
            await page.getByRole('button',{name:'回出生点',exact:true}).click();await page.waitForFunction(()=>!window.roamQA.runtime.resetTransition&&window.roamQA.runtime.getSnapshot().grounded);await idle();
            await focus();await page.keyboard.down('KeyW');await page.waitForTimeout(1500);
            await page.screenshot({path:path.join(outputDir,enabled?'comparison-ik.png':'comparison-fk.png')});
            await page.keyboard.up('KeyW');await idle();
          }
        } finally {await page.keyboard.up('KeyW');await page.evaluate(()=>window.roamQA.setIK(true));}
        await page.evaluate(()=>{window.roamQA.scene.getMeshByName('step').setEnabled(true);window.roamQA.postureStage='Step15cm';window.roamQA.observationTarget=2;});
        await page.getByRole('button',{name:'回出生点',exact:true}).click();await page.waitForFunction(()=>!window.roamQA.runtime.resetTransition&&window.roamQA.runtime.getSnapshot().grounded);await idle();await focus();await page.keyboard.down('KeyW');
        try{await page.waitForFunction(()=>window.roamQA.runtime.collider.position.z>-28.1,null,{timeout:10000});}finally{await page.keyboard.up('KeyW');}
        await idle();const height=await page.evaluate(()=>window.roamQA.runtime.collider.position.y);assert.ok(Math.abs(height-.15)<.01,'胶囊体必须真实登上15厘米台阶');
        metrics.stepHeight=height;await page.screenshot({path:path.join(outputDir,'step15cm.png')});
        await page.evaluate(()=>window.roamQA.scene.getMeshByName('step').setEnabled(false));
      }
      if(!runContactMode) {
      await focus();await page.keyboard.down('KeyW');await page.keyboard.down('KeyA');
      await page.waitForFunction(version=>{const a=window.roamQA.runtime.skeletalAnimator.getStatus().activeGroups;return version==='v2'?a.length===1&&a[0]==='WalkForward':a.length===2&&a.includes('WalkForward')&&a.includes('WalkLeft');},assetVersion);await page.waitForTimeout(900);
      await page.screenshot({path:path.join(outputDir,'runtime-diagonal.png')});await page.keyboard.up('KeyW');await page.keyboard.up('KeyA');await idle();
      }
      const samples=await page.evaluate(()=>window.roamQA.postureSamples);
      if(ikPhase1Mode){
        assert.ok(samples.some(s=>s.beforeFK?.LeftLeg&&s.afterIK?.LeftLeg),'缺少FK/IK膝盖对照');
        const feet=samples.flatMap(s=>Object.values(s.ik)),phases=new Set(feet.map(f=>f.phase));
        for(const phase of ['Swing','Landing','Support','ToeOff'])assert.ok(phases.has(phase),`真实移动缺少${phase}阶段`);
        assert.ok(feet.every(f=>f.weights&&Object.values(f.weights).every(v=>Number.isFinite(v)&&v>=0&&v<=1)&&Number.isFinite(f.pelvisOffset)&&f.pelvisOffset>=0&&f.pelvisOffset<=.08),'阶段权重及骨盆补偿必须有界');
        await writeFile(path.join(outputDir,ikPhase2Mode?'phase2-telemetry.json':'phase1-telemetry.json'),JSON.stringify(samples));
      }
      await writeFile(path.join(outputDir,'runtime-posture-telemetry.json'),JSON.stringify(samples));
      await writeFile(path.join(outputDir,'runtime-posture-results.json'),JSON.stringify({scene:'厂区环境模型_Optimized.glb',metrics,pageErrors},null,2));
      console.log(JSON.stringify(metrics));
    } else if(factoryMode) {
      await focus();await page.keyboard.down('KeyW');
      await page.waitForFunction(()=>window.roamQA.runtime.collider.position.z>-28.1,null,{timeout:10000});
      await page.keyboard.up('KeyW');await idle();
      const stair=await page.evaluate(()=>({height:window.roamQA.runtime.collider.position.y,feet:window.roamQA.runtime.footIK.getDebugState()}));
      assert.ok(Math.abs(stair.height-.15)<.01,'胶囊体必须真正登上15厘米台阶');
      for(const foot of Object.values(stair.feet))assert.ok(foot.locked&&foot.targetError<.01,'台阶支撑脚必须贴合目标');
      await page.screenshot({path:path.join(outputDir,'factory-step.png')});
      const position=await page.evaluate(()=>window.roamQA.runtime.collider.position.asArray());
      await page.mouse.move(240,450);await page.mouse.down({button:'right'});await page.mouse.move(868,450);await page.mouse.up({button:'right'});
      await page.waitForFunction(()=>window.roamQA.runtime.turnState.turnClip!==null,null,{timeout:4000});
      await page.waitForFunction(()=>window.roamQA.runtime.turnState.turnProgress>.25,null,{timeout:4000});
      await page.screenshot({path:path.join(outputDir,'factory-turn-mid.png')});
      await page.waitForFunction(()=>window.roamQA.runtime.turnState.turnClip===null&&Math.abs(window.roamQA.runtime.turnState.deltaYaw)<.05,null,{timeout:6000});await idle();
      for(const angle of [45,60,180]) {
        await page.mouse.move(10,450);await page.mouse.down({button:'right'});await page.mouse.move(10+angle*Math.PI/180/.0025,450);await page.mouse.up({button:'right'});
        await page.waitForFunction(()=>window.roamQA.runtime.turnState.turnClip!==null,null,{timeout:4000});
        await page.waitForFunction(()=>window.roamQA.runtime.turnState.turnClip===null&&Math.abs(window.roamQA.runtime.turnState.deltaYaw)<.05,null,{timeout:6000});await idle();
      }
      const after=await page.evaluate(()=>window.roamQA.runtime.collider.position.asArray());
      assert.ok(Math.hypot(...after.map((value,i)=>value-position[i]))<.001,'原地转身不能移动碰撞体');
      const telemetry=await page.evaluate(()=>window.roamQA.ikTelemetry);
      const solved=telemetry.filter(row=>row.locked&&row.weight>.999&&row.target&&row.before);
      assert.ok(solved.length>50,`必须实际触发支撑脚修正，当前${solved.length}样本`);
      const distance=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
      const rms=key=>Math.sqrt(solved.reduce((sum,row)=>sum+distance(row[key],row.target)**2,0)/solved.length);
      const beforeError=rms('before'),afterError=rms('actual');
      assert.ok(beforeError>.015,'需真实暴露未修正脚底偏移');
      assert.ok(afterError<.01&&afterError<beforeError*.25,'支撑期实际脚底误差必须显著减少');
      let maxDrift=0;const last={};
      for(const row of solved){const previous=last[row.side];if(previous&&distance(previous.target,row.target)<.0001)maxDrift=Math.max(maxDrift,distance(previous.actual,row.actual));last[row.side]=row;}
      assert.ok(maxDrift<.02,`固定锁点时脚底漂移${maxDrift}m`);
      await writeFile(path.join(outputDir,'results.json'),JSON.stringify({scene:'厂区环境模型_Optimized.glb',factoryScale:.001,stepHeight:stair.height,stair,turnPositionBefore:position,turnPositionAfter:after,
        solvedSamples:solved.length,beforeErrorRms:beforeError,afterErrorRms:afterError,maxLockedDrift:maxDrift,pageErrors},null,2));
      await writeFile(path.join(outputDir,'telemetry.json'),JSON.stringify(telemetry));
      console.log(JSON.stringify({solvedSamples:solved.length,beforeErrorRms:beforeError,afterErrorRms:afterError,maxLockedDrift:maxDrift}));
      await page.screenshot({path:path.join(outputDir,'factory-turn-finished.png')});
    } else {
    await focus();await page.keyboard.down('KeyW');
    await page.waitForFunction(()=>window.roamQA.runtime.getSnapshot().moving,null,{timeout:5000});
    await page.waitForFunction(()=>!window.roamQA.runtime.getSnapshot().moving,null,{timeout:10000});
    await idle();await page.keyboard.up('KeyW');
    console.log('PASS: 顶墙时实际速度归零且全部行走片段停止。');
    await page.getByRole('button',{name:'回出生点',exact:true}).click();
    await page.waitForFunction(()=>window.roamQA.runtime.getSnapshot().statusMessage!=='正在复位视角...');
    for(const [key,clipName] of [['KeyS','WalkBackward'],['KeyA','WalkLeft'],['KeyD','WalkRight']]){
      await focus();await page.keyboard.down(key);
      const expected=assetVersion==='v2'?'WalkForward':clipName;
      await page.waitForFunction(name=>window.roamQA.runtime.skeletalAnimator.getStatus().activeGroups.includes(name),expected,{timeout:5000});
      await page.waitForFunction(name=>{const s=window.roamQA.runtime.skeletalAnimator.getStatus();return s.activeGroups.length===1&&s.activeGroups[0]===name&&s.phase>0.2&&s.phase<0.8;},expected,{timeout:5000});
      await page.screenshot({path:path.join(outputDir,'runtime-'+clipName+'.png')});
      await page.keyboard.up(key);await idle();
    }
    await focus();await page.keyboard.down('Shift');await page.keyboard.down('KeyW');
    await page.waitForFunction(()=>window.roamQA.runtime.skeletalAnimator.getStatus().activeGroups.includes('RunForward'),null,{timeout:5000});
    await page.waitForFunction(()=>{const s=window.roamQA.runtime.skeletalAnimator.getStatus();return s.activeGroups.length===1&&s.activeGroups[0]==='RunForward'&&s.phase>0.2&&s.phase<0.8;},null,{timeout:5000});
    await page.screenshot({path:path.join(outputDir,'runtime-run.png')});
    await page.keyboard.up('KeyW');await page.keyboard.up('Shift');await idle();
    await page.keyboard.press('Space');
    await page.waitForFunction(()=>!window.roamQA.runtime.getSnapshot().grounded,null,{timeout:5000});
    await page.waitForFunction(()=>window.roamQA.runtime.getSnapshot().grounded,null,{timeout:5000});await idle();
    await page.getByRole('button',{name:'地面/飞行',exact:true}).click();await focus();await page.keyboard.down('KeyE');
    await page.waitForFunction(()=>window.roamQA.runtime.skeletalAnimator.getStatus().activeGroups.includes('FlyMove'),null,{timeout:5000});
    await page.keyboard.up('KeyE');await page.getByRole('button',{name:'第一/第三人称',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.roamQA.runtime.getSnapshot().viewMode),'firstPerson');
    await page.getByRole('button',{name:'第一/第三人称',exact:true}).click();
    await page.getByRole('button',{name:'地面/飞行',exact:true}).click();
    await page.getByRole('button',{name:'回出生点',exact:true}).click();
    await page.waitForFunction(()=>window.roamQA.runtime.getSnapshot().grounded,null,{timeout:5000});await idle();
    const counts = () => page.evaluate(()=>({meshes:window.roamQA.scene.meshes.length,skeletons:window.roamQA.scene.skeletons.length,groups:window.roamQA.scene.animationGroups.length,animatables:window.roamQA.scene.animatables.length}));
    const baseline = await counts();
    for(let i=0;i<20;i++){await page.getByRole('button',{name:'退出漫游',exact:true}).click();await page.getByRole('button',{name:'进入漫游',exact:true}).click();}
    await idle();assert.deepEqual(await counts(),baseline);
    await page.screenshot({path:path.join(outputDir,'runtime-final.png')});
    await writeFile(path.join(outputDir,'results.json'),JSON.stringify({clips,baseline,after:await counts(),pageErrors},null,2));
    }
    assert.deepEqual(pageErrors,[]);
    await page.evaluate(()=>window.roamQA.dispose());
    if(postureMode) {
      const video=page.video();await page.close();
      const videoPath=path.join(outputDir,ikPhase2Mode?'ik-phase2-comparison.webm':ikPhase1Mode?'ik-phase1-comparison.webm':locomotionMode?'locomotion-validation.webm':'posture-validation.webm');await video.saveAs(videoPath);
      assert.ok((await stat(videoPath)).size>1000,'姿态验证录像必须完成落盘');
    }
    console.log(runContactMode?'PASS: RunForward与起停真实鞋底2mm及连续支撑1cm门槛。':ikPhase1Mode?'PASS: 实际厂区GLB、前/左右走、前跑、停止、IK/FK对照、连续鞋底采样与15厘米台阶。':postureMode?'PASS: 实际厂区GLB、正式Runtime、八方向走跑交替摆臂与斜向混合。':factoryMode?'PASS: 实际厂区GLB、15厘米台阶、右键原地转身与支撑脚误差/漂移验证。':'PASS: 动作WebGL采样、两种皮肤、真实键盘后退/侧移/跑步/跳跃/飞行、视角切换、20次启停资源稳定。');
  } finally {try {await browser?.close();} finally {await server.close();}}
}
