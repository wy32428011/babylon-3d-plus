import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after, type TestContext } from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';
import type { CrossSceneEntityClipboardPayload } from '../../electron/shared/entityClipboardTransfer.ts';

const electronShim = `
const buffers = new Map();
export const app = {
  getPath() { throw new Error('fixture must not access user profile'); },
  isPackaged: false,
  getAppPath() { return process.cwd(); },
};
export const dialog = {};
export const clipboard = {
  has(format) { return buffers.has(format); },
  writeBuffer(format, buf) { buffers.set(format, Buffer.from(buf)); },
  readBuffer(format) { return buffers.get(format) ?? Buffer.alloc(0); },
};
export const BrowserWindow = { getAllWindows: () => [] };
export const net = { fetch: (...args) => globalThis.fetch(...args) };
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'electron'
      ? { url: `data:text/javascript,${encodeURIComponent(electronShim)}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

let cleanupModules: (() => void) | undefined;
after(() => {
  hooks.deregister();
  cleanupModules?.();
});

const [
  { prepareCrossSceneClipboardForTarget },
  { readProjectAssetIndex, writeRecentWorkspaceIndexFile },
  { encodeAssetUrl },
] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/entityClipboardIpc'),
  typeof import('../../electron/ipc/projectAssetStore'),
  typeof import('../../electron/ipc/assetRegistry'),
]>(
  [
    'electron/ipc/entityClipboardIpc.ts',
    'electron/ipc/projectAssetStore.ts',
    'electron/ipc/assetRegistry.ts',
  ],
  { deferCleanup: (cleanup) => { cleanupModules = cleanup; } },
);

function createValidGlb(marker = 1): Buffer {
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }], extras: { marker } }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    }),
  );
  const jsonSize = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonSize + 36);
  bytes.write('glTF');
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonSize, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(0x20, 20, 20 + jsonSize);
  json.copy(bytes, 20);
  bytes.writeUInt32LE(36, 20 + jsonSize);
  bytes.writeUInt32LE(0x004e4942, 24 + jsonSize);
  Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).copy(bytes, 28 + jsonSize);
  return bytes;
}

async function createTempRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-scene-ipc-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function writeFileEnsured(filePath: string, content: string | Buffer): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return filePath;
}

function buildModelClipboardPayload(
  sourceProjectRoot: string | null,
  modelPath: string,
  scriptPaths: string[] = [],
  entityName = '堆垛机',
): CrossSceneEntityClipboardPayload {
  return {
    schemaVersion: 1,
    clipboardId: 'clip_ipc_1',
    copiedAt: '2026-11-27T00:00:00.000Z',
    sourceContext: {
      sceneSessionId: 'source_session',
      sceneFilePath: sourceProjectRoot ? path.join(sourceProjectRoot, 'scene-a.scene.json') : null,
      projectRoot: sourceProjectRoot,
      dataPlatformBaseUrl: null,
      dataPlatformProjectId: null,
    },
    entries: [
      {
        rootId: 'entity_1',
        entities: [
          {
            id: 'entity_1',
            name: entityName,
            parentId: null,
            childrenIds: [],
            components: {
              transform: {
                position: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
              },
              modelAsset: {
                sourcePath: modelPath,
                sourceUrl: encodeAssetUrl(modelPath),
                lengthUnit: 'meter',
                unitScaleToMeters: 1,
                assetCode: 'DDJ-01',
                ...(scriptPaths.length > 0
                  ? {
                      scriptAssets: scriptPaths.map((scriptPath) => ({
                        path: scriptPath,
                        sourceUrl: encodeAssetUrl(scriptPath),
                        name: path.basename(scriptPath),
                      })),
                    }
                  : {}),
              },
            },
          },
        ],
      },
    ],
  };
}

test('同项目与共享库模型及外置脚本/贴图在粘贴后自动通过校验并授权', async (t) => {
  const root = await createTempRoot(t);
  const workspaceRoot = path.join(root, 'workspace');
  const sharedRoot = path.join(workspaceRoot, 'SharedResources');
  const projectRoot = path.join(workspaceRoot, 'Projects', '101');
  const pkgRoot = path.join(sharedRoot, 'Assets', 'Models', 'Model-55-Stacker');

  const glbPath = await writeFileEnsured(path.join(pkgRoot, 'stacker.glb'), createValidGlb(1));
  const scriptPath = await writeFileEnsured(path.join(pkgRoot, 'drive.ts'), 'export default function() {}');
  const dtsPath = await writeFileEnsured(path.join(pkgRoot, 'types.d.ts'), 'export type X = number;');
  const texPath = await writeFileEnsured(path.join(pkgRoot, 'textures', 'albedo.png'), Buffer.from([137, 80, 78, 71]));

  const authorized = new Set<string>();
  const payload = buildModelClipboardPayload(projectRoot, glbPath, [scriptPath]);
  const result = await prepareCrossSceneClipboardForTarget(payload, {
    projectRoot,
    workspaceRoot,
    sharedResourcesRoot: sharedRoot,
    dataPlatformBaseUrl: null,
    dataPlatformProjectId: null,
    authorizeFile: (filePath) => authorized.add(path.resolve(filePath).toLowerCase()),
  });

  assert.equal(result.available, true);
  assert.deepEqual(result.missingResources, []);
  assert.ok(authorized.has(path.resolve(glbPath).toLowerCase()));
  assert.ok(authorized.has(path.resolve(scriptPath).toLowerCase()));
  assert.ok(authorized.has(path.resolve(texPath).toLowerCase()), '同包贴图需随包授权');
  assert.equal(authorized.has(path.resolve(dtsPath).toLowerCase()), false, '声明文件 .d.ts 不得被授权');
});

test('空白编辑器（无项目目录）允许授权已校验的本地模型与脚本，并给出提示', async (t) => {
  const root = await createTempRoot(t);
  const workspaceRoot = path.join(root, 'workspace');
  const sourceProject = path.join(root, 'ProjectA');
  const pkgRoot = path.join(sourceProject, 'Assets', 'Models', 'ConveyorPkg');
  const glbPath = await writeFileEnsured(path.join(pkgRoot, 'conveyor.glb'), createValidGlb(2));
  const scriptPath = await writeFileEnsured(path.join(pkgRoot, 'conveyor.ts'), 'export const speed = 1;');

  const authorized = new Set<string>();
  const payload = buildModelClipboardPayload(sourceProject, glbPath, [scriptPath]);
  const result = await prepareCrossSceneClipboardForTarget(payload, {
    projectRoot: null,
    workspaceRoot,
    sharedResourcesRoot: null,
    dataPlatformBaseUrl: null,
    dataPlatformProjectId: null,
    authorizeFile: (filePath) => authorized.add(path.resolve(filePath).toLowerCase()),
  });

  assert.equal(result.available, true);
  assert.deepEqual(result.missingResources, []);
  assert.ok(authorized.has(path.resolve(glbPath).toLowerCase()));
  assert.ok(authorized.has(path.resolve(scriptPath).toLowerCase()));
});

test('跨本地项目复制自动拷贝模型包并改写路径，同名异内容包自动去重不覆盖原包', async (t) => {
  const root = await createTempRoot(t);
  const workspaceRoot = path.join(root, 'workspace');
  const projectA = path.join(root, 'ProjectA');
  const projectB = path.join(root, 'ProjectB');

  const pkgA = path.join(projectA, 'Assets', 'Models', 'RobotArm');
  const glbA = await writeFileEnsured(path.join(pkgA, 'arm.glb'), createValidGlb(10));
  const scriptA = await writeFileEnsured(path.join(pkgA, 'arm.ts'), 'export const arm = 1;');
  const texA = await writeFileEnsured(path.join(pkgA, 'skin.png'), Buffer.from([1, 2, 3, 4]));

  // ProjectB 已有同名但不同内容的 RobotArm 包，不得覆盖
  const existingPkgB = path.join(projectB, 'Assets', 'Models', 'RobotArm');
  const existingGlbB = await writeFileEnsured(path.join(existingPkgB, 'arm.glb'), createValidGlb(999));

  const authorized = new Set<string>();
  const payload = buildModelClipboardPayload(projectA, glbA, [scriptA], '机械臂');
  const result = await prepareCrossSceneClipboardForTarget(payload, {
    projectRoot: projectB,
    workspaceRoot,
    sharedResourcesRoot: null,
    dataPlatformBaseUrl: null,
    dataPlatformProjectId: null,
    authorizeFile: (filePath) => authorized.add(path.resolve(filePath).toLowerCase()),
  });

  assert.equal(result.available, true);
  assert.deepEqual(result.missingResources, []);
  const pastedModelAsset = (result.payload!.entries[0].entities[0].components as Record<string, {
    sourcePath: string;
    sourceUrl: string;
    scriptAssets: Array<{ path: string; sourceUrl: string }>;
  }>).modelAsset;

  assert.ok(pastedModelAsset.sourcePath.startsWith(path.join(projectB, 'Assets', 'Models', 'RobotArm-copied-')));
  assert.equal(pastedModelAsset.sourceUrl, encodeAssetUrl(pastedModelAsset.sourcePath));
  assert.ok(pastedModelAsset.scriptAssets[0].path.startsWith(path.dirname(pastedModelAsset.sourcePath)));
  assert.ok(authorized.has(path.resolve(pastedModelAsset.sourcePath).toLowerCase()));
  assert.ok(authorized.has(path.resolve(pastedModelAsset.scriptAssets[0].path).toLowerCase()));
  assert.ok(
    authorized.has(path.resolve(path.dirname(pastedModelAsset.sourcePath), path.basename(texA)).toLowerCase()),
  );
  // 确认目标已有同名异内容包未被破坏
  assert.deepEqual(await fs.readFile(existingGlbB), createValidGlb(999));
  assert.ok(result.warnings.some((warning) => warning.includes('复制到当前项目 Assets/Models')));
});

test('拒绝缺失资源与目录联接（Junction）且不予授权', async (t) => {
  const root = await createTempRoot(t);
  const workspaceRoot = path.join(root, 'workspace');
  const projectA = path.join(root, 'ProjectA');
  const projectB = path.join(root, 'ProjectB');
  const outsidePkg = path.join(root, 'OutsideSecrets');
  await writeFileEnsured(path.join(outsidePkg, 'secret.glb'), createValidGlb(3));
  await fs.mkdir(path.join(projectA, 'Assets', 'Models'), { recursive: true });
  const junctionPkg = path.join(projectA, 'Assets', 'Models', 'LinkedPkg');
  await fs.symlink(outsidePkg, junctionPkg, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedGlb = path.join(junctionPkg, 'secret.glb');

  const authorized = new Set<string>();
  const junctionResult = await prepareCrossSceneClipboardForTarget(
    buildModelClipboardPayload(projectA, linkedGlb, [], '越界链接模型'),
    {
      projectRoot: projectB,
      workspaceRoot,
      sharedResourcesRoot: null,
      dataPlatformBaseUrl: null,
      dataPlatformProjectId: null,
      authorizeFile: (filePath) => authorized.add(path.resolve(filePath).toLowerCase()),
    },
  );
  assert.equal(authorized.size, 0, 'Junction 路径不得授权');
  assert.equal(junctionResult.missingResources.length, 1);
  assert.equal(junctionResult.missingResources[0].entityName, '越界链接模型');

  const missingPath = path.join(projectB, 'Assets', 'Models', 'Missing', 'gone.glb');
  const missingResult = await prepareCrossSceneClipboardForTarget(
    buildModelClipboardPayload(projectB, missingPath, [], '缺失模型'),
    {
      projectRoot: projectB,
      workspaceRoot,
      sharedResourcesRoot: null,
      dataPlatformBaseUrl: null,
      dataPlatformProjectId: null,
      authorizeFile: (filePath) => authorized.add(path.resolve(filePath).toLowerCase()),
    },
  );
  assert.equal(authorized.size, 0);
  assert.equal(missingResult.missingResources.length, 1);
  assert.equal(missingResult.missingResources[0].entityName, '缺失模型');
});

test('多进程场景下原子写入 recent-workspaces.json 无损坏且不残留临时文件', async (t) => {
  const root = await createTempRoot(t);
  const targetFile = path.join(root, 'userData', 'recent-workspaces.json');

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      writeRecentWorkspaceIndexFile(targetFile, {
        version: 1,
        projects: [{ projectRoot: path.join(root, `Proj-${index}`), lastOpenedAt: new Date().toISOString() }],
        scenes: [{ filePath: path.join(root, `Scene-${index}.scene.json`), lastOpenedAt: new Date().toISOString() }],
      }),
    ),
  );

  const raw = await fs.readFile(targetFile, 'utf8');
  const parsed = JSON.parse(raw) as { version: number; projects: unknown[]; scenes: unknown[] };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.projects.length, 1);
  assert.equal(parsed.scenes.length, 1);

  const entries = await fs.readdir(path.dirname(targetFile));
  assert.deepEqual(entries, ['recent-workspaces.json']);
});

test('sourceProjectRoot 为空时也能从路径推断模型包，写入目标资产索引且二次粘贴不重复登记', async (t) => {
  const root = await createTempRoot(t);
  const workspaceRoot = path.join(root, 'workspace');
  const projectA = path.join(root, 'StandaloneSceneDir');
  const projectB = path.join(root, 'ProjectB');

  const pkgA = path.join(projectA, 'Assets', 'Models', 'Sorter');
  const glbA = await writeFileEnsured(path.join(pkgA, 'sorter.glb'), createValidGlb(21));

  const authorized = new Set<string>();
  const payload = buildModelClipboardPayload(null, glbA, [], '分拣机');
  const firstResult = await prepareCrossSceneClipboardForTarget(payload, {
    projectRoot: projectB,
    workspaceRoot,
    sharedResourcesRoot: null,
    dataPlatformBaseUrl: null,
    dataPlatformProjectId: null,
    authorizeFile: (filePath) => authorized.add(path.resolve(filePath).toLowerCase()),
  });

  assert.equal(firstResult.available, true);
  assert.deepEqual(firstResult.missingResources, []);
  assert.equal(firstResult.projectAssetsUpdated, true, '首次跨项目复制应登记目标项目资产索引');

  const pastedAsset = (firstResult.payload!.entries[0].entities[0].components as Record<string, {
    sourcePath: string;
    sourceUrl: string;
  }>).modelAsset;
  const expectedTargetGlb = path.join(projectB, 'Assets', 'Models', 'Sorter', 'sorter.glb');
  assert.equal(path.resolve(pastedAsset.sourcePath), path.resolve(expectedTargetGlb));
  assert.equal(pastedAsset.sourceUrl, encodeAssetUrl(expectedTargetGlb));
  assert.ok(authorized.has(path.resolve(expectedTargetGlb).toLowerCase()));

  const assetIndex = await readProjectAssetIndex(projectB);
  assert.equal(assetIndex.assets.length, 1);
  assert.equal(path.resolve(assetIndex.assets[0].path), path.resolve(expectedTargetGlb));

  const secondResult = await prepareCrossSceneClipboardForTarget(payload, {
    projectRoot: projectB,
    workspaceRoot,
    sharedResourcesRoot: null,
    dataPlatformBaseUrl: null,
    dataPlatformProjectId: null,
    authorizeFile: (filePath) => authorized.add(path.resolve(filePath).toLowerCase()),
  });
  assert.equal(secondResult.available, true);
  assert.equal(secondResult.projectAssetsUpdated, false, '重复粘贴同内容包不得重复新增索引条目');
  assert.equal((await readProjectAssetIndex(projectB)).assets.length, 1);
});

test('ComboModels 二级模型包仅复制自身子包且不波及同级组合模型', async (t) => {
  const root = await createTempRoot(t);
  const workspaceRoot = path.join(root, 'workspace');
  const projectA = path.join(root, 'ProjectA');
  const projectB = path.join(root, 'ProjectB');

  const comboTarget = path.join(projectA, 'Assets', 'Models', 'ComboModels', 'Line-A');
  const glbTarget = await writeFileEnsured(path.join(comboTarget, 'line.glb'), createValidGlb(31));
  const comboSibling = path.join(projectA, 'Assets', 'Models', 'ComboModels', 'Combo-Other');
  await writeFileEnsured(path.join(comboSibling, 'other.glb'), createValidGlb(32));

  const authorized = new Set<string>();
  const result = await prepareCrossSceneClipboardForTarget(
    buildModelClipboardPayload(projectA, glbTarget, [], '组合产线'),
    {
      projectRoot: projectB,
      workspaceRoot,
      sharedResourcesRoot: null,
      dataPlatformBaseUrl: null,
      dataPlatformProjectId: null,
      authorizeFile: (filePath) => authorized.add(path.resolve(filePath).toLowerCase()),
    },
  );

  assert.equal(result.available, true);
  assert.deepEqual(result.missingResources, []);
  assert.equal(result.projectAssetsUpdated, true);
  const pastedAsset = (result.payload!.entries[0].entities[0].components as Record<string, {
    sourcePath: string;
  }>).modelAsset;
  const expectedComboGlb = path.join(projectB, 'Assets', 'Models', 'ComboModels', 'Line-A', 'line.glb');
  assert.equal(path.resolve(pastedAsset.sourcePath), path.resolve(expectedComboGlb));
  assert.ok(authorized.has(path.resolve(expectedComboGlb).toLowerCase()));

  const comboEntries = await fs.readdir(path.join(projectB, 'Assets', 'Models', 'ComboModels'));
  assert.deepEqual(comboEntries, ['Line-A'], '同级兄弟目录 Combo-Other 不得被一起复制');
});

test('数据中台项目复制到普通本地项目自动将 SharedResources 模型本地化并写入本地索引', async (t) => {
  const root = await createTempRoot(t);
  const workspaceRoot = path.join(root, 'workspace');
  const sharedRoot = path.join(workspaceRoot, 'SharedResources');
  const projectA = path.join(workspaceRoot, 'Platforms', 'a'.repeat(64), 'Projects', '101');
  const localProjectB = path.join(root, 'LocalProjectB');

  const sharedPkg = path.join(sharedRoot, 'Assets', 'Models', 'Model-77-Agv');
  const sharedGlb = await writeFileEnsured(path.join(sharedPkg, 'agv.glb'), createValidGlb(41));

  const payload = buildModelClipboardPayload(projectA, sharedGlb, [], '潜伏车');
  payload.sourceContext.dataPlatformBaseUrl = 'http://platform-a.local';
  payload.sourceContext.dataPlatformProjectId = '101';

  const authorized = new Set<string>();
  const result = await prepareCrossSceneClipboardForTarget(payload, {
    projectRoot: localProjectB,
    workspaceRoot,
    sharedResourcesRoot: null,
    dataPlatformBaseUrl: null,
    dataPlatformProjectId: null,
    authorizeFile: (filePath) => authorized.add(path.resolve(filePath).toLowerCase()),
  });

  assert.equal(result.available, true);
  assert.deepEqual(result.missingResources, []);
  assert.equal(result.projectAssetsUpdated, true);
  const pastedAsset = (result.payload!.entries[0].entities[0].components as Record<string, {
    sourcePath: string;
  }>).modelAsset;
  const expectedLocalGlb = path.join(localProjectB, 'Assets', 'Models', 'Model-77-Agv', 'agv.glb');
  assert.equal(path.resolve(pastedAsset.sourcePath), path.resolve(expectedLocalGlb));
  assert.ok(authorized.has(path.resolve(expectedLocalGlb).toLowerCase()));
  assert.equal((await readProjectAssetIndex(localProjectB)).assets.length, 1);
});

test('跨不同数据中台服务复制自动本地化模型包、剥离原中台绑定并同步更新 poiEffect 目标路径', async (t) => {
  const root = await createTempRoot(t);
  const workspaceRoot = path.join(root, 'workspace');
  const sharedRoot = path.join(workspaceRoot, 'SharedResources');
  const projectA = path.join(root, 'WorkspaceA', 'Projects', '101');
  const projectB = path.join(workspaceRoot, 'Platforms', 'b'.repeat(64), 'Projects', '202');

  const pkgA = path.join(root, 'WorkspaceA', 'SharedResources', 'Assets', 'Models', 'Model-55-Stacker');
  const glbA = await writeFileEnsured(path.join(pkgA, 'stacker.glb'), createValidGlb(55));

  const payload: CrossSceneEntityClipboardPayload = {
    schemaVersion: 1,
    clipboardId: 'clip_cross_server',
    copiedAt: '2026-11-27T00:00:00.000Z',
    sourceContext: {
      sceneSessionId: 'source_server_a',
      sceneFilePath: path.join(projectA, 'scene.scene.json'),
      projectRoot: projectA,
      dataPlatformBaseUrl: 'http://platform-a.local',
      dataPlatformProjectId: '101',
    },
    entries: [
      {
        rootId: 'folder_root',
        entities: [
          {
            id: 'folder_root',
            name: '跨中台组',
            isFolder: true,
            parentId: null,
            childrenIds: ['model_1', 'effect_1'],
            components: {
              transform: {
                position: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
              },
            },
          },
          {
            id: 'model_1',
            name: '堆垛机',
            parentId: 'folder_root',
            childrenIds: [],
            components: {
              transform: {
                position: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
              },
              modelAsset: {
                sourcePath: glbA,
                sourceUrl: encodeAssetUrl(glbA),
                lengthUnit: 'meter',
                unitScaleToMeters: 1,
                assetCode: 'DDJ-55',
                dataPlatformModel: {
                  sourceKey: 'a'.repeat(64),
                  kind: 'model',
                  resourceId: '55',
                  modelPath: 'stacker.glb',
                },
              },
            },
          },
          {
            id: 'effect_1',
            name: '告警脉冲',
            parentId: 'folder_root',
            childrenIds: [],
            components: {
              transform: {
                position: { x: 0, y: 2, z: 0 },
                rotation: { x: 0, y: 0, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
              },
              poiEffect: {
                kind: 'alarm-pulse',
                configuration: {
                  version: 1,
                  target: {
                    mode: 'model',
                    entityId: null,
                    generatorId: null,
                    model: {
                      sourcePath: glbA,
                      sourceUrl: encodeAssetUrl(glbA),
                      identity: {
                        sourceKey: 'a'.repeat(64),
                        kind: 'model',
                        resourceId: '55',
                        modelPath: 'stacker.glb',
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    ],
  };

  const authorized = new Set<string>();
  const result = await prepareCrossSceneClipboardForTarget(payload, {
    projectRoot: projectB,
    workspaceRoot,
    sharedResourcesRoot: sharedRoot,
    dataPlatformBaseUrl: 'http://platform-b.local',
    dataPlatformProjectId: '202',
    authorizeFile: (filePath) => authorized.add(path.resolve(filePath).toLowerCase()),
  });

  assert.equal(result.available, true);
  assert.deepEqual(result.missingResources, []);
  assert.equal(result.projectAssetsUpdated, true);

  const pastedEntities = result.payload!.entries[0].entities;
  const pastedModelAsset = (pastedEntities[1].components as Record<string, Record<string, unknown>>).modelAsset;
  const expectedGlbB = path.join(projectB, 'Assets', 'Models', 'imported-Model-55-Stacker', 'stacker.glb');
  assert.equal(path.resolve(String(pastedModelAsset.sourcePath)), path.resolve(expectedGlbB));
  assert.equal(pastedModelAsset.sourceUrl, encodeAssetUrl(expectedGlbB));
  assert.equal(pastedModelAsset.dataPlatformModel, undefined, '跨服务本地化后应移除原中台绑定');

  const pastedEffectModel = ((pastedEntities[2].components as Record<string, {
    configuration: { target: { model: Record<string, unknown> } };
  }>).poiEffect).configuration.target.model;
  assert.equal(path.resolve(String(pastedEffectModel.sourcePath)), path.resolve(expectedGlbB));
  assert.equal(pastedEffectModel.sourceUrl, encodeAssetUrl(expectedGlbB));
  assert.equal(pastedEffectModel.identity, undefined);
  assert.ok(result.warnings.some((warning) => warning.includes('移除原中台绑定')));
});

test('位于 Assets/Models 之外的独立 GLB 复制到目标项目并自动建立独立模型包与索引', async (t) => {
  const root = await createTempRoot(t);
  const workspaceRoot = path.join(root, 'workspace');
  const projectB = path.join(root, 'ProjectB');
  const externalGlb = await writeFileEnsured(path.join(root, 'ExternalDownloads', 'pump.glb'), createValidGlb(61));

  const authorized = new Set<string>();
  const result = await prepareCrossSceneClipboardForTarget(
    buildModelClipboardPayload(null, externalGlb, [], '水泵'),
    {
      projectRoot: projectB,
      workspaceRoot,
      sharedResourcesRoot: null,
      dataPlatformBaseUrl: null,
      dataPlatformProjectId: null,
      authorizeFile: (filePath) => authorized.add(path.resolve(filePath).toLowerCase()),
    },
  );

  assert.equal(result.available, true);
  assert.deepEqual(result.missingResources, []);
  assert.equal(result.projectAssetsUpdated, true);

  const pastedModelAsset = (result.payload!.entries[0].entities[0].components as Record<string, {
    sourcePath: string;
    sourceUrl: string;
  }>).modelAsset;
  assert.ok(pastedModelAsset.sourcePath.startsWith(path.join(projectB, 'Assets', 'Models', 'pump-copied-')));
  assert.equal(path.basename(pastedModelAsset.sourcePath), 'pump.glb');
  assert.equal(pastedModelAsset.sourceUrl, encodeAssetUrl(pastedModelAsset.sourcePath));
  assert.ok(authorized.has(path.resolve(pastedModelAsset.sourcePath).toLowerCase()));
  assert.equal((await readProjectAssetIndex(projectB)).assets.length, 1);
});
