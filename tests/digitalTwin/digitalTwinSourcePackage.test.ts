import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildDigitalTwinSourcePackage } from '../../electron/ipc/digitalTwinSourcePackage.ts';

const require = createRequire(import.meta.url);
const NO_SKYBOX_CACHE = { getSharedProjectSkyboxRoot: () => null };

const unzipper = require('unzipper') as { Open: { file: (filePath: string) => Promise<{ files: Array<{ path: string; buffer: () => Promise<Buffer> }> }> } };

test('源工程包保留多场景且只复制场景实际引用的共享资源', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-package-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const mainScenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const secondaryScenePath = path.join(projectRoot, 'Scenes', 'secondary.scene.json');
  const usedModelRoot = path.join(sharedRoot, 'Assets', 'Models', 'Model-101-Pump');
  const unusedModelRoot = path.join(sharedRoot, 'Assets', 'Models', 'Model-999-Unused');
  try {
    await Promise.all([
      mkdir(path.dirname(mainScenePath), { recursive: true }),
      mkdir(usedModelRoot, { recursive: true }),
      mkdir(unusedModelRoot, { recursive: true }),
    ]);
    await writeFile(path.join(usedModelRoot, 'main.glb'), 'used', 'utf8');
    await writeFile(path.join(usedModelRoot, 'meta.json'), '{"lengthUnit":"meter"}', 'utf8');
    await writeFile(path.join(unusedModelRoot, 'main.glb'), 'unused', 'utf8');
    const scene = (name: string) => JSON.stringify({
      version: 3,
      scene: {
        name,
        entities: {
          model: { components: { modelAsset: { sourcePath: path.join(usedModelRoot, 'main.glb'), packagePath: usedModelRoot } } },
        },
        metadata: {
          description: path.join(unusedModelRoot, 'main.glb'),
        },
      },
    });
    await writeFile(mainScenePath, scene('主场景'), 'utf8');
    await writeFile(secondaryScenePath, scene('备用场景'), 'utf8');

    const result = await buildDigitalTwinSourcePackage({
      projectRoot,
      sharedResourcesRoot: sharedRoot,
      entrySceneFilePath: mainScenePath,
      outputRoot: tempRoot,
      manifest: {
        projectId: '42',
        projectName: '测试工程',
        editorProjectId: null,
        baseVersionId: null,
        resourceRevision: '7',
      },
      signal: new AbortController().signal,
      isPlatformImageReference: () => false,
      findSyncedImageForReference: async () => null,
      skyboxCacheDependencies: NO_SKYBOX_CACHE,
    });

    assert.equal(result.sceneCount, 2);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.fileSize > 0);
    const archive = await unzipper.Open.file(result.filePath);
    const paths = archive.files.map((entry) => entry.path.replace(/\\/g, '/')).sort();
    assert.ok(paths.includes('.babylon-editor/digital-twin-source-manifest.json'));
    assert.ok(paths.includes('Scenes/main.scene.json'));
    assert.ok(paths.includes('Scenes/secondary.scene.json'));
    assert.ok(paths.includes('Assets/Models/Model-101-Pump/main.glb'));
    assert.ok(!paths.some((entry) => entry.includes('Model-999-Unused')));
    const manifestEntry = archive.files.find((entry) => entry.path.replace(/\\/g, '/') === '.babylon-editor/digital-twin-source-manifest.json');
    assert.ok(manifestEntry);
    const manifest = JSON.parse((await manifestEntry!.buffer()).toString('utf8'));
    assert.equal(manifest.entryScenePath, 'Scenes/main.scene.json');
    assert.equal(manifest.scenes.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('源工程包拒绝任一场景携带旧 Fetch API Key', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-api-key-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const mainScenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const secondaryScenePath = path.join(projectRoot, 'Scenes', 'secondary.scene.json');
  try {
    await mkdir(path.dirname(mainScenePath), { recursive: true });
    await writeFile(mainScenePath, JSON.stringify({ version: 3, scene: { name: '主场景', entities: {} } }), 'utf8');
    await writeFile(secondaryScenePath, JSON.stringify({
      version: 3,
      scene: { name: '备用场景', entities: {}, fetchConfig: { url: 'http://127.0.0.1/api', apiKey: 'secret-key' } },
    }), 'utf8');

    await assert.rejects(
      buildDigitalTwinSourcePackage({
        projectRoot,
        sharedResourcesRoot: sharedRoot,
        entrySceneFilePath: mainScenePath,
        outputRoot: tempRoot,
        manifest: {
          projectId: '42',
          projectName: '测试工程',
          editorProjectId: null,
          baseVersionId: null,
          resourceRevision: '7',
        },
        signal: new AbortController().signal,
        isPlatformImageReference: () => false,
        findSyncedImageForReference: async () => null,
      skyboxCacheDependencies: NO_SKYBOX_CACHE,
      }),
      /Fetch API Key/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('数字孪生源工程包按发布策略剔除 CAD 引用且不读取缺失 DXF', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-skip-cad-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  try {
    await Promise.all([
      mkdir(path.dirname(scenePath), { recursive: true }),
      mkdir(sharedRoot, { recursive: true }),
    ]);
    await writeFile(scenePath, JSON.stringify({
      version: 3,
      scene: {
        name: '跳过 CAD',
        entityIds: ['cad'],
        entities: {
          cad: {
            components: {
              transform: { position: { x: 0, y: 0, z: 0 } },
              cadReference: {
                sourcePath: 'C:\\missing-digital-twin-cad\\layout.dxf',
                sourceUrl: 'editor-asset://local/C%3A%5Cmissing-digital-twin-cad%5Clayout.dxf',
              },
            },
          },
        },
      },
    }), 'utf8');

    const result = await buildDigitalTwinSourcePackage({
      projectRoot,
      sharedResourcesRoot: sharedRoot,
      entrySceneFilePath: scenePath,
      outputRoot: tempRoot,
      manifest: {
        projectId: '42',
        projectName: '测试工程',
        editorProjectId: null,
        baseVersionId: null,
        resourceRevision: '1',
      },
      signal: new AbortController().signal,
      isPlatformImageReference: () => false,
      findSyncedImageForReference: async () => null,
      skyboxCacheDependencies: NO_SKYBOX_CACHE,
      skipCadReferences: true,
    });

    const archive = await unzipper.Open.file(result.filePath);
    const sceneEntry = archive.files.find((entry) => entry.path.replace(/\\/g, '/') === 'Scenes/main.scene.json');
    assert.ok(sceneEntry);
    const packagedScene = JSON.parse((await sceneEntry!.buffer()).toString('utf8'));
    assert.equal('cadReference' in packagedScene.scene.entities.cad.components, false);
    assert.equal(result.sceneContents.some((item) => item.includes('missing-digital-twin-cad')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
