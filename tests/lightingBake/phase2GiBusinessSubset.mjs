import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function inside(root, file) { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }

/** 仅准备真实业务子场景和原资产副本；不启动渲染/烘焙，不改变原工程或模型参数。 */
export async function prepareBusinessGiSubset({ sourceScene, output, entityIds, environment, previewBudget = false, environmentOnly = false }) {
  sourceScene = path.resolve(sourceScene); output = path.resolve(output);
  const outputBase = path.resolve('output');
  assert.ok(output !== outputBase && inside(outputBase, output), 'GI副本只能创建于本仓库output的专属子目录');
  assert.ok(['keep', 'omit'].includes(environment), '必须明确选择保留或排除原环境模型');
  assert.ok(Array.isArray(entityIds) && new Set(entityIds).size === entityIds.length
    && (environmentOnly ? entityIds.length === 0 && environment === 'keep' : entityIds.length > 0), '业务根必须明确；environmentOnly须保留原环境且不混入模型根');
  assert.equal(path.basename(path.dirname(sourceScene)).toLowerCase(), 'scenes', '源场景必须来自原工程Scenes目录');
  const sourceProject = path.dirname(path.dirname(sourceScene)), sourceAssets = path.join(sourceProject, 'Assets');
  assert.ok(!inside(sourceProject, output), 'GI副本不能写入原工程');
  try { await fs.lstat(output); throw new Error('拒绝覆盖已存在的GI副本目录'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const original = await fs.readFile(sourceScene), document = JSON.parse(original.toString('utf8'));
  const source = document.scene;
  assert.ok(source?.entities && Array.isArray(source.entityIds) && source.sceneSettings?.lighting?.version === 2, '需要已规范化的真实v2光照业务场景');
  const selected = new Set();
  const descend = id => {
    assert.ok(source.entities[id], '源场景缺少实体：' + id);
    if (selected.has(id)) return;
    selected.add(id);
    for (const child of source.entities[id].childrenIds ?? []) descend(child);
  };
  for (const id of entityIds) {
    assert.ok(source.entities[id]?.components?.modelAsset, '只能以真实模型实体作为子场景根：' + id);
    const asset = source.entities[id].components.modelAsset;
    assert.ok(typeof asset.sourcePath === 'string' && path.isAbsolute(asset.sourcePath) && inside(sourceAssets, asset.sourcePath), '模型原文件必须位于原工程Assets中');
    for (const script of asset.scriptAssets ?? []) assert.ok(typeof script.path === 'string' && inside(sourceAssets, script.path), '脚本原文件必须位于原工程Assets中');
    descend(id);
  }
  if (environmentOnly) {
    assert.ok(source.sceneSettings.environment?.packagePath && source.sceneSettings.environment?.activeVariantUrl
      && source.sceneSettings.environment.visible !== false, '环境only案例必须保留真实可见原环境');
    for (const [id, entity] of Object.entries(source.entities)) if (entity.components?.light) selected.add(id);
  }
  for (const id of [...selected]) {
    const seen = new Set([id]);
    let parent = source.entities[id].parentId;
    while (parent) {
      assert.ok(!seen.has(parent) && source.entities[parent], '父节点缺失或形成循环');
      seen.add(parent); selected.add(parent); parent = source.entities[parent].parentId;
    }
  }
  if (environmentOnly) for (const id of selected) assert.equal(Boolean(source.entities[id].components?.modelAsset), false, '嵌套模型中的灯光需要先独立审查，不能偷偷带入外置脚本');
  const subset = structuredClone(document);
  subset.scene.entityIds = source.entityIds.filter(id => selected.has(id));
  assert.equal(subset.scene.entityIds.length, selected.size, '实体顺序清单与树不一致');
  subset.scene.entities = Object.fromEntries(Object.entries(subset.scene.entities).filter(([id]) => selected.has(id)));
  for (const entity of Object.values(subset.scene.entities)) entity.childrenIds = (entity.childrenIds ?? []).filter(id => selected.has(id));
  subset.scene.selectedEntityId = null;
  subset.scene.name = source.name + (environmentOnly ? ' · 原环境完整几何独立GI案例' : ' · 独立GI业务子场景');
  subset.scene.mqttConfig = { ...subset.scene.mqttConfig, enabled: false, simulatorEnabled: false };
  subset.scene.fetchConfig = { ...subset.scene.fetchConfig, url: '', apiKey: '' };
  subset.scene.sceneSettings.openingAnimation = { ...subset.scene.sceneSettings.openingAnimation, enabled: false };
  if (environment === 'omit') subset.scene.sceneSettings.environment = null;
  const lighting = subset.scene.sceneSettings.lighting;
  lighting.result = null;
  lighting.bake = { ...lighting.bake, enabled: true, ...(previewBudget ? {
    quality: 'preview', atlasSize: 1024, texelsPerMeter: 8, probeSpacing: 4, maxTextureMiB: 128,
  } : {}) };
  const references = [];
  const rewrite = value => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    if (typeof value !== 'string') return value;
    let file = value, kind = 'path';
    if (value.startsWith('editor-asset://local/')) { file = decodeURIComponent(new URL(value).pathname.slice(1)); kind = 'editor'; }
    else if (value.startsWith('file:')) { file = fileURLToPath(value); kind = 'file'; }
    if (!path.isAbsolute(file) || !inside(sourceProject, file)) return value;
    const mapped = path.join(output, path.relative(sourceProject, file));
    references.push({ original: file, mapped });
    return kind === 'editor' ? 'editor-asset://local/' + encodeURIComponent(mapped) : kind === 'file' ? pathToFileURL(mapped).href : mapped;
  };
  const prepared = rewrite(subset);
  const sourceHashes = new Map();
  await fs.mkdir(output, { recursive: false });
  const report = { status: 'PREPARING', scope: 'real-business-subset-preparation-only', sourceScene, sourceSceneSha256: sha(original),
    sourceProject, projectRoot: output, selectedRootEntityIds: entityIds, environmentOnly, entityCount: selected.size,
    modelEntityCount: Object.values(prepared.scene.entities).filter(entity => entity.components?.modelAsset).length,
    conditions: { environment, previewBudget, mqtt: false, fetch: false, opening: false, originalAssetBytesAndModelParameters: 'preserved',
      generatedGeometry: 'must be captured from the actual renderer; no cross-full-scene equivalence claim',
      assetsScope: 'complete original Assets directory, including unused library assets', sizeClass: 'unverified until real renderer preflight' },
    scenePath: path.join(output, 'Scenes', 'phase2-business-gi.scene.json'), copiedAssets: [], unresolvedPhysicalReferences: [] };
  try {
    await fs.cp(sourceAssets, path.join(output, 'Assets'), { recursive: true, force: false, errorOnExist: true, filter: async file => {
      const stat = await fs.lstat(file);
      assert.equal(stat.isSymbolicLink(), false, 'GI副本不跟随原资产链接');
      assert.ok(stat.isDirectory() || stat.isFile(), '原资产包含未知文件类型');
      if (stat.isFile()) sourceHashes.set(path.relative(sourceAssets, file), sha(await fs.readFile(file)));
      return true;
    } });
    for (const [relative, expected] of sourceHashes) {
      const sourceFile = path.join(sourceAssets, relative), destination = path.join(output, 'Assets', relative);
      const copied = await fs.readFile(destination);
      assert.equal(sha(copied), expected, '副本字节改变：' + relative);
      assert.equal(sha(await fs.readFile(sourceFile)), expected, '准备过程中原资产改变：' + relative);
      report.copiedAssets.push({ path: 'Assets/' + relative.replaceAll('\\', '/'), bytes: copied.length, sha256: expected });
    }
    for (const reference of references) {
      if (inside(sourceAssets, reference.original)) await fs.access(reference.mapped);
      else report.unresolvedPhysicalReferences.push(reference);
    }
    assert.equal(report.unresolvedPhysicalReferences.length, 0, '场景有Assets以外的原工程引用，必须先单独准备，不能伪装完整');
    await fs.mkdir(path.dirname(report.scenePath));
    await fs.writeFile(report.scenePath, JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx' });
    assert.equal(sha(await fs.readFile(sourceScene)), report.sourceSceneSha256, '原场景改变');
    report.subsetSceneSha256 = sha(await fs.readFile(report.scenePath));
    report.status = 'PREPARED_NOT_BAKED';
    return report;
  } catch (error) { report.status = 'FAIL'; report.error = String(error); throw error; }
  finally { await fs.writeFile(path.join(output, 'phase2-gi-preparation.json'), JSON.stringify(report, null, 2) + '\n'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = { entityIds: [] };
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === '--entity') options.entityIds.push(process.argv[++index]);
    else if (argument === '--source') options.sourceScene = process.argv[++index];
    else if (argument === '--output') options.output = process.argv[++index];
    else if (argument === '--environment') options.environment = process.argv[++index];
    else if (argument === '--preview-budget') options.previewBudget = true;
    else throw new Error('未知准备参数：' + argument);
  }
  assert.ok(options.sourceScene && options.output, '需要 --source/--output/--environment keep|omit 和一个或多个 --entity；只准备不烘焙');
  console.log(JSON.stringify(await prepareBusinessGiSubset(options), null, 2));
}
