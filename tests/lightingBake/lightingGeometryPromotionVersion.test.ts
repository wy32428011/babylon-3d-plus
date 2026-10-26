import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { decodeLightingGeometryResource } from '../../electron/shared/sceneLightingBakeGeometryBinary.ts';
import { validateLightingGeometry, validateLightingPng, validateLightingProbes } from '../../electron/shared/sceneLightingBakeArtifacts.ts';
import { matchLightingBakeSurfaceSources, safeLightingBakeChildPath } from '../../electron/ipc/lightingBakeValidation.ts';

// 从实际服务提取未导出的提交入口；文件系统/内容校验仍真实运行，不新增产品测试API。
const file = new URL('../../electron/ipc/lightingBakeService.ts', import.meta.url);
const source = readFileSync(file, 'utf8'), tree = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true);
const entry = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'validateAndPromote');
assert.ok(entry);
const javascript = ts.transpileModule('(' + entry.getText(tree) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const dependencies = { fs, path, createHash, randomUUID, matchLightingBakeSurfaceSources, safeLightingBakeChildPath,
  decodeLightingGeometryResource, validateLightingGeometry, validateLightingPng, validateLightingProbes,
  inside: (root: string, file: string) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); },
  assertActive: (options: { signal: AbortSignal; isProjectCurrent: () => boolean }) => { if (options.signal.aborted || !options.isProjectCurrent()) throw new Error('cancelled'); } };
const promote = Function(...Object.keys(dependencies), 'return ' + javascript.trimStart().replace(/^"use strict";\s*/, ''))(...Object.values(dependencies));

test('v1/v2提交与清单一致，错误/取消只清理本任务pending并保留旧正式资产', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b6-promote-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('b6-promote-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const assets = path.join(root, 'Assets', 'LightingBakes'), old = path.join(assets, 'old');
  await fs.mkdir(old, { recursive: true }); await fs.writeFile(path.join(old, 'keep.txt'), 'unchanged');
  const geometry = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2], uvs: [0, 0, 1, 0, 0, 1], bakeUvs: [0, 0, 1, 0, 0, 1] };
  const png = Buffer.alloc(33); png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.write('IHDR', 12); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
  for (const [version, declared, probeVersion, cancelled, valid] of [[1, undefined, 1, false, true], [2, 2, 1, false, true],
    [1, 2, 1, false, false], [2, 3, 1, false, false], [2, 2, 2, false, false], [2, 2, 1, true, false]] as const) {
    const staging = path.join(root, randomUUID()); await fs.mkdir(staging);
    await fs.writeFile(path.join(staging, 'g.json'), JSON.stringify({ version, ...geometry })); await fs.writeFile(path.join(staging, 'l.png'), png);
    await fs.writeFile(path.join(staging, 'p.json'), JSON.stringify({ version: probeVersion, encoding: 'ambient-cube', spacing: 1,
      probes: [{ position: [0, 0, 0], irradiance: Array(18).fill(.5) }] }));
    await fs.writeFile(path.join(staging, 'result.json'), JSON.stringify({ version: 1, signature: 'b6', engineVersion: 'fixture',
      atlases: [{ file: 'l.png', width: 1, height: 1, rgbmRange: 1 }], probesFile: 'p.json',
      meshes: [{ key: 'a/root', entityId: 'a', nodeKey: 'root', geometryFile: 'g.json', atlasIndex: 0, ...(declared === undefined ? {} : { geometryVersion: declared }) }],
      statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 1 } }));
    const controller = new AbortController(); if (cancelled) controller.abort();
    const authorized: string[] = [];
    const options = { input: { jobId: randomUUID(), signature: 'b6', settings: { atlasSize: 1, maxTextureMiB: 1 },
      meshes: [{ key: 'a/root', entityId: 'a', nodeKey: 'root', receiver: true }] },
      signal: controller.signal, isProjectCurrent: () => true, encodeAssetUrl: (file: string) => file,
      decodeAssetUrl: (file: string) => file, authorizeAssetFile: (file: string) => authorized.push(file) };
    if (valid) {
      const snapshot = await promote(options, staging, assets);
      assert.equal(snapshot.assets.find((asset: { kind: string }) => asset.kind === 'geometry').geometryVersion, version);
      assert.equal(authorized.length, 3);
    } else {
      const before = await fs.readdir(assets);
      await assert.rejects(promote(options, staging, assets), error => cancelled
        ? (error as Error).name === 'AbortError' || /cancelled/.test(String(error))
        : /版本|探针/.test(String(error)));
      assert.deepEqual(await fs.readdir(assets), before); assert.equal(authorized.length, 0);
    }
    assert.equal(await fs.readFile(path.join(old, 'keep.txt'), 'utf8'), 'unchanged');
    assert.equal((await fs.readdir(assets)).some(name => name.startsWith('.pending-')), false);
  }
});
