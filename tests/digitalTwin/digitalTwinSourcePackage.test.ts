import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildDigitalTwinSourcePackage } from '../../electron/ipc/digitalTwinSourcePackage.ts';

const require = createRequire(import.meta.url);
const NO_SKYBOX_CACHE = { getSharedProjectSkyboxRoot: () => null };

const unzipper = require('unzipper') as { Open: { file: (filePath: string) => Promise<{ files: Array<{ path: string; buffer: () => Promise<Buffer> }> }> } };

async function writeEnvironmentIndex(options: {
  sharedRoot: string;
  sourceKey: string;
  resourceId: string;
  fileRevision: string;
  runtimeRevision: string;
  modelContent: string;
}): Promise<void> {
  const relativePath = `.babylon-editor/data-platform-cache/environments/${options.sourceKey}/${options.resourceId}/${options.fileRevision}/model.glb`;
  await mkdir(path.join(options.sharedRoot, '.babylon-editor'), { recursive: true });
  await writeFile(path.join(options.sharedRoot, '.babylon-editor', 'data-platform-environment-index.json'), JSON.stringify({
    version: 1,
    protocolVersion: '1',
    sourceKey: options.sourceKey,
    manifestRevision: options.runtimeRevision,
    entries: [{
      sourceKey: options.sourceKey,
      resourceId: options.resourceId,
      displayName: '园区环境',
      relativePath,
      fileName: 'model.glb',
      fileSizeBytes: Buffer.byteLength(options.modelContent),
      fileSha256: createHash('sha256').update(options.modelContent).digest('hex'),
      fileRevision: options.fileRevision,
      runtimeRevision: options.runtimeRevision,
      lengthUnit: 'meter',
      status: 'active',
      syncedAt: '2026-08-26T00:00:00.000Z',
      lastUsedAt: '2026-08-26T00:00:00.000Z',
      warning: null,
    }],
  }), 'utf8');
}

function createPortableEnvironmentPackagePath(resourceId: string): string {
  return `Assets/Environments/Env-${resourceId}`;
}

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

test('源工程包允许场景携带 Fetch 配置并原样保留', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-api-key-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const mainScenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const secondaryScenePath = path.join(projectRoot, 'Scenes', 'secondary.scene.json');
  const fetchConfig = { url: 'https://fetch.example.test/inventory', apiKey: 'source-package-test-api-key' };
  try {
    await Promise.all([
      mkdir(path.dirname(mainScenePath), { recursive: true }),
      mkdir(path.join(sharedRoot, '.babylon-editor'), { recursive: true }),
    ]);
    await writeFile(
      path.join(sharedRoot, '.babylon-editor', 'data-platform-environment-index.json'),
      'unrelated-invalid-index',
      'utf8',
    );
    await writeFile(mainScenePath, JSON.stringify({ version: 3, scene: { name: '主场景', entities: {} } }), 'utf8');
    await writeFile(secondaryScenePath, JSON.stringify({
      version: 3,
      scene: { name: '备用场景', entities: {}, fetchConfig },
    }), 'utf8');

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

    const archive = await unzipper.Open.file(result.filePath);
    const sceneEntry = archive.files.find((entry) => entry.path.replace(/\\/g, '/') === 'Scenes/secondary.scene.json');
    assert.ok(sceneEntry);
    const packagedScene = JSON.parse((await sceneEntry!.buffer()).toString('utf8'));
    assert.deepEqual(packagedScene.scene.fetchConfig, fetchConfig);
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

test('源工程包复制数据中台环境缓存并将场景引用改写为便携路径', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-environment-cache-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const sourceKey = 'd8b7b05d99f03cdcd06d43a2bcb79a4eebc77d8c1636bd0723401bae08ed3199';
  const resourceId = '2088100088037199873';
  const fileRevision = '2092171410874761217';
  const runtimeRevision = '7645194092844337573';
  const revisionRoot = path.join(
    sharedRoot,
    '.babylon-editor',
    'data-platform-cache',
    'environments',
    sourceKey,
    resourceId,
    fileRevision,
  );
  const modelPath = path.join(revisionRoot, 'model.glb');
  const modelUrl = `editor-asset://local/${encodeURIComponent(modelPath)}?assetRevision=${runtimeRevision}`;
  const alternateModelPath = path.join(revisionRoot, 'alternate.glb');
  const alternateModelUrl = `editor-asset://local/${encodeURIComponent(alternateModelPath)}?assetRevision=${runtimeRevision}`;
  const portablePackagePath = createPortableEnvironmentPackagePath(resourceId);
  const portableModelPath = `${portablePackagePath}/model.glb`;
  const portableModelUrl = `editor-asset://local/${encodeURIComponent(portableModelPath)}`;

  try {
    await Promise.all([
      mkdir(path.dirname(scenePath), { recursive: true }),
      mkdir(revisionRoot, { recursive: true }),
    ]);
    await writeFile(modelPath, 'environment', 'utf8');
    await writeFile(path.join(revisionRoot, 'metadata.json'), '{"lengthUnit":"meter"}', 'utf8');
    await writeEnvironmentIndex({
      sharedRoot,
      sourceKey,
      resourceId,
      fileRevision,
      runtimeRevision,
      modelContent: 'environment',
    });
    await writeFile(scenePath, JSON.stringify({
      version: 3,
      scene: {
        name: '环境缓存',
        entities: {},
        sceneSettings: {
          environment: {
            packagePath: revisionRoot,
            activeVariantUrl: modelUrl,
            variants: [
              { name: '备用效果', sourcePath: alternateModelPath, sourceUrl: alternateModelUrl },
              { name: '当前效果', sourcePath: modelPath, sourceUrl: modelUrl },
            ],
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
    });

    const archive = await unzipper.Open.file(result.filePath);
    const paths = archive.files.map((entry) => entry.path.replace(/\\/g, '/'));
    assert.ok(paths.includes(portableModelPath));
    assert.equal(paths.includes(`${portablePackagePath}/metadata.json`), false);
    const sceneEntry = archive.files.find((entry) => entry.path.replace(/\\/g, '/') === 'Scenes/main.scene.json');
    assert.ok(sceneEntry);
    const sceneContent = (await sceneEntry!.buffer()).toString('utf8');
    const environment = JSON.parse(sceneContent).scene.sceneSettings.environment;
    assert.equal(environment.packagePath, portablePackagePath);
    assert.equal(environment.activeVariantUrl, portableModelUrl);
    assert.equal(environment.variants.length, 1);
    assert.equal(environment.variants[0].name, '当前效果');
    assert.equal(environment.variants[0].sourcePath, portableModelPath);
    assert.equal(environment.variants[0].sourceUrl, portableModelUrl);
    assert.equal(environment.source, 'data-platform');
    assert.equal(environment.resourceType, 'ENV_MODEL');
    assert.equal(environment.dataPlatformResourceId, resourceId);
    assert.equal(environment.dataPlatformSourceKey, sourceKey);
    assert.equal(environment.dataPlatformRevision, runtimeRevision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('源工程包拒绝通过祖先 Junction 读取共享缓存外资源', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-environment-junction-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const sourceKey = 'd8b7b05d99f03cdcd06d43a2bcb79a4eebc77d8c1636bd0723401bae08ed3199';
  const resourceId = '2088100088037199873';
  const fileRevision = '2092171410874761217';
  const runtimeRevision = '7645194092844337573';
  const externalSourceRoot = path.join(root, 'outside-environment-cache');
  const externalRevisionRoot = path.join(externalSourceRoot, resourceId, fileRevision);
  const linkedSourceRoot = path.join(
    sharedRoot,
    '.babylon-editor',
    'data-platform-cache',
    'environments',
    sourceKey,
  );
  const revisionRoot = path.join(linkedSourceRoot, resourceId, fileRevision);
  const modelPath = path.join(revisionRoot, 'model.glb');
  const modelUrl = `editor-asset://local/${encodeURIComponent(modelPath)}?assetRevision=${runtimeRevision}`;

  try {
    await Promise.all([
      mkdir(path.dirname(scenePath), { recursive: true }),
      mkdir(externalRevisionRoot, { recursive: true }),
      mkdir(path.dirname(linkedSourceRoot), { recursive: true }),
    ]);
    await writeFile(path.join(externalRevisionRoot, 'model.glb'), 'environment', 'utf8');
    await writeFile(path.join(externalRevisionRoot, 'secret.txt'), 'outside', 'utf8');
    await symlink(externalSourceRoot, linkedSourceRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await writeEnvironmentIndex({
      sharedRoot,
      sourceKey,
      resourceId,
      fileRevision,
      runtimeRevision,
      modelContent: 'environment',
    });
    await writeFile(scenePath, JSON.stringify({
      version: 3,
      scene: {
        name: 'Junction 环境缓存',
        entities: {},
        sceneSettings: {
          environment: {
            packagePath: revisionRoot,
            activeVariantUrl: modelUrl,
            variants: [{ name: '默认', sourcePath: modelPath, sourceUrl: modelUrl }],
          },
        },
      },
    }), 'utf8');

    await assert.rejects(
      buildDigitalTwinSourcePackage({
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
      }),
      /符号链接或 Junction/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('源工程包拒绝缺少 Sidecar 完整性记录的数据中台环境缓存', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-environment-no-sidecar-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const sourceKey = 'd8b7b05d99f03cdcd06d43a2bcb79a4eebc77d8c1636bd0723401bae08ed3199';
  const resourceId = '2088100088037199873';
  const fileRevision = '2092171410874761217';
  const revisionRoot = path.join(
    sharedRoot,
    '.babylon-editor',
    'data-platform-cache',
    'environments',
    sourceKey,
    resourceId,
    fileRevision,
  );
  const modelPath = path.join(revisionRoot, 'model.glb');
  try {
    await Promise.all([
      mkdir(path.dirname(scenePath), { recursive: true }),
      mkdir(revisionRoot, { recursive: true }),
    ]);
    await writeFile(modelPath, 'environment', 'utf8');
    await writeFile(scenePath, JSON.stringify({
      version: 3,
      scene: {
        name: '缺少 Sidecar 的环境缓存',
        entities: {},
        sceneSettings: {
          environment: {
            packagePath: revisionRoot,
            activeVariantUrl: `editor-asset://local/${encodeURIComponent(modelPath)}`,
          },
        },
      },
    }), 'utf8');

    await assert.rejects(
      buildDigitalTwinSourcePackage({
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
      }),
      /Sidecar/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('源工程包拒绝数据中台环境缓存引用中的 dot-segment', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-environment-dot-segment-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const sourceKey = 'd8b7b05d99f03cdcd06d43a2bcb79a4eebc77d8c1636bd0723401bae08ed3199';
  const resourceId = '2088100088037199873';
  const fileRevision = '2092171410874761217';
  const unsafeModelPath = `${sharedRoot}${path.sep}.babylon-editor${path.sep}data-platform-cache${path.sep}environments${path.sep}${sourceKey}${path.sep}${resourceId}${path.sep}${fileRevision}${path.sep}..${path.sep}..${path.sep}model.glb`;
  try {
    await Promise.all([
      mkdir(path.dirname(scenePath), { recursive: true }),
      mkdir(sharedRoot, { recursive: true }),
    ]);
    await writeFile(scenePath, JSON.stringify({
      version: 3,
      scene: {
        name: '不安全环境缓存路径',
        entities: {},
        sceneSettings: {
          environment: {
            source: 'data-platform',
            resourceType: 'ENV_MODEL',
            dataPlatformResourceId: resourceId,
            dataPlatformSourceKey: sourceKey,
            dataPlatformRevision: '7645194092844337573',
            activeVariantUrl: `editor-asset://local/${encodeURIComponent(unsafeModelPath)}`,
          },
        },
      },
    }), 'utf8');

    await assert.rejects(
      buildDigitalTwinSourcePackage({
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
      }),
      /不安全路径片段/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('源工程包拒绝 Sidecar 校验后被同长度替换的环境模型', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-environment-toctou-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const sourceKey = 'd8b7b05d99f03cdcd06d43a2bcb79a4eebc77d8c1636bd0723401bae08ed3199';
  const resourceId = '2088100088037199873';
  const fileRevision = '2092171410874761217';
  const runtimeRevision = '7645194092844337573';
  const revisionRoot = path.join(
    sharedRoot,
    '.babylon-editor',
    'data-platform-cache',
    'environments',
    sourceKey,
    resourceId,
    fileRevision,
  );
  const modelPath = path.join(revisionRoot, 'model.glb');
  const trustedContent = 'trusted-model';
  const replacedContent = 'altered-model';
  try {
    await Promise.all([
      mkdir(path.dirname(scenePath), { recursive: true }),
      mkdir(revisionRoot, { recursive: true }),
    ]);
    await writeFile(modelPath, trustedContent, 'utf8');
    await writeEnvironmentIndex({
      sharedRoot,
      sourceKey,
      resourceId,
      fileRevision,
      runtimeRevision,
      modelContent: trustedContent,
    });
    await writeFile(scenePath, JSON.stringify({
      version: 3,
      scene: {
        name: '复制阶段完整性校验',
        entities: {},
        sceneSettings: {
          environment: {
            packagePath: revisionRoot,
            activeVariantUrl: `editor-asset://local/${encodeURIComponent(modelPath)}?assetRevision=${runtimeRevision}`,
          },
        },
      },
    }), 'utf8');

    let replaced = false;
    await assert.rejects(
      buildDigitalTwinSourcePackage({
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
        onProgress: (detail) => {
          if (replaced || detail !== '正在复制源工程场景…') return;
          replaced = true;
          writeFileSync(modelPath, replacedContent, 'utf8');
        },
      }),
      /复制文件 SHA-256/,
    );
    assert.equal(replaced, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('受管便携环境即使稳定身份被删除，缺少 Sidecar 仍拒绝发布', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-portable-environment-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const resourceId = '2088100088037199873';
  const portablePackagePath = `Assets/Environments/Env-${resourceId}`;
  const portableModelPath = `${portablePackagePath}/model.glb`;
  const portableModelUrl = `editor-asset://local/${encodeURIComponent(portableModelPath)}`;
  const localModelPath = path.join(projectRoot, ...portableModelPath.split('/'));
  try {
    await Promise.all([
      mkdir(path.dirname(scenePath), { recursive: true }),
      mkdir(path.dirname(localModelPath), { recursive: true }),
      mkdir(sharedRoot, { recursive: true }),
    ]);
    await writeFile(localModelPath, 'portable-local-model', 'utf8');
    await writeFile(scenePath, JSON.stringify({
      version: 3,
      scene: {
        name: '便携环境重发布',
        entities: {},
        sceneSettings: {
          environment: {
            packagePath: portablePackagePath,
            activeVariantUrl: portableModelUrl,
            variants: [{ name: '默认', sourcePath: portableModelPath, sourceUrl: portableModelUrl }],
          },
        },
      },
    }), 'utf8');

    await assert.rejects(
      buildDigitalTwinSourcePackage({
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
      }),
      /Sidecar/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('便携 SOURCE 二次发布时按当前 Sidecar 刷新受管环境与稳定身份', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-portable-environment-relink-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const resourceId = '2088100088037199873';
  const sourceKey = 'd8b7b05d99f03cdcd06d43a2bcb79a4eebc77d8c1636bd0723401bae08ed3199';
  const oldRuntimeRevision = '7645194092844337573';
  const currentRuntimeRevision = '7645194092844337574';
  const currentFileRevision = '2092171410874761217';
  const legacyPortablePackagePath = `Assets/Environments/Env-${resourceId}`;
  const legacyPortableModelPath = `${legacyPortablePackagePath}/model.glb`;
  const legacyPortableModelUrl = `editor-asset://local/${encodeURIComponent(legacyPortableModelPath)}`;
  const localModelPath = path.join(projectRoot, ...legacyPortableModelPath.split('/'));
  const portablePackagePath = createPortableEnvironmentPackagePath(resourceId);
  const portableModelPath = `${portablePackagePath}/model.glb`;
  const portableModelUrl = `editor-asset://local/${encodeURIComponent(portableModelPath)}`;
  const currentModelPath = path.join(
    sharedRoot,
    '.babylon-editor',
    'data-platform-cache',
    'environments',
    sourceKey,
    resourceId,
    currentFileRevision,
    'model.glb',
  );
  const currentModelContent = 'current-sidecar-model';
  try {
    await Promise.all([
      mkdir(path.dirname(scenePath), { recursive: true }),
      mkdir(path.dirname(localModelPath), { recursive: true }),
      mkdir(path.dirname(currentModelPath), { recursive: true }),
    ]);
    await writeFile(localModelPath, 'stale-portable-model', 'utf8');
    await writeFile(currentModelPath, currentModelContent, 'utf8');
    await writeEnvironmentIndex({
      sharedRoot,
      sourceKey,
      resourceId,
      fileRevision: currentFileRevision,
      runtimeRevision: currentRuntimeRevision,
      modelContent: currentModelContent,
    });
    await writeFile(scenePath, JSON.stringify({
      version: 3,
      scene: {
        name: '便携环境重发布',
        entities: {},
        sceneSettings: {
          environment: {
            packagePath: legacyPortablePackagePath,
            source: 'data-platform',
            resourceType: 'ENV_MODEL',
            dataPlatformResourceId: resourceId,
            dataPlatformSourceKey: sourceKey,
            dataPlatformRevision: oldRuntimeRevision,
            displayNameSnapshot: '园区环境',
            activeVariantUrl: legacyPortableModelUrl,
            variants: [{ name: '默认', sourcePath: legacyPortableModelPath, sourceUrl: legacyPortableModelUrl }],
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
    });

    const archive = await unzipper.Open.file(result.filePath);
    const modelEntry = archive.files.find((entry) => entry.path.replace(/\\/g, '/') === portableModelPath);
    assert.ok(modelEntry);
    assert.equal((await modelEntry!.buffer()).toString('utf8'), currentModelContent);
    const sceneEntry = archive.files.find((entry) => entry.path.replace(/\\/g, '/') === 'Scenes/main.scene.json');
    assert.ok(sceneEntry);
    const environment = JSON.parse((await sceneEntry!.buffer()).toString('utf8')).scene.sceneSettings.environment;
    assert.equal(environment.source, 'data-platform');
    assert.equal(environment.resourceType, 'ENV_MODEL');
    assert.equal(environment.dataPlatformResourceId, resourceId);
    assert.equal(environment.dataPlatformSourceKey, sourceKey);
    assert.equal(environment.dataPlatformRevision, currentRuntimeRevision);
    assert.equal(environment.displayNameSnapshot, '园区环境');
    assert.equal(environment.packagePath, portablePackagePath);
    assert.equal(environment.activeVariantUrl, portableModelUrl);
    const publishedEnvironment = JSON.parse(result.sceneContents[0]).scene.sceneSettings.environment;
    assert.equal(publishedEnvironment.dataPlatformResourceId, resourceId);
    assert.equal(publishedEnvironment.dataPlatformSourceKey, sourceKey);
    assert.equal(publishedEnvironment.dataPlatformRevision, currentRuntimeRevision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('普通本地环境使用非受管目录时不依赖 Sidecar 且保留本地修改', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-local-portable-environment-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const portablePackagePath = 'Assets/Environments/Local-Campus';
  const portableModelPath = `${portablePackagePath}/model.glb`;
  const portableModelUrl = `editor-asset://local/${encodeURIComponent(portableModelPath)}`;
  const localModelPath = path.join(projectRoot, ...portableModelPath.split('/'));
  const localModelContent = 'locally-modified-portable-model';
  try {
    await Promise.all([
      mkdir(path.dirname(scenePath), { recursive: true }),
      mkdir(path.dirname(localModelPath), { recursive: true }),
      mkdir(sharedRoot, { recursive: true }),
    ]);
    await writeFile(localModelPath, localModelContent, 'utf8');
    await writeFile(scenePath, JSON.stringify({
      version: 3,
      scene: {
        name: '本地便携环境',
        entities: {},
        sceneSettings: {
          environment: {
            packagePath: portablePackagePath,
            displayNameSnapshot: '园区环境',
            activeVariantUrl: portableModelUrl,
            variants: [{ name: '默认', sourcePath: portableModelPath, sourceUrl: portableModelUrl }],
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
    });

    const archive = await unzipper.Open.file(result.filePath);
    const modelEntry = archive.files.find((entry) => entry.path.replace(/\\/g, '/') === portableModelPath);
    assert.ok(modelEntry);
    assert.equal((await modelEntry!.buffer()).toString('utf8'), localModelContent);
    const environment = JSON.parse(result.sceneContents[0]).scene.sceneSettings.environment;
    assert.equal('dataPlatformResourceId' in environment, false);
    assert.equal(environment.packagePath, portablePackagePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('源工程包拒绝身份格式非法的数据中台环境缓存路径', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-invalid-environment-identity-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const invalidModelPath = path.join(
    sharedRoot,
    '.babylon-editor',
    'data-platform-cache',
    'environments',
    'invalid-source-key',
    '2088100088037199873',
    '2092171410874761217',
    'model.glb',
  );
  try {
    await Promise.all([
      mkdir(path.dirname(scenePath), { recursive: true }),
      mkdir(sharedRoot, { recursive: true }),
    ]);
    await writeFile(scenePath, JSON.stringify({
      version: 3,
      scene: {
        name: '非法环境缓存身份',
        entities: {},
        sceneSettings: {
          environment: {
            activeVariantUrl: `editor-asset://local/${encodeURIComponent(invalidModelPath)}`,
          },
        },
      },
    }), 'utf8');

    await assert.rejects(
      buildDigitalTwinSourcePackage({
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
      }),
      /身份格式无效/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('源工程包拒绝 percent 编码损坏的本地环境 URL', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-invalid-environment-url-'));
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
        name: '损坏的本地环境 URL',
        entities: {},
        sceneSettings: {
          environment: {
            activeVariantUrl: 'editor-asset://local/D%3A%5CDT%5CZD%5CSharedResources%5C.babylon-editor%5Cdata-platform-cache%5Cenvironments%5Cbad%ZZ',
          },
        },
      },
    }), 'utf8');

    await assert.rejects(
      buildDigitalTwinSourcePackage({
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
      }),
      /本地环境资源 URL 格式无效/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('源工程包按稳定身份将旧共享目录环境重关联到当前缓存', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-environment-relink-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const legacyScenePath = path.join(projectRoot, 'Scenes', 'legacy.scene.json');
  const oldSourceKey = 'd8b7b05d99f03cdcd06d43a2bcb79a4eebc77d8c1636bd0723401bae08ed3199';
  const currentSourceKey = 'aa45e7400c925369a484dcf740cb335a59e8d3cd036e7a07d52381ae4c65d5df';
  const resourceId = '2088100088037199873';
  const runtimeRevision = '7645194092844337573';
  const currentFileRevision = '2092171410874761217';
  const oldRevisionRoot = path.join(
    'D:\\DT\\ZD\\SharedResources',
    '.babylon-editor',
    'data-platform-cache',
    'environments',
    oldSourceKey,
    resourceId,
    '1999999999999999999',
  );
  const oldModelPath = path.join(oldRevisionRoot, 'model.glb');
  const oldModelUrl = `editor-asset://local/${encodeURIComponent(oldModelPath)}?assetRevision=${runtimeRevision}`;
  const oldThumbnailUrl = `editor-asset://local/${encodeURIComponent(path.join(oldRevisionRoot, 'thumbnail.png'))}`;
  const currentRelativePath = `.babylon-editor/data-platform-cache/environments/${currentSourceKey}/${resourceId}/${currentFileRevision}/model.glb`;
  const currentModelPath = path.resolve(sharedRoot, ...currentRelativePath.split('/'));
  const portablePackagePath = createPortableEnvironmentPackagePath(resourceId);
  const portableModelPath = `${portablePackagePath}/model.glb`;

  try {
    await Promise.all([
      mkdir(path.dirname(scenePath), { recursive: true }),
      mkdir(path.dirname(currentModelPath), { recursive: true }),
      mkdir(path.join(sharedRoot, '.babylon-editor'), { recursive: true }),
    ]);
    await writeFile(currentModelPath, 'current-environment', 'utf8');
    await writeFile(path.join(path.dirname(currentModelPath), 'metadata.json'), '{"lengthUnit":"meter"}', 'utf8');
    await writeFile(path.join(sharedRoot, '.babylon-editor', 'data-platform-environment-index.json'), JSON.stringify({
      version: 1,
      protocolVersion: '1',
      sourceKey: currentSourceKey,
      manifestRevision: runtimeRevision,
      entries: [{
        sourceKey: currentSourceKey,
        resourceId,
        displayName: '园区环境',
        relativePath: currentRelativePath,
        fileName: 'model.glb',
        fileSizeBytes: Buffer.byteLength('current-environment'),
        fileSha256: createHash('sha256').update('current-environment').digest('hex'),
        fileRevision: currentFileRevision,
        runtimeRevision,
        lengthUnit: 'meter',
        status: 'active',
        syncedAt: '2026-08-26T00:00:00.000Z',
        lastUsedAt: '2026-08-26T00:00:00.000Z',
        warning: null,
      }],
    }), 'utf8');
    await writeFile(scenePath, JSON.stringify({
      version: 3,
      scene: {
        name: '旧环境缓存引用',
        entities: {},
        sceneSettings: {
          environment: {
            packagePath: oldRevisionRoot,
            source: 'data-platform',
            resourceType: 'ENV_MODEL',
            dataPlatformResourceId: resourceId,
            dataPlatformSourceKey: oldSourceKey,
            dataPlatformRevision: runtimeRevision,
            thumbnailUrl: oldThumbnailUrl,
            activeVariantUrl: oldModelUrl,
            variants: [{ name: '默认', sourcePath: oldModelPath, sourceUrl: oldModelUrl }],
          },
        },
      },
    }), 'utf8');
    await writeFile(legacyScenePath, JSON.stringify({
      version: 3,
      scene: {
        name: '无稳定身份的旧环境缓存引用',
        entities: {},
        sceneSettings: {
          environment: {
            packagePath: oldRevisionRoot,
            activeVariantUrl: oldModelUrl,
            variants: [{ name: '默认', sourcePath: oldModelPath, sourceUrl: oldModelUrl }],
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
    });

    const archive = await unzipper.Open.file(result.filePath);
    const paths = archive.files.map((entry) => entry.path.replace(/\\/g, '/'));
    assert.ok(paths.includes(portableModelPath));
    assert.equal(paths.includes(`${portablePackagePath}/metadata.json`), false);
    const sceneEntry = archive.files.find((entry) => entry.path.replace(/\\/g, '/') === 'Scenes/main.scene.json');
    assert.ok(sceneEntry);
    const sceneContent = (await sceneEntry!.buffer()).toString('utf8');
    const environment = JSON.parse(sceneContent).scene.sceneSettings.environment;
    assert.equal(environment.packagePath, portablePackagePath);
    assert.equal(environment.source, 'data-platform');
    assert.equal(environment.resourceType, 'ENV_MODEL');
    assert.equal(environment.dataPlatformResourceId, resourceId);
    assert.equal(environment.dataPlatformSourceKey, currentSourceKey);
    assert.equal(environment.dataPlatformRevision, runtimeRevision);
    assert.equal('thumbnailUrl' in environment, false);
    assert.equal(environment.variants[0].sourcePath, portableModelPath);
    assert.equal(sceneContent.includes(oldSourceKey), false);
    assert.equal(sceneContent.includes('D:\\\\DT\\\\ZD'), false);
    const legacySceneEntry = archive.files.find((entry) => entry.path.replace(/\\/g, '/') === 'Scenes/legacy.scene.json');
    assert.ok(legacySceneEntry);
    const legacyEnvironment = JSON.parse((await legacySceneEntry!.buffer()).toString('utf8')).scene.sceneSettings.environment;
    assert.equal(legacyEnvironment.packagePath, portablePackagePath);
    assert.equal(legacyEnvironment.source, 'data-platform');
    assert.equal(legacyEnvironment.resourceType, 'ENV_MODEL');
    assert.equal(legacyEnvironment.dataPlatformResourceId, resourceId);
    assert.equal(legacyEnvironment.dataPlatformSourceKey, currentSourceKey);
    assert.equal(legacyEnvironment.dataPlatformRevision, runtimeRevision);
    assert.equal(legacyEnvironment.variants[0].sourcePath, portableModelPath);

    await rm(scenePath);
    const legacyOnlyResult = await buildDigitalTwinSourcePackage({
      projectRoot,
      sharedResourcesRoot: sharedRoot,
      entrySceneFilePath: legacyScenePath,
      outputRoot: path.join(root, 'legacy-temp'),
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
    });
    assert.equal(legacyOnlyResult.sceneContents.length, 1);
    const legacyOnlyEnvironment = JSON.parse(
      legacyOnlyResult.sceneContents[0],
    ).scene.sceneSettings.environment;
    assert.equal(legacyOnlyEnvironment.source, 'data-platform');
    assert.equal(legacyOnlyEnvironment.resourceType, 'ENV_MODEL');
    assert.equal(legacyOnlyEnvironment.dataPlatformResourceId, resourceId);
    assert.equal(legacyOnlyEnvironment.dataPlatformSourceKey, currentSourceKey);
    assert.equal(legacyOnlyEnvironment.dataPlatformRevision, runtimeRevision);
    assert.equal(legacyOnlyEnvironment.packagePath, portablePackagePath);

    await writeFile(currentModelPath, 'CURRENT-environment', 'utf8');
    await assert.rejects(
      buildDigitalTwinSourcePackage({
        projectRoot,
        sharedResourcesRoot: sharedRoot,
        entrySceneFilePath: legacyScenePath,
        outputRoot: path.join(root, 'tampered-temp'),
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
      }),
      /SHA-256/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('源工程包拒绝普通资源目录与受管环境文件使用重叠目标', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-source-environment-target-overlap-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedRoot = path.join(root, 'SharedResources');
  const tempRoot = path.join(root, 'temp');
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const managedScenePath = path.join(projectRoot, 'Scenes', 'managed.scene.json');
  const sourceKey = 'd8b7b05d99f03cdcd06d43a2bcb79a4eebc77d8c1636bd0723401bae08ed3199';
  const resourceId = '2088100088037199873';
  const fileRevision = '2092171410874761217';
  const runtimeRevision = '7645194092844337573';
  const portablePackagePath = createPortableEnvironmentPackagePath(resourceId);
  const portableModelPath = `${portablePackagePath}/model.glb`;
  const portableModelUrl = `editor-asset://local/${encodeURIComponent(portableModelPath)}`;
  const localPackageRoot = path.join(projectRoot, ...portablePackagePath.split('/'));
  const managedPackageRoot = path.join(
    sharedRoot,
    '.babylon-editor',
    'data-platform-cache',
    'environments',
    sourceKey,
    resourceId,
    fileRevision,
  );
  const managedModelPath = path.join(managedPackageRoot, 'model.glb');
  const managedModelUrl = `editor-asset://local/${encodeURIComponent(managedModelPath)}?assetRevision=${runtimeRevision}`;
  try {
    await Promise.all([
      mkdir(path.dirname(scenePath), { recursive: true }),
      mkdir(localPackageRoot, { recursive: true }),
      mkdir(managedPackageRoot, { recursive: true }),
    ]);
    await writeFile(path.join(localPackageRoot, 'model.glb'), 'local-environment', 'utf8');
    await writeFile(path.join(localPackageRoot, 'local-only.txt'), 'local-only', 'utf8');
    await writeFile(managedModelPath, 'managed-environment', 'utf8');
    await writeEnvironmentIndex({
      sharedRoot,
      sourceKey,
      resourceId,
      fileRevision,
      runtimeRevision,
      modelContent: 'managed-environment',
    });
    await writeFile(scenePath, JSON.stringify({
      version: 3,
      scene: {
        name: '普通资源冲突',
        entities: {
          local: {
            components: {
              modelAsset: {
                packagePath: portablePackagePath,
                sourcePath: portableModelPath,
                sourceUrl: portableModelUrl,
              },
            },
          },
        },
        sceneSettings: {},
      },
    }), 'utf8');
    await writeFile(managedScenePath, JSON.stringify({
      version: 3,
      scene: {
        name: '受管环境',
        entities: {},
        sceneSettings: {
          environment: {
            packagePath: managedPackageRoot,
            activeVariantUrl: managedModelUrl,
            variants: [{ name: '受管', sourcePath: managedModelPath, sourceUrl: managedModelUrl }],
          },
        },
      },
    }), 'utf8');

    await assert.rejects(
      buildDigitalTwinSourcePackage({
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
      }),
      /源工程资源目标冲突/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
