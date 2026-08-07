import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createServer } from 'vite';

const execFileAsync = promisify(execFile);

function createMinimalGlbBuffer() {
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
  };
  const jsonBuffer = Buffer.from(JSON.stringify(gltf), 'utf8');
  const paddedJsonLength = Math.ceil(jsonBuffer.length / 4) * 4;
  const paddedJson = Buffer.alloc(paddedJsonLength, 0x20);
  jsonBuffer.copy(paddedJson);

  const totalLength = 12 + 8 + paddedJsonLength;
  const buffer = Buffer.alloc(totalLength);
  buffer.write('glTF', 0, 4, 'utf8');
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(totalLength, 8);
  buffer.writeUInt32LE(paddedJsonLength, 12);
  buffer.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(buffer, 20);
  return buffer;
}

test('编辑器读取并保留 string 类型模型脚本参数', async (t) => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });
  t.after(async () => server.close());

  const modelParameters = await server.ssrLoadModule('/src/editor/model/modelParameters.ts');
  const scanner = await server.ssrLoadModule('/electron/ipc/modelPackageScanner.ts');

  await t.test('显式 modelParameters schema 接受空字符串默认值并保留原始内容', () => {
    const config = modelParameters.normalizeModelParameterConfig({
      schema: 'babylon-editor.model-parameters',
      version: 1,
      parameters: [{
        key: 'displayText',
        label: '显示文本',
        type: 'string',
        defaultValue: '',
      }],
      bindings: [],
    });

    assert.ok(config);
    assert.deepEqual(config.parameters[0], {
      key: 'displayText',
      label: '显示文本',
      unit: undefined,
      type: 'string',
      defaultValue: '',
    });
    assert.equal(modelParameters.sanitizeModelParameterValue(config.parameters[0], '  A-01  '), '  A-01  ');
    assert.equal(modelParameters.sanitizeModelParameterValue(config.parameters[0], 123), '');
  });

  await t.test('仅含 parameterScripts 的模型包会生成 string 参数配置', async (subtest) => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'babylon-string-parameter-'));
    subtest.after(async () => fs.rm(rootPath, { recursive: true, force: true }));

    const packagePath = path.join(rootPath, 'StringParameterModel');
    await fs.mkdir(packagePath, { recursive: true });
    await fs.writeFile(path.join(packagePath, 'StringParameterModel.glb'), createMinimalGlbBuffer());
    await fs.writeFile(path.join(packagePath, 'meta.json'), JSON.stringify({
      parameterScripts: [{
        fields: [
          { key: 'deviceName', label: '设备名称', type: 'string', defaultValue: '测试模型' },
          { key: 'displayText', label: '显示文本', type: 'string', defaultValue: 'A-01' },
        ],
      }],
    }, null, 2));

    const result = await scanner.scanModelPackage(packagePath);
    assert.ok(result.asset);
    assert.deepEqual(result.asset.parameterConfig?.parameters, [{
      key: 'displayText',
      label: '显示文本',
      type: 'string',
      defaultValue: 'A-01',
    }]);
  });

  await t.test('参数同步脚本会把普通 string 字段写入 modelParameters', async (subtest) => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'babylon-string-sync-'));
    subtest.after(async () => fs.rm(rootPath, { recursive: true, force: true }));

    const packagePath = path.join(rootPath, 'StringParameterModel');
    await fs.mkdir(packagePath, { recursive: true });
    await fs.writeFile(path.join(packagePath, 'meta.json'), JSON.stringify({
      parameterScripts: [{
        fields: [
          { key: 'deviceName', label: '设备名称', type: 'string', defaultValue: '测试模型' },
          { key: 'displayText', label: '显示文本', type: 'string', defaultValue: '' },
        ],
      }],
    }, null, 2));

    await execFileAsync(process.execPath, [
      path.resolve('scripts/sync-model-parameters-from-scripts.mjs'),
      rootPath,
      '--write',
    ], { cwd: process.cwd() });

    const metadata = JSON.parse(await fs.readFile(path.join(packagePath, 'meta.json'), 'utf8'));
    assert.deepEqual(metadata.modelParameters.parameters, [{
      key: 'displayText',
      label: '显示文本',
      type: 'string',
      defaultValue: '',
    }]);
  });
});
