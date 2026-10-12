import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Open } from 'unzipper';
import { buildPrismaticOpeningPackage } from '../../scripts/build-prismatic-opening-package.mjs';
import { createOpeningPackageBinding, validateOpeningPackageConfig, validateOpeningPackageDefinition } from '../../electron/shared/openingPackage.ts';

const definition = () => ({
  manifest: { formatVersion: 1, runtimeApiVersion: 1, id: 'prismatic-genesis', version: '1.0.0', name: '棱光创生', renderer: 'prismatic-genesis', assets: [] },
  schema: { type: 'object', properties: { brandName: { type: 'string' } } },
  uiSchema: { groups: [{ title: '品牌', fields: ['brandName'] }] }, defaults: { brandName: '中鼎智能' },
  timeline: { stages: ['core', 'tunnel', 'assembly', 'showcase'].map((id, index) => ({ id, label: id, durationSeconds: [4, 3, 7, 8][index] })), handoffSeconds: .8 },
});

test('棱光创生真实包只含声明式定义和核心封面，素材指纹完整', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prismatic-opening-package-'));
  t.after(async () => {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('prismatic-opening-package-')) throw new Error('临时测试目录范围无效');
    await rm(root, { recursive: true, force: true });
  });
  const result = await buildPrismaticOpeningPackage(root);
  const archive = await Open.file(result.plugin);
  assert.deepEqual(archive.files.map(file => file.path).sort(), ['assets/cover.svg', 'config.schema.json', 'defaults.json', 'manifest.json', 'timeline.json', 'ui.schema.json']);
  const json = async (name: string) => JSON.parse((await archive.files.find(file => file.path === name)!.buffer()).toString('utf8'));
  const source = validateOpeningPackageDefinition({ manifest: await json('manifest.json'), schema: await json('config.schema.json'),
    uiSchema: await json('ui.schema.json'), defaults: await json('defaults.json'), timeline: await json('timeline.json') });
  assert.equal(source.defaults.brandName, '中鼎智能');
  assert.equal(source.defaults.quality, 'high');
  assert.equal(source.defaults.showUI, true);
  assert.deepEqual(source.timeline.stages.map(stage => stage.durationSeconds), [4, 3, 7, 8]);
  assert.equal(source.timeline.handoffSeconds, .8);
  const cover = await archive.files.find(file => file.path === 'assets/cover.svg')!.buffer();
  assert.equal(cover.length, source.manifest.assets[0].size);
  assert.equal(createHash('sha256').update(cover).digest('hex'), source.manifest.assets[0].sha256);
  assert.equal(archive.files.some(file => /\.(?:js|html|glb)$/i.test(file.path)), false);
});

test('棱光创生支持固定四段，场景时长独立保存且单阶段可跳过', () => {
  const source = validateOpeningPackageDefinition(definition());
  const first = createOpeningPackageBinding(source, 'project/prismatic/manifest.json', 'a'.repeat(64));
  const second = createOpeningPackageBinding(source, first.manifestUrl, first.contentHash);
  assert.equal(first.config.stages.reduce((sum, stage) => sum + stage.durationSeconds, 0), 22);
  first.config.stages[1].durationSeconds = 0;
  first.config.values.brandName = '';
  validateOpeningPackageConfig(source, first.config);
  assert.equal(second.config.stages[1].durationSeconds, 3);
  assert.equal(second.config.values.brandName, '中鼎智能');
});

test('棱光创生拒绝错误分镜数量、顺序、身份和全零时长', () => {
  for (const mutate of [
    (stages: ReturnType<typeof definition>['timeline']['stages']) => { stages.pop(); },
    (stages: ReturnType<typeof definition>['timeline']['stages']) => { [stages[0], stages[1]] = [stages[1], stages[0]]; },
    (stages: ReturnType<typeof definition>['timeline']['stages']) => { stages[2].id = 'warehouse'; },
    (stages: ReturnType<typeof definition>['timeline']['stages']) => { stages.forEach(stage => { stage.durationSeconds = 0; }); },
  ]) {
    const raw = definition(); mutate(raw.timeline.stages);
    assert.throws(() => validateOpeningPackageDefinition(raw), /棱光创生/);
    const source = validateOpeningPackageDefinition(definition());
    assert.throws(() => validateOpeningPackageConfig(source, { values: source.defaults, stages: raw.timeline.stages }), /棱光创生/);
  }
});
