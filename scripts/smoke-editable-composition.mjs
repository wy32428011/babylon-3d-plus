import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { saveCompositionPackage, listCompositionPackages, restoreCompositionPackage } from '../dist-electron/ipc/compositionPackage.js';
import { authorizeAssetRoot } from '../dist-electron/ipc/assetRegistry.js';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'editable-composition-ui-'));
authorizeAssetRoot(directory);
const output=path.resolve('output/playwright/editable-composition');await fs.mkdir(output,{recursive:true});
let server,browser,page;const errors=[];
const thumbnail=async entry=>({...entry,thumbnailUrl:entry.thumbnailUrl?'data:image/png;base64,'+(await fs.readFile(path.join(entry.packagePath,'thumbnail.png'))).toString('base64'):undefined});
try{
  server=await createServer({cacheDir:path.join(directory,'vite-cache'),server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false}});await server.listen();
  browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1600,height:1050}});page.setDefaultTimeout(30000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('compositionList',async()=>Promise.all((await listCompositionPackages(directory)).map(thumbnail)));
  await page.exposeFunction('compositionSave',async request=>thumbnail(await saveCompositionPackage(directory,{...request, previewGlb: request.previewGlb ? new Uint8Array(Object.values(request.previewGlb)) : undefined})));
  await page.exposeFunction('compositionRestore',async(id,revision)=>thumbnail(await restoreCompositionPackage(directory,id,revision)));
  await page.addInitScript(()=>{window.compositionResourceChecks=0;window.editorApi={prepareLocalSceneResources:async()=>{window.compositionResourceChecks++;return {configured:true,sourceKey:'composition-ui-fixture',modelAssets:[],environmentAssets:[],modelReplacements:[],issues:[],warnings:[]};},listCompositions:()=>window.compositionList(),loadComposition:async id=>(await window.compositionList()).find(e=>e.id===id),saveComposition:r=>window.compositionSave(r),syncCompositions:()=>window.compositionList(),restoreComposition:(id,revision)=>window.compositionRestore(id,revision)};});
  const html=await server.transformIndexHtml('/__composition__','<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/composition.harness.tsx"></script></body></html>');
  await page.route('**/__composition__',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.goto(server.resolvedUrls.local[0]+'__composition__',{waitUntil:'commit'});
  await page.waitForFunction(()=>window.compositionResourceChecks > 0 && window.compositionHarness?.ready(),null,{timeout:180000});await page.evaluate(()=>window.compositionHarness.camera());
  await page.getByRole('button',{name:'组合库',exact:true}).click();
  const saveSelection = page.getByRole('button',{name:'保存选中模型为组合',exact:true});
  await page.waitForFunction(() => !document.querySelector('.composition-toolbar > .composition-save-button')?.disabled);
  assert.equal(await page.getByRole('button',{name:'拖拽保存组合',exact:true}).count(), 0);
  assert.equal(await page.locator('.scene-viewport .composition-save-button').count(), 0);
  const initialSelection = await page.evaluate(() => window.compositionHarness.store.getState().hierarchySelectionIds);
  await page.evaluate(() => window.compositionHarness.store.getState().selectEntity(null));
  assert.equal(await saveSelection.isDisabled(), true);
  await page.screenshot({path:path.join(output,'composition-empty-selection.png')});
  await page.evaluate(ids => window.compositionHarness.store.getState().selectHierarchyEntities(ids,ids[0]), initialSelection);
  await page.waitForFunction(() => !document.querySelector('.composition-toolbar > .composition-save-button')?.disabled);
  await saveSelection.focus(); await page.keyboard.press('Enter');
  await page.getByRole('form',{name:'新建组合',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('form',{name:'新建组合',exact:true}).count(),0);
  assert.equal((await listCompositionPackages(directory)).length,0);
  await saveSelection.dragTo(page.locator('.composition-new'));
  await page.getByRole('region',{name:'组合模型库',exact:true}).getByRole('textbox',{name:'组合名称',exact:true}).fill('可编辑设备组合');await page.getByRole('button',{name:'保存组合',exact:true}).click();
  await page.locator('.composition-card-main').waitFor();
  await page.waitForFunction(()=>window.compositionHarness.store.getState().scene.entities[window.compositionHarness.store.getState().scene.selectedEntityId]?.composition);
  const initial=(await listCompositionPackages(directory))[0];assert.equal((await listCompositionPackages(directory)).length,1);
  const rootId=await page.evaluate(()=>window.compositionHarness.store.getState().scene.selectedEntityId);
  await page.getByRole('button',{name:'编辑组合内部',exact:true}).click();
  await page.getByText('设备 B',{exact:true}).first().click();
  await page.evaluate(()=>{const s=window.compositionHarness.store.getState();s.updateSelectedTransform('position','x',5);});
  assert.equal(await page.locator('.scene-title .composition-edit-status').count(),1);
  assert.equal(await page.locator('.scene-viewport .composition-edit-status').count(),0);
  await page.screenshot({path:path.join(output,'composition-editing.png')});
  await page.getByRole('button',{name:'完成编辑 Esc',exact:true}).click();
  await saveSelection.dragTo(page.locator('.composition-card-main'));
  await page.waitForFunction(revision=>!document.querySelector('.composition-card-main')?.disabled && document.querySelector('[role=status]')?.textContent.includes('同步') && window.compositionHarness.store.getState().scene.entities[window.compositionHarness.store.getState().scene.selectedEntityId]?.composition?.revision !== revision,initial.revision);
  const replaced=(await listCompositionPackages(directory))[0];assert.equal(replaced.id,initial.id);assert.notEqual(replaced.revision,initial.revision);assert.equal((await listCompositionPackages(directory)).length,1);
  assert.notDeepEqual(replaced.definition.nodes,initial.definition.nodes);
  await page.getByRole('button',{name:'编辑组合内部',exact:true}).click();
  await saveSelection.click();
  await page.getByRole('form',{name:'新建组合',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.compositionHarness.store.getState().compositionEditRootId),rootId);
  await page.getByRole('button',{name:'模型库',exact:true}).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.compositionHarness.store.getState().compositionEditRootId),null);
  await page.getByRole('button',{name:'组合库',exact:true}).click();
  await page.waitForFunction(() => !document.querySelector('.composition-toolbar > .composition-save-button')?.disabled);
  const checkLayout = async () => {
    const dimensions = await page.evaluate(() => {
      const bounds = element => { const b=element.getBoundingClientRect(); return {left:b.left,right:b.right,top:b.top,bottom:b.bottom}; };
      const panel=document.querySelector('.composition-library');
      const toolbar=panel.querySelector('.composition-toolbar');
      const card=panel.querySelector('.composition-card');
      return {panel:bounds(panel),toolbar:bounds(toolbar),save:bounds(toolbar.querySelector('.composition-save-button')),
        controls:[...toolbar.querySelectorAll(':scope > button, :scope > input')].map(bounds),
        card:bounds(card),actions:[...card.querySelectorAll(':scope > button')].map(bounds),
        primaryColor:getComputedStyle(toolbar.querySelector('.composition-save-button')).backgroundColor};
    });
    assert.ok(dimensions.save.top >= dimensions.toolbar.top && dimensions.save.bottom <= dimensions.toolbar.bottom);
    for (const b of dimensions.controls) assert.ok(b.left >= dimensions.panel.left && b.right <= dimensions.panel.right, '工具栏不应溢出组合库');
    for (const b of dimensions.actions) assert.ok(b.bottom <= dimensions.panel.bottom, '卡片操作不应被裁切');
    assert.equal(dimensions.primaryColor,'rgb(20, 83, 91)');
    return dimensions;
  };
  await page.mouse.move(0,0);
  const wideLayout=await checkLayout();
  await page.screenshot({path:path.join(output,'composition-toolbar-wide.png')});
  await page.setViewportSize({width:1100,height:800});
  const narrowLayout=await checkLayout();
  await page.screenshot({path:path.join(output,'composition-toolbar-narrow.png')});
  await page.setViewportSize({width:1600,height:1050});
  const canvas=page.locator('.scene-canvas'),box=await canvas.boundingBox();
  await page.locator('.composition-card-main').dragTo(canvas,{targetPosition:{x:box.width*0.65,y:box.height*0.65}});
  await page.waitForFunction(()=>Object.values(window.compositionHarness.store.getState().scene.entities).filter(e=>e.composition).length===2);
  const firstInstance = await page.evaluate(root => {
    const state = window.compositionHarness.store.getState(); state.selectEntity(root); return { root, pose: state.scene.entities[root].components.transform };
  }, rootId);
  await page.getByRole('button',{name:'使用库中版本',exact:true}).click();
  await page.getByRole('dialog',{name:'更新组合实例预览'}).waitFor();
  await page.getByRole('button',{name:'确认更新此实例',exact:true}).click();
  const upgradedPose = await page.evaluate(root => window.compositionHarness.store.getState().scene.entities[root].components.transform,rootId);
  assert.deepEqual(upgradedPose,firstInstance.pose);
  await page.evaluate(()=>{window.compositionHarness.store.getState().undo();window.compositionHarness.store.getState().redo();});
  const saved=await page.evaluate(()=>window.compositionHarness.save());await fs.writeFile(path.join(output,'scene.scene.json'),saved,'utf8');await page.evaluate(value=>window.compositionHarness.reopen(value),saved);
  const result=await page.evaluate(()=>{const s=window.compositionHarness.store.getState();return{roots:Object.values(s.scene.entities).filter(e=>e.composition),ids:s.scene.entityIds};});
  assert.equal(result.roots.length,2);assert.equal(new Set(result.ids).size,result.ids.length);assert.ok(result.roots.some(e=>e.id===rootId));
  await page.screenshot({path:path.join(output,'composition-replaced.png')});assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({status:'PASS',layout:{wide:wideLayout,narrow:narrowLayout},checks:['save-in-library-toolbar','empty-selection-disabled','keyboard-open-cancel','title-bar-edit-exit','escape-independent-of-library-tab','naming-escape-preserves-edit-mode','wide-narrow-no-clipping','real-drag-create','card-replace-same-id','member-adjustment','real-drag-place','independent-instances','explicit-instance-upgrade','upgrade-undo-redo','save-reopen','no-page-errors']},null,2));
  console.log('PASS: 组合创建、卡片替换、再次拖入及保存重开');
}catch(error){
  if(page) { await page.screenshot({path:path.join(output,'composition-failure.png')}).catch(()=>{}); console.error('Page errors:',errors); await fs.writeFile(path.join(output,'failure-dom.json'), JSON.stringify(await page.evaluate(() => ({html:document.querySelector('.composition-library')?.outerHTML, elements:[...document.querySelectorAll('.composition-library, .composition-toolbar, .composition-save-form, .composition-save-form input')].map(e => ({tag:e.tagName,cls:e.className,bounds:e.getBoundingClientRect().toJSON(),display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility,overflow:getComputedStyle(e).overflow})), logs:window.compositionHarness?.store.getState().logs.slice(0,5)})),null,2)); }
  throw error;
}finally{await browser?.close();await server?.close();await fs.rm(directory,{recursive:true,force:true});}
