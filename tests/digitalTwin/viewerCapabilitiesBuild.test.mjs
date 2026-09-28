import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { build, loadConfigFromFile } from 'vite';
import { assertViewerTemplateSupportsScene } from '../../electron/ipc/viewerTemplateCapabilities.ts';

test('能力清单使用最终落盘字节并覆盖入口引用的共享 JS chunk', async t => {
  const root = await mkdtemp(path.resolve('node_modules/.viewer-capabilities-build-'));
  t.after(async () => {
    if (path.dirname(root) !== path.resolve('node_modules')
      || !path.basename(root).startsWith('.viewer-capabilities-build-')) throw new Error('临时测试目录范围无效');
    await rm(root, { recursive: true, force: true });
  });
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.resolve('vite.viewer.config.ts'));
  const capabilitiesPlugin = loaded.config.plugins.find(plugin => plugin?.name === 'viewer-template-capabilities');
  assert.ok(capabilitiesPlugin, '真实 Viewer 配置必须启用能力清单插件');
  await writeFile(path.join(root, 'index.html'), '<html><body><script type="module" src="./main.js"></script></body></html>');
  await writeFile(path.join(root, 'shared.js'), 'export const shared = "shared runtime logic";');
  await writeFile(path.join(root, 'main.css'), 'body { color: #123456; }');
  await mkdir(path.join(root, 'images'));
  const imports = ['import { shared } from "./shared.js";', 'import "./main.css";'];
  for (let index = 1; index <= 10; index++) {
    await writeFile(path.join(root, 'images', `asset-${index}.webp`), `image-${index}`);
    imports.push(`import asset${index} from "./images/asset-${index}.webp?url";`);
  }
  imports.push(`console.log(shared, ${Array.from({ length: 10 }, (_, index) => `asset${index + 1}`).join(', ')});`);
  await writeFile(path.join(root, 'main.js'), imports.join('\n'));
  const outDir = path.join(root, 'dist');
  const finalMarker = '/* modified after capabilities generateBundle */';
  const result = await build({ configFile: false, root, base: './', publicDir: false, logLevel: 'silent',
    plugins: [capabilitiesPlugin, {
      name: 'late-entry-transform', enforce: 'post',
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) if (output.type === 'chunk' && output.isEntry) output.code += `\n${finalMarker}\n`;
      },
    }],
    build: { outDir, assetsInlineLimit: 0, rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: 'shared-runtime', test: /shared\.js$/ }] } },
    } },
  });
  const outputs = Array.isArray(result) ? result.flatMap(item => item.output) : result.output;
  const chunks = outputs.filter(output => output.type === 'chunk');
  const entry = chunks.find(output => output.isEntry);
  const shared = chunks.find(output => !output.isEntry);
  assert.ok(shared, '回归必须实际产生入口之外的共享 chunk');
  assert.ok((await readFile(path.join(outDir, entry.fileName), 'utf8')).includes(finalMarker));
  const manifest = JSON.parse(await readFile(path.join(outDir, 'viewer-capabilities.json'), 'utf8'));
  for (const file of [...manifest.entryFiles, ...manifest.openingAnimation.assets]) {
    const bytes = await readFile(path.join(outDir, file.path));
    assert.equal(file.size, bytes.length, `${file.path} 应使用最终落盘大小`);
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'), `${file.path} 应使用最终落盘 SHA-256`);
  }
  for (const chunk of chunks) assert.ok(manifest.entryFiles.some(file => file.path === chunk.fileName), `能力清单遗漏 ${chunk.fileName}`);
  const paths = ['viewer-capabilities.json', ...manifest.entryFiles.map(file => file.path), ...manifest.openingAnimation.assets.map(file => file.path)];
  const files = await Promise.all(paths.map(async relativePath => ({
    sourcePath: path.join(outDir, relativePath), destinationRelativePath: relativePath,
    size: (await stat(path.join(outDir, relativePath))).size,
  })));
  const scene = JSON.stringify({ scene: { sceneSettings: { openingAnimation: { enabled: true, template: 'reference-huishan' } } } });
  await assertViewerTemplateSupportsScene(scene, files, new AbortController().signal);
  await assert.rejects(assertViewerTemplateSupportsScene(scene, files.filter(file => file.destinationRelativePath !== shared.fileName), new AbortController().signal), /缺少.*shared-runtime/);
  await writeFile(path.join(outDir, shared.fileName), 'obsolete shared runtime');
  await assert.rejects(assertViewerTemplateSupportsScene(scene, files, new AbortController().signal), /资源不一致.*shared-runtime/);
});
