import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ downloadRemoteFile }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/dataPlatformTransfer'),
]>(['electron/ipc/dataPlatformTransfer.ts']);

function response(parts: Uint8Array[], headers: Record<string, string>, status = 200) {
  let index = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (index === parts.length) controller.close();
    else controller.enqueue(parts[index++]);
  } }), { headers, status });
}

test('真实流式写入逐块上报KB所需的绝对字节，总量未知时保留null至结束', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'download-byte-progress-'));
  try {
    for (const known of [true, false]) {
      const events: Array<{ downloadedBytes: number; totalBytes: number | null }> = [];
      const destinationPath = path.join(root, `${known}.glb`);
      await downloadRemoteFile({ baseUrl: 'https://example.test/', remoteUrl: '/model.glb', destinationPath,
        signal: new AbortController().signal, timeoutMs: 5000, context: '下载测试',
        onProgress: (event) => events.push(event),
        fetchImpl: async () => response([new Uint8Array(1024), new Uint8Array(1024)], known ? { 'content-length': '2048' } : {}),
      });
      assert.ok(events.some((event) => event.downloadedBytes === 1024 && event.totalBytes === (known ? 2048 : null)));
      assert.deepEqual(events.at(-1), { downloadedBytes: 2048, totalBytes: 2048 });
      assert.equal((await readFile(destinationPath)).length, 2048);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('续传进度从有效缓存偏移开始，服务器返回200时从0重新计数', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'download-resume-progress-'));
  try {
    for (const supportsRange of [true, false]) {
      const destinationPath = path.join(root, `${supportsRange}.glb`);
      const partialDirectoryPath = path.join(root, String(supportsRange));
      const controller = new AbortController();
      const options = { baseUrl: 'https://example.test/', remoteUrl: '/model.glb', destinationPath,
        partialDirectoryPath, resumeKey: 'model', timeoutMs: 5000, context: '续传测试' };
      await assert.rejects(downloadRemoteFile({ ...options, signal: controller.signal,
        onBytes: () => controller.abort(),
        fetchImpl: async () => response([new Uint8Array(1024), new Uint8Array(1024)], { etag: '"same"', 'content-length': '2048' }),
      }), /取消/);
      const events: Array<{ downloadedBytes: number; totalBytes: number | null }> = [];
      await downloadRemoteFile({ ...options, signal: new AbortController().signal,
        onProgress: (event) => events.push(event),
        fetchImpl: async (_url, init) => {
          assert.equal(new Headers(init?.headers).get('Range'), 'bytes=1024-');
          return supportsRange
            ? response([new Uint8Array(1024)], { etag: '"same"', 'content-range': 'bytes 1024-2047/2048' }, 206)
            : response([new Uint8Array(2048)], { etag: '"same"', 'content-length': '2048' });
        },
      });
      assert.equal(events[0].downloadedBytes, supportsRange ? 1024 : 0);
      assert.equal(events[0].totalBytes, 2048, '续传缺少Content-Length时使用Content-Range的完整大小');
      assert.deepEqual(events.at(-1), { downloadedBytes: 2048, totalBytes: 2048 });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
