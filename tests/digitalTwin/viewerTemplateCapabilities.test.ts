import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertViewerTemplateSupportsScene,
  createViewerTemplateCapabilities,
  VIEWER_TEMPLATE_CAPABILITIES_PATH,
} from '../../electron/ipc/viewerTemplateCapabilities.ts';

const enabledScene = JSON.stringify({ scene: { sceneSettings: {
  openingAnimation: { enabled: true, template: 'reference-huishan' },
} } });

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viewer-opening-capabilities-'));
  t.after(async () => {
    if (path.dirname(root) !== path.resolve(os.tmpdir())
      || !path.basename(root).startsWith('viewer-opening-capabilities-')) throw new Error('临时测试目录范围无效');
    await rm(root, { recursive: true, force: true });
  });
  const files: { sourcePath: string; destinationRelativePath: string; size: number }[] = [];
  const entries = [
    { path: 'index.html', content: '<script src="./assets/index-current.js"></script>' },
    { path: 'assets/index-current.js', content: 'current viewer opening entry' },
  ];
  const images = Array.from({ length: 10 }, (_, index) => ({
    id: `asset-${index + 1}`, path: `assets/asset-${index + 1}-hash.webp`, content: `image-${index + 1}`,
  }));
  async function add(relativePath: string, content: string) {
    const sourcePath = path.join(root, relativePath);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, content);
    const item = { sourcePath, destinationRelativePath: relativePath, size: Buffer.byteLength(content) };
    const existing = files.findIndex(file => file.destinationRelativePath === relativePath);
    if (existing < 0) files.push(item); else files[existing] = item;
  }
  for (const file of [...entries, ...images]) await add(file.path, file.content);
  const manifest = createViewerTemplateCapabilities(entries, images);
  const writeManifest = () => add(VIEWER_TEMPLATE_CAPABILITIES_PATH, JSON.stringify(manifest));
  const validate = (sceneContent = enabledScene, signal = new AbortController().signal) =>
    assertViewerTemplateSupportsScene(sceneContent, files, signal);
  return { files, entries, images, manifest, add, writeManifest, validate };
}

test('启用开场时拒绝旧 Viewer 模板，提示更新安装版或重新构建', async t => {
  const f = await fixture(t);
  await assert.rejects(f.validate(), /Viewer 模板.*开场动画.*更新.*build:viewer/s);
});

test('旧场景未配置或关闭开场时仍可使用没有能力清单的模板', async t => {
  const f = await fixture(t);
  await f.validate(JSON.stringify({ scene: { sceneSettings: {} } }));
  await f.validate(JSON.stringify({ scene: { sceneSettings: { openingAnimation: { enabled: false } } } }));
});

test('完整模板通过校验，保留相对路径和全部十张素材', async t => {
  const f = await fixture(t);
  await f.writeManifest();
  await f.validate();
  assert.equal(f.manifest.version, 1);
  assert.equal(f.manifest.openingAnimation.template, 'reference-huishan');
  assert.equal(f.manifest.openingAnimation.assets.length, 10);
  const first = f.manifest.openingAnimation.assets[0];
  assert.equal(first.sha256, createHash('sha256').update(f.images[0].content).digest('hex'));
  assert.equal(first.path, f.images[0].path);
});

test('插件包仅能发布到明确支持其协议和渲染器的新 Viewer', async t => {
  const f = await fixture(t);
  const scene = (renderer = 'timeline', runtimeApiVersion = 1) => JSON.stringify({ scene: { sceneSettings: {
    openingAnimation: { enabled: true, template: 'package', package: { definition: { manifest: { renderer, runtimeApiVersion } } } },
  } } });
  await f.writeManifest();
  await f.validate(scene());
  await f.validate(scene('reference-huishan'));
  await assert.rejects(f.validate(scene('external-js')), /插件包.*渲染器|插件包.*协议/);
  await assert.rejects(f.validate(scene('timeline', 2)), /插件包.*协议/);
  const old = { ...f.manifest } as Record<string, unknown>;
  delete old.openingPackages;
  await f.add(VIEWER_TEMPLATE_CAPABILITIES_PATH, JSON.stringify(old));
  await assert.rejects(f.validate(scene()), /插件包.*协议/);
  await f.validate(enabledScene);
});

test('旧 globe-huishan 和缺失模板标识沿用当前参考模板能力', async t => {
  const f = await fixture(t);
  await f.writeManifest();
  for (const template of ['globe-huishan', undefined]) {
    await f.validate(JSON.stringify({ scene: { sceneSettings: { openingAnimation: { enabled: true, template } } } }));
  }
});

test('素材漏复制时阻止打包而不是发布后黑屏', async t => {
  const f = await fixture(t);
  await f.writeManifest();
  f.files.splice(f.files.findIndex(file => file.destinationRelativePath === f.images[9].path), 1);
  await assert.rejects(f.validate(), /缺少.*asset-10/);
});

test('素材内容损坏或混用旧入口脚本时拒绝发布', async t => {
  const f = await fixture(t);
  await f.writeManifest();
  await f.add(f.images[0].path, 'broken!');
  await assert.rejects(f.validate(), /资源不一致/);
  await f.add(f.images[0].path, f.images[0].content);
  await f.add(f.entries[1].path, 'obsolete viewer opening code');
  await assert.rejects(f.validate(), /资源不一致/);
});

test('错误版本、缺少素材清单、重复素材和不安全路径不能伪装完整能力', async t => {
  const f = await fixture(t);
  const valid = JSON.parse(JSON.stringify(f.manifest));
  const variants = [
    { ...valid, version: 9 },
    { ...valid, openingAnimation: { ...valid.openingAnimation, assets: [] } },
    { ...valid, entryFiles: [] },
    { ...valid, openingAnimation: { ...valid.openingAnimation, assets: Array(10).fill(valid.openingAnimation.assets[0]) } },
    { ...valid, entryFiles: [{ ...valid.entryFiles[0], path: '../index.html' }, valid.entryFiles[1]] },
  ];
  for (const manifest of variants) {
    await f.add(VIEWER_TEMPLATE_CAPABILITIES_PATH, JSON.stringify(manifest));
    await assert.rejects(f.validate(), /Viewer 模板.*不完整|Viewer 模板.*无效/);
  }
});

test('无效 JSON 和过大清单给出可操作的中文错误', async t => {
  const f = await fixture(t);
  await f.add(VIEWER_TEMPLATE_CAPABILITIES_PATH, '{');
  await assert.rejects(f.validate(), /Viewer 模板.*无效/);
  await f.add(VIEWER_TEMPLATE_CAPABILITIES_PATH, ' '.repeat(65_537));
  await assert.rejects(f.validate(), /Viewer 模板.*无效/);
});

test('取消后不继续校验模板资源', async t => {
  const f = await fixture(t);
  await f.writeManifest();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.validate(enabledScene, controller.signal), /取消/);
});

test('未知开场模板和损坏场景明确失败，缺失磁盘资源不泄露本机路径', async t => {
  const f = await fixture(t);
  await f.writeManifest();
  await assert.rejects(f.validate('{'), /导出场景不是有效 JSON/);
  await assert.rejects(f.validate(JSON.stringify({ scene: { sceneSettings: {
    openingAnimation: { enabled: true, template: 'unknown' },
  } } })), /不支持场景配置的开场动画/);
  const sourcePath = f.files.find(file => file.destinationRelativePath === f.images[0].path)!.sourcePath;
  await rm(sourcePath);
  await assert.rejects(f.validate(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /资源读取失败/);
    assert.equal(error.message.includes(sourcePath), false);
    return true;
  });
});
