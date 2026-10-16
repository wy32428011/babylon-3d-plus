import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import ts from 'typescript';
import { chromium } from 'playwright';
import { copyManualRoamAvatarWithAdaptation } from '../dist-electron/ipc/manualRoamAvatarAdaptation.js';

const output = path.resolve('output/playwright/manual-roam-avatar-upload/run-' + Date.now());
await mkdir(output, { recursive: true });
const source = path.resolve('scripts/manual-roam-assets/sources/Xbot.glb');
let uploads = 0;
const files = new Map();
const moduleId = '\0humanoid-upload-fixture.js';
// 挂载正式 EditorLayout 的原始窗口快捷键回调，验证模态预览不会修改底层场景。
const layoutSource = await readFile(path.resolve('src/editor/layout/EditorLayout.tsx'), 'utf8');
const layoutAst = ts.createSourceFile('EditorLayout.tsx', layoutSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const keyboardDeclarations = [];
function findKeyboardDeclarations(node) {
  if (ts.isFunctionDeclaration(node) && ['handleWindowKeyDown', 'isKeyboardEditableTarget', 'hasVisibleEditorOverlay'].includes(node.name?.text)) keyboardDeclarations.push(node.getText(layoutAst));
  ts.forEachChild(node, findKeyboardDeclarations);
}
findKeyboardDeclarations(layoutAst);
assert.equal(keyboardDeclarations.length, 3);
const keyboardCode = ts.transpileModule(keyboardDeclarations.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {EngineStore} from '@babylonjs/core';
import {useEditorStore} from '/src/editor/store/editorStore.ts';
import {createEmptySceneDocument,createManualRoamSpawnEntity} from '/src/editor/model/SceneDocument.ts';
import {serializeScene,deserializeScene} from '/src/editor/project/SceneSerializer.ts';
import {ManualRoamAvatarInspector} from '/src/editor/panels/ManualRoamAvatarInspector.tsx';
import {isScenePreparationActive,beginScenePreparation,skipSceneModelSync,beginSceneModelAssetRefresh,settleSceneModelAssetRefresh,reportSceneRuntimeProgress} from '/src/editor/loading/scenePreparationProgress.ts';
import {createBabylonViewport} from '/src/runtime/babylon/createEngine.ts';
window.editorApi={listProjectAssets:async()=>({assets:[]}),importManualRoamAvatar:async()=>{
 const response=await fetch('/__humanoid_import__',{method:'POST'});if(!response.ok)throw new Error(await response.text());
 return {canceled:false,importedAsset:await response.json()};
}};
const scene=createEmptySceneDocument('普通人物上传验收'),spawn=createManualRoamSpawnEntity();
scene.entityIds.push(spawn.id);scene.entities[spawn.id]=spawn;
useEditorStore.setState({scene,sceneSessionId:'humanoid-upload-fixture',runtimeMode:'edit'});
function finishFixturePreparation(id){
 beginScenePreparation(id);skipSceneModelSync(id,null);beginSceneModelAssetRefresh(id,'fixture');settleSceneModelAssetRefresh(id,null,'fixture');
 reportSceneRuntimeProgress(id,{generation:'fixture',totalModels:0,settledModels:0,expectedBatchedEntities:0,batchedEntities:0,stable:true});
 if(isScenePreparationActive())throw new Error('空场景应完成准备后再验证编辑快捷键');
}
finishFixturePreparation('humanoid-upload-fixture');
useEditorStore.getState().selectEntity(spawn.id);
const {undo,copySelectedEntities,pasteEntityClipboard,lockSelectedEntities,groupSelectedEntities,ungroupSelectedEntities,deleteSelectedEntity,requestSceneFocusForSelection,hideSelectedEntities,setTransformTool}=useEditorStore.getState();
const TOOL_SHORTCUTS={e:'translate',r:'rotate',t:'scale'},isRuntimePreview=false,environmentAdjustmentActive=false;
let fullscreenExits=0;
const sceneFullscreen={isFullscreen:true,exit:async()=>{fullscreenExits++;}},getFullscreenElement=()=>null,handleToggleSceneFullscreen=async()=>{};
${keyboardCode}
window.addEventListener('keydown',handleWindowKeyDown,true);
const backgroundCanvas=document.createElement('canvas');backgroundCanvas.width=320;backgroundCanvas.height=240;
backgroundCanvas.style.cssText='position:absolute;right:24px;top:90px;width:320px;height:240px';document.body.append(backgroundCanvas);
const backgroundViewport=createBabylonViewport(backgroundCanvas,undefined,{showGrid:true});
const baselineEngines=EngineStore.Instances.length;
function Inspector(){const entity=useEditorStore(s=>s.scene.entities[spawn.id]);return React.createElement(ManualRoamAvatarInspector,{entityId:entity.id,component:entity.components.manualRoamSpawn,disabled:false});}
createRoot(document.getElementById('root')).render(React.createElement(Inspector));
window.uploadQA={
 avatar:()=>useEditorStore.getState().scene.entities[spawn.id].components.manualRoamSpawn.avatar,
 save:()=>serializeScene(useEditorStore.getState().scene),
 reload:content=>{const id='humanoid-reopened-'+Date.now();useEditorStore.setState({scene:deserializeScene(content),sceneSessionId:id});finishFixturePreparation(id);},
 undo:()=>useEditorStore.getState().undo(),redo:()=>useEditorStore.getState().redo(),
 engines:()=>EngineStore.Instances.length-baselineEngines,
 backgroundCamera:()=>backgroundViewport.camera.target.asArray(),
 exists:()=>Boolean(useEditorStore.getState().scene.entities[spawn.id]),
 tool:()=>useEditorStore.getState().transformTool,
 fullscreenExits:()=>fullscreenExits
};
`;
const server = await createServer({
  configFile: false, cacheDir: path.resolve('output/playwright/manual-roam-avatar-upload/vite-cache'),
  optimizeDeps: { entries: ['src/main.tsx'], include: ['react', 'react-dom/client', '@babylonjs/core', '@babylonjs/loaders'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  plugins: [react(), {
    name: 'humanoid-upload-fixture',
    resolveId(id) { if (id === '/__humanoid_upload__.js') return moduleId; },
    load(id) { if (id === moduleId) return harness; },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        const url = request.url?.split('?')[0];
        if (!['/__humanoid_upload__', '/__humanoid_import__'].includes(url) && !files.has(url)) return next();
        void (async () => {
          if (files.has(url)) {
            response.setHeader('Content-Type', 'model/gltf-binary');
            response.end(await readFile(files.get(url))); return;
          }
          if (url === '/__humanoid_import__') {
            assert.equal(request.method, 'POST');
            const file = path.join(output, 'uploaded-' + (++uploads) + '.glb');
            await copyManualRoamAvatarWithAdaptation(source, file);
            const publicPath = '/__humanoid_uploaded_' + uploads + '.glb'; files.set(publicPath, file);
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ name: 'Xbot', displayName: '普通 Mixamo 人物', path: file, assetRevision: createHash('sha256').update(await readFile(file)).digest('hex'), sourceUrl: vite.resolvedUrls.local[0].replace(/\/$/, '') + publicPath, libraryKind: 'model' })); return;
          }
          const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>人物上传验收</title><style>body{background:#222;color:#eee;font:14px sans-serif;padding:24px}#root{width:320px}fieldset{display:grid;gap:12px}.inspector-row{display:flex;justify-content:space-between}.muted{font-size:12px;color:#bbb}button,select{padding:6px}</style></head><body><h1>手动漫游人物</h1><div id="root"></div><script type="module" src="/__humanoid_upload__.js"></script></body></html>';
          response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml(url, html));
        })().catch(error => { response.statusCode = 500; response.end(String(error.stack ?? error)); });
      });
    },
  }],
});
let browser, page, context;
const errors = [], report = { output, screenshots: [], uploads: [] };
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  context = await browser.newContext({ viewport: { width: 1200, height: 900 }, recordVideo: { dir: path.join(output, 'video') } });
  page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + '__humanoid_upload__', { waitUntil: 'commit' });
  await page.getByRole('button', { name: '上传人物模型（GLB）', exact: true }).click();
  await page.getByRole('dialog', { name: '人物动作预览' }).waitFor();
  await page.getByRole('status').filter({ hasText: '已自动适配' }).waitFor();
  assert.equal(await page.evaluate(() => Boolean(window.uploadQA.avatar())), false, '应用前不得改变场景人物');
  const status = await page.getByRole('status').innerText();
  assert.doesNotMatch(status, /未启用|不可用|失败/);
  await page.locator('dialog canvas').focus();
  const backgroundCamera = await page.evaluate(() => window.uploadQA.backgroundCamera());
  await page.keyboard.down('w'); await page.waitForTimeout(220); await page.keyboard.up('w');
  assert.deepEqual(await page.evaluate(() => window.uploadQA.backgroundCamera()), backgroundCamera, '预览WASD不得移动底层编辑器相机');
  await page.keyboard.press('Delete');
  assert.equal(await page.evaluate(() => window.uploadQA.exists()), true, '预览按Delete不得删除底层出生点');
  const previousTool = await page.evaluate(() => window.uploadQA.tool());
  await page.keyboard.press('r');
  assert.equal(await page.evaluate(() => window.uploadQA.tool()), previousTool, '预览按键不得切换编辑器工具');
  for (const action of ['站立', '行走', '跑步', '跳跃', '飞行']) {
    await page.getByRole('button', { name: action, exact: true }).click();
    // 采集动作中间帧，禁止只凭动作按钮文本宣布视觉通过。
    await page.waitForTimeout(action === '跳跃' ? 180 : 700);
    const file = path.join(output, action + '.png');
    await page.screenshot({ path: file }); report.screenshots.push(file);
  }
  await page.getByRole('button', { name: '应用此人物', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.uploadQA.engines()), 0, '应用后释放独立预览引擎');
  const applied = await page.evaluate(() => window.uploadQA.avatar());
  assert.match(applied.sourceUrl, /__humanoid_uploaded_1/);
  const saved = await page.evaluate(() => window.uploadQA.save());
  await writeFile(path.join(output, 'saved.scene.json'), saved);
  await page.evaluate(() => window.uploadQA.undo());
  assert.equal(await page.evaluate(() => Boolean(window.uploadQA.avatar())), false);
  await page.evaluate(() => window.uploadQA.redo());
  assert.deepEqual(await page.evaluate(() => window.uploadQA.avatar()), applied);
  await page.evaluate(content => window.uploadQA.reload(content), saved);
  assert.deepEqual(await page.evaluate(() => window.uploadQA.avatar()), applied);
  await page.getByRole('button', { name: '预览人物动作', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已自动适配' }).waitFor();
  await page.locator('dialog canvas').focus();
  await page.keyboard.press('Control+z');
  assert.deepEqual(await page.evaluate(() => window.uploadQA.avatar()), applied, '预览按Ctrl+Z不得撤销底层人物绑定');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.uploadQA.fullscreenExits()), 0, 'Esc只关闭预览，不退出底层全屏');
  await page.getByRole('button', { name: '上传人物模型（GLB）', exact: true }).click();
  await page.getByRole('dialog', { name: '人物动作预览' }).waitFor();
  await page.getByRole('button', { name: '关闭人物预览' }).click();
  assert.deepEqual(await page.evaluate(() => window.uploadQA.avatar()), applied, '取消新人物预览应保留已保存人物');
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.uploadQA.engines()), 0, '关闭或取消预览不泄漏引擎');
  assert.deepEqual(errors, []);
  report.uploads = [...files.values()]; report.status = status; report.savedAvatar = applied;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: true, output, uploads, saveReopen: true, undoRedo: true, previewCancel: true, status }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') });
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error.stack ?? error), errors }, null, 2));
  throw error;
} finally {
  await context?.close(); await browser?.close(); await server.close();
}
