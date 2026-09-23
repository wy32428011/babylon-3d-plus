import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveCompositionPackage, listCompositionPackages, restoreCompositionPackage } from '../../dist-electron/ipc/compositionPackage.js';
import { authorizeAssetRoot } from '../../dist-electron/ipc/assetRegistry.js';
import type { CompositionDefinition } from '../../electron/shared/compositionTypes.ts';
const definition = (): CompositionDefinition => ({ schemaVersion: 1, name: '测试组合', nodes: ['a','b'].map((id,i)=>({ id, name:id, parentId:null, childrenIds:[], components:{ transform:{position:{x:i,y:0,z:0}, rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},meshRenderer:{meshKind:'cube',materialColor:'#fff'} }})) });
test('替换保留卡片 ID，检查版本冲突，旧版本可恢复', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'composition-package-'));
  try {
    authorizeAssetRoot(root);
    const first=await saveCompositionPackage(root,{definition:definition()});
    const changed=definition();changed.nodes[1].components.transform.position.x=5;
    const second=await saveCompositionPackage(root,{definition:changed,targetId:first.id,expectedRevision:first.revision});
    assert.equal(second.id,first.id);assert.notEqual(second.revision,first.revision);
    assert.equal((await listCompositionPackages(root)).length,1);
    await assert.rejects(saveCompositionPackage(root,{definition:changed,targetId:first.id,expectedRevision:first.revision}),/版本/);
    const restored=await restoreCompositionPackage(root,first.id,second.revision);
    assert.equal(restored.definition.nodes[1].components.transform.position.x,1);
    assert.equal((await listCompositionPackages(root)).length,1);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('资源复制到固定包，原模型更新不影响已保存组合，拒绝越权路径', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'composition-resources-'));
  try {
    authorizeAssetRoot(root);const source=path.join(root,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'model.glb'),'original');
    const d=definition();d.nodes[0].components.modelAsset={sourcePath:path.join(source,'model.glb'),sourceUrl:'editor-asset://local/'+encodeURIComponent(path.join(source,'model.glb')),assetCode:'old',lengthUnit:'meter',unitScaleToMeters:1};
    const saved=await saveCompositionPackage(root,{definition:d});
    await fs.writeFile(path.join(source,'model.glb'),'changed');
    const model=saved.definition.nodes[0].components.modelAsset as {sourcePath:string};
    assert.equal(await fs.readFile(model.sourcePath,'utf8'),'original');
    const bad=definition();bad.nodes[0].components.modelAsset={sourcePath:'C:/Windows/system.ini'};
    await assert.rejects(saveCompositionPackage(root,{definition:bad}),/授权/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('子目录模型沿用包根，保留 glTF 的父目录纹理和缓冲引用', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'composition-layout-'));
  try {
    authorizeAssetRoot(root);const packageRoot=path.join(root,'original'),source=path.join(packageRoot,'variants','model.gltf');
    await fs.mkdir(path.dirname(source),{recursive:true});await fs.writeFile(path.join(packageRoot,'meta.json'),'{}');
    await fs.writeFile(path.join(packageRoot,'buffer.bin'),'buffer');await fs.writeFile(source,JSON.stringify({asset:{version:'2.0'},buffers:[{uri:'../buffer.bin',byteLength:6}]}));
    const d=definition();d.nodes[0].components.modelAsset={sourcePath:source,sourceUrl:'editor-asset://local/'+encodeURIComponent(source),assetCode:'old',lengthUnit:'meter',unitScaleToMeters:1};
    const saved=await saveCompositionPackage(root,{definition:d});
    const target=(saved.definition.nodes[0].components.modelAsset as {sourcePath:string}).sourcePath;
    assert.equal(await fs.readFile(path.resolve(path.dirname(target),'../buffer.bin'),'utf8'),'buffer');
    assert.ok(target.includes(path.join('models','0','variants','model.gltf')));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
