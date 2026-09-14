import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createAssetFileByteStream } from '../electron/shared/assetFileByteStream.ts';

assert.ok(process.argv[2], '用法：node --experimental-strip-types scripts/smoke-asset-stream-throughput.mjs <资源文件> [报告路径]');
const file = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3] ?? 'output/playwright/extreme-performance/asset-stream.json');
const samples = [];
for (let round = 0; round < 3; round += 1) {
  for (const mode of round % 2 ? ['byte-stream', 'adapter'] : ['adapter', 'byte-stream']) {
    const started = performance.now(), hash = createHash('sha256');
    const stream = mode === 'adapter' ? Readable.toWeb(createReadStream(file)) : createAssetFileByteStream(file);
    const reader = stream.getReader();
    let bytes = 0, chunks = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      hash.update(value); bytes += value.byteLength; chunks += 1;
    }
    samples.push({ mode, round, ms: performance.now() - started, bytes, chunks, sha256: hash.digest('hex') });
  }
}
assert.equal(new Set(samples.map(sample => sample.sha256)).size, 1, '两条读取路径必须返回完全相同的文件内容');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ scope: 'isolated-file-transfer-with-sha256-not-scene-open', fileName: path.basename(file), samples }, null, 2));
console.log(JSON.stringify({ output, samples }));
