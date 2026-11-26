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

test('组合打包与物化保留中台与本地模型 originModel，不泄露本机路径，且兼容旧清单与版本恢复', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composition-origin-'));
  try {
    authorizeAssetRoot(root);
    const sourceKey = 'a'.repeat(64);
    const platformDir = path.join(root, 'Assets', 'Models', 'Model-123-堆垛机');
    const localDir = path.join(root, 'Assets', 'Models', 'LocalRack');
    await fs.mkdir(platformDir, { recursive: true });
    await fs.mkdir(localDir, { recursive: true });
    const platformFile = path.join(platformDir, 'stacker.glb');
    const localFile = path.join(localDir, 'rack.glb');
    await fs.writeFile(platformFile, 'platform-glb');
    await fs.writeFile(localFile, 'local-glb');
    const d = definition();
    d.nodes[0].components.modelAsset = {
      sourcePath: platformFile,
      sourceUrl: 'editor-asset://local/' + encodeURIComponent(platformFile),
      assetCode: 'old-a',
      dataPlatformModel: { sourceKey, kind: 'model', resourceId: '123', modelPath: 'stacker.glb' },
      lengthUnit: 'meter',
      unitScaleToMeters: 1,
    };
    d.nodes[1].components.modelAsset = {
      sourcePath: localFile,
      sourceUrl: 'editor-asset://local/' + encodeURIComponent(localFile),
      assetCode: 'old-b',
      lengthUnit: 'meter',
      unitScaleToMeters: 1,
    };
    const first = await saveCompositionPackage(root, { definition: d });
    const firstA = first.definition.nodes[0].components.modelAsset as Record<string, any>;
    const firstB = first.definition.nodes[1].components.modelAsset as Record<string, any>;
    assert.equal(firstA.dataPlatformModel, undefined, '固定组合副本仍隔离普通模型最新同步');
    assert.deepEqual(firstA.sourceSnapshot.originModel, {
      dataPlatformModel: { sourceKey, kind: 'model', resourceId: '123', modelPath: 'stacker.glb' },
      resourceKey: 'model:123:stacker.glb',
    });
    assert.match(firstB.sourceSnapshot.originModel.localPathSha256, /^[0-9a-f]{64}$/);
    const manifestText = await fs.readFile(path.join(first.packagePath, 'composition.json'), 'utf8');
    assert.equal(manifestText.includes(root), false, 'composition.json 不得包含本机绝对路径');

    // 保存第二版并恢复第一版后 originModel 仍完整保留
    const secondDef = structuredClone(first.definition);
    secondDef.nodes[0].components.transform.position.x = 10;
    const second = await saveCompositionPackage(root, { definition: secondDef, targetId: first.id, expectedRevision: first.revision });
    const restored = await restoreCompositionPackage(root, first.id, second.revision);
    assert.deepEqual((restored.definition.nodes[0].components.modelAsset as any).sourceSnapshot.originModel, firstA.sourceSnapshot.originModel);
    assert.deepEqual((restored.definition.nodes[1].components.modelAsset as any).sourceSnapshot.originModel, firstB.sourceSnapshot.originModel);

    // 模拟旧版已落盘 composition.json（仅有 dataPlatformModel、无 compositionOriginModel），加载物化仍能推导 originModel
    const legacyManifestPath = path.join(restored.packagePath, 'composition.json');
    const legacyManifest = JSON.parse(await fs.readFile(legacyManifestPath, 'utf8'));
    delete legacyManifest.definition.nodes[0].components.modelAsset.compositionOriginModel;
    legacyManifest.definition.nodes[0].components.modelAsset.dataPlatformModel = { sourceKey, kind: 'model', resourceId: '123', modelPath: 'stacker.glb' };
    const nextManifestText = JSON.stringify(legacyManifest);
    await fs.writeFile(legacyManifestPath, nextManifestText, 'utf8');
    const { createHash } = await import('node:crypto');
    const nextSha = createHash('sha256').update(nextManifestText).digest('hex');
    const indexPath = path.join(root, 'Assets', 'Compositions', 'index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    index[0].contentSha256 = nextSha;
    await fs.writeFile(indexPath, JSON.stringify(index), 'utf8');
    const loaded = (await listCompositionPackages(root))[0];
    assert.deepEqual((loaded.definition.nodes[0].components.modelAsset as any).sourceSnapshot.originModel, firstA.sourceSnapshot.originModel);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
