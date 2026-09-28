import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (existsSync(fileURLToPath(url))) return next(url.href, context);
  }
  return next(specifier, context);
} });
const { importOpeningPackageArchive, listOpeningPackagesInProject, exportOpeningPackageArchive, readOpeningPackageDirectory } = await import('../../electron/ipc/openingPackageStore.ts');
const { resolveOpeningPackageResources, prepareOpeningSceneContent, collectOpeningSourceBundles } = await import('../../electron/ipc/openingPackageResources.ts');
const { importOpeningImage, validateOpeningImageFile } = await import('../../electron/ipc/openingAssetStore.ts');

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'opening-package-store-'));
  try { await mkdir(path.join(root, 'project')); await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const sha = createHash('sha256').update(bytes).digest('hex');
async function packageZip(root: string, version = '1.0.0', name = '测试') {
  const file = path.join(root, `${version}-${name}.zip`), archive = new ZipArchive({ zlib: { level: 1 } });
  const completed = pipeline(archive, createWriteStream(file));
  const files = { 'manifest.json': { formatVersion: 1, runtimeApiVersion: 1, id: 'demo', version, name,
    renderer: 'timeline', assets: [{ id: 'cover', path: 'assets/cover.png', type: 'image', size: bytes.length, sha256: sha }] },
    'config.schema.json': { type: 'object', properties: { title: { type: 'string' } } },
    'ui.schema.json': { groups: [{ title: '文字', fields: ['title'] }] },
    'defaults.json': { title: '你好' }, 'timeline.json': { stages: [{ id: 'intro', label: '开始', durationSeconds: 2, titleKey: 'title', backgroundAssetId: 'cover' }] } };
  for (const [name, value] of Object.entries(files)) archive.append(JSON.stringify(value), { name });
  archive.append(bytes, { name: 'assets/cover.png' });
  await Promise.all([archive.finalize(), completed]);
  return file;
}

test('导入同内容幂等、不同版本并存、导出可在另一工程重新导入', async () => fixture(async root => {
  const project = path.join(root, 'project'), archive = await packageZip(root);
  const first = await importOpeningPackageArchive(project, archive);
  const second = await importOpeningPackageArchive(project, archive);
  assert.equal(first.manifestUrl, second.manifestUrl); assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.config.values.title, '你好');
  await importOpeningPackageArchive(project, await packageZip(root, '2.0.0'));
  assert.equal((await listOpeningPackagesInProject(project)).packages.length, 2);
  const exported = path.join(root, 'exported.zip');
  await exportOpeningPackageArchive(project, first, exported);
  const project2 = path.join(root, 'project2'); await mkdir(project2);
  const transferred = await importOpeningPackageArchive(project2, exported);
  assert.equal(transferred.contentHash, first.contentHash);
  assert.notEqual(transferred.manifestUrl, first.manifestUrl);
}));

test('同 ID 同版本内容不同不覆盖；被篡改的完整包不可发布或导出', async () => fixture(async root => {
  const project = path.join(root, 'project'), first = await importOpeningPackageArchive(project, await packageZip(root));
  await assert.rejects(importOpeningPackageArchive(project, await packageZip(root, '1.0.0', '另一个')), /同.*版本|冲突/);
  const manifest = decodeURIComponent(new URL(first.manifestUrl).pathname.slice(1));
  await writeFile(path.join(path.dirname(manifest), 'assets/cover.png'), Buffer.from([1, 2, 3]));
  await assert.rejects(readOpeningPackageDirectory(path.dirname(manifest)), /开场包.*校验/);
  await assert.rejects(exportOpeningPackageArchive(project, first, path.join(root, 'bad.zip')), /开场包/);
  const result = await listOpeningPackagesInProject(project);
  assert.equal(result.packages.length, 0); assert.ok(result.warnings.length > 0);
}));

test('导出身份不能跳出当前工程；并发导入同包只产生一个完整版本', async () => fixture(async root => {
  const project = path.join(root, 'project'), archive = await packageZip(root);
  const results = await Promise.all([importOpeningPackageArchive(project, archive), importOpeningPackageArchive(project, archive)]);
  assert.equal(results[0].contentHash, results[1].contentHash);
  assert.equal((await listOpeningPackagesInProject(project)).packages.length, 1);
  await assert.rejects(exportOpeningPackageArchive(project, { id: '../other', version: '1.0.0', contentHash: sha }, path.join(root, 'bad.zip')), /开场包/);
  assert.equal(JSON.parse(await readFile(decodeURIComponent(new URL(results[0].manifestUrl).pathname.slice(1)), 'utf8')).id, 'demo');
}));

test('场景替换素材固定保存，搬目录按身份恢复；改写定义、外部路径与错误摘要阻断发布', async () => fixture(async root => {
  const project = path.join(root, 'project'), binding = await importOpeningPackageArchive(project, await packageZip(root));
  const image = path.join(root, 'override.png'); await writeFile(image, bytes);
  const override = await importOpeningImage(project, image);
  binding.config.assetOverrides = { cover: { assetUrl: override.assetUrl, size: override.size, sha256: override.sha256 } };
  const scene = { version: 5, scene: { name: '独立设置', sceneSettings: { openingAnimation: { template: 'package', package: binding } } } };
  const collected = await collectOpeningSourceBundles([scene, structuredClone(scene)], project, new AbortController().signal);
  assert.equal(collected.length, 2, '相同包与图片分别去重');
  const moved = path.join(root, 'moved'); await cp(project, moved, { recursive: true }); await mkdir(path.join(moved, 'Scenes'));
  const original = JSON.stringify(scene), reopened = await prepareOpeningSceneContent(original, path.join(moved, 'Scenes/main.scene.json'));
  const relocated = JSON.parse(reopened).scene.sceneSettings.openingAnimation.package;
  assert.notEqual(relocated.manifestUrl, binding.manifestUrl);
  assert.notEqual(relocated.config.assetOverrides.cover.assetUrl, override.assetUrl);
  assert.deepEqual(relocated.config.values, binding.config.values);
  assert.ok(await resolveOpeningPackageResources(JSON.parse(reopened), moved));
  assert.equal(JSON.stringify(scene), original, '原内容未被改写');
  const externalSave = path.join(root, 'outside/saved.scene.json');
  assert.equal(await prepareOpeningSceneContent(original, externalSave), original, '项目外另存保留并验证原工程受管素材');
  const nestedReopened = JSON.parse(await prepareOpeningSceneContent(original, path.join(moved, 'Scenes/folder/nested.scene.json')));
  assert.equal(nestedReopened.scene.sceneSettings.openingAnimation.package.manifestUrl, relocated.manifestUrl, 'Scenes嵌套目录也优先恢复新工程素材');
  const changed = structuredClone(scene); changed.scene.sceneSettings.openingAnimation.package.definition.timeline.stages[0].durationSeconds = 8;
  await assert.rejects(resolveOpeningPackageResources(changed, project), /开场包.*校验失败/);
  binding.config.assetOverrides.cover.sha256 = 'f'.repeat(64);
  await assert.rejects(resolveOpeningPackageResources(scene, project), /图片校验失败/);
  binding.config.assetOverrides.cover.assetUrl = 'https://example.test/map.png';
  await assert.rejects(resolveOpeningPackageResources(scene, project), /工程|网络/);
  assert.equal(await prepareOpeningSceneContent('{"version":5,"scene":{}}', path.join(moved, 'Scenes/old.scene.json')), '{"version":5,"scene":{}}');
}));

test('本地缺失或损坏开场资源保留配置和业务场景，发布资源检查仍拒绝', async () => fixture(async root => {
  const project = path.join(root, 'project'), binding = await importOpeningPackageArchive(project, await packageZip(root));
  const scene = { version: 5, scene: { name: '保留业务场景', entities: { machine: { name: '业务设备' } }, sceneSettings: { openingAnimation: { template: 'package', package: binding } } } };
  const content = JSON.stringify(scene), sceneFile = path.join(project, 'Scenes/main.scene.json');
  const directory = path.dirname(decodeURIComponent(new URL(binding.manifestUrl).pathname.slice(1)));
  await writeFile(path.join(directory, 'assets/cover.png'), 'corrupt');
  assert.equal(await prepareOpeningSceneContent(content, sceneFile), content);
  await assert.rejects(resolveOpeningPackageResources(scene, project), /开场包.*校验/);
  await rm(directory, { recursive: true, force: true });
  assert.equal(await prepareOpeningSceneContent(content, sceneFile), content);
  await assert.rejects(resolveOpeningPackageResources(scene, project));
}));

test('图片导入校验真实格式、重复内容复用、损坏缓存和伪装图片均拒绝', async () => fixture(async root => {
  const project = path.join(root, 'project');
  for (const [extension, header] of [['png', bytes], ['jpg', Buffer.from([255, 216, 255, ...Array(13).fill(0)])],
    ['gif', Buffer.from('GIF89a1234567890')], ['webp', Buffer.from('RIFF1234WEBP1234')]] as const) {
    const source = path.join(root, `image.${extension}`); await writeFile(source, header);
    const first = await importOpeningImage(project, source), second = await importOpeningImage(project, source);
    assert.deepEqual(first, second);
    assert.equal((await validateOpeningImageFile(project, first.filePath)).sha256, first.sha256);
  }
  await writeFile(path.join(root, 'forbidden.svg'), '<svg/>');
  await assert.rejects(importOpeningImage(project, path.join(root, 'forbidden.svg')), /仅支持/);
  await writeFile(path.join(root, 'fake.png'), 'This is not a png file');
  await assert.rejects(importOpeningImage(project, path.join(root, 'fake.png')), /内容与扩展名/);
  await writeFile(path.join(root, 'empty.png'), '');
  await assert.rejects(importOpeningImage(project, path.join(root, 'empty.png')), /为空/);
  const image = await importOpeningImage(project, path.join(root, 'image.png'));
  await writeFile(image.filePath, Buffer.concat([bytes, Buffer.from([9])]));
  await assert.rejects(importOpeningImage(project, path.join(root, 'image.png')), /校验失败/);
  await assert.rejects(validateOpeningImageFile(project, path.join(project, 'Assets/OpeningAssets/wrong.png')), /不存在|ENOENT/);
}));

test('工程 Assets 为 Junction 时导入不在外部目标创建任何目录或文件', async () => fixture(async root => {
  const project = path.join(root, 'project'), outside = path.join(root, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(project, 'Assets'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(importOpeningPackageArchive(project, await packageZip(root)), /Junction|符号链接/);
  await writeFile(path.join(root, 'image.png'), bytes);
  await assert.rejects(importOpeningImage(project, path.join(root, 'image.png')), /Junction|符号链接/);
  assert.deepEqual(await readdir(outside), []);
}));
