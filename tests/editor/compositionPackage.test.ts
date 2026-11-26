import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  saveCompositionPackage,
  listCompositionPackages,
  loadCompositionPackage,
  restoreCompositionPackage,
  resolveLegacyCompositionMemberOriginModels,
} from '../../dist-electron/ipc/compositionPackage.js';
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

test('旧版无 originModel 的组合包与已解组场景成员可通过索引与清单反查补齐原始模型身份', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composition-legacy-origin-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'composition-legacy-project-'));
  try {
    authorizeAssetRoot(root);
    authorizeAssetRoot(projectRoot);
    const { createHash } = await import('node:crypto');
    const sourceKey = 'b'.repeat(64);
    const platformRuntimeRevision = 'c'.repeat(64);
    const localImportRevision = 'm9a1-123e4567-e89b-12d3-a456-426614174000';
    const platformDir = path.join(root, 'Assets', 'Models', 'Model-456-输送机');
    const localDir = path.join(projectRoot, 'Assets', 'Models', 'CustomConveyor');
    await fs.mkdir(platformDir, { recursive: true });
    await fs.mkdir(localDir, { recursive: true });
    const platformFile = path.join(platformDir, 'belt.glb');
    const localFile = path.join(localDir, 'custom.glb');
    const platformBytes = Buffer.from('platform-belt-glb-bytes');
    const localBytes = Buffer.from('local-custom-glb-bytes');
    await fs.writeFile(platformFile, platformBytes);
    await fs.writeFile(localFile, localBytes);
    const platformSha = createHash('sha256').update(platformBytes).digest('hex');
    const localSha = createHash('sha256').update(localBytes).digest('hex');

    await fs.mkdir(path.join(root, '.babylon-editor'), { recursive: true });
    await fs.writeFile(path.join(root, '.babylon-editor', 'data-platform-model-index.json'), JSON.stringify({
      version: 1,
      sourceKey,
      entries: [{
        kind: 'model',
        resourceId: '456',
        packageRelativePath: 'Assets/Models/Model-456-输送机',
        runtimeRevision: platformRuntimeRevision,
        fileRevision: platformSha,
        deviceType: 'conveyor',
      }],
    }), 'utf8');
    await fs.writeFile(path.join(root, '.babylon-editor', 'asset-index.json'), JSON.stringify({
      version: 2,
      assets: [{
        kind: 'model',
        libraryKind: 'model',
        name: 'belt.glb',
        path: platformFile,
        assetRevision: platformRuntimeRevision,
        dataPlatformSourceKey: sourceKey,
        fileSha256: platformSha,
      }],
    }), 'utf8');
    await fs.mkdir(path.join(projectRoot, '.babylon-editor'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.babylon-editor', 'asset-index.json'), JSON.stringify({
      version: 2,
      assets: [{
        kind: 'model',
        libraryKind: 'model',
        name: 'custom.glb',
        path: localFile,
        assetRevision: localImportRevision,
        fileSha256: localSha,
      }],
    }), 'utf8');

    const d = definition();
    d.nodes[0].components.modelAsset = {
      sourcePath: platformFile,
      sourceUrl: 'editor-asset://local/' + encodeURIComponent(platformFile),
      assetCode: 'p1',
      assetRevision: platformRuntimeRevision,
      lengthUnit: 'meter',
      unitScaleToMeters: 1,
    };
    d.nodes[1].components.modelAsset = {
      sourcePath: localFile,
      sourceUrl: 'editor-asset://local/' + encodeURIComponent(localFile),
      assetCode: 'l1',
      assetRevision: localImportRevision,
      lengthUnit: 'meter',
      unitScaleToMeters: 1,
    };
    const saved = await saveCompositionPackage(root, { definition: d });

    // 剥离清单中的 compositionOriginModel 与 dataPlatformModel，模拟旧版本已落盘的组合包。
    const manifestPath = path.join(saved.packagePath, 'composition.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    for (const node of manifest.definition.nodes) {
      delete node.components.modelAsset.compositionOriginModel;
      delete node.components.modelAsset.dataPlatformModel;
    }
    const strippedText = JSON.stringify(manifest);
    await fs.writeFile(manifestPath, strippedText, 'utf8');
    const strippedSha = createHash('sha256').update(strippedText).digest('hex');
    const indexPath = path.join(root, 'Assets', 'Compositions', 'index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    index[0].contentSha256 = strippedSha;
    await fs.writeFile(indexPath, JSON.stringify(index), 'utf8');

    // 1) 重新加载旧组合包时，自动从共享/项目索引推导出 originModel。
    const loaded = await loadCompositionPackage(root, saved.id, undefined, [projectRoot, root]);
    const loadedA = loaded.definition.nodes[0].components.modelAsset as any;
    const loadedB = loaded.definition.nodes[1].components.modelAsset as any;
    assert.deepEqual(loadedA.sourceSnapshot.originModel, {
      dataPlatformModel: { sourceKey, kind: 'model', resourceId: '456', modelPath: 'belt.glb' },
      resourceKey: 'model:456:belt.glb',
    });
    assert.ok(loadedB.sourceSnapshot.originModel?.localPathSha256);
    assert.ok(loadedB.sourceSnapshot.originModel?.portablePathSha256);

    // 2) 对已经解组并落盘但缺少 originModel 的旧场景成员，能反查并补齐身份（即使原 assetRevision 与新索引不同，也可用文件 SHA-256 命中）。
    const ungroupedScene = {
      entities: {
        e_platform: {
          id: 'e_platform',
          components: {
            modelAsset: {
              ...structuredClone(loadedA),
              assetRevision: 'stale-revision',
              sourceSnapshot: {
                contentSha256: strippedSha,
                composition: true,
                compositionResource: loadedA.sourceSnapshot.compositionResource,
              },
            },
          },
        },
        e_local: {
          id: 'e_local',
          components: {
            modelAsset: {
              ...structuredClone(loadedB),
              assetRevision: 'stale-revision',
              sourceSnapshot: {
                contentSha256: strippedSha,
                composition: true,
                compositionResource: loadedB.sourceSnapshot.compositionResource,
              },
            },
          },
        },
      },
    };
    const backfills = await resolveLegacyCompositionMemberOriginModels(ungroupedScene, {
      sharedResourcesRoot: root,
      projectRoot,
    });
    assert.equal(backfills.length, 2);
    assert.deepEqual(backfills.find(item => item.entityId === 'e_platform')?.originModel, loadedA.sourceSnapshot.originModel);
    assert.deepEqual(backfills.find(item => item.entityId === 'e_local')?.originModel, loadedB.sourceSnapshot.originModel);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
