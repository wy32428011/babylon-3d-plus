import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ syncSceneDataPlatformModelAssets }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/dataPlatformModelIncrementalSync'),
]>(['electron/ipc/dataPlatformModelIncrementalSync.ts']);

test('不同场景资源可同时下载，相同资源仍串行提交并复用完整缓存', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-model-parallel-'));
  const downloads: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const dependencies = {
    requestJson: async (options: { body?: unknown }) => {
      const id = (options.body as { id: string }).id;
      return { success: true, data: { id, modelName: `设备${id}`, fileName: 'model.gltf',
        fileUrl: `/files/${id}.gltf`, revision: '1' } };
    },
    downloadFile: async (options: import('../../electron/ipc/dataPlatformTransfer').DownloadRemoteFileOptions) => {
      downloads.push(options.remoteUrl);
      await barrier;
      const bytes = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{}] }] }));
      await fs.mkdir(path.dirname(options.destinationPath), { recursive: true });
      await fs.writeFile(options.destinationPath, bytes);
      return { bytes: bytes.length, contentType: 'application/json', finalUrl: options.remoteUrl, etag: null, resumedBytes: 0 };
    },
    readAssetIndex: async (editorRoot: string): Promise<import('../../electron/types').ProjectAssetIndex> => {
      try { return JSON.parse(await fs.readFile(path.join(editorRoot, '.babylon-editor/asset-index.json'), 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, assets: [] };
        throw error;
      }
    },
  };
  const sync = (id: string) => syncSceneDataPlatformModelAssets({ baseUrl: 'https://example.com',
    sharedResourcesRoot: root, resources: [{ kind: 'model', resourceId: id }], dependencies });
  const jobs = [sync('1'), sync('2'), sync('1')];
  const completion = Promise.all(jobs);
  try {
    const deadline = Date.now() + 1200;
    while (downloads.length < 2 && Date.now() < deadline) await delay(10);
    assert.equal(downloads.length, 2, '独立资源必须在首个资源下载结束前开始，重复资源不能重复下载');
    release();
    const [[first], [second], [same]] = await completion;
    assert.equal(same.path, first.path);
    assert.notEqual(second.path, first.path);
    assert.deepEqual(downloads.sort(), ['/files/1.gltf', '/files/2.gltf']);
    assert.ok(await fs.stat(first.path));
    assert.ok(await fs.stat(second.path));
    const [reopened] = await sync('2');
    assert.equal(reopened.path, second.path);
    assert.equal(downloads.length, 2, '并发索引提交不能丢失另一个资源的缓存');
  } finally {
    release();
    await Promise.allSettled(jobs);
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const mode of ['failure', 'cancel'] as const) {
  test(`批量场景同步${mode === 'failure' ? '单项失败' : '取消'}后等待其他在途资源写盘和清理完成`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-model-batch-drain-'));
    const controller = new AbortController();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let secondStarted!: () => void;
    const ready = new Promise<void>(resolve => { secondStarted = resolve; });
    const downloads: string[] = [];
    const dependencies = {
      requestJson: async (options: { body?: unknown }) => {
        const id = (options.body as { id: string }).id;
        return { success: true, data: { id, modelName: `设备${id}`, fileName: 'model.gltf',
          fileUrl: `/files/${id}.gltf`, revision: '1' } };
      },
      downloadFile: async (options: import('../../electron/ipc/dataPlatformTransfer').DownloadRemoteFileOptions) => {
        downloads.push(options.remoteUrl);
        if (options.remoteUrl === '/files/2.gltf') secondStarted();
        if (mode === 'failure' && options.remoteUrl === '/files/1.gltf') {
          await ready;
          throw new Error('资源 1 下载失败');
        }
        // 模拟已经启动且尚未完成取消清理的下载，不能因其他 worker 失败提前返回。
        await barrier;
        const bytes = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{}] }] }));
        await fs.mkdir(path.dirname(options.destinationPath), { recursive: true });
        await fs.writeFile(options.destinationPath, bytes);
        return { bytes: bytes.length, contentType: 'application/json', finalUrl: options.remoteUrl, etag: null, resumedBytes: 0 };
      },
      readAssetIndex: async (editorRoot: string): Promise<import('../../electron/types').ProjectAssetIndex> => {
        try { return JSON.parse(await fs.readFile(path.join(editorRoot, '.babylon-editor/asset-index.json'), 'utf8')); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, assets: [] };
          throw error;
        }
      },
    };
    const options = { baseUrl: 'https://example.com', sharedResourcesRoot: root,
      resources: [{ kind: 'model' as const, resourceId: '1' }, { kind: 'model' as const, resourceId: '2' }],
      dependencies, signal: controller.signal };
    const pending = syncSceneDataPlatformModelAssets(options);
    let settled = false;
    const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }))
      .finally(() => { settled = true; });
    try {
      await ready;
      if (mode === 'cancel') controller.abort();
      await delay(100);
      assert.equal(settled, false, '另一个资源尚在写盘前等待，批量入口必须继续等待');
      release();
      const result = await outcome;
      assert.equal(result.value, null);
      assert.match(String(result.error), mode === 'failure' ? /资源 1 下载失败/ : /取消/);
      const files = await fs.readdir(root, { recursive: true });
      assert.equal(files.some(file => /\.pending-|data-platform-model-sync-/.test(file)), false,
        '批量入口返回时所有暂存目录均已提交或清理');
      if (mode === 'failure') {
        const [asset] = await syncSceneDataPlatformModelAssets({ ...options, resources: [options.resources[1]] });
        assert.ok(await fs.stat(asset.path));
        assert.equal(downloads.filter(url => url === '/files/2.gltf').length, 1,
          '批量拒绝之前成功资源的缓存提交已经完成，后续调用能够直接复用');
      }
    } finally {
      release();
      await outcome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
