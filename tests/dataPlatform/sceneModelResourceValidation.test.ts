import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ validateSceneModelResourceReferences: validate }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/sceneModelResourceValidation'),
]>(['electron/ipc/sceneModelResourceValidation.ts']);
const signal = new AbortController().signal;
const sourceUrl = 'editor-asset://local/old-model.glb';
const config = {
  schema: 'babylon-editor.model-parameters', version: 1,
  parameters: [{ key: 'skin', type: 'texture', defaultValue: 'textures/old.png' }],
  bindings: [{ target: { kind: 'node', name: 'door' }, property: 'visible', value: true }],
};
const document = {
  asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
  nodes: [{ name: 'door', mesh: 0 }], meshes: [{ primitives: [{ material: 0 }] }], materials: [{ name: 'metal' }],
};
function glb(json: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(json));
  const body = Buffer.alloc(Math.ceil(bytes.length / 4) * 4, 0x20);
  bytes.copy(body);
  const header = Buffer.alloc(20);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + body.length, 8);
  header.writeUInt32LE(body.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, body]);
}
async function fixture(run: (context: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const context = await createFixture();
  try { await run(context); } finally { await fs.rm(context.root, { recursive: true, force: true }); }
}
async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-resource-validation-'));
  const modelPath = path.join(root, 'model.glb');
  await fs.mkdir(path.join(root, 'textures'));
  await fs.writeFile(path.join(root, 'textures/old.png'), 'old texture');
  await fs.writeFile(modelPath, glb(document));
  const previous = { sourceUrl, parameterConfig: structuredClone(config), parameterValues: { skin: 'textures/old.png' } };
  const asset: import('../../electron/types').ProjectModelAssetEntry = {
    id: modelPath, name: 'model', path: modelPath, sourceUrl: 'new-model', kind: 'model', libraryKind: 'model',
    packagePath: root, parameterConfig: structuredClone(config),
  };
  return { root, modelPath, previous, asset,
    scene: { entities: { entity: { components: { modelAsset: previous } } } },
    replacements: [{ sourceUrls: [sourceUrl], asset }],
  };
}

test('实际 GLB 节点和保留纹理存在时通过，不改动场景及参数', async () => fixture(async (c) => {
  const before = JSON.stringify(c.scene);
  await validate(c.scene, c.replacements, signal);
  assert.equal(JSON.stringify(c.scene), before);
}));

test('保留 Babylon glTFLoader 生成的 __root__ 根 Mesh 绑定', async () => fixture(async (c) => {
  c.previous.parameterConfig = { ...config, bindings: [{ target: { kind: 'mesh', name: '__root__' }, property: 'visible', value: true }] } as typeof c.previous.parameterConfig;
  c.asset.parameterConfig = c.previous.parameterConfig;
  assert.deepEqual(await validate(c.scene, c.replacements, signal), []);
}));

test('新版绑定节点缺失仅返回警告，规则与间接目标不再阻断模型替换', async () => fixture(async (c) => {
  await fs.writeFile(c.modelPath, glb({ ...document, nodes: [{ name: 'replacement', mesh: 0 }] }));
  assert.match((await validate(c.scene, c.replacements, signal)).join('\n'), /door.*不存在/);
  const rules = { ...config, bindings: [], rules: [{ when: true, set: config.bindings }] };
  c.previous.parameterConfig = rules;
  c.asset.parameterConfig = rules;
  const scene = { entities: { generator: { components: { modelGenerator: { defaultTarget: { kind: 'model', modelAsset: c.previous } } } } } };
  assert.match((await validate(scene, c.replacements, signal)).join('\n'), /door.*不存在/);
}));

test('参数纹理缺失或路径不安全时只警告并跳过，不阻断模型替换', async () => fixture(async (c) => {
  await fs.rm(path.join(c.root, 'textures/old.png'));
  assert.match((await validate(c.scene, c.replacements, signal)).join('\n'), /skin.*old.png.*跳过/);
  for (const value of ['../outside.png', '/outside.png', 'C:/outside.png', 'textures/../../outside.png']) {
    c.previous.parameterValues.skin = value;
    assert.match((await validate(c.scene, c.replacements, signal)).join('\n'), /skin.*不安全.*跳过/);
  }
}));

test('省略旧显式参数值时采用新版默认纹理，不再读取旧默认纹理', async () => fixture(async (c) => {
  c.previous.parameterValues = {} as typeof c.previous.parameterValues;
  c.asset.parameterConfig = { ...config, parameters: [{ ...config.parameters[0], defaultValue: 'missing-new-default.png' }] };
  assert.match((await validate(c.scene, c.replacements, signal)).join('\n'), /missing-new-default.png/);
  await fs.writeFile(path.join(c.root, 'missing-new-default.png'), 'new texture');
  await fs.rm(path.join(c.root, 'textures/old.png'));
  await validate(c.scene, c.replacements, signal);
}));

test('glTF 外部 buffer 与 image 必须位于包内且文件存在', async () => fixture(async (c) => {
  const modelPath = path.join(c.root, 'model.gltf');
  c.asset.path = modelPath;
  const json = { ...document, buffers: [{ uri: 'mesh.bin', byteLength: 4 }], images: [{ uri: 'textures/old.png' }] };
  await fs.writeFile(modelPath, JSON.stringify(json));
  await assert.rejects(validate(c.scene, c.replacements, signal), /mesh.bin/);
  await fs.writeFile(path.join(c.root, 'mesh.bin'), 'data');
  await validate(c.scene, c.replacements, signal);
  await fs.writeFile(modelPath, JSON.stringify({ ...json, buffers: [{ uri: '../outside.bin' }] }));
  await assert.rejects(validate(c.scene, c.replacements, signal), /不安全/);
}));

test('mesh 绑定使用 Babylon 节点生成的名称，material 检查实际被使用材质', async () => fixture(async (c) => {
  const bindings = [
    { target: { kind: 'mesh', name: 'door' }, property: 'visible', value: true },
    { target: { kind: 'material', name: 'metal' }, property: 'alpha', value: 1 },
  ];
  c.previous.parameterConfig = { ...config, bindings } as typeof c.previous.parameterConfig;
  c.asset.parameterConfig = c.previous.parameterConfig;
  await validate(c.scene, c.replacements, signal);
  await fs.writeFile(c.modelPath, glb({ ...document, materials: [{ name: 'plastic' }] }));
  assert.match((await validate(c.scene, c.replacements, signal)).join('\n'), /metal.*不存在/);
}));

test('预取消立即终止，损坏 GLB 与超限 glTF 不被当作可用新模型', async () => fixture(async (c) => {
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(validate(c.scene, c.replacements, aborted.signal), /取消/);
  await fs.writeFile(c.modelPath, 'broken');
  await assert.rejects(validate(c.scene, c.replacements, signal), /GLB/);
  c.asset.path = path.join(c.root, 'huge.gltf');
  const handle = await fs.open(c.asset.path, 'w');
  await handle.truncate(64 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(validate(c.scene, c.replacements, signal), /64 MiB/);
}));

test('参数纹理junction越界时只警告但不读取包外内容', async () => fixture(async (c) => {
  const packageRoot = path.join(c.root, 'package');
  await fs.mkdir(packageRoot);
  c.asset.path = path.join(packageRoot, 'model.glb');
  c.asset.packagePath = packageRoot;
  await fs.copyFile(c.modelPath, c.asset.path);
  await fs.symlink(path.join(c.root, 'textures'), path.join(packageRoot, 'textures'), 'junction');
  assert.match((await validate(c.scene, c.replacements, signal)).join('\n'), /不安全.*跳过/);
}));

test('未被默认场景引用的同名节点不能假装绑定有效，多 primitive 名称按加载器规则校验', async () => fixture(async (c) => {
  await fs.writeFile(c.modelPath, glb({ ...document, scenes: [{ nodes: [1] }], nodes: [document.nodes[0], { name: 'other', mesh: 0 }] }));
  assert.match((await validate(c.scene, c.replacements, signal)).join('\n'), /door.*不存在/);
  await fs.writeFile(c.modelPath, glb({ ...document, meshes: [{ primitives: [{ material: 0 }, { material: 0 }] }] }));
  c.previous.parameterConfig = { ...config, bindings: [{ target: { kind: 'mesh', name: 'door_primitive1' }, property: 'visible', value: true }] };
  c.asset.parameterConfig = c.previous.parameterConfig;
  await validate(c.scene, c.replacements, signal);
}));

test('新版专用遥测声明节点缺失只返回警告，模型仍可替换', async () => fixture(async (c) => {
  const declarations = [
    { device: { devType: 'rgv' }, fixedNodes: ['removed'] },
    { device: { devType: 'rgv' }, cargo: { frontNodes: ['removed'], backNodes: ['door'] } },
    { device: { devType: 'conveyor' }, cargo: { travel: { nodes: ['removed'] } } },
    { device: { devType: 'stacker' }, motion: { travel: { nodes: ['removed'] } } },
    { device: { devType: 'stacker' }, specializedMotion: { lift: { nodes: ['removed'] } } },
    { device: { devType: 'stacker' }, motion: { fork: { backStageTwoNodes: ['removed'] } } },
  ];
  for (const declaration of declarations) {
    c.asset.dataDrivenConfig = declaration;
    assert.match((await validate(c.scene, c.replacements, signal)).join('\n'), /dataDriven.*removed.*不存在/);
    c.asset.dataDrivenConfig = JSON.parse(JSON.stringify(declaration).replaceAll('removed', 'door'));
    await validate(c.scene, c.replacements, signal);
  }
}));

test('遥测节点校验使用新版资源声明，不把保留的旧Inspector摘要当作当前脚本配置', async () => fixture(async (c) => {
  Object.assign(c.previous, { dataDrivenConfig: { device: { devType: 'rgv' }, fixedNodes: ['old-removed'] } });
  c.asset.dataDrivenConfig = { device: { devType: 'rgv' }, fixedNodes: ['door'] };
  const before = JSON.stringify(c.scene);
  await validate(c.scene, c.replacements, signal);
  assert.equal(JSON.stringify(c.scene), before);
  c.asset.dataDrivenConfig = { device: { devType: 'stacker' }, motion: { travel: { fallbackPattern: '^generated-' } }, label: 'not-a-node' };
  await validate(c.scene, c.replacements, signal);
}));

test('旧货格映射被新版清理不再阻断，新版映射缺少参数只警告', async () => fixture(async (c) => {
  Object.assign(c.previous, { builtInSlotBindingConfig: { enabledParam: 'enabled', dimensionMapping: { columns: 'columns' } } });
  c.asset.builtInSlotBindingConfig = { enabledParam: 'other', dimensionMapping: {} };
  const warnings = await validate(c.scene, c.replacements, signal);
  assert.match(warnings.join('\n'), /builtInSlotBinding.*other.*不存在/);
  assert.ok(!warnings.some(message => /enabled|columns/.test(message)));
  const withEnabled = { ...config, parameters: [...config.parameters, { key: 'other', type: 'boolean', defaultValue: true }] };
  c.asset.parameterConfig = withEnabled;
  assert.deepEqual(await validate(c.scene, c.replacements, signal), []);
}));

test('新版删除的旧纹理key不读取，旧节点绑定不参与新版校验', async () => fixture(async (c) => {
  await fs.rm(path.join(c.root, 'textures/old.png'));
  c.asset.parameterConfig = { ...config, parameters: [], bindings: [] };
  await fs.writeFile(c.modelPath, glb({ ...document, nodes: [{ name: 'replacement', mesh: 0 }] }));
  assert.deepEqual(await validate(c.scene, c.replacements, signal), []);
}));

test('保留的同key异类型值只警告，不作为新版texture读取；范围变化也不阻断', async () => fixture(async (c) => {
  Object.assign(c.previous, { parameterConfig: { ...config, parameters: [{ key: 'skin', type: 'number', defaultValue: 1 }] }, parameterValues: { skin: 99 } });
  await fs.rm(path.join(c.root, 'textures/old.png'));
  assert.match((await validate(c.scene, c.replacements, signal)).join('\n'), /skin.*类型.*跳过/);
  c.asset.parameterConfig = { ...config, parameters: [{ key: 'skin', type: 'number', min: 0, max: 5, defaultValue: 1 }] };
  assert.match((await validate(c.scene, c.replacements, signal)).join('\n'), /skin.*范围/);
  assert.equal((c.previous.parameterValues as Record<string, unknown>).skin, 99);
}));

test('包内子模型可以用父目录相对路径引用公共依赖，真实越界仍拒绝', async () => fixture(async (c) => {
  await fs.mkdir(path.join(c.root, 'parts'));
  await fs.writeFile(path.join(c.root, 'mesh.bin'), 'data');
  c.asset.path = path.join(c.root, 'parts', 'model.gltf');
  c.previous.parameterConfig = { ...config, parameters: [] };
  c.previous.parameterValues = {} as typeof c.previous.parameterValues;
  c.asset.parameterConfig = c.previous.parameterConfig;
  const json = { ...document, buffers: [{ uri: '../mesh.bin', byteLength: 4 }], images: [{ uri: '../textures/old.png' }] };
  await fs.writeFile(c.asset.path, JSON.stringify(json));
  await validate(c.scene, c.replacements, signal);
  await fs.writeFile(c.asset.path, JSON.stringify({ ...json, images: [{ uri: '../../outside.png' }] }));
  await assert.rejects(validate(c.scene, c.replacements, signal), /不安全/);
}));

test('子模型父目录依赖经过junction实际越界时仍拒绝', async () => fixture(async (c) => {
  const packageRoot = path.join(c.root, 'nested-package');
  await fs.mkdir(path.join(packageRoot, 'parts'), { recursive: true });
  await fs.symlink(path.join(c.root, 'textures'), path.join(packageRoot, 'textures'), 'junction');
  c.asset.path = path.join(packageRoot, 'parts', 'model.gltf'); c.asset.packagePath = packageRoot;
  c.previous.parameterConfig = { ...config, parameters: [] };
  c.previous.parameterValues = {} as typeof c.previous.parameterValues;
  c.asset.parameterConfig = c.previous.parameterConfig;
  await fs.writeFile(c.asset.path, JSON.stringify({ ...document, images: [{ uri: '../textures/old.png' }] }));
  await assert.rejects(validate(c.scene, c.replacements, signal), /不安全/);
}));
