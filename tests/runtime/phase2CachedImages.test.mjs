import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

test('无绑定缓存部分迁移时合并两处独有图片，同引用共享优先；绑定场景只读自己的共享根', async () => {
  const source = await fs.readFile('electron/ipc/dataPlatformProjectService.ts', 'utf8');
  const ast = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'listSyncedImagesForWorkspace');
  assert.ok(declaration);
  const code = ts.transpileModule(declaration.getText(ast).replace(/^export /, '') + '\nlistSyncedImagesForWorkspace;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const shared = [{ reference: 'shared-only', filePath: 'shared' }, { reference: 'both', filePath: 'shared-version' }];
  const legacy = [{ reference: 'legacy-only', filePath: 'legacy' }, { reference: 'both', filePath: 'legacy-version' }];
  const reads = [];
  let binding = null;
  const list = runInNewContext(code, { getCurrentDataPlatformBinding: () => binding,
    ensureWritableEditorRoot: async () => {}, resolveDataPlatformSharedResourcesRoot: root => root + '/SharedResources',
    resolveDataPlatformBindingSharedResourcesRoot: () => 'bound/shared',
    listSyncedImages: async root => { reads.push(root); return root.endsWith('SharedResources') ? shared : root === 'workspace' ? legacy : [{ reference: 'bound' }]; } });
  assert.deepEqual(structuredClone(await list('workspace')), [shared[0], shared[1], legacy[0]]);
  assert.deepEqual(reads.sort(), ['workspace', 'workspace/SharedResources']);
  binding = { projectRoot: 'bound/project', metadata: {} }; reads.length = 0;
  assert.deepEqual(structuredClone(await list('workspace')), [{ reference: 'bound' }]);
  assert.deepEqual(reads, ['bound/shared']);
});

const imageSource = await fs.readFile('electron/ipc/dataPlatformImageSync.ts', 'utf8');
const imageAst = ts.createSourceFile('images.ts', imageSource, ts.ScriptTarget.Latest, true);
const names = new Set(['listSyncedImages', 'readImageIndex', 'getImageIndexPath', 'isPlainObject', 'isNodeError']);
const imageCode = ts.transpileModule(imageAst.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
  .map(node => node.getText(imageAst).replace(/^export /, '')).join('\n') + '\n({listSyncedImages})',
{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

async function imagesFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-local-images-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('phase2-local-images-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'Assets', 'Images'), { recursive: true });
  await fs.mkdir(path.join(root, '.babylon-editor'));
  const authorized = [];
  const api = runInNewContext(imageCode, { fs, path, IMAGE_INDEX_FILE: 'synced-images.json',
    IMAGE_EXTENSION_PATTERN: /\.(png|jpe?g|webp|gif|svg)$/i, ICON_KEY_PATTERN: /^[a-z][a-z0-9_-]{1,63}$/,
    PLATFORM_IMAGE_REFERENCE_PREFIX: 'editor-image://platform/', MAX_IMAGE_FILE_BYTES: 20 * 1024 * 1024,
    getProjectImagesRoot: directory => path.join(directory, 'Assets', 'Images'),
    readUtf8File: file => fs.readFile(file, 'utf8'), authorizeAssetFile: file => authorized.push(file),
    encodeAssetUrl: file => 'editor-asset://local/' + encodeURIComponent(file) });
  const entry = (key, filePath = path.join(root, 'Assets', 'Images', key + '.png')) => ({ id: key, iconKey: key,
    name: key, updatedAt: '2026-10-25', fileName: key + '.png', filePath, sourceUrl: 'https://untrusted.invalid/ignored.png',
    reference: 'editor-image://platform/' + key });
  return { root, authorized, entry, list: () => api.listSyncedImages(root),
    write: entries => fs.writeFile(path.join(root, '.babylon-editor', 'synced-images.json'), JSON.stringify({ version: 1, images: entries })) };
}

test('离线缓存图片恢复精确文件授权并重建本地URL，不信任索引中的远端sourceUrl', async t => {
  const f = await imagesFixture(t), entry = f.entry('cached_image');
  await fs.writeFile(entry.filePath, Buffer.from([137, 80, 78, 71])); await f.write([entry]);
  const images = await f.list();
  assert.equal(images.length, 1); assert.equal(images[0].reference, entry.reference);
  assert.equal(images[0].sourceUrl, 'editor-asset://local/' + encodeURIComponent(entry.filePath));
  assert.deepEqual(f.authorized, [entry.filePath]);
});

test('缓存索引不能授权越界/错配路径、空文件、目录或超过20MiB的文件', async t => {
  const f = await imagesFixture(t);
  const escaped = f.entry('escaped', path.join(f.root, 'private.png'));
  const empty = f.entry('empty'), directory = f.entry('directory'), large = f.entry('large'), traversal = f.entry('traversal');
  traversal.fileName = '../private.png';
  await fs.writeFile(escaped.filePath, 'private'); await fs.writeFile(empty.filePath, ''); await fs.mkdir(directory.filePath);
  await fs.writeFile(large.filePath, ''); await fs.truncate(large.filePath, 20 * 1024 * 1024 + 1);
  await f.write([escaped, empty, directory, large, traversal, f.entry('missing')]);
  assert.equal((await f.list()).length, 0); assert.deepEqual(f.authorized, []);
});

test('图片目录中的junction不能把缓存授权穿透到工程之外', async t => {
  const f = await imagesFixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-images-outside-'));
  t.after(async () => {
    assert.equal(path.dirname(outside), path.resolve(os.tmpdir()));
    assert.ok(path.basename(outside).startsWith('phase2-images-outside-'));
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(outside, 'linked.png'), 'outside');
  const imageRoot = path.join(f.root, 'Assets', 'Images');
  assert.equal(path.relative(f.root, imageRoot), path.join('Assets', 'Images'));
  await fs.rmdir(imageRoot);
  await fs.symlink(outside, imageRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await f.write([f.entry('linked')]);
  assert.equal((await f.list()).length, 0); assert.deepEqual(f.authorized, []);
});

const documentSource = await fs.readFile('src/editor/store/slices/sceneDocumentSlice.ts', 'utf8');
const documentAst = ts.createSourceFile('slice.ts', documentSource, ts.ScriptTarget.Latest, true);
let loadSceneMethod;
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(documentAst) === 'loadSceneFromFile') loadSceneMethod = node.initializer.getText(documentAst);
  ts.forEachChild(node, visit);
}
visit(documentAst);
assert.ok(loadSceneMethod);
const loadCode = ts.transpileModule('const load = ' + loadSceneMethod + '; load;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

for (const stale of [false, true]) test(`场景提交等待本地图片登记，过期会话不得污染当前登记表（stale=${stale}）`, async () => {
  const events = [], state = { runtimeMode: 'edit', sceneSessionId: 'before', logs: [] };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fixtureScene = { name: 'fixture', sceneSettings: { environment: null } };
  const api = { loadSceneFile: async () => ({ canceled: false, content: '{}', sceneOpenToken: 1 }),
    listSyncedImages: () => { events.push('read-cache'); return gate; },
    confirmSceneOpen: async () => { events.push('confirm'); return true; } };
  const load = runInNewContext(loadCode, { window: { editorApi: api }, get: () => state,
    set: fn => { events.push('publish-scene'); Object.assign(state, fn(state)); },
    deserializeScene: () => fixtureScene, createLoadedSceneState: () => ({ sceneSessionId: 'loaded' }),
    setSyncedImageAssets: images => events.push('register:' + images[0].reference),
    syncDataPlatformImagesAfterLocalSceneLoad: async () => {}, prependLog: logs => logs });
  const pending = load('fixture.scene.json');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['read-cache']);
  if (stale) state.sceneSessionId = 'newer';
  release([{ reference: 'cached' }]);
  assert.equal(await pending, !stale);
  assert.deepEqual(events, stale ? ['read-cache'] : ['read-cache', 'confirm', 'register:cached', 'publish-scene']);
});
